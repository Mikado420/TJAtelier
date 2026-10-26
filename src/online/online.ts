/**
 * オンライン対戦の画面（ロビー → 部屋 → 予約した曲を順に → 同時スタート → 順位）。
 * サーバーとのやりとりは net.ts、プレイは PlayMode.startOnline。
 *
 * 部屋の中:
 * - 左: 参加者（部屋主・難易度・準備OK）とチャット
 * - 右: 今の曲（自分の難易度・準備OK・カウントダウン）と予約の一覧（＋ 曲を予約）
 * - 部屋設定（部屋主）: 曲を選べる人・1 人の予約の数・自動スタート
 */
import type { AudioEngine } from '../audio/audio';
import { toPlayable, type EChart } from '../chart/model';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { Game } from '../engine/game';
import { saveBest, type Crown } from '../home/home';
import { listFolders, listSongs, loadSongAudio, loadSongData, loadSongVideo, type SongEntry } from '../io/library';
import type { PlayMode } from '../play/playmode';
import type { Opponent } from '../render/renderer';
import { getCachedAudio, getCachedVideo, putCachedAudio, putCachedVideo } from './cache';
import {
  audioHash, listRooms, newRoomId, OnlineClient,
  type ChatMsg, type HistoryRow, type ResultRow, type RoomInfo, type RoomSettings, type Roster, type SongMeta, type WatchPlayer,
} from './net';

export interface OnlineHost {
  audio: AudioEngine;
  play: PlayMode;
  toast(msg: string): void;
  /** 背景の動画を流す設定か（流さないなら動画は受け取らない） */
  videoOn(): boolean;
  /** オンラインの画面を閉じた（曲選択へ戻る） */
  closed(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COURSE: Record<string, [string, string]> = {
  Easy: ['かんたん', 'var(--c-easy)'],
  Normal: ['ふつう', 'var(--c-normal)'],
  Hard: ['むずかしい', 'var(--c-hard)'],
  Oni: ['おに', 'var(--c-oni)'],
  Edit: ['うら', 'var(--c-edit)'],
};
const COURSE_ORDER = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
const courseChip = (name: string, level?: number) => {
  const [label, color] = COURSE[name] ?? [name, 'var(--btn)'];
  return `<span class="ol-course" style="--cc:${color}">${esc(label)}${level !== undefined ? `<b>★${level}</b>` : ''}</span>`;
};
const PICK_LABEL: Record<RoomSettings['pick'], string> = { host: '部屋主だけ', all: '全員', turn: '全員（順番に）', random: '全員（ランダム）' };
const NAME_KEY = 'malody-web:onlineName';

/** 曲を選ぶときのフォルダ（「すべて」「未分類」はフォルダ名に使えない値） */
const ALL = 'all';
const UNCAT = 'uncat';
const FOLDER_COLORS = ['#3a7ca5', '#7b4bd0', '#c8337e', '#1fa59a', '#e8603c', '#c9a227', '#5a8f3c', '#b3477a'];
function folderColor(key: string) {
  if (key === ALL) return '#4d9fbe';
  if (key === UNCAT) return '#5a6670';
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}

type View = 'lobby' | 'room';
type Modal = '' | 'create' | { join: RoomInfo } | 'settings' | 'standings' | 'pick' | 'results';

export class OnlineScreen {
  private root: HTMLElement;
  private body: HTMLElement;
  private view: View = 'lobby';
  private client: OnlineClient | null = null;
  private rooms: RoomInfo[] = [];
  private roomsErr = '';
  private poll = 0;
  private roster: Roster | null = null;
  /** 今の曲（受け取って遊べる状態のもの） */
  private song: { meta: SongMeta; chart: EChart } | null = null;
  /** 今の曲（受け取り中のものも。難易度を選ぶのに使う） */
  private nextSong: { meta: SongMeta; chart: EChart; by: string } | null = null;
  /** 自分が遊ぶ難易度（今の曲の中から） */
  private myCourse = '';
  /** 受け取り中・送り中の割合（null = していない） */
  private transfer: { label: string; ratio: number } | null = null;
  /** 背景の動画の受け取り・送りの割合 */
  private vtransfer: { label: string; ratio: number } | null = null;
  /** 今の曲の背景の動画（受け取ったもの。プレイで流す） */
  private video: { key: string; data: ArrayBuffer; name: string; off: number } | null = null;
  /** 曲を選ぶ一覧 */
  private picking: SongEntry[] | null = null;
  private pickOpen = '';
  private pickFolders: string[] = [];
  private results: ResultRow[] | null = null;
  private history: HistoryRow[] = [];
  /** 自分がプレイを終えて、ほかの人を待っている */
  private waiting = false;
  private playingNow = false;
  private opponents = new Map<string, Opponent>();
  /** チャットの記録（新しいものが下） */
  private chatLog: ChatMsg[] = [];
  private modal: Modal = '';
  /** 通信が切れて入り直しているところ */
  private reconnecting = false;
  private cdTimer = 0;

  constructor(private readonly host: OnlineHost) {
    const root = document.createElement('div');
    root.id = 'online';
    root.className = 'ol hidden';
    root.innerHTML = `
      <header class="ol-head">
        <button class="ol-back" data-ol="back" aria-label="戻る"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
        <h2 class="ol-title">オンライン</h2>
        <span class="ol-sub"></span>
      </header>
      <div class="ol-body"></div>`;
    document.body.appendChild(root);
    this.root = root;
    this.body = root.querySelector('.ol-body')!;
    root.addEventListener('click', (e) => void this.onClick(e));
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement).matches('.ol-modal input')) {
        e.preventDefault();
        root.querySelector<HTMLButtonElement>('.ol-modal [data-ol="ok"]')?.click();
      }
    });
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  open() {
    // プレイ中のはずなのにプレイが動いていない（止まった）ときは、やめた扱いにして部屋に戻す
    if (this.playingNow && !this.host.play.isActive) {
      this.playingNow = false;
      this.client?.send({ t: 'quit' });
    }
    this.root.classList.remove('hidden');
    if (!this.client) {
      this.view = 'lobby';
      this.render();
      void this.refresh();
      this.startPoll();
    } else this.render();
  }

  private hide() {
    this.root.classList.add('hidden');
  }

  private get name() {
    try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
  }
  private set name(v: string) {
    try { localStorage.setItem(NAME_KEY, v); } catch { /* 保存できない */ }
  }

  private get me() {
    return this.client?.me ?? '';
  }

  private get amHost() {
    return !!this.roster && this.roster.host === this.me;
  }

  private startPoll() {
    clearInterval(this.poll);
    this.poll = window.setInterval(() => {
      if (this.view === 'lobby' && this.isOpen && !document.hidden) void this.refresh();
    }, 5000);
  }

  private async refresh() {
    try {
      this.rooms = await listRooms();
      this.roomsErr = '';
    } catch {
      this.roomsErr = 'サーバーにつながりません';
    }
    if (this.view === 'lobby') this.renderLobbyList();
  }

  // ---------- 表示 ----------

  private render() {
    const sub = this.root.querySelector('.ol-sub')!;
    if (this.view === 'lobby') {
      this.root.querySelector('.ol-title')!.textContent = 'オンライン';
      sub.textContent = '';
      this.body.innerHTML = `
        <div class="ol-lobby">
          <aside class="ol-side">
            <label class="ol-field"><span>名前</span><input id="olName" maxlength="12" placeholder="12文字まで" value="${esc(this.name)}" autocomplete="off"></label>
            <button class="ol-btn primary" data-ol="create">部屋を作る</button>
            <button class="ol-btn" data-ol="refresh">一覧を更新</button>
          </aside>
          <section class="ol-rooms" id="olRooms"></section>
        </div>
        ${this.modalHtml()}`;
      this.renderLobbyList();
      const nm = this.body.querySelector<HTMLInputElement>('#olName')!;
      nm.addEventListener('change', () => { this.name = nm.value.trim().slice(0, 12); });
      return;
    }
    // 部屋
    const c = this.client!;
    this.root.querySelector('.ol-title')!.textContent = c.room.title;
    this.renderSub();
    // 入力中のメッセージは書き直しても残す
    const draft = this.body.querySelector<HTMLInputElement>('#olMsg')?.value ?? '';
    this.body.innerHTML = `
      <div class="ol-room">
        <section class="ol-card ol-players"><h3>参加者 <small id="olCount"></small></h3><div id="olPlayers"></div>
          <div class="ol-chat"><div class="ol-log" id="olLog" aria-live="polite"></div>
            <form class="ol-say" id="olSay"><input id="olMsg" maxlength="80" placeholder="メッセージを送る" autocomplete="off" enterkeyhint="send"><button class="ol-btn primary" type="submit" aria-label="送る"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-5 16-3-7z"/></svg></button></form>
          </div>
        </section>
        <section class="ol-card ol-songbox" id="olSong"></section>
      </div>
      <div id="olModal">${this.modalHtml()}</div>`;
    this.body.querySelector<HTMLInputElement>('#olMsg')!.value = draft;
    this.renderPlayers();
    this.renderSong();
    this.renderLog();
    const form = this.body.querySelector<HTMLFormElement>('#olSay')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = form.querySelector<HTMLInputElement>('#olMsg')!;
      const x = inp.value.trim().slice(0, 80);
      if (!x || !this.client) return;
      this.client.send({ t: 'chat', x });
      inp.value = '';
    });
  }

  private renderSub() {
    const c = this.client;
    if (!c) return;
    const sub = this.root.querySelector('.ol-sub')!;
    sub.innerHTML = `${c.room.locked ? '🔒 ' : ''}部屋 ${esc(c.room.id)}${this.reconnecting ? ' <em class="ol-recon">つなぎ直しています…</em>' : ''}`;
  }

  /** モーダルだけ描き直す */
  private renderModal() {
    const el = this.body.querySelector('#olModal');
    if (el) el.innerHTML = this.modalHtml();
    else this.render();
  }

  /** チャットの記録を描く（いちばん下までスクロール） */
  private renderLog() {
    const el = this.body.querySelector<HTMLElement>('#olLog');
    if (!el) return;
    el.innerHTML = this.chatLog.length
      ? this.chatLog.map((c) => `<p class="${c.p === this.me ? 'me' : ''}"><b>${esc(c.name)}</b><span>${esc(c.x)}</span></p>`).join('')
      : '<p class="ol-log-empty">まだメッセージはありません</p>';
    el.scrollTop = el.scrollHeight;
  }

  private renderLobbyList() {
    const el = this.body.querySelector('#olRooms');
    if (!el) return;
    if (this.roomsErr) {
      el.innerHTML = `<p class="ol-empty">${esc(this.roomsErr)}</p>`;
      return;
    }
    if (!this.rooms.length) {
      el.innerHTML = '<p class="ol-empty">いま開いている部屋はありません</p>';
      return;
    }
    el.innerHTML = this.rooms
      .map((r) => {
        const full = r.players >= r.max;
        return `<button class="ol-roomcard${full ? ' full' : ''}" data-join="${esc(r.id)}">
          <span class="ol-rt">${r.locked ? '<i class="ol-lock" title="あいことば">🔒</i>' : ''}${esc(r.title)}</span>
          <span class="ol-rs">${r.song ? `♪ ${esc(r.song)}` : '曲はまだ'}</span>
          <span class="ol-rm"><span>${esc(r.host)}</span><b>${r.players}/${r.max}</b><em class="${r.playing ? 'play' : ''}">${r.playing ? 'プレイ中' : full ? '満員' : '待機中'}</em></span>
        </button>`;
      })
      .join('');
  }

  private modalHtml() {
    const m = this.modal;
    if (m === 'create') {
      return `<div class="ol-modal"><div class="ol-mbox">
        <h3>部屋を作る</h3>
        <label class="ol-field"><span>部屋の名前</span><input id="olTitle" maxlength="24" placeholder="${esc(this.name || 'ななし')} の部屋"></label>
        <label class="ol-field"><span>あいことば</span><input id="olPass" maxlength="16" placeholder="なし" autocomplete="off"></label>
        <div class="ol-mbtn"><button class="ol-btn" data-ol="cancel">やめる</button><button class="ol-btn primary" data-ol="ok">作る</button></div>
      </div></div>`;
    }
    if (m && typeof m === 'object' && 'join' in m) {
      return `<div class="ol-modal"><div class="ol-mbox">
        <h3>${esc(m.join.title)}</h3>
        <label class="ol-field"><span>あいことば</span><input id="olPass" maxlength="16" autocomplete="off"></label>
        <div class="ol-mbtn"><button class="ol-btn" data-ol="cancel">やめる</button><button class="ol-btn primary" data-ol="ok">入る</button></div>
      </div></div>`;
    }
    if (m === 'settings' && this.roster) {
      const s = this.roster.settings;
      const host = this.amHost;
      return `<div class="ol-modal"><div class="ol-mbox ol-set">
        <h3>部屋設定</h3>
        <div class="ol-field"><span>曲を選べる人</span>
          <div class="ol-seg">${(Object.keys(PICK_LABEL) as RoomSettings['pick'][]).map((k) => `<button data-set-pick="${k}" class="${s.pick === k ? 'on' : ''}" ${host ? '' : 'disabled'}>${PICK_LABEL[k]}</button>`).join('')}</div>
        </div>
        <div class="ol-field"><span>1 人の予約</span>
          <div class="ol-step"><button data-set-limit="-1" ${host && s.limit > 1 ? '' : 'disabled'} aria-label="減らす">−</button><b>${s.limit} 曲まで</b><button data-set-limit="1" ${host && s.limit < 5 ? '' : 'disabled'} aria-label="増やす">＋</button></div>
        </div>
        <div class="ol-field"><span>全員が準備OKなら自動で始める</span>
          <div class="ol-seg"><button data-set-auto="1" class="${s.auto ? 'on' : ''}" ${host ? '' : 'disabled'}>ON</button><button data-set-auto="0" class="${s.auto ? '' : 'on'}" ${host ? '' : 'disabled'}>OFF</button></div>
        </div>
        <div class="ol-mbtn"><button class="ol-btn primary" data-ol="close">閉じる</button></div>
      </div></div>`;
    }
    if (m === 'standings' && this.roster) return this.standingsHtml();
    if (m === 'results' && this.results) return this.resultsHtml();
    if (m === 'pick' && this.picking) return this.pickHtml();
    return '';
  }

  private renderPlayers() {
    const el = this.body.querySelector('#olPlayers');
    const R = this.roster;
    if (!el || !R) return;
    const cnt = this.body.querySelector('#olCount');
    if (cnt) cnt.textContent = `${R.players.length} / 4`;
    const me = this.me;
    const amHost = this.amHost;
    const songOn = !!R.song;
    el.innerHTML = R.players
      .map((p) => {
        const st = p.away ? '<em class="away">接続待ち</em>'
          : p.inGame ? '<em class="play">プレイ中</em>'
          : !songOn ? '<em>待機</em>'
          : !p.ready ? '<em>受け取り中</em>'
          : p.ok ? '<em class="ok">準備OK</em>' : '<em>準備中</em>';
        return `<div class="ol-player${p.p === me ? ' me' : ''}">
          <span class="ol-crown">${p.p === R.host ? '👑' : ''}</span>
          <span class="ol-pn">${esc(p.name)}${p.p === me ? '<small>あなた</small>' : ''}</span>
          ${songOn && p.course ? courseChip(p.course) : ''}${st}
          ${amHost && p.p !== me ? `<button class="ol-kick" data-host="${esc(p.p)}" aria-label="部屋主にする" title="部屋主にする">👑</button><button class="ol-kick" data-kick="${esc(p.p)}" aria-label="退出させる">×</button>` : ''}
        </div>`;
      })
      .join('');
  }

  /** 右: 今の曲・予約の一覧 */
  private renderSong() {
    const el = this.body.querySelector('#olSong');
    const R = this.roster;
    if (!el || !R) return;
    const me = this.me;
    const amHost = this.amHost;
    const s = R.song;
    const tr = this.transfer;
    const myP = R.players.find((p) => p.p === me);
    const canReserve = R.settings.pick !== 'host' || amHost;
    const myQ = R.queue.filter((q) => q.by === me).length;
    // 自分の難易度（今の曲にある難易度から）
    const chart = s && this.nextSong?.meta.key === s.key ? this.nextSong.chart : null;
    const courses = chart ? [...chart.courses].sort((a, b) => COURSE_ORDER.indexOf(a.name) - COURSE_ORDER.indexOf(b.name)) : [];
    const cd = R.countdown ? Math.max(0, Math.ceil((this.client!.toPerf(R.countdown) - performance.now()) / 1000)) : 0;
    const again = R.phase === 'wait' && R.last && (amHost || R.last.by === me);
    const now = s
      ? `<div class="ol-nowbox">
          <div class="ol-now"><b>${esc(s.title)}</b><small>${esc(s.byName)} の予約</small></div>
          ${courses.length ? `<div class="ol-mycourse"><span>あなたの難易度</span>${courses.map((c) => `<button data-course="${esc(c.name)}" class="${c.name === this.myCourse ? 'on' : ''}" ${R.phase === 'play' ? 'disabled' : ''}>${courseChip(c.name, c.level)}</button>`).join('')}</div>` : ''}
          ${tr ? `<div class="ol-prog"><span>${esc(tr.label)} ${Math.round(tr.ratio * 100)}%</span><i style="width:${(tr.ratio * 100).toFixed(1)}%"></i></div>` : ''}
          ${this.vtransfer ? `<div class="ol-prog ol-vprog"><span>${esc(this.vtransfer.label)} ${Math.round(this.vtransfer.ratio * 100)}%</span><i style="width:${(this.vtransfer.ratio * 100).toFixed(1)}%"></i></div>` : ''}
          <div class="ol-go">
            ${this.waiting ? '<p class="ol-wait">ほかの人が終わるのを待っています…</p>'
              : R.phase === 'play' ? (this.song ? '<button class="ol-btn primary big" data-ol="watch">観戦する</button>' : '<p class="ol-wait">プレイ中です</p>')
              : cd ? `<p class="ol-cd">あと <b>${cd}</b></p><button class="ol-btn" data-ol="ok">準備OKを取り消す</button>`
              : `<button class="ol-btn ${myP?.ok ? '' : 'primary'} big" data-ol="ok" ${this.song ? '' : 'disabled'}>${myP?.ok ? '準備OKを取り消す' : '準備OK'}</button>`}
            ${amHost && R.phase === 'wait' && !cd ? `<span class="ol-hostbtn"><button class="ol-mini" data-ol="start" ${R.players.every((p) => p.ready || p.away) ? '' : 'disabled'}>すぐ始める</button><button class="ol-mini ghost" data-ol="skip">この曲を飛ばす</button></span>` : ''}
          </div>
        </div>`
      : `<div class="ol-nowbox empty"><p class="ol-empty">${R.queue.length ? '' : '予約がありません'}</p>${again ? `<button class="ol-btn" data-ol="again">もう一回（${esc(R.last!.title)}）</button>` : ''}</div>`;
    const q = R.queue
      .map((x, i) => `<div class="ol-q${x.by === me ? ' me' : ''}"><i>${i + 1}</i><span class="ol-qt"><b>${esc(x.title)}</b><small>${esc(x.byName)}</small></span>${courseChip(x.course, x.level)}
        ${amHost ? `<button class="ol-qb" data-move="${x.qid}" data-d="-1" ${i ? '' : 'disabled'} aria-label="上へ">↑</button><button class="ol-qb" data-move="${x.qid}" data-d="1" ${i < R.queue.length - 1 ? '' : 'disabled'} aria-label="下へ">↓</button>` : ''}
        ${amHost || x.by === me ? `<button class="ol-qb" data-unq="${x.qid}" aria-label="予約を取り消す">×</button>` : ''}</div>`)
      .join('');
    el.innerHTML = `
      <h3>いまの曲<span class="ol-h3b"><button class="ol-mini ghost" data-ol="standings">成績</button><button class="ol-mini ghost" data-ol="settings">${amHost ? '部屋設定' : esc(PICK_LABEL[R.settings.pick])}</button></span></h3>
      ${now}
      <h3>予約 <small>${R.queue.length}</small>${canReserve ? `<button class="ol-mini" data-ol="pick" ${myQ >= R.settings.limit ? 'disabled' : ''}>＋ 曲を予約</button>` : ''}</h3>
      <div class="ol-queue">${q}</div>`;
    // カウントダウン中は描き直す
    clearInterval(this.cdTimer);
    if (cd) this.cdTimer = window.setInterval(() => { if (this.view === 'room' && !this.playingNow) this.renderSong(); }, 250);
  }

  private standingsHtml() {
    const R = this.roster!;
    const rows = R.standings.map((s, i) => `<tr><td class="rk">${i + 1}</td><td class="nm">${esc(s.name)}</td><td class="sc">${s.total.toLocaleString()}</td><td>${s.wins}</td><td>${s.plays}</td></tr>`).join('');
    const hist = this.history.map((h) => `<details class="ol-hist"><summary><b>${esc(h.title)}</b>${courseChip(h.course, h.level)}<small>${esc(h.list[0]?.name ?? '')}</small></summary>
      <table>${h.list.map((r, i) => `<tr><td class="rk">${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${courseChip(r.course)}</td><td class="sc">${r.score.toLocaleString()}</td></tr>`).join('')}</table></details>`).join('');
    return `<div class="ol-modal"><div class="ol-mbox ol-res">
      <h3>この部屋の成績</h3>
      <table><thead><tr><th></th><th>名前</th><th>合計スコア</th><th>1位</th><th>曲数</th></tr></thead><tbody>${rows || '<tr><td colspan="5">まだありません</td></tr>'}</tbody></table>
      ${hist ? `<h3>遊んだ曲</h3>${hist}` : ''}
      <div class="ol-mbtn"><button class="ol-btn primary" data-ol="close">閉じる</button></div>
    </div></div>`;
  }

  private resultsHtml() {
    const me = this.me;
    const R = this.roster;
    const again = R && R.phase === 'wait' && R.last && (this.amHost || R.last.by === me);
    const rows = (this.results ?? [])
      .map((r, i) => `<tr class="${r.p === me ? 'me' : ''}"><td class="rk">${i + 1}</td><td class="nm">${esc(r.name)}</td><td>${courseChip(r.course)}</td><td class="sc">${r.score.toLocaleString()}</td><td>${r.good}</td><td>${r.ok}</td><td>${r.bad}</td><td>${r.maxCombo}</td><td>${r.rolls}</td></tr>`)
      .join('');
    return `<div class="ol-modal"><div class="ol-mbox ol-res">
      <h3>結果</h3>
      <table><thead><tr><th></th><th>名前</th><th></th><th>スコア</th><th>良</th><th>可</th><th>不可</th><th>最大コンボ</th><th>連打</th></tr></thead><tbody>${rows || '<tr><td colspan="9">記録がありません</td></tr>'}</tbody></table>
      <div class="ol-mbtn"><button class="ol-btn" data-ol="standings">成績</button>${again ? '<button class="ol-btn" data-ol="again">もう一回</button>' : ''}<button class="ol-btn primary" data-ol="close">OK</button></div>
    </div></div>`;
  }

  /** 曲を予約する一覧（フォルダごと。タップで開く） */
  private pickHtml() {
    const songs = this.picking!;
    const keys = [ALL, UNCAT, ...[...this.pickFolders].sort((x, y) => x.localeCompare(y, 'ja'))];
    const inF = (k: string) => (k === ALL ? songs : k === UNCAT ? songs.filter((x) => !x.folders.length) : songs.filter((x) => x.folders.includes(k)));
    const rows = keys.map((k) => {
      const list = inF(k);
      if (k !== ALL && !list.length) return '';
      const open = this.pickOpen === k;
      const name = k === ALL ? 'すべて' : k === UNCAT ? '未分類' : k.replace(/\//g, ' › ');
      return `<button class="ol-pf${open ? ' open' : ''}" data-pf="${esc(k)}" style="--fc:${folderColor(k)}"><span>${esc(name)}</span><small>${list.length} 曲</small><i aria-hidden="true"></i></button>
        ${open ? `<div class="ol-pfl" style="--fc:${folderColor(k)}">${list
          .map((x) => `<div class="ol-pi"><span class="ol-pit">${esc(x.title)}${x.length ? '' : '<small>音源なし</small>'}</span><span class="ol-pic">${[...x.courses].sort((a, b) => COURSE_ORDER.indexOf(a.name) - COURSE_ORDER.indexOf(b.name))
            .map((c) => `<button data-pick="${esc(x.id)}" data-pcourse="${esc(c.name)}">${courseChip(c.name, c.level)}</button>`)
            .join('')}</span></div>`)
          .join('')}</div>` : ''}`;
    }).join('');
    return `<div class="ol-modal"><div class="ol-mbox ol-pickbox">
      <h3>曲を予約<button class="ol-mini" data-ol="close">閉じる</button></h3>
      <div class="ol-pick">${songs.length ? rows : '<p class="ol-empty">曲がありません</p>'}</div>
    </div></div>`;
  }

  // ---------- 操作 ----------

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-ol],[data-join],[data-kick],[data-host],[data-pick],[data-pf],[data-course],[data-move],[data-unq],[data-set-pick],[data-set-limit],[data-set-auto]');
    if (!b) return;
    const a = b.dataset.ol;
    const c = this.client;
    if (a === 'back') return this.back();
    if (a === 'refresh') return void this.refresh();
    if (a === 'create') {
      if (!this.ensureName()) return;
      this.modal = 'create';
      this.render();
      this.body.querySelector<HTMLInputElement>('#olTitle')?.focus();
      return;
    }
    if (a === 'cancel' || a === 'close') {
      this.modal = '';
      if (this.view === 'room') this.renderModal();
      else this.render();
      return;
    }
    if (a === 'ok' && this.view === 'lobby') {
      const pass = this.body.querySelector<HTMLInputElement>('#olPass')?.value.trim() ?? '';
      if (this.modal === 'create') {
        const title = this.body.querySelector<HTMLInputElement>('#olTitle')?.value.trim() ?? '';
        this.modal = '';
        await this.enter(await newRoomId().catch(() => ''), { create: true, title, pass });
      } else if (this.modal && typeof this.modal === 'object' && 'join' in this.modal) {
        const id = this.modal.join.id;
        this.modal = '';
        await this.enter(id, { pass });
      }
      return;
    }
    if (b.dataset.join) {
      if (!this.ensureName()) return;
      const r = this.rooms.find((x) => x.id === b.dataset.join);
      if (!r) return;
      if (r.players >= r.max) { this.host.toast('満員です'); return; }
      if (r.locked) { this.modal = { join: r }; this.render(); this.body.querySelector<HTMLInputElement>('#olPass')?.focus(); return; }
      await this.enter(r.id, {});
      return;
    }
    if (!c || !this.roster) return;
    if (b.dataset.kick) {
      const name = this.roster.players.find((p) => p.p === b.dataset.kick)?.name ?? '';
      if (confirm(`${name} を部屋から退出させますか？`)) c.send({ t: 'kick', p: b.dataset.kick });
      return;
    }
    if (b.dataset.host) {
      const name = this.roster.players.find((p) => p.p === b.dataset.host)?.name ?? '';
      if (confirm(`${name} を部屋主にしますか？`)) c.send({ t: 'host', p: b.dataset.host });
      return;
    }
    if (b.dataset.course) {
      this.myCourse = b.dataset.course;
      c.send({ t: 'course', c: this.myCourse });
      this.renderSong();
      return;
    }
    if (b.dataset.move) { c.send({ t: 'move', qid: b.dataset.move, d: Number(b.dataset.d) }); return; }
    if (b.dataset.unq) { c.send({ t: 'unreserve', qid: b.dataset.unq }); return; }
    if (b.dataset.setPick) { c.send({ t: 'settings', s: { pick: b.dataset.setPick } }); return; }
    if (b.dataset.setLimit) { c.send({ t: 'settings', s: { limit: this.roster.settings.limit + Number(b.dataset.setLimit) } }); return; }
    if (b.dataset.setAuto) { c.send({ t: 'settings', s: { auto: b.dataset.setAuto === '1' } }); return; }
    if (b.dataset.pf !== undefined) {
      const k = b.dataset.pf;
      this.pickOpen = this.pickOpen === k ? '' : k;
      this.host.audio.playUi('folder');
      this.renderModal();
      this.body.querySelector(`[data-pf="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (b.dataset.pick) { await this.reserve(b.dataset.pick, b.dataset.pcourse!); return; }
    if (a === 'pick') {
      this.picking = (await listSongs()).filter((s) => s.courses.length);
      const fs = new Set(await listFolders().catch(() => [] as string[]));
      for (const x of this.picking) for (const f of x.folders) fs.add(f);
      this.pickFolders = [...fs];
      this.modal = 'pick';
      this.renderModal();
      return;
    }
    if (a === 'settings') { this.modal = 'settings'; this.renderModal(); return; }
    if (a === 'standings') { this.modal = 'standings'; this.renderModal(); return; }
    if (a === 'ok') {
      const mine = this.roster.players.find((p) => p.p === this.me);
      c.send({ t: 'ok', on: !mine?.ok });
      return;
    }
    if (a === 'start') { c.send({ t: 'start' }); return; }
    if (a === 'skip') { if (confirm('この曲を飛ばしますか？')) c.send({ t: 'skip' }); return; }
    if (a === 'again') { c.send({ t: 'again' }); this.modal = ''; this.renderModal(); return; }
    if (a === 'watch') { c.send({ t: 'watch' }); return; }
  }

  private ensureName() {
    const v = this.body.querySelector<HTMLInputElement>('#olName')?.value.trim().slice(0, 12) ?? this.name;
    if (!v) {
      this.host.toast('名前を入れてください');
      this.body.querySelector<HTMLInputElement>('#olName')?.focus();
      return false;
    }
    this.name = v;
    return true;
  }

  private back() {
    if (this.view === 'room') {
      if (!confirm('部屋から出ますか？')) return;
      this.leaveRoom();
      return;
    }
    clearInterval(this.poll);
    this.hide();
    this.host.closed();
  }

  private leaveRoom(msg?: string) {
    this.client?.close();
    this.client = null;
    this.roster = null;
    this.song = null;
    this.nextSong = null;
    this.transfer = null;
    this.picking = null;
    this.results = null;
    this.history = [];
    this.waiting = false;
    this.chatLog = [];
    this.modal = '';
    this.reconnecting = false;
    clearInterval(this.cdTimer);
    this.view = 'lobby';
    if (this.playingNow) {
      this.playingNow = false;
      this.host.play.quitOnline();
    }
    if (msg) this.host.toast(msg);
    this.open();
    void this.refresh();
  }

  /** 部屋に入る（作る） */
  private async enter(id: string, q: { create?: boolean; title?: string; pass?: string }) {
    if (!id) { this.host.toast('サーバーにつながりません'); return; }
    const c = new OnlineClient();
    this.bind(c);
    try {
      await c.connect(id, { name: this.name, ...q });
    } catch (err) {
      this.host.toast((err as Error).message || '入れませんでした');
      this.render();
      void this.refresh();
      return;
    }
    this.client = c;
    this.view = 'room';
    this.song = null;
    this.results = null;
    this.modal = '';
    this.render();
  }

  private bind(c: OnlineClient) {
    c.on = {
      roster: (r) => {
        this.roster = r;
        if (!r.song) { this.song = null; this.transfer = null; }
        // プレイ中に抜けた人
        for (const [p, o] of this.opponents) if (!r.players.some((x) => x.p === p) && !o.status) o.status = 'lost';
        if (this.view !== 'room' || this.playingNow) return;
        if (this.body.querySelector('#olPlayers')) {
          this.renderPlayers();
          this.renderSong();
          if (this.modal === 'settings' || this.modal === 'standings' || this.modal === 'results') this.renderModal();
        } else this.render();
      },
      next: (meta, by) => void this.prepare(meta, by),
      upload: (key, lib) => void this.upload(key, lib),
      songProgress: (ratio) => {
        if (!this.transfer) return;
        this.transfer.ratio = ratio;
        this.paintProgress();
      },
      songReady: (meta, bytes) => void this.received(meta, bytes),
      vupload: (key, lib) => void this.vupload(key, lib),
      videoProgress: (ratio) => {
        if (!this.vtransfer) return;
        this.vtransfer.ratio = ratio;
        this.paintVProgress();
      },
      videoReady: (meta, bytes) => {
        const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        this.vtransfer = null;
        void putCachedVideo(meta.vhash, ab);
        this.setVideo(meta, ab);
        if (this.view === 'room' && !this.playingNow) this.renderSong();
      },
      start: (zero, key, players) => void this.startGame(zero, key, players),
      watch: (zero, key, players) => void this.startGame(zero, key, players, true),
      state: (s) => {
        const o = this.opponents.get(s.p);
        if (!o) return;
        o.score = Number(s.s) || 0;
        o.combo = Number(s.c) || 0;
        o.gauge = Number(s.g) || 0;
        for (const [i, j] of s.j) {
          if (!(i >= 0 && i < o.marks.length) || j < 0 || j > 2) continue;
          if (!o.marks[i]) {
            if (j === 0) o.good++;
            else if (j === 1) o.ok++;
            else o.bad++;
          }
          o.marks[i] = j + 1;
          o.fx = { j: j + 1, t: performance.now(), i };
        }
      },
      fin: (p) => { const o = this.opponents.get(p); if (o) o.status = 'fin'; },
      quit: (p) => { const o = this.opponents.get(p); if (o) o.status = 'quit'; },
      results: (list, history) => {
        this.results = list;
        this.history = history;
        this.waiting = false;
        this.modal = 'results';
        if (!this.playingNow && this.view === 'room') this.render();
      },
      history: (list) => { this.history = list; },
      chat: (m) => {
        this.chatLog.push(m);
        if (this.chatLog.length > 100) this.chatLog.shift();
        // プレイ中は画面の上に小さく出す
        if (this.playingNow && m.p !== c.me) this.host.toast(`${m.name}: ${m.x}`);
        if (this.view === 'room') this.renderLog();
      },
      chatlog: (list) => {
        this.chatLog = list.slice(-100);
        if (this.view === 'room') this.renderLog();
      },
      reconnect: (st) => {
        this.reconnecting = st === 'trying';
        if (st === 'ok') this.host.toast('つなぎ直しました');
        if (this.view === 'room') this.renderSub();
      },
      error: (msg) => this.host.toast(msg),
      closed: (reason) => {
        if (this.client !== c) return;
        this.leaveRoom(reason);
      },
    };
  }

  private paintProgress() {
    const tr = this.transfer;
    if (!tr || this.view !== 'room' || this.playingNow) return;
    const el = this.body.querySelector<HTMLElement>('.ol-prog');
    if (el) {
      el.querySelector('span')!.textContent = `${tr.label} ${Math.round(tr.ratio * 100)}%`;
      el.querySelector<HTMLElement>('i')!.style.width = `${(tr.ratio * 100).toFixed(1)}%`;
    } else this.renderSong();
  }

  /** 曲を予約する（譜面は TJA にして送る。音源は、ほかの人が持っていないときだけ後で送る） */
  private async reserve(id: string, courseName: string) {
    const c = this.client;
    if (!c) return;
    const data = await loadSongData(id);
    if (!data?.chart) { this.host.toast('譜面を読み込めませんでした'); return; }
    const a = await loadSongAudio(id);
    const tja = writeTJA(data.chart);
    const chart = parseTJA(tja);
    const course = chart.courses.find((x) => x.name === courseName);
    if (!course) { this.host.toast('その難易度がありません'); return; }
    c.send({
      t: 'reserve',
      meta: {
        title: chart.title || '（無題）',
        subtitle: chart.subtitle ?? '',
        course: courseName,
        level: course.level,
        tja,
        size: a?.data.byteLength ?? 0,
        audioName: a?.name ?? '',
        hash: a ? await audioHash(a.data) : '',
        lib: id,
        ...(await this.videoMeta(id)),
      },
    });
    this.modal = '';
    this.renderModal();
    this.host.toast(`「${chart.title || '（無題）'}」を予約しました`);
  }

  /** 予約する曲の背景の動画の情報（動画が無ければ空） */
  private async videoMeta(id: string) {
    const v = await loadSongVideo(id).catch(() => null);
    if (!v) return { vname: '', vsize: 0, vhash: '', voff: 0, vfromAudio: false };
    const e = (await listSongs()).find((x) => x.id === id);
    return { vname: v.name, vsize: v.fromAudio ? 0 : v.data.byteLength, vhash: v.fromAudio ? '' : await audioHash(v.data), voff: e?.videoOffset ?? 0, vfromAudio: v.fromAudio };
  }

  /** 背景の動画を決める（プレイで流す） */
  private setVideo(meta: SongMeta, data: ArrayBuffer) {
    if (this.nextSong?.meta.key !== meta.key) return;
    this.video = { key: meta.key, data, name: meta.vname, off: meta.voff };
    if (!this.playingNow) this.applyVideo();
  }

  /** 今の曲の動画をプレイ画面に渡す（無ければ外す） */
  private applyVideo() {
    const v = this.video && this.video.key === this.song?.meta.key ? this.video : null;
    const type = v && /\.mov$/i.test(v.name) ? 'video/quicktime' : 'video/mp4';
    this.host.play.setVideo(v ? new Blob([v.data], { type }) : null, v?.off ?? 0);
  }

  /** 背景の動画: 持っていればそれを、なければ（流す設定なら）受け取る。音源と同じファイルなら音源を使う */
  private async prepareVideo(meta: SongMeta, by: string, audio: ArrayBuffer | null) {
    const c = this.client;
    if (!c || !meta.vname) return;
    if (meta.vfromAudio) {
      if (audio) this.setVideo(meta, audio);
      return;
    }
    if (!meta.vsize) return;
    let v: ArrayBuffer | null = null;
    if (by === c.me) v = (await loadSongVideo(meta.lib).catch(() => null))?.data ?? null;
    if (!v) v = await getCachedVideo(meta.vhash);
    if (v) { this.setVideo(meta, v); return; }
    // 動画を流さない設定なら受け取らない（通信を節約）
    if (!this.host.videoOn()) return;
    this.vtransfer = { label: '動画を受け取っています', ratio: 0 };
    c.vneed(meta);
    if (this.view === 'room' && !this.playingNow) this.renderSong();
  }

  /** 予約した人: 今の曲の背景の動画を送る */
  private async vupload(key: string, lib: string) {
    const c = this.client;
    if (!c) return;
    const v = await loadSongVideo(lib).catch(() => null);
    if (!v || v.fromAudio) return;
    this.vtransfer = { label: '動画を送っています', ratio: 0 };
    this.paintVProgress();
    try {
      await c.sendAudio(key, v.data, (r) => {
        if (!this.vtransfer) return;
        this.vtransfer.ratio = r;
        this.paintVProgress();
      }, 'vend');
    } catch (err) {
      this.host.toast((err as Error).message);
    }
    this.vtransfer = null;
    if (this.view === 'room' && !this.playingNow) this.renderSong();
  }

  private paintVProgress() {
    const tr = this.vtransfer;
    if (!tr || this.view !== 'room' || this.playingNow) return;
    const el = this.body.querySelector<HTMLElement>('.ol-vprog');
    if (el) {
      el.querySelector('span')!.textContent = `${tr.label} ${Math.round(tr.ratio * 100)}%`;
      el.querySelector<HTMLElement>('i')!.style.width = `${(tr.ratio * 100).toFixed(1)}%`;
    } else this.renderSong();
  }

  /** 次の曲が決まった: 音源を持っていればすぐ読み込み、なければ受け取る */
  private async prepare(meta: SongMeta, by: string) {
    const c = this.client;
    if (!c) return;
    let chart: EChart;
    try {
      chart = parseTJA(meta.tja);
    } catch {
      this.host.toast('譜面を読み込めませんでした');
      return;
    }
    this.nextSong = { meta, chart, by };
    // プレイ中は、終わってから準備する（遊んでいる曲の音源を差し替えないように）
    if (this.playingNow) return;
    this.song = null;
    this.transfer = null;
    this.vtransfer = null;
    this.video = null;
    this.host.play.setVideo(null);
    // 難易度: 前と同じ難易度があればそれ、なければ予約した人の難易度
    if (!chart.courses.some((x) => x.name === this.myCourse)) this.myCourse = meta.course;
    if (this.myCourse !== meta.course) c.send({ t: 'course', c: this.myCourse });
    let audio: ArrayBuffer | null = null;
    if (meta.size > 0) {
      if (by === c.me) audio = (await loadSongAudio(meta.lib))?.data.slice(0) ?? null;
      if (!audio) audio = await getCachedAudio(meta.hash);
      if (!audio) {
        this.transfer = { label: '曲を受け取っています', ratio: 0 };
        c.need(meta);
        // 音源と別の動画は、音源のあとに受け取る（サーバーは音源を送り終えてから流す）
        if (!meta.vfromAudio) void this.prepareVideo(meta, by, null);
        if (this.view === 'room') this.renderSong();
        return;
      }
    }
    await this.load(meta, chart, audio);
    void this.prepareVideo(meta, by, audio);
  }

  /** 音源を全部受け取った */
  private async received(meta: SongMeta, bytes: Uint8Array) {
    const ab = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    void putCachedAudio(meta.hash, ab.slice(0));
    const chart = this.nextSong?.meta.key === meta.key ? this.nextSong.chart : parseTJA(meta.tja);
    await this.load(meta, chart, ab);
    // 動画が音源と同じファイルなら、受け取った音源を動画にも使う
    if (meta.vfromAudio) this.setVideo(meta, ab);
  }

  /** 今の曲を読み込んで、遊べる状態にする */
  private async load(meta: SongMeta, chart: EChart, audio: ArrayBuffer | null) {
    const c = this.client;
    if (!c || this.nextSong?.meta.key !== meta.key) return;
    this.transfer = null;
    try {
      await this.host.audio.loadMusic(audio);
      this.song = { meta, chart };
      this.applyVideo();
      c.send({ t: 'have', key: meta.key });
    } catch {
      this.host.toast('届いた曲を読み込めませんでした');
      this.song = null;
    }
    if (this.view === 'room' && !this.playingNow) this.renderSong();
  }

  /** 予約した人: 今の曲の音源を送る */
  private async upload(key: string, lib: string) {
    const c = this.client;
    if (!c) return;
    const a = await loadSongAudio(lib);
    if (!a) { this.host.toast('音源を読み込めませんでした'); return; }
    this.transfer = { label: '曲を送っています', ratio: 0 };
    this.paintProgress();
    try {
      await c.sendAudio(key, a.data, (r) => {
        if (!this.transfer) return;
        this.transfer.ratio = r;
        this.paintProgress();
      });
    } catch (err) {
      this.host.toast((err as Error).message);
    }
    this.transfer = null;
    if (this.view === 'room' && !this.playingNow) this.renderSong();
  }

  /** オンラインで遊んだ記録を、自分の曲の一覧の同じ曲に残す（予約した人は選んだ曲、ほかの人は同じ曲名の曲があれば） */
  private async record(meta: SongMeta, course: string, score: number, crown: Crown) {
    try {
      const songs = await listSongs();
      let s = songs.find((x) => x.id === meta.lib && x.courses.some((c) => c.name === course));
      if (!s) {
        const same = songs.filter((x) => x.title === meta.title && (x.subtitle ?? '') === meta.subtitle && x.courses.some((c) => c.name === course));
        if (same.length === 1) s = same[0];
      }
      if (s) saveBest(s.id, course, score, crown);
    } catch { /* 残せない */ }
  }

  /** 全員同時にスタート（相手がほかの難易度なら、その難易度のレーンを出す） */
  private async startGame(zero: number, key: string, players: (Partial<WatchPlayer> & { p: string; name: string; course?: string })[], spectate = false) {
    const c = this.client;
    if (!c || !this.song || this.song.meta.key !== key) {
      this.host.toast(spectate ? '曲を受け取ってから観戦できます' : '曲が届いていないので、今回は見学です');
      // 遊べないことをサーバーに伝える（ほかの人がいつまでも待たないように）
      if (!spectate) c?.send({ t: 'quit' });
      return;
    }
    const { meta, chart } = this.song;
    const courseOf = (name?: string) => chart.courses.find((x) => x.name === name) ?? chart.courses.find((x) => x.name === meta.course) ?? chart.courses[0];
    const ec = courseOf(spectate ? meta.course : this.myCourse);
    const course = toPlayable(chart, ec);
    this.results = null;
    this.waiting = false;
    this.modal = '';
    this.opponents.clear();
    const opps: Opponent[] = [];
    for (const p of players) {
      if (p.p === c.me) continue;
      const pe = courseOf(p.course);
      let lane: Opponent['lane'];
      if (pe !== ec) {
        const pc = toPlayable(chart, pe);
        lane = { game: new Game(pc.notes), course: pc, vis: [], bars: [] };
      }
      const n = lane ? lane.course.notes.length : course.notes.length;
      const o: Opponent = { id: p.p, name: p.name, score: p.s ?? 0, combo: p.c ?? 0, gauge: p.g ?? 0, good: 0, ok: 0, bad: 0, marks: new Uint8Array(n), fx: null, status: p.status ?? '', lane, course: pe.name };
      // 観戦: ここまでの判定を入れておく
      for (const [i, j] of p.j ?? []) {
        if (!(i >= 0 && i < o.marks.length) || j < 0 || j > 2 || o.marks[i]) continue;
        o.marks[i] = j + 1;
        if (j === 0) o.good++;
        else if (j === 1) o.ok++;
        else o.bad++;
      }
      this.opponents.set(p.p, o);
      opps.push(o);
    }
    if (spectate && !opps.length) { this.host.toast('観戦できる人がいません'); return; }
    this.playingNow = true;
    clearInterval(this.cdTimer);
    this.hide();
    try {
      await this.host.play.startOnline(course, { title: meta.title, course: ec.name, level: ec.level }, c.toPerf(zero), {
        send: (m) => { if (!spectate) c.send(m); },
        opponents: opps,
        spectate,
        onFinish: (stats) => {
          this.playingNow = false;
          if (!spectate) {
            const { crown, ...r } = stats;
            c.send({ t: 'fin', r });
            if (crown) void this.record(meta, ec.name, r.score, crown);
          }
          this.waiting = !this.results && (!spectate || this.roster?.phase === 'play');
          if (this.results) this.modal = 'results';
          this.open();
          this.afterPlay(meta.key);
        },
        onQuit: () => {
          this.playingNow = false;
          if (!spectate) c.send({ t: 'quit' });
          this.waiting = false;
          this.open();
          this.afterPlay(meta.key);
        },
      });
    } catch (err) {
      // 始められなかった: プレイ画面を閉じて部屋に戻る
      console.error(err);
      this.host.toast(`始められませんでした: ${(err as Error)?.message ?? err}`);
      if (this.playingNow) {
        this.playingNow = false;
        this.host.play.quitOnline();
      }
      this.open();
    }
  }

  /** プレイが終わった: そのあいだに決まった次の曲の準備をする */
  private afterPlay(playedKey: string) {
    const n = this.nextSong;
    if (n && n.meta.key !== playedKey && !this.song) void this.prepare(n.meta, n.by);
  }
}

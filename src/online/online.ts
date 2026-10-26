/**
 * オンライン対戦の画面（ロビー → 部屋 → 同時スタート → 順位）。
 * サーバーとのやりとりは net.ts、プレイは PlayMode.startOnline。
 */
import type { AudioEngine } from '../audio/audio';
import { toPlayable, type EChart } from '../chart/model';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { listFolders, listSongs, loadSongAudio, loadSongData, type SongEntry } from '../io/library';
import { saveBest, type Crown } from '../home/home';
import type { PlayMode } from '../play/playmode';
import type { Opponent } from '../render/renderer';
import { listRooms, newRoomId, OnlineClient, type ChatMsg, type ResultRow, type RoomInfo, type Roster, type SongMeta, type WatchPlayer } from './net';

export interface OnlineHost {
  audio: AudioEngine;
  play: PlayMode;
  toast(msg: string): void;
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
const courseChip = (name: string, level: number) => {
  const [label, color] = COURSE[name] ?? [name, 'var(--btn)'];
  return `<span class="ol-course" style="--cc:${color}">${esc(label)}<b>★${level}</b></span>`;
};
/** 曲を選ぶときのフォルダ（「すべて」「未分類」はフォルダ名に使えない値） */
const ALL = '\uE000all';
const UNCAT = '\uE000uncat';
const FOLDER_COLORS = ['#3a7ca5', '#7b4bd0', '#c8337e', '#1fa59a', '#e8603c', '#c9a227', '#5a8f3c', '#b3477a'];
function folderColor(key: string) {
  if (key === ALL) return '#4d9fbe';
  if (key === UNCAT) return '#5a6670';
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}
const NAME_KEY = 'malody-web:onlineName';

type View = 'lobby' | 'room';

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
  /** 受け取り中・送り中の割合（null = していない） */
  private transfer: { label: string; ratio: number } | null = null;
  /** 部屋主: 曲を選ぶ一覧を出している */
  private picking: SongEntry[] | null = null;
  private results: ResultRow[] | null = null;
  /** 自分がプレイを終えて、ほかの人を待っている */
  private waiting = false;
  private playingNow = false;
  private opponents = new Map<string, Opponent>();
  /** チャットの記録（新しいものが下） */
  private chatLog: ChatMsg[] = [];
  /** 曲を選ぶ一覧で開いているフォルダ */
  private pickOpen = '';
  private pickFolders: string[] = [];
  private modal: '' | 'create' | { join: RoomInfo } = '';

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
    sub.innerHTML = `${c.room.locked ? '🔒 ' : ''}部屋 ${esc(c.room.id)}`;
    this.body.innerHTML = `
      <div class="ol-room">
        <section class="ol-card ol-players"><h3>参加者 <small>${this.roster?.players.length ?? 0} / 4</small></h3><div id="olPlayers"></div>
          <div class="ol-chat"><div class="ol-log" id="olLog" aria-live="polite"></div>
            <form class="ol-say" id="olSay"><input id="olMsg" maxlength="80" placeholder="メッセージを送る" autocomplete="off" enterkeyhint="send"><button class="ol-btn primary" type="submit" aria-label="送る"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-5 16-3-7z"/></svg></button></form>
          </div>
        </section>
        <section class="ol-card ol-songbox" id="olSong"></section>
      </div>
      ${this.results ? this.resultsHtml() : ''}`;
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

  /** チャットの記録を描く（いちばん下までスクロール） */
  private renderLog() {
    const el = this.body.querySelector<HTMLElement>('#olLog');
    if (!el) return;
    const me = this.client?.me;
    el.innerHTML = this.chatLog.length
      ? this.chatLog.map((c) => `<p class="${c.p === me ? 'me' : ''}"><b>${esc(c.name)}</b><span>${esc(c.x)}</span></p>`).join('')
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
      el.innerHTML = '<p class="ol-empty">いま開いている部屋はありません。<br>「部屋を作る」で作れます。</p>';
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
    if (this.modal === 'create') {
      return `<div class="ol-modal"><div class="ol-mbox">
        <h3>部屋を作る</h3>
        <label class="ol-field"><span>部屋の名前</span><input id="olTitle" maxlength="24" placeholder="${esc(this.name || 'ななし')} の部屋"></label>
        <label class="ol-field"><span>あいことば</span><input id="olPass" maxlength="16" placeholder="なし（だれでも入れる）" autocomplete="off"></label>
        <div class="ol-mbtn"><button class="ol-btn" data-ol="cancel">やめる</button><button class="ol-btn primary" data-ol="ok">作る</button></div>
      </div></div>`;
    }
    if (this.modal && 'join' in this.modal) {
      return `<div class="ol-modal"><div class="ol-mbox">
        <h3>${esc(this.modal.join.title)}</h3>
        <label class="ol-field"><span>あいことば</span><input id="olPass" maxlength="16" autocomplete="off"></label>
        <div class="ol-mbtn"><button class="ol-btn" data-ol="cancel">やめる</button><button class="ol-btn primary" data-ol="ok">入る</button></div>
      </div></div>`;
    }
    return '';
  }

  private renderPlayers() {
    const el = this.body.querySelector('#olPlayers');
    const R = this.roster;
    if (!el || !R) return;
    const me = this.client!.me;
    const amHost = R.host === me;
    el.innerHTML = R.players
      .map((p) => {
        const st = p.inGame ? '<em class="play">プレイ中</em>' : p.ready ? '<em class="ok">準備OK</em>' : R.song ? '<em>受け取り中</em>' : '<em>待機</em>';
        return `<div class="ol-player${p.p === me ? ' me' : ''}">
          <span class="ol-crown">${p.p === R.host ? '👑' : ''}</span>
          <span class="ol-pn">${esc(p.name)}${p.p === me ? '<small>あなた</small>' : ''}</span>
          ${st}
          ${amHost && p.p !== me ? `<button class="ol-kick" data-kick="${esc(p.p)}" aria-label="退出させる">×</button>` : ''}
        </div>`;
      })
      .join('');
  }

  private renderSong() {
    const el = this.body.querySelector('#olSong');
    const R = this.roster;
    if (!el || !R) return;
    const amHost = R.host === this.client!.me;
    if (this.picking) {
      // フォルダごとに分けて出す（タップで開く。曲えらびと同じ並び）
      const songs = this.picking;
      const keys = [ALL, UNCAT, ...[...this.pickFolders].sort((x, y) => x.localeCompare(y, 'ja'))];
      const inF = (k: string) => (k === ALL ? songs : k === UNCAT ? songs.filter((x) => !x.folders.length) : songs.filter((x) => x.folders.includes(k)));
      const rows = keys.map((k) => {
        const list = inF(k);
        if (k !== ALL && !list.length) return '';
        const open = this.pickOpen === k;
        const name = k === ALL ? 'すべて' : k === UNCAT ? '未分類' : k.replace(/\//g, ' › ');
        return `<button class="ol-pf${open ? ' open' : ''}" data-pf="${esc(k)}" style="--fc:${folderColor(k)}"><span>${esc(name)}</span><small>${list.length} 曲</small><i aria-hidden="true"></i></button>
          ${open ? `<div class="ol-pfl" style="--fc:${folderColor(k)}">${list.length ? list
            .map((x) => `<div class="ol-pi"><span class="ol-pit">${esc(x.title)}${x.length ? '' : '<small>音源なし</small>'}</span><span class="ol-pic">${x.courses
              .map((c) => `<button data-pick="${esc(x.id)}" data-course="${esc(c.name)}">${courseChip(c.name, c.level)}</button>`)
              .join('')}</span></div>`)
            .join('') : '<p class="ol-empty">曲がありません</p>'}</div>` : ''}`;
      }).join('');
      el.innerHTML = `<h3>曲を選ぶ <button class="ol-mini" data-ol="pickClose">閉じる</button></h3>
        <div class="ol-pick">${songs.length ? rows : '<p class="ol-empty">曲がありません</p>'}</div>`;
      return;
    }
    const allReady = R.players.every((p) => p.ready);
    const s = R.song;
    const tr = this.transfer;
    el.innerHTML = `
      <h3>曲${amHost && R.phase === 'wait' ? '<button class="ol-mini" data-ol="pick">曲を選ぶ</button>' : ''}</h3>
      ${s ? `<div class="ol-now"><b>${esc(s.title)}</b>${courseChip(s.course, s.level)}</div>` : `<p class="ol-empty">${amHost ? '「曲を選ぶ」で遊ぶ曲を決めてください' : '部屋主が曲を選ぶのを待っています'}</p>`}
      ${tr ? `<div class="ol-prog"><span>${esc(tr.label)} ${Math.round(tr.ratio * 100)}%</span><i style="width:${(tr.ratio * 100).toFixed(1)}%"></i></div>` : ''}
      <div class="ol-go">
        ${this.waiting ? '<p class="ol-wait">ほかの人が終わるのを待っています…</p>'
          : R.phase === 'play' ? (this.song ? '<button class="ol-btn primary big" data-ol="watch">観戦する</button><small>いま遊んでいる人のプレイを見られます</small>' : '<p class="ol-wait">プレイ中です。曲を受け取っています…</p>')
          : amHost ? `<button class="ol-btn primary big" data-ol="start" ${s && allReady && !tr ? '' : 'disabled'}>スタート</button>${s && !allReady ? '<small>全員が曲を受け取るまで待ってください</small>' : ''}`
          : `<p class="ol-wait">${s ? (this.song ? '部屋主のスタートを待っています' : '曲を受け取っています…') : ''}</p>`}
      </div>`;
  }

  private resultsHtml() {
    const me = this.client?.me;
    const rows = (this.results ?? [])
      .map((r, i) => `<tr class="${r.p === me ? 'me' : ''}"><td class="rk">${i + 1}</td><td class="nm">${esc(r.name)}</td><td class="sc">${r.score.toLocaleString()}</td><td>${r.good}</td><td>${r.ok}</td><td>${r.bad}</td><td>${r.maxCombo}</td><td>${r.rolls}</td></tr>`)
      .join('');
    return `<div class="ol-modal"><div class="ol-mbox ol-res">
      <h3>結果</h3>
      <table><thead><tr><th></th><th>名前</th><th>スコア</th><th>良</th><th>可</th><th>不可</th><th>最大コンボ</th><th>連打</th></tr></thead><tbody>${rows || '<tr><td colspan="8">記録がありません</td></tr>'}</tbody></table>
      <div class="ol-mbtn"><button class="ol-btn primary" data-ol="resClose">OK</button></div>
    </div></div>`;
  }

  // ---------- 操作 ----------

  private async onClick(e: Event) {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-ol],[data-join],[data-kick],[data-pick],[data-pf]');
    if (!b) return;
    const a = b.dataset.ol;
    if (a === 'back') return this.back();
    if (a === 'refresh') return void this.refresh();
    if (a === 'create') {
      if (!this.ensureName()) return;
      this.modal = 'create';
      this.render();
      this.body.querySelector<HTMLInputElement>('#olTitle')?.focus();
      return;
    }
    if (a === 'cancel') { this.modal = ''; this.render(); return; }
    if (a === 'ok') {
      const pass = this.body.querySelector<HTMLInputElement>('#olPass')?.value.trim() ?? '';
      if (this.modal === 'create') {
        const title = this.body.querySelector<HTMLInputElement>('#olTitle')?.value.trim() ?? '';
        this.modal = '';
        await this.enter(await newRoomId().catch(() => ''), { create: true, title, pass });
      } else if (this.modal && 'join' in this.modal) {
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
    if (b.dataset.kick) {
      const name = this.roster?.players.find((p) => p.p === b.dataset.kick)?.name ?? '';
      if (confirm(`${name} を部屋から退出させますか？`)) this.client?.send({ t: 'kick', p: b.dataset.kick });
      return;
    }
    if (b.dataset.pf !== undefined) {
      const k = b.dataset.pf;
      this.pickOpen = this.pickOpen === k ? '' : k;
      this.host.audio.playUi('folder');
      this.renderSong();
      b.blur();
      this.body.querySelector(`[data-pf="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (a === 'pick') {
      this.picking = (await listSongs()).filter((s) => s.courses.length);
      const fs = new Set(await listFolders().catch(() => [] as string[]));
      for (const x of this.picking) for (const f of x.folders) fs.add(f);
      this.pickFolders = [...fs];
      this.renderSong();
      return;
    }
    if (a === 'pickClose') { this.picking = null; this.renderSong(); return; }
    if (b.dataset.pick) { await this.chooseSong(b.dataset.pick, b.dataset.course!); return; }
    if (a === 'start') { this.client?.send({ t: 'start' }); return; }
    if (a === 'watch') { this.client?.send({ t: 'watch' }); return; }
    if (a === 'resClose') { this.results = null; this.render(); return; }
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
    this.transfer = null;
    this.picking = null;
    this.results = null;
    this.waiting = false;
    this.chatLog = [];
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
    this.render();
  }

  private bind(c: OnlineClient) {
    c.on = {
      roster: (r) => {
        const songChanged = r.song?.key !== this.roster?.song?.key;
        this.roster = r;
        if (songChanged && !r.song) this.song = null;
        // プレイ中に抜けた人
        for (const [p, o] of this.opponents) if (!r.players.some((x) => x.p === p) && !o.status) o.status = 'lost';
        if (this.view === 'room') {
          if (this.body.querySelector('#olPlayers')) {
            this.body.querySelector('.ol-players h3 small')!.textContent = `${r.players.length} / 4`;
            this.renderPlayers();
            if (!this.picking) this.renderSong();
          } else this.render();
        }
      },
      songMeta: (meta) => {
        this.song = null;
        this.transfer = meta.size > 0 ? { label: '曲を受け取っています', ratio: 0 } : null;
        this.renderSong();
      },
      songProgress: (ratio) => {
        if (!this.transfer) return;
        this.transfer.ratio = ratio;
        const el = this.body.querySelector<HTMLElement>('.ol-prog');
        if (el) {
          el.querySelector('span')!.textContent = `${this.transfer.label} ${Math.round(ratio * 100)}%`;
          el.querySelector<HTMLElement>('i')!.style.width = `${(ratio * 100).toFixed(1)}%`;
        } else this.renderSong();
      },
      songReady: (meta, bytes) => void this.receiveSong(meta, bytes),
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
      results: (list) => {
        this.results = list;
        this.waiting = false;
        if (!this.playingNow && this.view === 'room') this.render();
      },
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
      error: (msg) => this.host.toast(msg),
      closed: (reason) => {
        if (this.client !== c) return;
        this.leaveRoom(reason);
      },
    };
  }

  /** 部屋主: 曲を選んで、部屋の全員へ送る */
  private async chooseSong(id: string, courseName: string) {
    const c = this.client;
    if (!c) return;
    const data = await loadSongData(id);
    if (!data?.chart) { this.host.toast('譜面を読み込めませんでした'); return; }
    const a = await loadSongAudio(id);
    const tja = writeTJA(data.chart);
    // 部屋主も、ほかの人と同じく TJA から読み直した譜面で遊ぶ（音符の番号がそろうように）
    const chart = parseTJA(tja);
    const course = chart.courses.find((x) => x.name === courseName);
    if (!course) { this.host.toast('その難易度がありません'); return; }
    const meta: SongMeta = {
      key: `${id}:${courseName}:${Date.now().toString(36)}`,
      title: chart.title || '（無題）',
      subtitle: chart.subtitle ?? '',
      course: courseName,
      level: course.level,
      tja,
      size: a?.data.byteLength ?? 0,
      audioName: a?.name ?? '',
    };
    this.picking = null;
    try {
      await this.host.audio.loadMusic(a ? a.data.slice(0) : null);
    } catch {
      this.host.toast('音源を読み込めませんでした');
    }
    this.song = { meta, chart };
    this.transfer = a ? { label: '曲を送っています', ratio: 0 } : null;
    this.renderSong();
    try {
      await c.sendSong(meta, a ? a.data : null, (r) => {
        if (!this.transfer) return;
        this.transfer.ratio = r;
        const el = this.body.querySelector<HTMLElement>('.ol-prog');
        if (el) {
          el.querySelector('span')!.textContent = `${this.transfer.label} ${Math.round(r * 100)}%`;
          el.querySelector<HTMLElement>('i')!.style.width = `${(r * 100).toFixed(1)}%`;
        }
      });
    } catch (err) {
      this.host.toast((err as Error).message);
    }
    this.transfer = null;
    this.renderSong();
  }

  /** 部屋主以外: 届いた曲を読み込む */
  private async receiveSong(meta: SongMeta, bytes: Uint8Array | null) {
    this.transfer = null;
    try {
      const chart = parseTJA(meta.tja);
      if (!chart.courses.some((x) => x.name === meta.course)) throw new Error('course');
      const ab = bytes ? (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)) : null;
      await this.host.audio.loadMusic(ab);
      this.song = { meta, chart };
      this.client?.send({ t: 'have', key: meta.key });
    } catch {
      this.host.toast('届いた曲を読み込めませんでした');
      this.song = null;
    }
    this.renderSong();
  }

  /** オンラインで遊んだ記録を、自分の曲の一覧の同じ曲に残す（部屋主は選んだ曲、ほかの人は同じ曲名の曲があれば） */
  private async record(meta: SongMeta, score: number, crown: Crown) {
    try {
      const songs = await listSongs();
      const hostId = meta.key.split(':').slice(0, -2).join(':');
      let s = songs.find((x) => x.id === hostId && x.courses.some((c) => c.name === meta.course));
      if (!s) {
        const same = songs.filter((x) => x.title === meta.title && (x.subtitle ?? '') === meta.subtitle && x.courses.some((c) => c.name === meta.course));
        if (same.length === 1) s = same[0];
      }
      if (s) saveBest(s.id, meta.course, score, crown);
    } catch { /* 残せない */ }
  }

  /** 全員同時にスタート */
  private async startGame(zero: number, key: string, players: (Partial<WatchPlayer> & { p: string; name: string })[], spectate = false) {
    const c = this.client;
    if (!c || !this.song || this.song.meta.key !== key) {
      this.host.toast(spectate ? '曲を受け取ってから観戦できます' : '曲が届いていないので、今回は見学です');
      // 遊べないことをサーバーに伝える（ほかの人がいつまでも待たないように）
      if (!spectate) c?.send({ t: 'quit' });
      return;
    }
    const { meta, chart } = this.song;
    const ec = chart.courses.find((x) => x.name === meta.course)!;
    const course = toPlayable(chart, ec);
    this.results = null;
    this.waiting = false;
    this.opponents.clear();
    const opps: Opponent[] = [];
    for (const p of players) {
      if (p.p === c.me) continue;
      const o: Opponent = { id: p.p, name: p.name, score: p.s ?? 0, combo: p.c ?? 0, gauge: p.g ?? 0, good: 0, ok: 0, bad: 0, marks: new Uint8Array(course.notes.length), fx: null, status: p.status ?? '' };
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
    this.hide();
    try {
    await this.host.play.startOnline(course, { title: meta.title, course: meta.course, level: meta.level }, c.toPerf(zero), {
      send: (m) => { if (!spectate) c.send(m); },
      opponents: opps,
      spectate,
      onFinish: (stats) => {
        this.playingNow = false;
        if (!spectate) {
          const { crown, ...r } = stats;
          c.send({ t: 'fin', r });
          if (crown) void this.record(meta, r.score, crown);
        }
        this.waiting = !this.results && (!spectate || this.roster?.phase === 'play');
        this.open();
      },
      onQuit: () => {
        this.playingNow = false;
        if (!spectate) c.send({ t: 'quit' });
        this.waiting = false;
        this.open();
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
}

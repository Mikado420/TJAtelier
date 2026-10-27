/**
 * オンライン作業の部屋をさがす・作る画面（オンライン対戦の部屋の一覧とは別）。
 *
 * - 自分の部屋（入ったことのある部屋）: タップですぐ入る（あいことばは要らない）
 * - 公開の部屋: タップするとあいことばを聞く（見学できる部屋は「見学する」も）
 * - 部屋番号で探すと、一覧に出さない部屋も見つかる
 * - 部屋を作る: 曲を選び、部屋の名前・あいことば・一覧に出さない・見学を決める
 */
import { ROOM_DAYS, type RoomInfo, type RoomSettings } from './protocol';
import { fetchRooms, forgetJoined, joinedList, type JoinOpts } from './session';

export interface LobbyHost {
  toast(msg: string): void;
  /** 部屋を作るときに選べる曲 */
  songs(): Promise<{ id: string; title: string; subtitle: string }[]>;
  enter(id: string, join: JoinOpts): void;
  create(songId: string, room: RoomSettings): void;
  /** 閉じた（ホームを出し直す） */
  closed(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COURSE_SHORT: Record<string, string> = { Easy: 'か', Normal: 'ふ', Hard: 'む', Oni: 'お', Edit: 'う' };
const ago = (t: number) => {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m} 分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 時間前`;
  return `${Math.floor(h / 24)} 日前`;
};

type View = { k: 'list' } | { k: 'join'; room: RoomInfo } | { k: 'create'; song?: string };

export class CollabLobby {
  private el: HTMLElement;
  private view: View = { k: 'list' };
  private mine: RoomInfo[] = [];
  /** 自分の一覧にあるのに見つからなかった部屋（消えた） */
  private gone: string[] = [];
  private pub: RoomInfo[] = [];
  private found: RoomInfo[] = [];
  private query = '';
  private loading = false;
  private songList: { id: string; title: string; subtitle: string }[] = [];

  constructor(private h: LobbyHost) {
    this.el = document.createElement('div');
    this.el.id = 'clobby';
    this.el.className = 'sheet cpanel clobby hidden';
    (document.getElementById('root') ?? document.body).appendChild(this.el);
    this.el.addEventListener('click', (e) => void this.onClick(e));
    this.el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.id !== 'clQuery') return;
      this.query = t.value;
      this.renderLists();
      void this.searchId();
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.id !== 'clSong') return;
      const name = this.el.querySelector<HTMLInputElement>('#clName');
      const song = this.songList.find((x) => x.id === t.value);
      if (name && song) name.value = song.title;
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      const t = e.target as HTMLElement;
      if (t.id === 'clPass') this.join(false);
    });
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  /** 開く（createFor を渡すと、その曲で部屋を作る画面） */
  async open(opts: { createFor?: string; retry?: string; msg?: string } = {}) {
    this.el.classList.remove('hidden');
    this.view = opts.createFor ? { k: 'create', song: opts.createFor } : { k: 'list' };
    if (opts.msg) this.h.toast(opts.msg);
    this.render();
    if (opts.createFor) {
      this.songList = await this.h.songs();
      this.render();
      return;
    }
    await this.refresh();
    // あいことばが違ったとき: その部屋のあいことばを聞き直す
    if (opts.retry) {
      const r = [...this.mine, ...this.pub].find((x) => x.id === opts.retry) ?? (await fetchRooms([opts.retry]).catch(() => []))[0];
      if (r) {
        this.view = { k: 'join', room: r };
        this.render();
      }
    }
  }

  close() {
    this.el.classList.add('hidden');
    this.el.innerHTML = '';
  }

  private async refresh() {
    this.loading = true;
    this.renderLists();
    const ids = joinedList().map((p) => p.id);
    try {
      const [mine, pub] = await Promise.all([ids.length ? fetchRooms(ids) : Promise.resolve([]), fetchRooms()]);
      this.mine = ids.map((id) => mine.find((r) => r.id === id)).filter((r): r is RoomInfo => !!r);
      this.gone = ids.filter((id) => !mine.some((r) => r.id === id));
      this.pub = pub.filter((r) => !ids.includes(r.id));
    } catch {
      this.h.toast('部屋の一覧を読み込めませんでした（つながっていないかもしれません）');
    }
    this.loading = false;
    this.renderLists();
  }

  /** 部屋番号らしい文字なら、一覧に出さない部屋も探す */
  private searchSeq = 0;
  private async searchId() {
    const q = this.query.trim().toUpperCase();
    const seq = ++this.searchSeq;
    if (!/^[A-Z0-9]{6,10}$/.test(q) || [...this.mine, ...this.pub].some((r) => r.id === q)) {
      this.found = [];
      return;
    }
    const r = await fetchRooms([q]).catch(() => []);
    if (seq !== this.searchSeq) return;
    this.found = r;
    this.renderLists();
  }

  private render() {
    const v = this.view;
    const title = v.k === 'create' ? '部屋を作る' : v.k === 'join' ? '部屋に入る' : 'オンライン作業';
    this.el.innerHTML = `<div class="sheet-panel"><div class="sheet-head"><div class="sheet-title">${v.k !== 'list' ? '<button data-cl="back" class="icon cp-back" aria-label="戻る">‹</button>' : ''}<h2>${title}</h2></div><div class="cl-hbtns">${v.k === 'list' ? '<button data-cl="reload" class="icon" aria-label="更新">↻</button>' : ''}<button data-cl="close" class="icon" aria-label="閉じる">×</button></div></div><div class="sheet-body">${this.body()}</div></div>`;
    if (v.k === 'list') this.renderLists();
  }

  private body(): string {
    const v = this.view;
    if (v.k === 'list') {
      return `<div class="cl-top"><input id="clQuery" type="search" placeholder="部屋の名前・曲名・リーダー・部屋番号" value="${esc(this.query)}" autocomplete="off"><button data-cl="create" class="cl-new">＋ 部屋を作る</button></div>
        <div id="clLists"></div>
        <p class="note">だれも入らないまま ${ROOM_DAYS} 日たった部屋は消えます。オンライン対戦の部屋はホームの地球儀 →「オンライン対戦」から。</p>`;
    }
    if (v.k === 'join') {
      const r = v.room;
      return `${this.row(r, false)}
        <label class="field"><span>あいことば</span><input id="clPass" type="text" autocomplete="off" enterkeyhint="go"></label>
        <div class="btns"><button data-cl="joinGo">入る</button>${r.watch ? '<button data-cl="watchGo">見学する（見るだけ）</button>' : ''}</div>
        <p class="note">一度入ると、この端末では次からあいことばは要りません。${r.members >= 8 ? '（この部屋は満員です）' : ''}</p>`;
    }
    const songs = this.songList;
    const sel = songs.find((x) => x.id === v.song);
    return `<p class="note">選んだ曲の全部の難易度が本譜面になり、音源もサーバーに置きます。作った人がリーダーです。</p>
      <label class="field"><span>曲</span><select id="clSong">${songs.length ? songs.map((x) => `<option value="${x.id}" ${x.id === v.song ? 'selected' : ''}>${esc(x.title)}</option>`).join('') : '<option value="">読み込み中…</option>'}</select></label>
      <label class="field"><span>部屋の名前</span><input id="clName" type="text" value="${esc(sel?.title ?? '')}" autocomplete="off"></label>
      <label class="field"><span>あいことば</span><input id="clNewPass" type="text" autocomplete="off" placeholder="仲間に伝える言葉"></label>
      <label class="field cp-ck2"><input id="clUnl" type="checkbox"><span>一覧に出さない（部屋番号で探した人だけ）</span></label>
      <label class="field cp-ck2"><input id="clWatch" type="checkbox"><span>見学（あいことばなしで、見るだけで入れる）</span></label>
      <div class="btns"><button data-cl="createGo">作る</button></div>`;
  }

  private row(r: RoomInfo, tap = true) {
    const left = r.online ? '' : `あと約 ${Math.max(0, Math.ceil(ROOM_DAYS - (Date.now() - r.lastActive) / 86400_000))} 日`;
    const cs = r.courses.map(([c, n]) => `<em class="cl-c cd-${c.toLowerCase()}">${COURSE_SHORT[c] ?? c} ${n}</em>`).join('');
    return `<div class="item cl-room" ${tap ? `data-room="${r.id}"` : ''}>
      <div class="grow">
        <b>${esc(r.name || r.title || '（無題）')}</b>${r.unlisted ? ' <small class="cl-tag">一覧に出さない</small>' : ''}${r.watch ? ' <small class="cl-tag">見学できる</small>' : ''}
        <div class="pos">${esc(r.title)} ・ リーダー ${esc(r.leader)} ・ 部屋番号 ${r.id}</div>
        <div class="pos">👥 ${r.online}/${r.members} 人${r.viewers ? `（見学 ${r.viewers}）` : ''} ・ 編集 ${ago(r.updatedAt)}${left ? ` ・ ${left}` : ''}</div>
        ${cs ? `<div class="cl-cs">${cs}</div>` : ''}
      </div>
    </div>`;
  }

  private match(r: RoomInfo) {
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    return `${r.name} ${r.title} ${r.leader} ${r.id}`.toLowerCase().includes(q);
  }

  private renderLists() {
    const box = this.el.querySelector('#clLists');
    if (!box) return;
    const mine = this.mine.filter((r) => this.match(r));
    const pub = this.pub.filter((r) => this.match(r));
    const gone = this.gone.map((id) => joinedList().find((p) => p.id === id)).filter((p) => !!p);
    box.innerHTML = `
      ${this.found.length ? `<h3>部屋番号で見つかった部屋</h3><div class="list">${this.found.map((r) => this.row(r)).join('')}</div>` : ''}
      <h3>自分の部屋（あいことばなしで入れる）</h3>
      <div class="list">${mine.map((r) => this.row(r)).join('') || `<p class="note">${this.loading ? '読み込み中…' : 'まだありません'}</p>`}
        ${gone.map((p) => `<div class="item"><div class="grow">${esc(p!.title)}<div class="pos">${p!.id} ・ 見つかりません（${ROOM_DAYS} 日だれも入らずに消えたかもしれません）</div></div><button data-cl="forget" data-id="${p!.id}">一覧から外す</button></div>`).join('')}
      </div>
      <h3>公開の部屋</h3>
      <div class="list">${pub.map((r) => this.row(r)).join('') || `<p class="note">${this.loading ? '読み込み中…' : this.query ? '見つかりません（一覧に出さない部屋は、部屋番号をそのまま入れると探せます）' : 'いまは公開の部屋がありません'}</p>`}</div>`;
  }

  private join(watch: boolean) {
    if (this.view.k !== 'join') return;
    const r = this.view.room;
    const pass = (this.el.querySelector('#clPass') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!watch && !pass) {
      this.h.toast('あいことばを入れてください');
      return;
    }
    this.close();
    this.h.enter(r.id, watch ? { watch: true } : { pass });
  }

  private async onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t === this.el) return;
    const b = t.closest<HTMLElement>('[data-cl]');
    const room = t.closest<HTMLElement>('[data-room]');
    if (!b && room) {
      const id = room.dataset.room!;
      // 自分の部屋はすぐ入る
      if (joinedList().some((p) => p.id === id)) {
        this.close();
        this.h.enter(id, {});
        return;
      }
      const r = [...this.found, ...this.pub, ...this.mine].find((x) => x.id === id);
      if (r) {
        this.view = { k: 'join', room: r };
        this.render();
        (this.el.querySelector('#clPass') as HTMLInputElement | null)?.focus();
      }
      return;
    }
    if (!b) return;
    switch (b.dataset.cl) {
      case 'close':
        this.close();
        this.h.closed();
        return;
      case 'back':
        this.view = { k: 'list' };
        this.render();
        return;
      case 'reload':
        await this.refresh();
        return;
      case 'forget':
        forgetJoined(b.dataset.id!);
        this.gone = this.gone.filter((x) => x !== b.dataset.id);
        this.renderLists();
        return;
      case 'create':
        this.view = { k: 'create' };
        this.render();
        this.songList = await this.h.songs();
        if (this.view.k === 'create') {
          this.view.song = this.songList[0]?.id;
          this.render();
        }
        return;
      case 'joinGo': this.join(false); return;
      case 'watchGo': this.join(true); return;
      case 'createGo': {
        const v = (id: string) => this.el.querySelector<HTMLInputElement & HTMLSelectElement>(`#${id}`);
        const song = v('clSong')?.value ?? '';
        const pass = v('clNewPass')?.value.trim() ?? '';
        if (!song) { this.h.toast('曲を選んでください'); return; }
        if (!pass) { this.h.toast('あいことばを決めてください'); return; }
        const name = v('clName')?.value.trim() || this.songList.find((x) => x.id === song)?.title || '合作';
        const room = { name: name.slice(0, 40), pass: pass.slice(0, 40), unlisted: !!v('clUnl')?.checked, watch: !!v('clWatch')?.checked };
        this.close();
        this.h.create(song, room);
        return;
      }
    }
  }
}

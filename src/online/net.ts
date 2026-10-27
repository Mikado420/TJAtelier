/**
 * オンライン対戦のサーバー（worker/）とのやりとり。
 * 部屋の一覧・部屋に入る・時計合わせ・曲（譜面と音源）の送り受け・プレイ中の様子の送り受け。
 */

const DEFAULT_SERVER = 'https://tjatelier-online.mikadoo420.workers.dev';

/** つなぐ先（確認用に ?online=http://127.0.0.1:8787 で変えられる） */
export function serverBase() {
  try {
    const q = new URLSearchParams(location.search).get('online');
    if (q) return q.replace(/\/$/, '');
  } catch { /* なし */ }
  return DEFAULT_SERVER;
}

export interface RoomInfo {
  id: string;
  title: string;
  host: string;
  players: number;
  max: number;
  playing: boolean;
  locked: boolean;
  song: string;
}

export interface ChatMsg { p: string; name: string; x: string }

export interface SongMeta {
  key: string;
  title: string;
  subtitle: string;
  course: string;
  level: number;
  tja: string;
  size: number;
  audioName: string;
  /** 音源の中身から作った値（同じ音源を持っている人には送らない） */
  hash: string;
  /** 予約した人の曲の一覧での番号 */
  lib: string;
  /** 背景の動画: ファイル名（無ければ ''）・バイト数（音源と同じなら 0）・中身から作った値・ずれ（秒）・音源と同じファイルか */
  vname: string;
  vsize: number;
  vhash: string;
  voff: number;
  vfromAudio: boolean;
}

export interface RoomSettings { pick: 'host' | 'all' | 'turn' | 'random'; limit: number; auto: boolean }
export interface RosterPlayer { p: string; name: string; ready: boolean; ok: boolean; inGame: boolean; course: string; away: boolean }
export interface QueueItem { qid: string; by: string; byName: string; title: string; subtitle: string; course: string; level: number }
export interface Standing { name: string; total: number; wins: number; plays: number }
export interface Roster {
  host: string;
  players: RosterPlayer[];
  phase: 'wait' | 'play';
  settings: RoomSettings;
  queue: QueueItem[];
  song: { key: string; title: string; subtitle: string; course: string; level: number; by: string; byName: string } | null;
  last: { title: string; by: string } | null;
  /** 自動で始まる時刻（サーバーの時計。0 = カウントダウンしていない） */
  countdown: number;
  standings: Standing[];
}
export interface ResultRow { p: string; name: string; course: string; score: number; good: number; ok: number; bad: number; maxCombo: number; rolls: number }
export interface HistoryRow { title: string; course: string; level: number; at: number; list: ResultRow[] }
/** プレイ中に届くほかの人の様子。j = 新しく判定した音符 [音符の番号, 0 良 / 1 可 / 2 不可] */
/** j: [音符の番号, 0 良 / 1 可 / 2 不可, 判定した曲の時刻（ms。前の版には無い）]、h: 叩いた入力 [曲の時刻（ms）, 0 ドン左 / 1 ドン右 / 2 カッ左 / 3 カッ右] */
export interface PlayState { p: string; s: number; c: number; g: number; j: ([number, number] | [number, number, number])[]; h?: [number, number][] }

export interface WatchPlayer { p: string; name: string; course: string; s: number; c: number; g: number; j: [number, number][]; status: '' | 'fin' | 'quit' | 'lost' }

export interface Handlers {
  roster(r: Roster): void;
  /** 次の曲が決まった（音源を持っていれば have、なければ need を返す） */
  next(meta: SongMeta, by: string): void;
  /** 予約した曲の音源を送ってほしい（予約した人に） */
  upload(key: string, lib: string): void;
  /** 受け取った割合（0〜1） */
  songProgress(ratio: number): void;
  /** 音源を全部受け取った */
  songReady(meta: SongMeta, audio: Uint8Array): void;
  /** 予約した曲の背景の動画を送ってほしい（予約した人に） */
  vupload(key: string, lib: string): void;
  /** 動画を受け取った割合（0〜1） */
  videoProgress(ratio: number): void;
  /** 動画を全部受け取った */
  videoReady(meta: SongMeta, video: Uint8Array): void;
  start(zero: number, key: string, players: { p: string; name: string; course: string }[]): void;
  /** 観戦: 今のプレイの曲の 0 秒の時刻と、参加している人のここまでの様子 */
  watch(zero: number, key: string, players: WatchPlayer[]): void;
  state(s: PlayState): void;
  fin(p: string): void;
  quit(p: string): void;
  results(list: ResultRow[], history: HistoryRow[]): void;
  history(list: HistoryRow[]): void;
  /** 通信が切れて入り直している（ok = 入り直せた） */
  reconnect(state: 'trying' | 'ok'): void;
  chat(m: ChatMsg): void;
  chatlog(list: ChatMsg[]): void;
  error(msg: string): void;
  /** 部屋から出された・切れた */
  closed(reason: string): void;
}

export async function listRooms(): Promise<RoomInfo[]> {
  const r = await fetch(`${serverBase()}/rooms`, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

export async function newRoomId(): Promise<string> {
  const r = await fetch(`${serverBase()}/new`, { cache: 'no-store' });
  return (await r.json()).id;
}

/** 音源を送るときの 1 かけらの大きさ */
const CHUNK = 192 * 1024;

export class OnlineClient {
  private ws: WebSocket | null = null;
  me = '';
  room = { id: '', title: '', locked: false };
  on: Partial<Handlers> = {};
  /** サーバーの時計 − この端末の performance.now()（ms）。Date.now() は飛ぶことがあるので使わない */
  private offset = 0;
  /** 時計合わせの記録（往復の時間とずれ）。往復が速かったものほど正確なので、速い 3 つの真ん中を使う */
  private clockSamples: { rtt: number; off: number }[] = [];
  private syncTimer = 0;
  /** 今のカウントダウンで時計を合わせたか */
  private cdSynced = false;
  private pingTimer = 0;
  private closedByMe = false;
  // 受け取り中の曲
  private meta: SongMeta | null = null;
  private buf: Uint8Array | null = null;
  private got = 0;
  // 受け取り中の背景の動画
  private vbuf: Uint8Array | null = null;
  private vgot = 0;
  /** 送っている曲の通し番号（途中で別の曲に変えたら古いほうを止める） */
  private upSeq = 0;

  /** 入り直すときに使う（部屋・名前・あいことば） */
  private joinArgs: { id: string; name: string; pass: string } | null = null;
  private retrying = false;

  /** 部屋に入る。入れたら解決、だめなら理由のエラー */
  connect(id: string, q: { name: string; create?: boolean; title?: string; pass?: string }): Promise<void> {
    this.joinArgs = { id, name: q.name, pass: q.pass ?? '' };
    const base = serverBase().replace(/^http/, 'ws');
    const p = new URLSearchParams({ name: q.name, create: q.create ? '1' : '0', title: q.title ?? '', pass: q.pass ?? '', cid: clientId() });
    const ws = new WebSocket(`${base}/ws/${id}?${p}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.closedByMe = false;
    return new Promise((resolve, reject) => {
      let hello = false;
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') {
          this.onChunk(e.data as ArrayBuffer);
          return;
        }
        let m: Record<string, unknown>;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'hello') {
          hello = true;
          this.me = String(m.you);
          this.room = m.room as typeof this.room;
          this.startPing();
          resolve();
          return;
        }
        if (m.t === 'denied') {
          reject(new Error(String(m.msg)));
          return;
        }
        this.onMessage(m);
      };
      ws.onclose = (e) => {
        if (this.ws !== ws) return;
        clearInterval(this.pingTimer);
        if (!hello) reject(new Error('つながりませんでした'));
        else if (this.closedByMe) return;
        else if (e.code === 4001) this.on.closed?.('部屋主に退出させられました');
        else if (e.code === 4002) this.on.closed?.('ほかの画面で同じ部屋に入りました');
        else void this.retry();
      };
      ws.onerror = () => { /* onclose で知らせる */ };
    });
  }

  /** 通信が切れたとき: 同じ部屋に入り直す（同じ端末なので元の席に戻る） */
  private async retry() {
    if (this.retrying || !this.joinArgs) return;
    this.retrying = true;
    this.on.reconnect?.('trying');
    const a = this.joinArgs;
    for (const wait of [500, 1500, 3000, 5000, 8000]) {
      await new Promise((r) => setTimeout(r, wait));
      if (this.closedByMe) { this.retrying = false; return; }
      try {
        await this.connect(a.id, { name: a.name, pass: a.pass });
        this.retrying = false;
        this.on.reconnect?.('ok');
        return;
      } catch {
        // もう一度
      }
    }
    this.retrying = false;
    this.on.closed?.('通信が切れました');
  }

  close() {
    this.closedByMe = true;
    clearInterval(this.pingTimer);
    clearInterval(this.syncTimer);
    try { this.ws?.close(1000); } catch { /* 閉じ済み */ }
    this.ws = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(m: object) {
    if (this.connected) this.ws!.send(JSON.stringify(m));
  }

  /** サーバーの今の時刻（ms） */
  serverNow() {
    return performance.now() + this.offset;
  }

  /** サーバーの時刻 t（ms）が、この端末の performance.now() でいつか */
  toPerf(t: number) {
    return t - this.offset;
  }

  /** 今の往復の時間（ms。いちばん速かったもの） */
  get rtt() {
    return this.clockSamples.length ? Math.min(...this.clockSamples.map((x) => x.rtt)) : 0;
  }

  private startPing() {
    this.clockSamples = [];
    this.syncClock();
    clearInterval(this.pingTimer);
    // 4 秒ごとに時計を測り直す（つながっているかの確認も兼ねる）
    this.pingTimer = window.setInterval(() => { if (this.connected) this.send({ t: 'ping', c: performance.now() }); }, 4000);
  }

  /** 時計を細かく合わせる（入ったとき・次の曲が決まったとき・カウントダウンが始まったとき） */
  private syncClock() {
    clearInterval(this.syncTimer);
    let n = 0;
    this.syncTimer = window.setInterval(() => {
      this.send({ t: 'ping', c: performance.now() });
      if (++n >= 10) clearInterval(this.syncTimer);
    }, 80);
  }

  private onMessage(m: Record<string, unknown>) {
    switch (m.t) {
      case 'pong': {
        const c = Number(m.c);
        const now = performance.now();
        const rtt = now - c;
        if (!Number.isFinite(rtt) || rtt < 0 || rtt > 5000) break;
        // 行きと帰りが同じ時間だとして、送ってから返事までの真ん中の時刻にサーバーの時計が m.s だった
        this.clockSamples.push({ rtt, off: Number(m.s) - (c + rtt / 2) });
        if (this.clockSamples.length > 16) this.clockSamples.shift();
        const best = [...this.clockSamples].sort((a, b) => a.rtt - b.rtt).slice(0, 3).map((x) => x.off).sort((a, b) => a - b);
        this.offset = best[Math.floor(best.length / 2)];
        break;
      }
      case 'roster':
        // カウントダウンが始まったら、始まる直前にもう一度時計を合わせる
        if (m.countdown && !this.cdSynced) this.syncClock();
        this.cdSynced = !!m.countdown;
        this.on.roster?.(m as unknown as Roster);
        break;
      case 'next': {
        this.syncClock();
        this.meta = m.meta as SongMeta;
        this.buf = null;
        this.got = 0;
        this.vbuf = null;
        this.vgot = 0;
        this.upSeq++; // 前の曲を送っている途中なら止める
        this.on.next?.(this.meta, String(m.by));
        break;
      }
      case 'upload': this.on.upload?.(String(m.key), String(m.lib ?? '')); break;
      case 'vupload': this.on.vupload?.(String(m.key), String(m.lib ?? '')); break;
      case 'vend':
        if (this.meta && m.key === this.meta.key && this.vbuf && this.vgot === this.meta.vsize) {
          const b = this.vbuf;
          this.vbuf = null;
          this.on.videoReady?.(this.meta, b);
        }
        break;
      case 'songEnd':
        if (this.meta && m.key === this.meta.key && this.buf && this.got === this.meta.size) {
          const b = this.buf;
          this.buf = null; // 受け取った音源は渡したら手放す（メモリを空ける）
          this.on.songReady?.(this.meta, b);
        }
        break;
      case 'start': this.on.start?.(Number(m.zero), String(m.key), m.players as { p: string; name: string; course: string }[]); break;
      case 'st': this.on.state?.(m as unknown as PlayState); break;
      case 'watch': this.on.watch?.(Number(m.zero), String(m.key), m.players as WatchPlayer[]); break;
      case 'fin': this.on.fin?.(String(m.p)); break;
      case 'quit': this.on.quit?.(String(m.p)); break;
      case 'results': this.on.results?.(m.list as ResultRow[], (m.history as HistoryRow[]) ?? []); break;
      case 'history': this.on.history?.((m.list as HistoryRow[]) ?? []); break;
      case 'chat': this.on.chat?.({ p: String(m.p), name: String(m.name ?? ''), x: String(m.x ?? '') }); break;
      case 'chatlog': this.on.chatlog?.(((m.list as ChatMsg[]) ?? []).map((c) => ({ p: String(c.p), name: String(c.name ?? ''), x: String(c.x ?? '') }))); break;
      case 'err': this.on.error?.(String(m.msg)); break;
      case 'kicked': this.closedByMe = true; this.on.closed?.('部屋主に退出させられました'); break;
    }
  }

  private onChunk(data: ArrayBuffer) {
    if (!this.meta) return;
    // 音源を受け取り終えていなければ音源、それから動画（サーバーは音源を送り終えてから動画を流す）
    if (!this.buf || this.got >= this.buf.length) {
      if (!this.vbuf) return;
      const n = Math.min(data.byteLength, this.vbuf.length - this.vgot);
      this.vbuf.set(new Uint8Array(data, 0, n), this.vgot);
      this.vgot += n;
      this.on.videoProgress?.(this.vgot / this.meta.vsize);
      return;
    }
    const n = Math.min(data.byteLength, this.buf.length - this.got);
    this.buf.set(new Uint8Array(data, 0, n), this.got);
    this.got += n;
    this.on.songProgress?.(this.got / this.meta.size);
  }

  /** 今の曲の音源を持っていない: 受け取る準備をして、サーバーに知らせる */
  need(meta: SongMeta) {
    if (this.meta?.key !== meta.key) return;
    this.buf = new Uint8Array(meta.size);
    this.got = 0;
    this.send({ t: 'need', key: meta.key });
  }

  /** 背景の動画を持っていない（欲しい）: 受け取る準備をして、サーバーに知らせる */
  vneed(meta: SongMeta) {
    if (this.meta?.key !== meta.key || !meta.vsize) return;
    this.vbuf = new Uint8Array(meta.vsize);
    this.vgot = 0;
    this.send({ t: 'vneed', key: meta.key });
  }

  /** 予約した人: 今の曲の音源（end = 'songEnd'）・動画（end = 'vend'）を送る（少しずつ。送った割合を progress で知らせる） */
  async sendAudio(key: string, audio: ArrayBuffer, progress?: (r: number) => void, end: 'songEnd' | 'vend' = 'songEnd') {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('つながっていません');
    const seq = ++this.upSeq;
    for (let i = 0; i < audio.byteLength; i += CHUNK) {
      // 送りきれていない分が多いときは待つ（回線が詰まらないように）
      while (ws.bufferedAmount > 2 * 1024 * 1024) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('通信が切れました');
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.ws !== ws || seq !== this.upSeq) return; // 抜けた
      ws.send(audio.slice(i, i + CHUNK));
      progress?.(Math.min(1, (i + CHUNK) / audio.byteLength));
    }
    this.send({ t: end, key });
  }
}

/** この端末の値（入り直したときに同じ人だと分かるように。localStorage に残す） */
export function clientId() {
  const K = 'malody-web:onlineCid';
  try {
    let v = localStorage.getItem(K);
    if (!v) { v = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(K, v); }
    return v;
  } catch {
    return '';
  }
}

/** 音源の中身から作る値（SHA-256 の先頭。同じ音源かどうかを見分ける） */
export async function audioHash(data: ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return `${data.byteLength.toString(36)}-${Array.from(d.slice(0, 12), (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

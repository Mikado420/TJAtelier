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

export interface SongMeta {
  key: string;
  title: string;
  subtitle: string;
  course: string;
  level: number;
  tja: string;
  size: number;
  audioName: string;
}

export interface RosterPlayer { p: string; name: string; ready: boolean; inGame: boolean }
export interface Roster {
  host: string;
  players: RosterPlayer[];
  phase: 'wait' | 'play';
  song: { key: string; title: string; course: string; level: number } | null;
}
export interface ResultRow { p: string; name: string; score: number; good: number; ok: number; bad: number; maxCombo: number; rolls: number }
/** プレイ中に届くほかの人の様子。j = 新しく判定した音符 [音符の番号, 0 良 / 1 可 / 2 不可] */
export interface PlayState { p: string; s: number; c: number; g: number; j: [number, number][] }

export interface WatchPlayer { p: string; name: string; s: number; c: number; g: number; j: [number, number][]; status: '' | 'fin' | 'quit' | 'lost' }

export interface Handlers {
  roster(r: Roster): void;
  /** 曲の受け取りが始まった（部屋主以外） */
  songMeta(meta: SongMeta): void;
  /** 受け取った割合（0〜1） */
  songProgress(ratio: number): void;
  /** 曲を全部受け取った */
  songReady(meta: SongMeta, audio: Uint8Array | null): void;
  start(zero: number, key: string, players: { p: string; name: string }[]): void;
  /** 観戦: 今のプレイの曲の 0 秒の時刻と、参加している人のここまでの様子 */
  watch(zero: number, key: string, players: WatchPlayer[]): void;
  state(s: PlayState): void;
  fin(p: string): void;
  quit(p: string): void;
  results(list: ResultRow[]): void;
  chat(p: string, k: number): void;
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
  /** サーバーの時計 − この端末の時計（ms） */
  private offset = 0;
  private bestRtt = Infinity;
  private pingTimer = 0;
  private closedByMe = false;
  // 受け取り中の曲
  private meta: SongMeta | null = null;
  private buf: Uint8Array | null = null;
  private got = 0;
  /** 送っている曲の通し番号（途中で別の曲に変えたら古いほうを止める） */
  private upSeq = 0;

  /** 部屋に入る。入れたら解決、だめなら理由のエラー */
  connect(id: string, q: { name: string; create?: boolean; title?: string; pass?: string }): Promise<void> {
    const base = serverBase().replace(/^http/, 'ws');
    const p = new URLSearchParams({ name: q.name, create: q.create ? '1' : '0', title: q.title ?? '', pass: q.pass ?? '' });
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
        clearInterval(this.pingTimer);
        if (!hello) reject(new Error('つながりませんでした'));
        else if (!this.closedByMe) this.on.closed?.(e.code === 4001 ? '部屋主に退出させられました' : '通信が切れました');
      };
      ws.onerror = () => { /* onclose で知らせる */ };
    });
  }

  close() {
    this.closedByMe = true;
    clearInterval(this.pingTimer);
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
    return Date.now() + this.offset;
  }

  /** サーバーの時刻 t（ms）が、この端末の performance.now() でいつか */
  toPerf(t: number) {
    return performance.now() + (t - this.serverNow());
  }

  private startPing() {
    this.bestRtt = Infinity;
    let n = 0;
    const ping = () => this.send({ t: 'ping', c: performance.now() });
    // 最初は細かく何度か測って、あとはときどき
    const fast = setInterval(() => {
      ping();
      if (++n >= 8) clearInterval(fast);
    }, 150);
    this.pingTimer = window.setInterval(ping, 4000);
  }

  private onMessage(m: Record<string, unknown>) {
    switch (m.t) {
      case 'pong': {
        const c = Number(m.c);
        const rtt = performance.now() - c;
        // 行きと帰りが同じ時間だとして、返事の真ん中の時刻のサーバーの時計で合わせる（いちばん速かった返事を使う）
        if (rtt <= this.bestRtt * 1.2 || rtt < 60) {
          if (rtt < this.bestRtt) this.bestRtt = rtt;
          const local = Date.now() - rtt / 2;
          this.offset = Number(m.s) - local;
        }
        break;
      }
      case 'roster': this.on.roster?.(m as unknown as Roster); break;
      case 'song': {
        const meta = m.meta as SongMeta;
        if (m.from === this.me) break;
        this.meta = meta;
        this.buf = meta.size > 0 ? new Uint8Array(meta.size) : null;
        this.got = 0;
        this.on.songMeta?.(meta);
        break;
      }
      case 'songEnd':
        if (this.meta && m.key === this.meta.key && this.got === this.meta.size) {
          this.on.songReady?.(this.meta, this.buf);
        }
        break;
      case 'start': this.on.start?.(Number(m.zero), String(m.key), m.players as { p: string; name: string }[]); break;
      case 'st': this.on.state?.(m as unknown as PlayState); break;
      case 'watch': this.on.watch?.(Number(m.zero), String(m.key), m.players as WatchPlayer[]); break;
      case 'fin': this.on.fin?.(String(m.p)); break;
      case 'quit': this.on.quit?.(String(m.p)); break;
      case 'results': this.on.results?.(m.list as ResultRow[]); break;
      case 'chat': this.on.chat?.(String(m.p), Number(m.k)); break;
      case 'err': this.on.error?.(String(m.msg)); break;
      case 'kicked': this.closedByMe = true; this.on.closed?.('部屋主に退出させられました'); break;
    }
  }

  private onChunk(data: ArrayBuffer) {
    if (!this.meta || !this.buf) return;
    const n = Math.min(data.byteLength, this.buf.length - this.got);
    this.buf.set(new Uint8Array(data, 0, n), this.got);
    this.got += n;
    this.on.songProgress?.(this.got / this.meta.size);
  }

  /** 部屋主: 曲を送る（音源は少しずつ。送った割合を progress で知らせる） */
  async sendSong(meta: SongMeta, audio: ArrayBuffer | null, progress?: (r: number) => void) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('つながっていません');
    const seq = ++this.upSeq;
    this.send({ t: 'song', meta: { ...meta, size: audio ? audio.byteLength : 0 } });
    if (!audio) return;
    for (let i = 0; i < audio.byteLength; i += CHUNK) {
      // 送りきれていない分が多いときは待つ（回線が詰まらないように）
      while (ws.bufferedAmount > 2 * 1024 * 1024) {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('通信が切れました');
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.ws !== ws || seq !== this.upSeq) return; // 別の曲に変えた・抜けた
      ws.send(audio.slice(i, i + CHUNK));
      progress?.(Math.min(1, (i + CHUNK) / audio.byteLength));
    }
    this.send({ t: 'songEnd' });
  }
}

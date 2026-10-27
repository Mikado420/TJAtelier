/**
 * 合作プロジェクトにつながっている間の状態（サーバーとのやりとり・手元のプロジェクト・送っていない変更）。
 *
 * - 自分の変更は手元にすぐ当て、サーバーに送る。サーバーから「受け取った」が届くまで pending に残す
 * - 切れている間の変更もためておき、つながったら送り直す（変更は「その値にする」だけなので、送り直しても大丈夫）
 * - ほかの人の変更が届いたら当てる。まだ送っている途中の自分の変更と同じ所なら、自分の変更を当て直す
 *   （サーバーには自分の変更が後で届くので、最後は自分の値になる）
 * - プロジェクトと送っていない変更は端末にも保存し、オフラインでも開いて編集できる
 */
import { serverBase } from '../online/net';
import { applyOp, type CollabDoc, type Lane, type Member, type Op, type RoomInfo, type RoomSettings } from './protocol';

export interface ChatMsg {
  id: string;
  by: string;
  x: string;
  ts: number;
  at?: { l: string; tick: number };
  sys?: boolean;
  re?: Record<string, string[]>;
}

export interface VerInfo { id: string; name: string; by: string; at: number; auto: boolean }

export interface CollabLink { id: string }

/** 入り方: あいことば・見学・作る（部屋の設定） */
export interface JoinOpts { pass?: string; watch?: boolean; create?: RoomSettings }

export type Status = 'connecting' | 'online' | 'offline' | 'denied';

export interface SessionEvents {
  /** プロジェクトを最初から受け取り直した（入った・入り直した・版を戻した） */
  reset(): void;
  /** レーンの中身が変わった（ほかの人の変更・自分の変更が断られて戻った） */
  lanes(ids: Set<string>, by: string): void;
  /** 曲の情報が変わった */
  meta(): void;
  /** レーンが増えた・消えた・本譜面が変わった */
  laneList(): void;
  members(): void;
  online(): void;
  chat(m: ChatMsg | null): void;
  cursor(by: string, l: string, tick: number, play: boolean): void;
  playall(m: { by: string; at: number; from: number; mode: string; lanes: string[] }): void;
  stopall(by: string): void;
  trash(): void;
  vers(list: VerInfo[]): void;
  status(s: Status, msg?: string): void;
  room(): void;
  error(msg: string): void;
  rejected(n: number): void;
  kicked(): void;
}

interface Pending { c: number; ops: Op[] }

/** 1 つの変更が触る所（同じ所かどうかを見分ける） */
function opKey(op: Op): string {
  switch (op.o) {
    case 'n': case 'e': case 'g': return `${op.o}:${op.l}:${op.k}`;
    case 'h': case 'lm': case 'rep': return `${op.o}:${op.l}`;
    case 'new': return `new:${op.lane.id}`;
    case 'm': return 'm';
  }
}
const opLane = (op: Op): string | null => (op.o === 'm' ? null : op.o === 'new' ? op.lane.id : op.l);

// ───── 端末に保存（IndexedDB） ─────

const DB = 'tjatelier-collab';
function db(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('p');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbGet<T>(k: string): Promise<T | undefined> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const q = d.transaction('p').objectStore('p').get(k);
      q.onsuccess = () => res(q.result as T);
      q.onerror = () => res(undefined);
    });
  } catch {
    return undefined;
  }
}
export async function idbPut(k: string, v: unknown) {
  try {
    const d = await db();
    await new Promise<void>((res) => {
      const t = d.transaction('p', 'readwrite');
      t.objectStore('p').put(v, k);
      t.oncomplete = () => res();
      t.onerror = () => res();
    });
  } catch { /* 保存できない環境 */ }
}
export async function idbDel(k: string) {
  try {
    const d = await db();
    d.transaction('p', 'readwrite').objectStore('p').delete(k);
  } catch { /* 無視 */ }
}

/** 参加しているプロジェクトの一覧（ホームに出す） */
export interface JoinedProject { id: string; title: string; role: 'edit' | 'view'; at: number }
const LIST_KEY = 'malody-web:collabList';
export function joinedList(): JoinedProject[] {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY) ?? '[]');
  } catch {
    return [];
  }
}
export function rememberJoined(p: JoinedProject) {
  const list = joinedList().filter((x) => x.id !== p.id);
  list.unshift(p);
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list.slice(0, 50))); } catch { /* 無視 */ }
}
export function forgetJoined(id: string) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(joinedList().filter((x) => x.id !== id))); } catch { /* 無視 */ }
  void idbDel(`doc:${id}`);
}

/** 合作用の端末の値（オンライン対戦とは別。プロジェクトのメンバーを見分ける） */
export function collabCid() {
  const K = 'malody-web:collabCid';
  try {
    let v = localStorage.getItem(K);
    if (!v) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      v = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(K, v);
    }
    return v;
  } catch {
    return '';
  }
}

export class CollabSession {
  doc: CollabDoc | null = null;
  me = '';
  role: 'edit' | 'view' = 'edit';
  /** 見るだけのリンクの鍵（編集できる人にだけ届く） */
  /** 部屋の設定（あいことばはメンバーにだけ届く） */
  room: RoomSettings = { name: '', pass: '', unlisted: false, watch: false };
  /** 最後にだれかが入った・出た時刻 */
  lastActive = 0;
  status: Status = 'connecting';
  chat: ChatMsg[] = [];
  chatAll = 0;
  online: { ids: string[]; viewers: number } = { ids: [], viewers: 0 };
  vers: VerInfo[] = [];
  /** サーバーの時計 − この端末の時計（ms） */
  clockOffset = 0;
  private bestRtt = Infinity;
  private pending: Pending[] = [];
  private seq = 1;
  private ws: WebSocket | null = null;
  private closed = false;
  private retry = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  private flushTimer = 0;
  private saveTimer = 0;
  private loading: CollabDoc | null = null;
  private on: Partial<SessionEvents> = {};

  constructor(readonly link: CollabLink, private profile: { name: string; color: string }, private join: JoinOpts = {}) {}

  handlers(h: Partial<SessionEvents>) {
    this.on = h;
  }

  get pendingCount() {
    return this.pending.reduce((a, p) => a + p.ops.length, 0);
  }

  get myMember(): Member | undefined {
    return this.doc?.members[this.me];
  }

  /** 端末に保存したプロジェクトから開く（オフラインでも開けるように） */
  async loadCache(): Promise<boolean> {
    const c = await idbGet<{ doc: CollabDoc; me: string; role: 'edit' | 'view'; pending: Pending[]; chat: ChatMsg[]; room?: RoomSettings }>(`doc:${this.link.id}`);
    if (!c?.doc) return false;
    this.doc = c.doc;
    this.doc.groups ??= {};
    if (c.room) this.room = c.room;
    this.me = c.me;
    this.role = c.role;
    this.pending = c.pending ?? [];
    this.chat = c.chat ?? [];
    this.seq = Math.max(1, ...this.pending.map((p) => p.c + 1));
    return true;
  }

  private saveCache() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      if (!this.doc || !this.me) return;
      void idbPut(`doc:${this.link.id}`, { doc: this.doc, me: this.me, role: this.role, pending: this.pending, chat: this.chat.slice(-200), room: this.room });
    }, 800);
  }

  connect() {
    this.closed = false;
    clearTimeout(this.retryTimer);
    const base = serverBase().replace(/^http/, 'ws');
    const q = new URLSearchParams({ cid: collabCid(), name: this.profile.name, color: this.profile.color });
    const j = this.join;
    if (j.pass) q.set('pass', j.pass);
    if (j.watch) q.set('watch', '1');
    if (j.create) {
      q.set('create', '1');
      q.set('pass', j.create.pass);
      q.set('rname', j.create.name);
      if (j.create.unlisted) q.set('unlisted', '1');
      if (j.create.watch) q.set('rwatch', '1');
    }
    this.setStatus('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}/collab/ws/${this.link.id}?${q}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data === 'pong') return;
      try {
        this.handle(JSON.parse(e.data));
      } catch (err) {
        console.error(err);
      }
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      if (this.closed || this.status === 'denied') return;
      if (e.code === 4004) return;
      this.setStatus('offline');
      this.scheduleRetry();
    };
    ws.onerror = () => { /* onclose で入り直す */ };
  }

  private scheduleRetry() {
    clearTimeout(this.retryTimer);
    const wait = Math.min(15000, 1000 * 2 ** this.retry++);
    this.retryTimer = window.setTimeout(() => this.connect(), wait);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.flushTimer);
    this.saveCache();
    try { this.ws?.close(1000, 'bye'); } catch { /* 閉じ済み */ }
    this.ws = null;
  }

  private setStatus(s: Status, msg?: string) {
    this.status = s;
    this.on.status?.(s, msg);
  }

  private raw(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** サーバーの今の時刻（ms） */
  serverNow() {
    return Date.now() + this.clockOffset;
  }

  private ping() {
    this.raw({ t: 'ping', c: Date.now() });
  }

  private handle(m: Record<string, any>) {
    switch (m.t) {
      case 'denied':
        this.setStatus('denied', m.msg);
        return;
      case 'kicked':
        this.closed = true;
        this.on.kicked?.();
        return;
      case 'hello':
        this.me = m.you;
        this.role = m.role;
        if (m.room) this.room = m.room;
        this.lastActive = m.lastActive ?? 0;
        this.loading = m.doc;
        this.chat = m.chat;
        this.chatAll = m.chatAll;
        this.online = m.online;
        this.retry = 0;
        // 一度入ったら、次からはあいことばは要らない（見学は見学のまま）
        this.join = { watch: m.role === 'view' };
        if (m.room) this.on.room?.();
        this.ping();
        clearInterval(this.pingTimer);
        this.pingTimer = window.setInterval(() => this.ping(), 20000);
        for (let i = 1; i <= 3; i++) setTimeout(() => this.ping(), i * 400);
        return;
      case 'lane':
        if (this.loading) {
          this.loading.lanes[m.lane.id] = m.lane;
        } else if (this.doc) {
          const isNew = !this.doc.lanes[m.lane.id];
          const mainChanged = this.doc.lanes[m.lane.id]?.main !== m.lane.main;
          this.doc.lanes[m.lane.id] = m.lane;
          this.reapply(new Set([m.lane.id]));
          this.on.lanes?.(new Set([m.lane.id]), '');
          if (isNew || mainChanged) this.on.laneList?.();
          this.saveCache();
        }
        return;
      case 'ready': {
        if (!this.loading) return;
        this.doc = this.loading;
        this.loading = null;
        // 送っていない自分の変更を当て直して、送り直す
        for (const p of this.pending) for (const op of p.ops) applyOp(this.doc, op);
        this.setStatus('online');
        this.on.reset?.();
        this.on.chat?.(null);
        this.on.online?.();
        for (const p of this.pending) this.raw({ t: 'ops', c: p.c, ops: p.ops });
        this.sent = Math.max(this.sent, ...this.pending.map((p) => p.c));
        this.saveCache();
        return;
      }
      case 'pong': {
        const rtt = Date.now() - Number(m.c);
        if (rtt <= this.bestRtt * 1.5 || rtt < 150) {
          this.bestRtt = Math.min(this.bestRtt, rtt);
          this.clockOffset = Number(m.s) + rtt / 2 - Date.now();
        }
        return;
      }
      case 'ack': {
        const i = this.pending.findIndex((p) => p.c === m.c);
        if (i >= 0) this.pending.splice(i, 1);
        const n = m.rej === 'all' ? 1 : (m.rej as number[]).length;
        if (n) this.on.rejected?.(n);
        this.saveCache();
        return;
      }
      case 'lanes': {
        // 断られた変更があったレーンの、正しい中身
        if (!this.doc) return;
        const ids = new Set<string>();
        for (const [id, lane] of Object.entries(m.lanes as Record<string, Lane | null>)) {
          if (lane) this.doc.lanes[id] = lane;
          else delete this.doc.lanes[id];
          ids.add(id);
        }
        this.reapply(ids);
        this.on.lanes?.(ids, '');
        this.on.laneList?.();
        this.saveCache();
        return;
      }
      case 'ops': {
        if (!this.doc) return;
        const ids = new Set<string>();
        let meta = false;
        let list = false;
        const mine = this.pendingKeys();
        for (const op of m.ops as Op[]) {
          applyOp(this.doc, op);
          if (op.o === 'm') meta = true;
          if (op.o === 'new' || op.o === 'lm') list = true;
          const l = opLane(op);
          if (l) ids.add(l);
          // 自分がまだ送っている途中の同じ所は、自分の値に戻す
          if (mine.has(opKey(op)) || op.o === 'rep') this.reapply(new Set(l ? [l] : []), op.o === 'rep' ? undefined : opKey(op));
        }
        if (ids.size) this.on.lanes?.(ids, m.by);
        if (meta) this.on.meta?.();
        if (list) this.on.laneList?.();
        this.saveCache();
        return;
      }
      case 'laneDel':
        if (this.doc) {
          delete this.doc.lanes[m.l];
          this.on.laneList?.();
          this.saveCache();
        }
        return;
      case 'room':
        this.room = m.room;
        this.on.room?.();
        this.saveCache();
        return;
      case 'members':
        if (this.doc) {
          this.doc.members = m.members;
          this.doc.leader = m.leader;
          if (m.groups) this.doc.groups = m.groups;
          this.on.members?.();
          this.saveCache();
        }
        return;
      case 'online':
        this.online = { ids: m.ids, viewers: m.viewers };
        this.on.online?.();
        return;
      case 'trash':
        if (this.doc) {
          this.doc.trash = m.trash;
          this.on.trash?.();
        }
        return;
      case 'chat':
        this.chat.push(m.m);
        this.chatAll++;
        if (this.chat.length > 1000) this.chat.shift();
        this.on.chat?.(m.m);
        this.saveCache();
        return;
      case 'chatOld':
        this.chat = [...m.ms, ...this.chat];
        this.on.chat?.(null);
        return;
      case 'react': {
        const c = this.chat.find((x) => x.id === m.id);
        if (c) c.re = m.re;
        this.on.chat?.(null);
        return;
      }
      case 'cur':
        this.on.cursor?.(m.by, m.l, m.tick, m.play);
        return;
      case 'playall':
        this.on.playall?.(m as never);
        return;
      case 'stopall':
        this.on.stopall?.(m.by);
        return;
      case 'vers':
        this.vers = m.list;
        this.on.vers?.(m.list);
        return;
      case 'trashLane':
        this.trashWait.get(m.id)?.(m.lane);
        this.trashWait.delete(m.id);
        return;
      case 'err':
        this.on.error?.(m.msg);
        return;
    }
  }

  private pendingKeys() {
    const s = new Set<string>();
    for (const p of this.pending) for (const op of p.ops) s.add(opKey(op));
    return s;
  }

  /** 送っている途中の自分の変更を、そのレーン（key を渡したらその所だけ）に当て直す */
  private reapply(lanes: Set<string>, key?: string) {
    if (!this.doc) return;
    for (const p of this.pending) for (const op of p.ops) {
      const l = opLane(op);
      if (key ? opKey(op) === key : l && lanes.has(l)) applyOp(this.doc, op);
    }
  }

  /** 自分の変更（手元にすぐ当てて、少しまとめて送る） */
  apply(ops: Op[]) {
    if (!this.doc || !ops.length || this.role !== 'edit') return;
    for (const op of ops) applyOp(this.doc, op);
    // まとめる（大きいときは分ける）
    let cur: Op[] = [];
    let size = 0;
    const push = () => {
      if (cur.length) this.pending.push({ c: this.seq++, ops: cur });
      cur = [];
      size = 0;
    };
    for (const op of ops) {
      const n = op.o === 'new' || op.o === 'rep' ? JSON.stringify(op).length : 80;
      if (size + n > 400_000) push();
      cur.push(op);
      size += n;
    }
    push();
    this.saveCache();
    clearTimeout(this.flushTimer);
    this.flushTimer = window.setTimeout(() => this.flush(), 60);
  }

  private sent = 0;
  private flush() {
    // まだ送っていないものを送る（受け取りが届くまで pending に残す）
    for (const p of this.pending) if (p.c > this.sent) {
      this.raw({ t: 'ops', c: p.c, ops: p.ops });
      this.sent = p.c;
    }
  }

  cmd(x: string, args: Record<string, unknown> = {}) {
    this.raw({ t: 'cmd', x, ...args });
  }

  sendChat(x: string, at?: { l: string; tick: number }) {
    this.raw({ t: 'chat', x, at });
  }

  react(id: string, e: string) {
    this.raw({ t: 'react', id, e });
  }

  moreChat() {
    if (this.chat.length) this.raw({ t: 'chatMore', before: this.chat[0].id });
  }

  private curAt = 0;
  private curTimer = 0;
  private curLast = '';
  /** 自分の見ている場所を知らせる（1 秒に 4 回まで） */
  cursor(l: string, tick: number, play: boolean) {
    const s = `${l}:${Math.round(tick)}:${play}`;
    if (s === this.curLast) return;
    const send = () => {
      this.curAt = Date.now();
      this.curLast = s;
      this.raw({ t: 'cur', l, tick: Math.round(tick), play });
    };
    clearTimeout(this.curTimer);
    if (Date.now() - this.curAt > 250) send();
    else this.curTimer = window.setTimeout(send, 250);
  }

  playAll(from: number, mode: string, lanes: string[]) {
    this.raw({ t: 'playall', from, mode, lanes });
  }

  stopAll() {
    this.raw({ t: 'stopall' });
  }

  private trashWait = new Map<string, (l: Lane | null) => void>();
  trashLane(id: string): Promise<Lane | null> {
    return new Promise((res) => {
      this.trashWait.set(id, res);
      this.cmd('trashLane', { id });
      setTimeout(() => {
        if (this.trashWait.get(id) === res) {
          this.trashWait.delete(id);
          res(null);
        }
      }, 8000);
    });
  }

  // ───── 音源 ─────

  async uploadAudio(hash: string, data: ArrayBuffer): Promise<boolean> {
    try {
      const r = await fetch(`${serverBase()}/collab/audio/${this.link.id}/${hash}?cid=${encodeURIComponent(collabCid())}`, { method: 'PUT', body: data });
      return r.ok;
    } catch {
      return false;
    }
  }

  async downloadAudio(hash: string): Promise<ArrayBuffer | null> {
    try {
      const r = await fetch(`${serverBase()}/collab/audio/${this.link.id}/${hash}?cid=${encodeURIComponent(collabCid())}`);
      return r.ok ? await r.arrayBuffer() : null;
    } catch {
      return null;
    }
  }
}

/** 部屋の一覧（ids を渡すとその部屋。一覧に出さない部屋も） */
export async function fetchRooms(ids?: string[]): Promise<RoomInfo[]> {
  const q = ids ? `?ids=${ids.map(encodeURIComponent).join(',')}` : '';
  const r = await fetch(`${serverBase()}/collab/rooms${q}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

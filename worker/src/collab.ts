/**
 * 合作プロジェクト 1 つ分の中身（Cloudflare の Durable Object とローカルの確認用サーバーの両方で使う）。
 *
 * - プロジェクト（曲の情報・レーン・メンバー）を持ち、届いた変更を権限で確かめてから当て、ほかの人へ配る
 * - チャット（1000 件まで）・レーンのごみ箱（30 日）・版の記録（10 分ごと＋手動、30 個まで）
 * - 音源はかけらに分けて保存する（R2 は使わない）
 * - 保存は少し待ってまとめて書く（無料の枠の「書いた行数」を節約する）
 * - 部屋の形: あいことばで入る（一度入った端末は次から要らない）・見学（見るだけ）・一覧に出さない
 * - だれも入らないまま 2 週間たった部屋は消す（Durable Object の目覚ましで）
 */
import {
  applyOp, canApply, CHAT_KEEP, COLORS, emptyDoc, MAX_MEMBERS, newCollabId, ROOM_DAYS, TRASH_DAYS,
  type BarRange, type CollabDoc, type Group, type Lane, type Member, type Op, type RoomInfo, type RoomSettings,
} from '../../src/collab/protocol';
import type { Conn } from './core';

export interface CollabStore {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
  /** 全部消す（部屋を片付けるとき） */
  clear(): Promise<void>;
}

/** Map で持つ保存先（テストとローカルのサーバー用） */
export class MemoryStore implements CollabStore {
  m = new Map<string, unknown>();
  async get<T>(k: string) { return this.m.get(k) as T | undefined; }
  async put(e: Record<string, unknown>) { for (const [k, v] of Object.entries(e)) this.m.set(k, structuredClone(v)); }
  async delete(ks: string[]) { for (const k of ks) this.m.delete(k); }
  async clear() { this.m.clear(); }
  async list<T>(prefix: string) {
    const out = new Map<string, T>();
    for (const [k, v] of [...this.m].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (k.startsWith(prefix)) out.set(k, v as T);
    return out;
  }
}

export interface ChatMsg {
  id: string;
  /** 送った人（'' = お知らせ） */
  by: string;
  x: string;
  ts: number;
  /** 📍 場所（レーンと tick） */
  at?: { l: string; tick: number };
  sys?: boolean;
  /** リアクション（絵文字 → 押した人） */
  re?: Record<string, string[]>;
}

export interface VerInfo {
  id: string;
  name: string;
  by: string;
  at: number;
  auto: boolean;
  parts: number;
}

interface Info {
  /** （前の版の招待リンクの鍵。今は使わない） */
  key?: string;
  vkey?: string;
  room: RoomSettings;
  groups: Record<string, Group>;
  /** 最後にだれかが入った・出た時刻（ここから 2 週間で消える） */
  lastActive: number;
  /** 最後に編集した時刻 */
  updatedAt: number;
  /** 端末の値 → メンバーの id（ほかの人には見せない） */
  cids: Record<string, string>;
  meta: CollabDoc['meta'];
  members: CollabDoc['members'];
  leader: string;
  trash: CollabDoc['trash'];
  created: number;
  lastVerAt: number;
  /** 前の版から変わったか */
  changed: boolean;
}

interface Sess {
  mid: string;
  role: 'edit' | 'view';
  rate: number;
  rateAt: number;
  chatAt: number;
}

export interface JoinQuery {
  cid: string;
  name: string;
  color: string;
  /** あいことば（一度入った端末は要らない） */
  pass: string;
  /** 見学で入る */
  watch: boolean;
  /** 作るときだけ: 部屋の設定 */
  create?: RoomSettings;
}

const DAY = 86400_000;
/** 部屋の一覧への知らせを、これより短い間隔では送らない（変わった人数などはすぐ） */
const LOBBY_EVERY = 30_000;

/** 版・音源を保存するときの 1 かけらの大きさ（1 つの値の上限 2MB に収める） */
const PART = 900_000;
const VER_KEEP = 30;
const VER_EVERY = 10 * 60_000;
const SAVE_WAIT = 3000;
const LEAVE_WAIT = 30_000;
const CHAT_SEND = 200;

const clampStr = (s: unknown, n: number) => String(s ?? '').slice(0, n);

export class CollabCore {
  private info: Info | null = null;
  private doc: CollabDoc = emptyDoc();
  private chat: ChatMsg[] = [];
  private vers: VerInfo[] = [];
  private sess = new Map<Conn, Sess>();
  private dirtyLanes = new Set<string>();
  private dirtyInfo = false;
  private dirtyChat = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loaded = false;
  private now: () => number;
  /** 部屋の一覧に知らせる（null = 消えた） */
  onLobby: (info: RoomInfo | { id: string; gone: true }) => void = () => {};
  private lobbyAt = 0;
  private lobbyKey = '';

  constructor(readonly id: string, private store: CollabStore, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  get exists() { return !!this.info; }
  get connections() { return this.sess.size; }
  get lastActive() { return this.info?.lastActive ?? 0; }

  /** だれも入らないまま 2 週間たったか */
  expired(now = this.now()) {
    return !!this.info && !this.sess.size && now - this.info.lastActive >= ROOM_DAYS * DAY;
  }

  /** 部屋を消す（片付け） */
  async destroy() {
    for (const t of this.leaveTimers.values()) clearTimeout(t);
    this.leaveTimers.clear();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.info = null;
    this.doc = emptyDoc();
    this.chat = [];
    this.vers = [];
    await this.store.clear();
    this.onLobby({ id: this.id, gone: true });
  }

  /** 部屋の一覧に出す内容 */
  roomInfo(): RoomInfo | null {
    const info = this.info;
    if (!info) return null;
    const on = this.onlineIds();
    const mains = Object.values(this.doc.lanes).filter((l) => l.main);
    const order = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
    mains.sort((a, b) => order.indexOf(a.course) - order.indexOf(b.course));
    return {
      id: this.id, name: info.room.name, title: this.doc.meta.title, leader: this.doc.members[this.doc.leader]?.name ?? '',
      members: Object.keys(this.doc.members).length, online: on.ids.length, viewers: on.viewers, watch: info.room.watch, unlisted: info.room.unlisted,
      lastActive: info.lastActive, updatedAt: info.updatedAt, courses: mains.map((l) => [l.course, Object.keys(l.notes).length]),
    };
  }

  /** 部屋の一覧に知らせる（人数などが変わったらすぐ、ノーツ数などは少し間をあけて） */
  private pushLobby(force = false) {
    const r = this.roomInfo();
    if (!r) return;
    const key = `${r.name}|${r.title}|${r.leader}|${r.members}|${r.online}|${r.viewers}|${r.watch}|${r.unlisted}`;
    if (!force && key === this.lobbyKey && this.now() - this.lobbyAt < LOBBY_EVERY) return;
    this.lobbyKey = key;
    this.lobbyAt = this.now();
    this.onLobby(r);
  }

  /** 保存してあるプロジェクトを読む */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    const info = await this.store.get<Info>('info');
    if (!info) return;
    // 前の版（招待リンク）のプロジェクト: 部屋の設定を足す
    info.room ??= { name: info.meta.title || '合作', pass: '', unlisted: true, watch: false };
    info.groups ??= {};
    info.lastActive ??= this.now();
    info.updatedAt ??= info.lastActive;
    for (const m of Object.values(info.members)) m.perms.main = m.perms.any;
    this.info = info;
    const lanes = await this.store.list<Lane>('lane:');
    this.doc = { meta: info.meta, members: info.members, leader: info.leader, trash: info.trash, groups: info.groups, lanes: {} };
    for (const l of lanes.values()) this.doc.lanes[l.id] = l;
    this.chat = (await this.store.get<ChatMsg[]>('chat')) ?? [];
    this.vers = (await this.store.get<VerInfo[]>('vers')) ?? [];
    // ごみ箱の古いものを消す
    const old = this.doc.trash.filter((t) => this.now() - t.at > TRASH_DAYS * 86400_000);
    if (old.length) {
      this.doc.trash = this.doc.trash.filter((t) => !old.includes(t));
      await this.store.delete(old.map((t) => `trash:${t.id}`));
      this.dirtyInfo = true;
      this.schedule();
    }
  }

  /** 端末からできること（メンバー = 編集、見学できる部屋なら見るだけ、ほかは入れない） */
  access(cid: string): 'edit' | 'view' | null {
    if (!this.info) return null;
    const mid = cid ? this.info.cids[cid] : undefined;
    if (mid && this.doc.members[mid]) return 'edit';
    return this.info.room.watch ? 'view' : null;
  }

  private send(c: Conn, m: unknown) {
    try { c.send(JSON.stringify(m)); } catch { /* 切れている */ }
  }

  private broadcast(m: unknown, except?: Conn) {
    const s = JSON.stringify(m);
    for (const c of this.sess.keys()) if (c !== except) try { c.send(s); } catch { /* 切れている */ }
  }

  private onlineIds() {
    const ids = new Set<string>();
    let viewers = 0;
    for (const s of this.sess.values()) {
      if (s.role === 'view') viewers++;
      else ids.add(s.mid);
    }
    return { ids: [...ids], viewers };
  }

  private publicMembers() {
    return { members: this.doc.members, leader: this.doc.leader, groups: this.doc.groups };
  }

  /** 部屋の設定（あいことばはメンバーにだけ） */
  private roomFor(role: 'edit' | 'view') {
    const r = this.info!.room;
    return role === 'edit' ? r : { ...r, pass: '' };
  }

  /** 入る。だめなら理由の文字を返す */
  async join(conn: Conn, q: JoinQuery): Promise<{ mid: string; role: 'edit' | 'view' } | string> {
    await this.load();
    const now = this.now();
    const cid = clampStr(q.cid, 64);
    const fresh = !this.info;
    if (!this.info) {
      const r = q.create;
      if (!r) return 'この部屋は見つかりません（番号が違うか、2 週間だれも入らずに消えました）';
      if (!r.pass.trim()) return 'あいことばを決めてください';
      this.info = {
        cids: {}, meta: this.doc.meta, members: this.doc.members, leader: '', trash: this.doc.trash, created: now, lastVerAt: now, changed: false,
        room: { name: clampStr(r.name, 40) || '合作', pass: clampStr(r.pass, 40), unlisted: !!r.unlisted, watch: !!r.watch }, groups: this.doc.groups, lastActive: now, updatedAt: now,
      };
    }
    // メンバーの端末ならそのまま。ちがえば、あいことば（見学なら見学できる部屋か）
    const known = !!cid && !!this.info.cids[cid] && !!this.doc.members[this.info.cids[cid]];
    let role: 'edit' | 'view';
    if (known || fresh) role = 'edit';
    else if (q.watch) {
      if (!this.info.room.watch) return 'この部屋は見学できません';
      role = 'view';
    } else if (q.pass && q.pass === this.info.room.pass) role = 'edit';
    else return q.pass ? 'あいことばが違います' : 'あいことばを入れてください';
    this.info.lastActive = now;
    this.dirtyInfo = true;
    this.schedule();
    let mid: string;
    if (role === 'view') {
      mid = 'v:' + newCollabId(6);
    } else {
      mid = this.info.cids[cid];
      if (!mid || !this.doc.members[mid]) {
        if (!cid) return 'この端末では入れません';
        if (Object.keys(this.doc.members).length >= MAX_MEMBERS) return `この部屋は満員です（${MAX_MEMBERS} 人まで）`;
        mid = newCollabId(8);
        this.info.cids[cid] = mid;
        const used = new Set(Object.values(this.doc.members).map((m) => m.color));
        const color = /^#[0-9a-f]{6}$/i.test(q.color) && !used.has(q.color) ? q.color : COLORS.find((c) => !used.has(c)) ?? COLORS[0];
        this.doc.members[mid] = { id: mid, name: clampStr(q.name, 24) || 'メンバー', color, perms: { main: false, any: false }, viewer: false, lastSeen: now };
        if (!this.doc.leader) {
          this.doc.leader = mid;
          this.doc.members[mid].perms = { main: true, any: true };
        }
      }
      const m = this.doc.members[mid];
      if (q.name) m.name = clampStr(q.name, 24);
      m.lastSeen = now;
      this.dirtyInfo = true;
      this.schedule();
    }
    const wasOnline = role === 'edit' && this.onlineIds().ids.includes(mid);
    this.sess.set(conn, { mid, role, rate: 0, rateAt: now, chatAt: 0 });
    this.hello(conn, mid, role);
    if (role === 'edit') {
      const t = this.leaveTimers.get(mid);
      if (t) {
        // 少し切れていただけ（入り直し）: お知らせは出さない
        clearTimeout(t);
        this.leaveTimers.delete(mid);
      } else if (!wasOnline) {
        this.sys(`${this.doc.members[mid].name} さんが入りました`);
      }
      this.broadcast({ t: 'members', ...this.publicMembers() }, conn);
    }
    this.broadcast({ t: 'online', ...this.onlineIds() });
    this.pushLobby(true);
    return { mid, role };
  }

  /** 眠りから起きたとき、つながったままの相手を戻す */
  attach(conn: Conn, a: { mid: string; role: 'edit' | 'view' }) {
    if (a.role === 'edit' && !this.doc.members[a.mid]) return false;
    this.sess.set(conn, { mid: a.mid, role: a.role, rate: 0, rateAt: this.now(), chatAt: 0 });
    return true;
  }

  private hello(conn: Conn, mid: string, role: 'edit' | 'view') {
    const lanes = Object.values(this.doc.lanes);
    this.send(conn, {
      t: 'hello', you: mid, role, now: this.now(), id: this.id, room: this.roomFor(role), lastActive: this.info?.lastActive,
      doc: { meta: this.doc.meta, members: this.doc.members, leader: this.doc.leader, trash: this.doc.trash, groups: this.doc.groups, lanes: {} },
      lanes: lanes.length, chat: this.chat.slice(-CHAT_SEND), chatAll: this.chat.length, online: this.onlineIds(),
    });
    // レーンは 1 本ずつ送る（1 回に送れる大きさに収める）
    for (const l of lanes) this.send(conn, { t: 'lane', lane: l });
    this.send(conn, { t: 'ready' });
  }

  leave(conn: Conn) {
    const s = this.sess.get(conn);
    if (!s) return;
    this.sess.delete(conn);
    if (this.info) {
      this.info.lastActive = this.now();
      this.dirtyInfo = true;
    }
    this.broadcast({ t: 'online', ...this.onlineIds() });
    this.pushLobby(true);
    if (s.role === 'edit' && !this.onlineIds().ids.includes(s.mid) && !this.leaveTimers.has(s.mid)) {
      const m = this.doc.members[s.mid];
      if (m) {
        m.lastSeen = this.now();
        this.dirtyInfo = true;
      }
      this.leaveTimers.set(s.mid, setTimeout(() => {
        this.leaveTimers.delete(s.mid);
        if (!this.onlineIds().ids.includes(s.mid) && this.doc.members[s.mid]) this.sys(`${this.doc.members[s.mid].name} さんが抜けました`);
        if (!this.sess.size) void this.flush();
      }, LEAVE_WAIT));
    }
    if (!this.sess.size) void this.flush();
  }

  /** お知らせをチャットに出す */
  private sys(x: string) {
    this.pushChat({ id: newCollabId(8), by: '', x, ts: this.now(), sys: true });
  }

  private pushChat(m: ChatMsg) {
    this.chat.push(m);
    if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
    this.dirtyChat = true;
    this.schedule();
    this.broadcast({ t: 'chat', m });
  }

  private changed() {
    if (!this.info) return;
    this.info.changed = true;
    this.info.updatedAt = this.now();
    this.dirtyInfo = true;
    this.pushLobby();
    // 10 分ごとに自動で版を残す
    if (this.now() - this.info.lastVerAt >= VER_EVERY) void this.saveVersion('自動', '', true);
  }

  async message(conn: Conn, data: string | ArrayBuffer) {
    const s = this.sess.get(conn);
    if (!s || typeof data !== 'string') return;
    const now = this.now();
    if (now - s.rateAt > 1000) {
      s.rate = 0;
      s.rateAt = now;
    }
    if (++s.rate > 120) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const edit = s.role === 'edit';
    switch (m.t) {
      case 'ping':
        this.send(conn, { t: 'pong', c: m.c, s: now });
        return;
      case 'ops':
        if (edit) this.ops(conn, s.mid, m.c, m.ops);
        else this.send(conn, { t: 'ack', c: m.c, rej: 'all' });
        return;
      case 'cur':
        this.broadcast({ t: 'cur', by: s.mid, l: clampStr(m.l, 20), tick: Number(m.tick) || 0, play: !!m.play }, conn);
        return;
      case 'chat': {
        if (!edit) return;
        const x = clampStr(m.x, 1000).trim();
        if (!x || now - s.chatAt < 300) return;
        s.chatAt = now;
        const at = m.at && typeof m.at === 'object' ? { l: clampStr((m.at as { l: string }).l, 20), tick: Number((m.at as { tick: number }).tick) || 0 } : undefined;
        this.pushChat({ id: newCollabId(8), by: s.mid, x, ts: now, at });
        return;
      }
      case 'react': {
        if (!edit) return;
        const msg = this.chat.find((c) => c.id === m.id);
        const e = clampStr(m.e, 8);
        if (!msg || !e) return;
        msg.re ??= {};
        const who = msg.re[e] ?? [];
        msg.re[e] = who.includes(s.mid) ? who.filter((x) => x !== s.mid) : [...who, s.mid];
        if (!msg.re[e].length) delete msg.re[e];
        this.dirtyChat = true;
        this.schedule();
        this.broadcast({ t: 'react', id: msg.id, re: msg.re });
        return;
      }
      case 'chatMore': {
        const before = this.chat.findIndex((c) => c.id === m.before);
        const end = before < 0 ? 0 : before;
        this.send(conn, { t: 'chatOld', ms: this.chat.slice(Math.max(0, end - CHAT_SEND), end) });
        return;
      }
      case 'playall':
        // みんなで同時に再生: 少し先の時刻を決めて配る
        this.broadcast({ t: 'playall', by: s.mid, at: now + 1500, from: Number(m.from) || 0, mode: clampStr(m.mode, 20), lanes: Array.isArray(m.lanes) ? m.lanes.slice(0, 20).map((x) => clampStr(x, 20)) : [] });
        return;
      case 'stopall':
        this.broadcast({ t: 'stopall', by: s.mid });
        return;
      case 'cmd':
        if (edit) await this.cmd(conn, s.mid, m);
        else if (m.x === 'vers') this.send(conn, { t: 'vers', list: this.vers });
        return;
    }
  }

  /** 変更をまとめて当てる。だめだったものは、そのレーンの正しい中身を送り返す */
  private ops(conn: Conn, mid: string, c: unknown, list: unknown) {
    if (!Array.isArray(list)) return;
    const ok: Op[] = [];
    const rej: number[] = [];
    const fix = new Set<string>();
    let meta = false;
    list.slice(0, 20000).forEach((raw, i) => {
      const op = raw as Op;
      if (!op || typeof op !== 'object' || typeof op.o !== 'string') return rej.push(i);
      // 足すレーンの持ち主は送った人（本譜面以外）
      if (op.o === 'new' && op.lane && !op.lane.main) op.lane.owner = mid;
      if (op.o === 'new' && op.lane?.main) op.lane.owner = mid;
      if (canApply(this.doc, mid, op) && applyOp(this.doc, op)) {
        ok.push(op);
        if (op.o === 'm') meta = true;
        else this.dirtyLanes.add(op.o === 'new' ? op.lane.id : op.l);
        if (op.o === 'new') this.sys(`${this.doc.members[mid]?.name ?? ''} さんがレーン「${op.lane.name || '無題'}」（${op.lane.course}${op.lane.main ? '・本譜面' : ''}）を足しました`);
      } else {
        rej.push(i);
        if (op.o !== 'm' && op.o !== 'new') fix.add(op.l);
        else if (op.o === 'new' && op.lane?.id) fix.add(op.lane.id);
      }
    });
    if (meta) this.dirtyInfo = true;
    if (ok.length) {
      this.changed();
      this.schedule();
      this.broadcast({ t: 'ops', by: mid, ops: ok }, conn);
    }
    this.send(conn, { t: 'ack', c, rej });
    if (fix.size) {
      const lanes: Record<string, Lane | null> = {};
      for (const l of fix) lanes[l] = this.doc.lanes[l] ?? null;
      this.send(conn, { t: 'lanes', lanes });
    }
  }

  private err(conn: Conn, msg: string) {
    this.send(conn, { t: 'err', msg });
  }

  private async cmd(conn: Conn, mid: string, m: Record<string, unknown>) {
    const leader = mid === this.doc.leader;
    const me = this.doc.members[mid];
    const free = leader || !!me?.perms.any;
    const name = me?.name ?? '';
    switch (m.x) {
      case 'del': {
        // レーンをごみ箱へ（自分のレーン、本譜面はリーダーだけ）
        const lane = this.doc.lanes[String(m.l)];
        if (!lane) return;
        if (lane.main ? !leader : lane.owner !== mid && !leader) return this.err(conn, 'このレーンは消せません');
        await this.toTrash(lane, mid);
        this.sys(`${name} さんがレーン「${lane.name || '無題'}」をごみ箱に入れました`);
        return;
      }
      case 'restore': {
        const t = this.doc.trash.find((x) => x.id === m.id);
        if (!t) return;
        const lane = await this.store.get<Lane>(`trash:${t.id}`);
        if (!lane) return;
        if (lane.main && !leader) return this.err(conn, '本譜面を戻せるのはリーダーだけです');
        if (!lane.main && lane.owner !== mid && !leader) return this.err(conn, 'ほかの人のレーンは戻せません');
        // 同じ難易度の本譜面がもうあるなら、下書きとして戻す
        if (lane.main && Object.values(this.doc.lanes).some((l) => l.main && l.course === lane.course)) {
          lane.main = false;
          lane.owner = mid;
        }
        if (this.doc.lanes[lane.id]) lane.id = newCollabId(8);
        this.doc.lanes[lane.id] = lane;
        this.doc.trash = this.doc.trash.filter((x) => x !== t);
        await this.store.delete([`trash:${t.id}`]);
        this.dirtyLanes.add(lane.id);
        this.dirtyInfo = true;
        this.changed();
        this.schedule();
        this.broadcast({ t: 'lane', lane });
        this.broadcast({ t: 'trash', trash: this.doc.trash });
        this.sys(`${name} さんがレーン「${lane.name || '無題'}」をごみ箱から戻しました`);
        return;
      }
      case 'purge': {
        if (!leader) return;
        const t = this.doc.trash.find((x) => x.id === m.id);
        if (!t) return;
        this.doc.trash = this.doc.trash.filter((x) => x !== t);
        await this.store.delete([`trash:${t.id}`]);
        this.dirtyInfo = true;
        this.schedule();
        this.broadcast({ t: 'trash', trash: this.doc.trash });
        return;
      }
      case 'trashLane': {
        // ごみ箱の中身を見る
        const lane = await this.store.get<Lane>(`trash:${String(m.id)}`);
        this.send(conn, { t: 'trashLane', id: m.id, lane: lane ?? null });
        return;
      }
      case 'adoptAll': {
        // レーンを丸ごと本譜面にする（前の本譜面はごみ箱へ）
        const src = this.doc.lanes[String(m.src)];
        const dst = this.doc.lanes[String(m.dst)];
        if (!src || !dst || !dst.main || src === dst) return;
        if (!free) return this.err(conn, '丸ごと採用には、本譜面を自由に編集できる権限が要ります');
        const old: Lane = structuredClone(dst);
        old.id = newCollabId(8);
        old.main = false;
        old.name = `${dst.name || '本譜面'}（前の版）`;
        await this.toTrash(old, mid, false);
        const op: Op = { o: 'rep', l: dst.id, head: structuredClone(src.head), notes: structuredClone(src.notes), events: structuredClone(src.events), grads: structuredClone(src.grads) };
        applyOp(this.doc, op);
        this.dirtyLanes.add(dst.id);
        this.changed();
        this.schedule();
        this.broadcast({ t: 'lane', lane: dst });
        this.sys(`${name} さんが「${src.name || '無題'}」を ${dst.course} の本譜面に丸ごと採用しました（前の本譜面はごみ箱にあります）`);
        return;
      }
      case 'audioSet': {
        // 音源を変える。切り貼りで頭の位置が変わったら、全部のレーンの OFFSET を同じだけずらす（skip のレーンは送った人が合わせ済み）
        if (!free) return this.err(conn, '音源を変えられるのは、リーダーと本譜面を自由に編集できる人だけです');
        const a = m.audio as { hash?: unknown; name?: unknown; size?: unknown } | null;
        if (a && typeof a.hash !== 'string') return;
        const audio = a ? { hash: String(a.hash), name: clampStr(a.name, 200), size: Number(a.size) || 0 } : null;
        const shift = Number(m.shift) || 0;
        const skip = String(m.skip ?? '');
        const ops: Op[] = [{ o: 'm', v: { audio } }];
        if (shift && Math.abs(shift) < 3600) {
          for (const l of Object.values(this.doc.lanes)) if (l.id !== skip) ops.push({ o: 'h', l: l.id, v: { offset: Math.round((l.head.offset + shift) * 1e6) / 1e6 } });
        }
        for (const op of ops) {
          applyOp(this.doc, op);
          if (op.o === 'h') this.dirtyLanes.add(op.l);
        }
        this.dirtyInfo = true;
        this.changed();
        this.schedule();
        this.broadcast({ t: 'ops', by: mid, ops });
        this.sys(`${name} さんが音源を「${audio?.name ?? 'なし'}」にしました${ops.length > 1 ? '（全部のレーンの OFFSET を合わせました）' : ''}`);
        return;
      }
      case 'adoptNote': {
        // 範囲の採用は変更として届く。ここではお知らせだけ出す
        const src = this.doc.lanes[String(m.src)];
        const dst = this.doc.lanes[String(m.dst)];
        if (!src || !dst) return;
        this.sys(`${name} さんが「${src.name || '無題'}」の ${clampStr(m.range, 40)} を ${dst.course} の本譜面に採用しました`);
        return;
      }
      case 'main': {
        // 下書きを本譜面にする（その難易度に本譜面が無いとき）
        const lane = this.doc.lanes[String(m.l)];
        if (!lane || lane.main || !free) return;
        if (Object.values(this.doc.lanes).some((l) => l.main && l.course === lane.course)) return this.err(conn, 'この難易度にはもう本譜面があります');
        lane.main = true;
        this.dirtyLanes.add(lane.id);
        this.changed();
        this.schedule();
        this.broadcast({ t: 'lane', lane });
        return;
      }
      case 'perm': {
        if (!leader) return;
        const t = this.doc.members[String(m.mid)];
        if (!t || t.id === this.doc.leader) return;
        const any = !!(m.perms as { any?: boolean } | undefined)?.any;
        t.perms = { main: any, any };
        this.membersChanged();
        return;
      }
      case 'groups': {
        // 担当（A・B・C…）をまとめて決め直す（リーダーだけ）
        if (!leader || !m.groups || typeof m.groups !== 'object') return;
        const out: Record<string, Group> = {};
        for (const g of Object.values(m.groups as Record<string, Group>).slice(0, 26)) {
          if (!g || typeof g.id !== 'string') continue;
          const ranges: BarRange[] = (Array.isArray(g.ranges) ? g.ranges : []).slice(0, 50)
            .filter((r) => r && this.doc.lanes[r.lane]?.main)
            .map((r) => ({ lane: String(r.lane), from: Math.max(1, Math.round(Number(r.from)) || 1), to: Math.max(1, Math.round(Number(r.to)) || 1) }))
            .map((r) => (r.to < r.from ? { ...r, from: r.to, to: r.from } : r));
          const members = (Array.isArray(g.members) ? g.members : []).map(String).filter((x) => this.doc.members[x]);
          out[g.id.slice(0, 12)] = { id: g.id.slice(0, 12), name: clampStr(g.name, 20) || '?', color: clampStr(g.color, 20) || COLORS[0], ranges, members };
        }
        this.doc.groups = out;
        this.membersChanged();
        return;
      }
      case 'room': {
        // 部屋の設定（リーダーだけ）。あいことばを変えても、入ったことのある人はそのまま入れる
        if (!leader || !this.info) return;
        const r = this.info.room;
        if (typeof m.name === 'string' && m.name.trim()) r.name = clampStr(m.name.trim(), 40);
        if (typeof m.pass === 'string' && m.pass.trim()) r.pass = clampStr(m.pass.trim(), 40);
        if (typeof m.unlisted === 'boolean') r.unlisted = m.unlisted;
        if (typeof m.watch === 'boolean') r.watch = m.watch;
        // 見学をやめたら、見学の人は出てもらう
        if (!r.watch) for (const [c, x] of this.sess) if (x.role === 'view') {
          this.send(c, { t: 'denied', msg: 'この部屋は見学できなくなりました' });
          this.sess.delete(c);
          c.close(4003, 'denied');
        }
        this.dirtyInfo = true;
        this.schedule();
        for (const [c, x] of this.sess) this.send(c, { t: 'room', room: this.roomFor(x.role) });
        this.broadcast({ t: 'online', ...this.onlineIds() });
        this.pushLobby(true);
        return;
      }
      case 'leader': {
        if (!leader) return;
        const t = this.doc.members[String(m.mid)];
        if (!t || t.id === mid) return;
        this.doc.leader = t.id;
        t.perms = { main: true, any: true };
        this.membersChanged();
        this.sys(`リーダーが ${t.name} さんに変わりました`);
        return;
      }
      case 'kick': {
        if (!leader) return;
        const t = this.doc.members[String(m.mid)];
        if (!t || t.id === mid) return;
        delete this.doc.members[t.id];
        for (const g of Object.values(this.doc.groups)) g.members = g.members.filter((x) => x !== t.id);
        for (const [cid, x] of Object.entries(this.info!.cids)) if (x === t.id) delete this.info!.cids[cid];
        for (const [c, s] of this.sess) if (s.mid === t.id) {
          this.send(c, { t: 'kicked' });
          this.sess.delete(c);
          c.close(4004, 'kicked');
        }
        this.membersChanged();
        this.broadcast({ t: 'online', ...this.onlineIds() });
        this.sys(`${t.name} さんがプロジェクトから外れました`);
        return;
      }
      case 'profile': {
        if (!me) return;
        if (typeof m.name === 'string' && m.name.trim()) me.name = clampStr(m.name.trim(), 24);
        if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) me.color = m.color;
        this.membersChanged();
        return;
      }
      case 'vers':
        this.send(conn, { t: 'vers', list: this.vers });
        return;
      case 'saveVer': {
        await this.saveVersion(clampStr(m.name, 40) || '手動で保存', mid, false);
        return;
      }
      case 'restoreVer': {
        if (!leader) return this.err(conn, '版を戻せるのはリーダーだけです');
        const v = this.vers.find((x) => x.id === m.id);
        if (!v) return;
        const snap = await this.readVersion(v);
        if (!snap) return this.err(conn, '版を読めませんでした');
        await this.saveVersion(`「${v.name}」に戻す前`, mid, true);
        for (const id of Object.keys(this.doc.lanes)) if (!snap.lanes[id]) await this.store.delete([`lane:${id}`]);
        this.doc.lanes = snap.lanes;
        this.doc.meta = snap.meta;
        this.info!.meta = snap.meta;
        for (const id of Object.keys(snap.lanes)) this.dirtyLanes.add(id);
        this.dirtyInfo = true;
        this.sys(`${name} さんが版「${v.name}」（${new Date(v.at).toISOString().slice(0, 16).replace('T', ' ')}）に戻しました`);
        await this.flush();
        // 全員に最初から送り直す
        for (const [c, s] of this.sess) this.hello(c, s.mid, s.role);
        return;
      }
    }
  }

  private membersChanged() {
    this.dirtyInfo = true;
    this.schedule();
    this.broadcast({ t: 'members', ...this.publicMembers() });
  }

  private async toTrash(lane: Lane, by: string, remove = true) {
    const item = { id: newCollabId(8), name: lane.name || '無題', course: lane.course, by, at: this.now() };
    await this.store.put({ [`trash:${item.id}`]: lane });
    this.doc.trash.push(item);
    if (remove) {
      delete this.doc.lanes[lane.id];
      this.dirtyLanes.delete(lane.id);
      await this.store.delete([`lane:${lane.id}`]);
      // 担当の範囲からも外す
      for (const g of Object.values(this.doc.groups)) g.ranges = g.ranges.filter((r) => r.lane !== lane.id);
      this.broadcast({ t: 'laneDel', l: lane.id });
      this.broadcast({ t: 'members', ...this.publicMembers() });
    }
    this.dirtyInfo = true;
    this.changed();
    this.schedule();
    this.broadcast({ t: 'trash', trash: this.doc.trash });
  }

  // ───── 版 ─────

  private async saveVersion(name: string, by: string, auto: boolean) {
    if (!this.info) return;
    if (auto && !this.info.changed && this.vers.length) return;
    this.info.lastVerAt = this.now();
    this.info.changed = false;
    this.dirtyInfo = true;
    const v: VerInfo = { id: newCollabId(8), name, by, at: this.now(), auto, parts: 0 };
    const s = JSON.stringify({ meta: this.doc.meta, lanes: this.doc.lanes });
    const put: Record<string, unknown> = {};
    for (let i = 0; i < Math.max(1, s.length); i += PART) put[`ver:${v.id}:${v.parts++}`] = s.slice(i, i + PART);
    await this.store.put(put);
    this.vers.push(v);
    // 多すぎたら古いもの（自動のものから）を消す
    while (this.vers.length > VER_KEEP) {
      const i = this.vers.findIndex((x) => x.auto);
      const [gone] = this.vers.splice(i < 0 ? 0 : i, 1);
      await this.store.delete(Array.from({ length: gone.parts }, (_, n) => `ver:${gone.id}:${n}`));
    }
    await this.store.put({ vers: this.vers });
    this.schedule();
    if (!auto) this.sys(`${this.doc.members[by]?.name ?? ''} さんが版「${name}」を残しました`);
    this.broadcast({ t: 'vers', list: this.vers });
  }

  private async readVersion(v: VerInfo): Promise<{ meta: CollabDoc['meta']; lanes: Record<string, Lane> } | null> {
    const parts: string[] = [];
    for (let n = 0; n < v.parts; n++) {
      const p = await this.store.get<string>(`ver:${v.id}:${n}`);
      if (p === undefined) return null;
      parts.push(p);
    }
    try {
      return JSON.parse(parts.join(''));
    } catch {
      return null;
    }
  }

  // ───── 音源 ─────

  /** 音源を保存する（編集できる人だけ）。前の音源は、今の音源でなければ消す */
  async putAudio(cid: string, hash: string, bytes: Uint8Array): Promise<string | null> {
    await this.load();
    if (this.access(cid) !== 'edit') return 'この部屋のメンバーではありません';
    if (!/^[0-9a-z]{4,64}$/i.test(hash)) return '音源の値が違います';
    if (bytes.byteLength > 60_000_000) return '音源が大きすぎます（60MB まで）';
    const old = await this.store.list<{ parts: number }>('audmeta:');
    const put: Record<string, unknown> = {};
    let parts = 0;
    for (let i = 0; i < Math.max(1, bytes.byteLength); i += PART) put[`aud:${hash}:${parts++}`] = bytes.slice(i, i + PART);
    put[`audmeta:${hash}`] = { parts, size: bytes.byteLength };
    const entries = Object.entries(put);
    for (let i = 0; i < entries.length; i += 100) await this.store.put(Object.fromEntries(entries.slice(i, i + 100)));
    // 今使っていない古い音源を消す
    const cur = this.doc.meta.audio?.hash;
    for (const [k, v] of old) {
      const h = k.slice('audmeta:'.length);
      if (h === hash || h === cur) continue;
      await this.store.delete([k, ...Array.from({ length: v.parts }, (_, n) => `aud:${h}:${n}`)]);
    }
    return null;
  }

  async getAudio(cid: string, hash: string): Promise<Uint8Array | string> {
    await this.load();
    if (!this.access(cid)) return 'この部屋のメンバーではありません';
    const meta = await this.store.get<{ parts: number; size: number }>(`audmeta:${hash}`);
    if (!meta) return '音源がありません';
    const out = new Uint8Array(meta.size);
    let at = 0;
    for (let n = 0; n < meta.parts; n++) {
      const p = await this.store.get<Uint8Array | ArrayBuffer>(`aud:${hash}:${n}`);
      if (!p) return '音源の一部がありません';
      const u = p instanceof Uint8Array ? p : new Uint8Array(p);
      out.set(u, at);
      at += u.byteLength;
    }
    return out;
  }

  // ───── 保存 ─────

  private schedule() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_WAIT);
  }

  /** たまった変更を書く */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.info) return;
    const put: Record<string, unknown> = {};
    if (this.dirtyInfo) {
      this.info.meta = this.doc.meta;
      this.info.members = this.doc.members;
      this.info.leader = this.doc.leader;
      this.info.trash = this.doc.trash;
      this.info.groups = this.doc.groups;
      put.info = this.info;
    }
    for (const id of this.dirtyLanes) if (this.doc.lanes[id]) put[`lane:${id}`] = this.doc.lanes[id];
    if (this.dirtyChat) put.chat = this.chat;
    this.dirtyInfo = false;
    this.dirtyChat = false;
    this.dirtyLanes.clear();
    const entries = Object.entries(put);
    for (let i = 0; i < entries.length; i += 100) await this.store.put(Object.fromEntries(entries.slice(i, i + 100)));
    this.pushLobby();
  }

  /** テスト用 */
  get state() {
    return { doc: this.doc, chat: this.chat, vers: this.vers };
  }

  /** メンバーの一覧（テスト・確認用） */
  member(mid: string): Member | undefined {
    return this.doc.members[mid];
  }
}

/** 合作の部屋の一覧（公開の部屋・番号で探す・自分の部屋の様子） */
export class CollabLobbyCore {
  rooms = new Map<string, RoomInfo>();

  update(i: RoomInfo | { id: string; gone: true }) {
    if ('gone' in i) this.rooms.delete(i.id);
    else this.rooms.set(i.id, i);
  }

  /** ids を渡すとその部屋（一覧に出さない部屋も）。無ければ公開の部屋 */
  list(now: number, ids?: string[]): RoomInfo[] {
    const alive = (r: RoomInfo) => r.online > 0 || now - r.lastActive < ROOM_DAYS * DAY;
    for (const r of [...this.rooms.values()]) if (!alive(r)) this.rooms.delete(r.id);
    const all = [...this.rooms.values()];
    const out = ids ? all.filter((r) => ids.includes(r.id)) : all.filter((r) => !r.unlisted);
    return out.sort((a, b) => b.online - a.online || b.updatedAt - a.updatedAt).slice(0, 300);
  }
}

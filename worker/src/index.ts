/**
 * TJAtelier のオンライン対戦サーバー（Cloudflare Workers + Durable Objects）
 *
 * GET  /rooms                 公開している部屋の一覧（JSON）
 * GET  /new                   新しい部屋の番号
 * GET  /ws/:id?name=&create=1&title=&pass=   部屋に入る（WebSocket）
 *
 * 合作（リアルタイム共同編集）:
 * GET  /collab/rooms[?ids=A,B]   部屋の一覧（ids で一覧に出さない部屋も）
 * GET  /collab/ws/:id?cid=&name=&color=&pass=&watch=1&create=1&rname=&unlisted=1&rwatch=1   部屋に入る（WebSocket）
 * GET  /collab/audio/:id/:hash?cid=    共有している音源を受け取る（メンバー・見学できる部屋）
 * PUT  /collab/audio/:id/:hash?cid=    音源を置く（メンバーだけ）
 */
import { DurableObject } from 'cloudflare:workers';
import { LOBBY_STALE_MS, LobbyCore, newRoomId, RoomCore, type Conn, type LobbyInfo, type RoomState } from './core';
import { CollabCore, CollabLobbyCore, type CollabStore } from './collab';
import { ROOM_DAYS, type RoomInfo } from '../../src/collab/protocol';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
  COLLAB: DurableObjectNamespace<Collab>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });

const lobbyStub = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('main'));
/** 合作の部屋の一覧（対戦の一覧とは別） */
const collabLobby = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('collab'));

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/rooms') return json(await lobbyStub(env).list());
    if (url.pathname === '/new') return json({ id: newRoomId() });
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      const stub = env.ROOM.get(env.ROOM.idFromName(m[1]));
      return stub.fetch(req);
    }
    if (url.pathname === '/collab/rooms') {
      const ids = url.searchParams.get('ids');
      return json(await collabLobby(env).collabList(ids ? ids.split(',').slice(0, 100) : undefined));
    }
    const cw = url.pathname.match(/^\/collab\/ws\/([A-Z0-9]{6,10})$/);
    if (cw) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket only', { status: 426 });
      return env.COLLAB.get(env.COLLAB.idFromName(cw[1])).fetch(req);
    }
    const ca = url.pathname.match(/^\/collab\/audio\/([A-Z0-9]{6,10})\/([0-9a-z]{4,64})$/i);
    if (ca && (req.method === 'GET' || req.method === 'PUT')) {
      const res = await env.COLLAB.get(env.COLLAB.idFromName(ca[1])).fetch(req);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    if (url.pathname === '/') return json({ ok: true, name: 'tjatelier-online' });
    return json({ error: 'not found' }, 404);
  },
};

/** 公開している部屋の一覧 */
export class Lobby extends DurableObject<Env> {
  private core = new LobbyCore();
  private loaded = false;

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const saved = await this.ctx.storage.get<LobbyInfo[]>('rooms');
    for (const r of saved ?? []) this.core.rooms.set(r.id, r);
  }

  async list(): Promise<LobbyInfo[]> {
    await this.load();
    return this.core.list();
  }

  async update(info: LobbyInfo | { id: string; gone: true }) {
    await this.load();
    this.core.update(info);
    await this.ctx.storage.put('rooms', [...this.core.rooms.values()]);
  }

  // ───── 合作の部屋の一覧（名前 'collab' の Lobby で使う） ─────
  private collab: CollabLobbyCore | null = null;
  private async loadCollab() {
    if (this.collab) return this.collab;
    const c = new CollabLobbyCore();
    for (const r of (await this.ctx.storage.get<RoomInfo[]>('collabRooms')) ?? []) c.rooms.set(r.id, r);
    this.collab = c;
    return c;
  }

  async collabList(ids?: string[]): Promise<RoomInfo[]> {
    return (await this.loadCollab()).list(Date.now(), ids);
  }

  async collabUpdate(info: RoomInfo | { id: string; gone: true }) {
    const c = await this.loadCollab();
    c.update(info);
    await this.ctx.storage.put('collabRooms', [...c.rooms.values()]);
  }
}

/** 譜面の文字を保存するときの 1 かけらの長さ（1 つの値の上限 2MB に収める） */
const TJA_PART = 500_000;

/**
 * 1 つの部屋。
 * WebSocket は「眠れる」受け方（acceptWebSocket）にする。だれも何も送らない間はサーバーが眠り、
 * 動いている時間（無料の枠の上限）に数えられない。つながっているかの確認（'ping'）は眠ったまま自動で返す。
 * 眠ると中身が消えるので、部屋の様子は変わるたびに保存し、起きたときに戻す
 */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private roomId = '';
  private conns = new WeakMap<WebSocket, Conn>();
  /** 保存してある譜面（予約の番号） */
  private savedTja = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(() => this.load());
  }

  private connOf(ws: WebSocket): Conn {
    let c = this.conns.get(ws);
    if (!c) {
      c = {
        send: (d) => ws.send(d),
        close: (code, reason) => {
          try { ws.close(code, reason); } catch { /* 閉じ済み */ }
        },
      };
      this.conns.set(ws, c);
    }
    return c;
  }

  private makeCore(id: string) {
    this.roomId = id;
    const core = new RoomCore(id, (info) => {
      const lobby = lobbyStub(this.env);
      this.ctx.waitUntil(lobby.update(info ?? { id, gone: true }).catch(() => {}));
      if (!info) this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
    });
    core.onChange = () => this.save();
    this.core = core;
    return core;
  }

  /** 眠りから起きたとき: 保存した様子と、つながったままの WebSocket から部屋を戻す */
  private async load() {
    const id = await this.ctx.storage.get<string>('id');
    const st = await this.ctx.storage.get<RoomState>('state');
    if (!id || !st) return;
    const core = this.makeCore(id);
    const parts = await this.ctx.storage.list<string>({ prefix: 'tja:' });
    const tja = new Map<string, string[]>();
    for (const [k, v] of parts) {
      const [, qid, n] = k.split(':');
      const a = tja.get(qid) ?? [];
      a[Number(n)] = v;
      tja.set(qid, a);
      this.savedTja.add(qid);
    }
    const conns = new Map<string, Conn>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { p?: string } | null;
      if (a?.p) conns.set(a.p, this.connOf(ws));
    }
    core.restore(st, (qid) => (tja.get(qid) ?? []).join(''), conns);
    if (core.empty) {
      // だれもつながっていない（サーバーが入れ替わったなど）: 部屋を片付けて一覧から消す
      await this.clear();
      this.ctx.waitUntil(lobbyStub(this.env).update({ id, gone: true }).catch(() => {}));
    }
  }

  private async clear() {
    await this.ctx.storage.deleteAll();
    this.savedTja.clear();
  }

  /** 部屋の様子を保存する（譜面は予約ごとに 1 回だけ） */
  private save() {
    const core = this.core;
    if (!core) return;
    if (core.empty) {
      this.ctx.waitUntil(this.clear());
      return;
    }
    const { state, items } = core.snapshot();
    const put: Record<string, unknown> = { id: this.roomId, state };
    const keep = new Set<string>();
    for (const it of items) {
      keep.add(it.qid);
      if (this.savedTja.has(it.qid)) continue;
      this.savedTja.add(it.qid);
      const t = it.meta.tja;
      for (let i = 0, n = 0; i < Math.max(1, t.length); i += TJA_PART, n++) put[`tja:${it.qid}:${n}`] = t.slice(i, i + TJA_PART);
    }
    const del: string[] = [];
    for (const qid of this.savedTja) {
      if (keep.has(qid)) continue;
      this.savedTja.delete(qid);
      for (let n = 0; n < 5; n++) del.push(`tja:${qid}:${n}`);
    }
    // 1 回に書ける数に分けて書く
    const entries = Object.entries(put);
    for (let i = 0; i < entries.length; i += 100) this.ctx.waitUntil(this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 100))));
    for (let i = 0; i < del.length; i += 100) this.ctx.waitUntil(this.ctx.storage.delete(del.slice(i, i + 100)));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.pathname.split('/').pop()!;
    const core = this.core ?? this.makeCore(id);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const conn = this.connOf(server);
    const q = url.searchParams;
    const p = core.join(conn, { name: q.get('name') ?? '', create: q.get('create') === '1', title: q.get('title') ?? '', pass: q.get('pass') ?? '', cid: q.get('cid') ?? '' });
    if (typeof p === 'string') {
      server.send(JSON.stringify({ t: 'denied', msg: p }));
      server.close(4003, 'denied');
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ p: p.id });
    // 一覧から消えないよう、人がいるあいだはときどき知らせ直す（目覚ましで起きる。ずっと起きてはいない）
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS / 2);
    return new Response(null, { status: 101, webSocket: client });
  }

  private playerOf(ws: WebSocket) {
    const a = ws.deserializeAttachment() as { p?: string } | null;
    return a?.p ? this.core?.player(a.p) : undefined;
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const p = this.playerOf(ws);
    if (p && this.core) this.core.message(p, data);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    // 切れても少しのあいだ席を残す（入り直したら同じ席に戻る）
    const p = this.playerOf(ws);
    if (p && this.core) this.core.disconnect(p, this.connOf(ws));
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* 閉じ済み */ }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1000);
  }

  async alarm() {
    const core = this.core;
    if (!core || core.empty) return;
    core.heartbeat();
    await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS / 2);
  }
}

/** Durable Object の保存場所を、合作の中身から使える形にする */
function doStore(st: DurableObjectStorage): CollabStore {
  return {
    get: (k) => st.get(k),
    async put(e) {
      const en = Object.entries(e);
      for (let i = 0; i < en.length; i += 100) await st.put(Object.fromEntries(en.slice(i, i + 100)));
    },
    async delete(ks) {
      for (let i = 0; i < ks.length; i += 100) await st.delete(ks.slice(i, i + 100));
    },
    list: (prefix) => st.list({ prefix }),
    async clear() {
      await st.deleteAlarm();
      await st.deleteAll();
    },
  };
}

/**
 * 合作プロジェクト 1 つ。対戦の部屋と同じく WebSocket は「眠れる」受け方にし、起きたら保存から戻す。
 * 変更の保存は少し待ってまとめて書く（待っている間は眠らない）
 */
export class Collab extends DurableObject<Env> {
  private core: CollabCore | null = null;
  private conns = new WeakMap<WebSocket, Conn>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      const id = await ctx.storage.get<string>('pid');
      if (!id) return;
      const core = this.make(id);
      await core.load();
      for (const ws of ctx.getWebSockets()) {
        const a = ws.deserializeAttachment() as { mid?: string; role?: 'edit' | 'view' } | null;
        if (!a?.mid || !a.role || !core.attach(this.connOf(ws), { mid: a.mid, role: a.role })) {
          try { ws.close(4100, 'reload'); } catch { /* 閉じ済み */ }
        }
      }
    });
  }

  private make(id: string) {
    const core = new CollabCore(id, doStore(this.ctx.storage));
    core.onLobby = (info) => this.ctx.waitUntil(collabLobby(this.env).collabUpdate(info).catch(() => {}));
    this.core = core;
    return core;
  }

  /** 2 週間だれも入らなかったら片付ける（入るたびに目覚ましを先へ延ばす） */
  async alarm() {
    const id = await this.ctx.storage.get<string>('pid');
    const core = this.core ?? (id ? this.make(id) : null);
    if (!core) return;
    await core.load();
    if (core.expired()) {
      await core.destroy();
      this.core = null;
      return;
    }
    const next = core.connections ? Date.now() + ROOM_DAYS * 86400_000 : core.lastActive + ROOM_DAYS * 86400_000 + 60_000;
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 60_000, next));
  }

  private connOf(ws: WebSocket): Conn {
    let c = this.conns.get(ws);
    if (!c) {
      c = {
        send: (d) => ws.send(d),
        close: (code, reason) => {
          try { ws.close(code, reason); } catch { /* 閉じ済み */ }
        },
      };
      this.conns.set(ws, c);
    }
    return c;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const q = url.searchParams;
    const parts = url.pathname.split('/');
    if (parts[2] === 'audio') {
      const id = parts[3];
      const hash = parts[4];
      const core = this.core ?? this.make(id);
      if (req.method === 'PUT') {
        const err = await core.putAudio(q.get('cid') ?? '', hash, new Uint8Array(await req.arrayBuffer()));
        return err ? new Response(err, { status: 403 }) : new Response('ok');
      }
      const got = await core.getAudio(q.get('cid') ?? '', hash);
      if (typeof got === 'string') return new Response(got, { status: 404 });
      return new Response(got, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    const id = parts[3];
    const fresh = !this.core;
    const core = this.core ?? this.make(id);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const conn = this.connOf(server);
    const r = await core.join(conn, {
      cid: q.get('cid') ?? '', name: q.get('name') ?? '', color: q.get('color') ?? '', pass: q.get('pass') ?? '', watch: q.get('watch') === '1',
      create: q.get('create') === '1' ? { name: q.get('rname') ?? '', pass: q.get('pass') ?? '', unlisted: q.get('unlisted') === '1', watch: q.get('rwatch') === '1' } : undefined,
    });
    if (typeof r === 'string') {
      server.send(JSON.stringify({ t: 'denied', msg: r }));
      server.close(4003, 'denied');
      if (fresh && !core.exists) this.core = null;
      return new Response(null, { status: 101, webSocket: client });
    }
    if (fresh || !(await this.ctx.storage.get('pid'))) await this.ctx.storage.put('pid', id);
    server.serializeAttachment({ mid: r.mid, role: r.role });
    // 入るたびに片付けの目覚ましを 2 週間後へ
    await this.ctx.storage.setAlarm(Date.now() + ROOM_DAYS * 86400_000 + 60_000);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (this.core) await this.core.message(this.connOf(ws), data);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.core?.leave(this.connOf(ws));
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* 閉じ済み */ }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1000);
  }
}

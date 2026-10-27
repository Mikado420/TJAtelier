/**
 * TJAtelier のオンライン対戦サーバー（Cloudflare Workers + Durable Objects）
 *
 * GET  /rooms                 公開している部屋の一覧（JSON）
 * GET  /new                   新しい部屋の番号
 * GET  /ws/:id?name=&create=1&title=&pass=   部屋に入る（WebSocket）
 */
import { DurableObject } from 'cloudflare:workers';
import { LOBBY_STALE_MS, LobbyCore, newRoomId, RoomCore, type Conn, type LobbyInfo, type RoomState } from './core';

interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOBBY: DurableObjectNamespace<Lobby>;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });

const lobbyStub = (env: Env) => env.LOBBY.get(env.LOBBY.idFromName('main'));

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

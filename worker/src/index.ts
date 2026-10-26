/**
 * TJAtelier のオンライン対戦サーバー（Cloudflare Workers + Durable Objects）
 *
 * GET  /rooms                 公開している部屋の一覧（JSON）
 * GET  /new                   新しい部屋の番号
 * GET  /ws/:id?name=&create=1&title=&pass=   部屋に入る（WebSocket）
 */
import { DurableObject } from 'cloudflare:workers';
import { LobbyCore, newRoomId, RoomCore, type Conn, type LobbyInfo } from './core';

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

/** 1 つの部屋 */
export class Room extends DurableObject<Env> {
  private core: RoomCore | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private last: LobbyInfo | null = null;

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const id = url.pathname.split('/').pop()!;
    if (!this.core) {
      this.core = new RoomCore(id, (info) => {
        this.last = info;
        const lobby = lobbyStub(this.env);
        this.ctx.waitUntil(lobby.update(info ?? { id, gone: true }).catch(() => {}));
        if (!info && this.beat) {
          clearInterval(this.beat);
          this.beat = null;
        }
      });
    }
    const core = this.core;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const conn: Conn = {
      send: (d) => server.send(d),
      close: (code, reason) => {
        try { server.close(code, reason); } catch { /* 閉じ済み */ }
      },
    };
    const q = url.searchParams;
    const p = core.join(conn, { name: q.get('name') ?? '', create: q.get('create') === '1', title: q.get('title') ?? '', pass: q.get('pass') ?? '', cid: q.get('cid') ?? '' });
    if (typeof p === 'string') {
      server.send(JSON.stringify({ t: 'denied', msg: p }));
      server.close(4003, 'denied');
      return new Response(null, { status: 101, webSocket: client });
    }
    server.addEventListener('message', (e) => core.message(p, e.data as string | ArrayBuffer));
    // 切れても少しのあいだ席を残す（入り直したら同じ席に戻る）
    const bye = () => core.disconnect(p, conn);
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    // 一覧から消えないよう、人がいるあいだは 2 分ごとに知らせ直す
    if (!this.beat) {
      this.beat = setInterval(() => {
        if (this.last && !core.empty) {
          this.last = { ...this.last, updatedAt: Date.now() };
          this.ctx.waitUntil(lobbyStub(this.env).update(this.last).catch(() => {}));
        }
      }, 120000);
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

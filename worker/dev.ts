/**
 * ローカルで確かめる用のサーバー（bun worker/dev.ts）。Cloudflare と同じ部屋の中身（core.ts）を Bun で動かす。
 * Web 版は ?online=http://127.0.0.1:8787 で、こちらにつなぐ。
 */
import { LobbyCore, newRoomId, RoomCore, type Conn } from './src/core';

const lobby = new LobbyCore();
const rooms = new Map<string, RoomCore>();
const CORS = { 'Access-Control-Allow-Origin': '*' };

type Data = { id: string; q: URLSearchParams; player?: unknown; core?: RoomCore; conn?: Conn };

Bun.serve<Data, undefined>({
  port: Number(process.env.PORT ?? 8787),
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === '/rooms') return Response.json(lobby.list(), { headers: CORS });
    if (url.pathname === '/new') return Response.json({ id: newRoomId() }, { headers: CORS });
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (m && server.upgrade(req, { data: { id: m[1], q: url.searchParams } })) return undefined;
    return new Response('not found', { status: 404 });
  },
  websocket: {
    maxPayloadLength: 2 * 1024 * 1024,
    open(ws) {
      const { id, q } = ws.data;
      let core = rooms.get(id);
      if (!core) {
        core = new RoomCore(id, (info) => {
          lobby.update(info ?? { id, gone: true });
          if (!info) rooms.delete(id);
        });
        rooms.set(id, core);
      }
      const conn: Conn = {
        send: (d) => { ws.send(d); },
        close: (c, r) => ws.close(c, r),
      };
      const p = core.join(conn, { name: q.get('name') ?? '', create: q.get('create') === '1', title: q.get('title') ?? '', pass: q.get('pass') ?? '', cid: q.get('cid') ?? '' });
      if (typeof p === 'string') {
        ws.send(JSON.stringify({ t: 'denied', msg: p }));
        ws.close(4003, 'denied');
        if (core.empty) rooms.delete(id);
        return;
      }
      ws.data.player = p;
      ws.data.core = core;
      ws.data.conn = conn;
    },
    message(ws, msg) {
      const { core, player } = ws.data;
      if (!core || !player) return;
      const data = typeof msg === 'string' ? msg : (msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer);
      core.message(player as never, data);
    },
    close(ws) {
      const { core, player, conn } = ws.data;
      if (core && player && conn) core.disconnect(player as never, conn);
    },
  },
});
console.log('online dev server on', process.env.PORT ?? 8787);

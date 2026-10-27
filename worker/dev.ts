/**
 * ローカルで確かめる用のサーバー（bun worker/dev.ts）。Cloudflare と同じ部屋の中身（core.ts）を Bun で動かす。
 * Web 版は ?online=http://127.0.0.1:8787 で、こちらにつなぐ。
 */
import { LobbyCore, newRoomId, RoomCore, type Conn } from './src/core';
import { CollabCore, MemoryStore } from './src/collab';

const lobby = new LobbyCore();
const rooms = new Map<string, RoomCore>();
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': '*' };
/** 合作プロジェクト（保存はメモリだけ） */
const collabs = new Map<string, CollabCore>();
const collabOf = (id: string) => {
  let c = collabs.get(id);
  if (!c) collabs.set(id, (c = new CollabCore(id, new MemoryStore())));
  return c;
};

type Data = { id: string; q: URLSearchParams; collab?: boolean; player?: unknown; core?: RoomCore; conn?: Conn };

Bun.serve<Data, undefined>({
  port: Number(process.env.PORT ?? 8787),
  async fetch(req, server) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const cw = url.pathname.match(/^\/collab\/ws\/([A-Z0-9]{10})$/);
    if (cw && server.upgrade(req, { data: { id: cw[1], q: url.searchParams, collab: true } })) return undefined;
    const ca = url.pathname.match(/^\/collab\/audio\/([A-Z0-9]{10})\/([0-9a-z]{4,64})$/i);
    if (ca) {
      const core = collabOf(ca[1]);
      const key = url.searchParams.get('key') ?? '';
      if (req.method === 'PUT') {
        const err = await core.putAudio(key, ca[2], new Uint8Array(await req.arrayBuffer()));
        return new Response(err ?? 'ok', { status: err ? 403 : 200, headers: CORS });
      }
      const got = await core.getAudio(key, ca[2]);
      return typeof got === 'string' ? new Response(got, { status: 404, headers: CORS }) : new Response(got, { headers: CORS });
    }
    if (url.pathname === '/rooms') return Response.json(lobby.list(), { headers: CORS });
    if (url.pathname === '/new') return Response.json({ id: newRoomId() }, { headers: CORS });
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (m && server.upgrade(req, { data: { id: m[1], q: url.searchParams } })) return undefined;
    return new Response('not found', { status: 404 });
  },
  websocket: {
    maxPayloadLength: 2 * 1024 * 1024,
    async open(ws) {
      const { id, q } = ws.data;
      if (ws.data.collab) {
        const conn: Conn = { send: (d) => { ws.send(d); }, close: (c, r) => ws.close(c, r) };
        ws.data.conn = conn;
        const r = await collabOf(id).join(conn, { cid: q.get('cid') ?? '', name: q.get('name') ?? '', color: q.get('color') ?? '', key: q.get('key') ?? '', create: q.get('create') === '1', vkey: q.get('vkey') ?? '' });
        if (typeof r === 'string') {
          ws.send(JSON.stringify({ t: 'denied', msg: r }));
          ws.close(4003, 'denied');
        }
        return;
      }
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
      if (ws.data.collab) {
        if (msg === 'ping') return void ws.send('pong');
        if (ws.data.conn) void collabOf(ws.data.id).message(ws.data.conn, typeof msg === 'string' ? msg : '');
        return;
      }
      const { core, player } = ws.data;
      if (!core || !player) return;
      const data = typeof msg === 'string' ? msg : (msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer);
      core.message(player as never, data);
    },
    close(ws) {
      if (ws.data.collab) {
        if (ws.data.conn) collabOf(ws.data.id).leave(ws.data.conn);
        return;
      }
      const { core, player, conn } = ws.data;
      if (core && player && conn) core.disconnect(player as never, conn);
    },
  },
});
console.log('online dev server on', process.env.PORT ?? 8787);

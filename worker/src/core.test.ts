import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomCore } from './core';

type Msg = Record<string, unknown>;
function conn() {
  const got: Msg[] = [];
  const bin: ArrayBuffer[] = [];
  return { got, bin, send: (d: string | ArrayBuffer) => (typeof d === 'string' ? got.push(JSON.parse(d)) : bin.push(d)), close() {} };
}
const meta = (title: string, size = 0, hash = '') => ({ title, subtitle: '', course: 'Oni', level: 8, tja: 'x', size, audioName: 'a.ogg', hash, lib: title });
const last = (c: ReturnType<typeof conn>, t: string) => [...c.got].reverse().find((m) => m.t === t);

describe('部屋（予約・音源を配る・準備OK・入り直し）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const room = new RoomCore('R', () => {});
    const ca = conn();
    const cb = conn();
    const A = room.join(ca, { name: 'A', create: true, title: '', pass: '', cid: 'a' });
    const B = room.join(cb, { name: 'B', create: false, title: '', pass: '', cid: 'b' });
    if (typeof A === 'string' || typeof B === 'string') throw new Error('join');
    const send = (p: typeof A, m: Msg) => room.message(p, JSON.stringify(m));
    return { room, ca, cb, A, B, send };
  };

  it('予約すると次の曲になり、音源を持っていない人がいるときだけ、予約した人に送ってもらう', () => {
    const { ca, cb, A, B, send, room } = setup();
    send(B, { t: 'reserve', meta: meta('曲1', 10, 'h1') });
    const next = last(cb, 'next')!.meta as Msg;
    expect(next.title).toBe('曲1');
    // B（予約した人）は持っている。A は持っていない → B に「送って」
    send(B, { t: 'have', key: next.key });
    send(A, { t: 'need', key: next.key });
    expect(last(cb, 'upload')?.key).toBe(next.key);
    room.message(B, new ArrayBuffer(10));
    send(B, { t: 'songEnd', key: next.key });
    expect(ca.bin.length).toBe(1);
    expect(cb.bin.length).toBe(0);
    expect(last(ca, 'songEnd')?.key).toBe(next.key);
  });

  it('みんな持っていれば送らない。全員が準備OK ならカウントダウンして始まる', () => {
    const { ca, cb, A, B, send } = setup();
    send(A, { t: 'reserve', meta: meta('曲1', 10, 'h1') });
    const key = (last(ca, 'next')!.meta as Msg).key;
    send(A, { t: 'have', key });
    send(B, { t: 'have', key });
    expect(last(ca, 'upload')).toBeUndefined();
    send(A, { t: 'ok', on: true });
    send(B, { t: 'course', c: 'Hard' });
    send(B, { t: 'ok', on: true });
    expect(Number(last(cb, 'roster')!.countdown)).toBeGreaterThan(0);
    vi.advanceTimersByTime(3100);
    const st = last(cb, 'start')!;
    expect((st.players as Msg[]).map((p) => p.course)).toEqual(['Oni', 'Hard']);
  });

  it('部屋主だけのときは、ほかの人は予約できない。1 人の予約の数にも上限がある', () => {
    const { cb, A, B, send } = setup();
    send(A, { t: 'settings', s: { pick: 'host', limit: 1 } });
    send(B, { t: 'reserve', meta: meta('x') });
    expect(last(cb, 'err')?.msg).toMatch(/部屋主だけ/);
    send(A, { t: 'settings', s: { pick: 'all' } });
    send(B, { t: 'reserve', meta: meta('x', 10) });
    send(B, { t: 'reserve', meta: meta('y', 10) });
    send(B, { t: 'reserve', meta: meta('z', 10) });
    expect(last(cb, 'err')?.msg).toMatch(/1 曲まで/);
  });

  it('順番に: 予約した人を交代で選ぶ', () => {
    const { ca, A, B, send, room } = setup();
    send(A, { t: 'settings', s: { pick: 'turn', limit: 3 } });
    // 今の曲があるあいだに予約をためる
    send(A, { t: 'reserve', meta: meta('A1', 0) });
    send(A, { t: 'reserve', meta: meta('A2', 0) });
    send(A, { t: 'reserve', meta: meta('A3', 0) });
    send(B, { t: 'reserve', meta: meta('B1', 0) });
    const order: string[] = [(last(ca, 'next')!.meta as Msg).title as string];
    for (let i = 0; i < 3; i++) {
      send(A, { t: 'skip' });
      order.push((last(ca, 'next')!.meta as Msg).title as string);
    }
    expect(order).toEqual(['A1', 'B1', 'A2', 'A3']);
    void room;
  });

  it('切れても 20 秒は席が残り、同じ端末なら同じ席に戻る', () => {
    const { room, cb, B } = setup();
    room.disconnect(B, cb);
    expect((last(cb, 'roster')!.players as Msg[]).length).toBe(2);
    const cb2 = conn();
    const B2 = room.join(cb2, { name: 'B', create: false, title: '', pass: '', cid: 'b' });
    expect(typeof B2 !== 'string' && B2.id).toBe(B.id);
    vi.advanceTimersByTime(25000);
    expect((last(cb2, 'roster')!.players as Msg[]).length).toBe(2);
  });
});

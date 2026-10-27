import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabCore, MemoryStore } from './collab';
import { emptyHead, type Lane } from '../../src/collab/protocol';

type Msg = Record<string, any>;
function conn() {
  const got: Msg[] = [];
  return { got, closed: false, send: (d: string | ArrayBuffer) => { if (typeof d === 'string') got.push(JSON.parse(d)); }, close() { this.closed = true; } };
}
const last = (c: ReturnType<typeof conn>, t: string) => [...c.got].reverse().find((m) => m.t === t);
const lane = (id: string, owner: string, main: boolean, course = 'Oni'): Lane => ({ id, course, name: id, owner, color: '#fff', main, order: 0, head: emptyHead(), notes: {}, events: {}, grads: {} });
const KEY = 'editkey123';
const VKEY = 'viewkey123';

describe('合作プロジェクト（サーバー）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = async () => {
    const store = new MemoryStore();
    const core = new CollabCore('P', store);
    const ca = conn();
    const cb = conn();
    const A = await core.join(ca, { cid: 'a', name: 'A', color: '', key: KEY, vkey: VKEY, create: true });
    const B = await core.join(cb, { cid: 'b', name: 'B', color: '', key: KEY, vkey: '', create: false });
    if (typeof A === 'string' || typeof B === 'string') throw new Error(String(A) + B);
    const send = (c: typeof ca, m: Msg) => core.message(c, JSON.stringify(m));
    return { store, core, ca, cb, A: A.mid, B: B.mid, send };
  };

  it('作った人がリーダー。鍵が違えば入れない。見るだけの鍵では変更できない', async () => {
    const { core, A, ca } = await setup();
    expect(last(ca, 'hello')!.doc.leader).toBe(A);
    expect(await core.join(conn(), { cid: 'x', name: 'X', color: '', key: 'wrong', vkey: '', create: false })).toBe('リンクの鍵が違います');
    const cv = conn();
    const V = await core.join(cv, { cid: 'v', name: 'V', color: '', key: VKEY, vkey: '', create: false });
    expect(typeof V !== 'string' && V.role).toBe('view');
    await core.message(cv, JSON.stringify({ t: 'ops', c: 1, ops: [{ o: 'm', v: { title: 'x' } }] }));
    expect(last(cv, 'ack')!.rej).toBe('all');
    expect(core.state.doc.meta.title).toBe('');
  });

  it('本譜面はリーダーだけ。権限を渡すと担当範囲の中だけ、「範囲外も」で全部', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }] });
    expect(core.state.doc.lanes.M.main).toBe(true);
    const put = (tick: number) => send(cb, { t: 'ops', c: tick, ops: [{ o: 'n', l: 'M', k: String(tick), v: { type: 'don' } }] });
    await put(0);
    expect(last(cb, 'ack')!.rej).toEqual([0]);
    expect(last(cb, 'lanes')!.lanes.M.id).toBe('M');
    await send(ca, { t: 'cmd', x: 'perm', mid: B, perms: { main: true, any: false } });
    await send(ca, { t: 'cmd', x: 'ranges', mid: B, ranges: [{ lane: 'M', from: 1000, to: 2000 }] });
    await put(500);
    expect(last(cb, 'ack')!.rej).toEqual([0]);
    await put(1500);
    expect(last(cb, 'ack')!.rej).toEqual([]);
    expect(core.state.doc.lanes.M.notes['1500']).toEqual({ type: 'don' });
    // A（リーダー）に届く
    expect(last(ca, 'ops')!.ops[0].k).toBe('1500');
    // ヘッダーは範囲外も持っている人だけ
    await send(cb, { t: 'ops', c: 9, ops: [{ o: 'h', l: 'M', v: { bpm: 200 } }] });
    expect(core.state.doc.lanes.M.head.bpm).toBe(120);
    await send(ca, { t: 'cmd', x: 'perm', mid: B, perms: { main: true, any: true } });
    await put(500);
    expect(core.state.doc.lanes.M.notes['500']).toBeTruthy();
  });

  it('自分のレーンは本人だけが編集できる。ごみ箱に入れて戻せる', async () => {
    const { core, B, ca, cb, send } = await setup();
    await send(cb, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('L', 'someone', false) }] });
    expect(core.state.doc.lanes.L.owner).toBe(B);
    await send(ca, { t: 'ops', c: 2, ops: [{ o: 'n', l: 'L', k: '0', v: { type: 'ka' } }] });
    expect(core.state.doc.lanes.L.notes['0']).toBeUndefined();
    await send(cb, { t: 'ops', c: 3, ops: [{ o: 'n', l: 'L', k: '0', v: { type: 'ka' } }] });
    expect(core.state.doc.lanes.L.notes['0']).toEqual({ type: 'ka' });
    await send(cb, { t: 'cmd', x: 'del', l: 'L' });
    expect(core.state.doc.lanes.L).toBeUndefined();
    expect(last(ca, 'laneDel')!.l).toBe('L');
    const tid = core.state.doc.trash[0].id;
    await send(cb, { t: 'cmd', x: 'restore', id: tid });
    expect(core.state.doc.lanes.L.notes['0']).toEqual({ type: 'ka' });
    expect(core.state.doc.trash.length).toBe(0);
    // チャットにお知らせが出ている
    expect(core.state.chat.some((m) => m.sys && m.x.includes('ごみ箱'))).toBe(true);
  });

  it('丸ごと採用: 前の本譜面はごみ箱へ', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }, { o: 'n', l: 'M', k: '0', v: { type: 'don' } }] });
    await send(cb, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('L', B, false) }, { o: 'n', l: 'L', k: '96', v: { type: 'ka' } }] });
    await send(cb, { t: 'cmd', x: 'adoptAll', src: 'L', dst: 'M' });
    expect(last(cb, 'err')).toBeTruthy();
    await send(ca, { t: 'cmd', x: 'adoptAll', src: 'L', dst: 'M' });
    expect(core.state.doc.lanes.M.notes).toEqual({ '96': { type: 'ka' } });
    expect(core.state.doc.trash.length).toBe(1);
    expect(last(cb, 'lane')!.lane.notes['96']).toBeTruthy();
  });

  it('9 人目は入れない。リーダーを渡せる。外すとつながりが切れる', async () => {
    const { core, B, ca, cb, send } = await setup();
    for (let i = 0; i < 6; i++) expect(typeof (await core.join(conn(), { cid: 'c' + i, name: 'n', color: '', key: KEY, vkey: '', create: false }))).toBe('object');
    expect(await core.join(conn(), { cid: 'z', name: 'Z', color: '', key: KEY, vkey: '', create: false })).toContain('満員');
    // 前からいる人は入り直せる
    expect(typeof (await core.join(conn(), { cid: 'b', name: 'B', color: '', key: KEY, vkey: '', create: false }))).toBe('object');
    await send(ca, { t: 'cmd', x: 'leader', mid: B });
    expect(core.state.doc.leader).toBe(B);
    await send(cb, { t: 'cmd', x: 'kick', mid: last(ca, 'hello')!.you });
    expect(ca.closed).toBe(true);
    expect(Object.keys(core.state.doc.members).length).toBe(7);
  });

  it('保存して読み直せる。版を残して戻せる', async () => {
    const { store, core, A, ca, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }, { o: 'm', v: { title: '曲' } }] });
    await send(ca, { t: 'cmd', x: 'saveVer', name: 'はじめ' });
    await send(ca, { t: 'ops', c: 2, ops: [{ o: 'n', l: 'M', k: '0', v: { type: 'don' } }, { o: 'm', v: { title: '曲2' } }] });
    await core.flush();
    const core2 = new CollabCore('P', store);
    const c = conn();
    await core2.join(c, { cid: 'a', name: 'A', color: '', key: KEY, vkey: '', create: false });
    expect(core2.state.doc.meta.title).toBe('曲2');
    expect(core2.state.doc.lanes.M.notes['0']).toBeTruthy();
    expect(last(c, 'lane')!.lane.id).toBe('M');
    const v = core2.state.vers.find((x) => x.name === 'はじめ')!;
    await core2.message(c, JSON.stringify({ t: 'cmd', x: 'restoreVer', id: v.id }));
    expect(core2.state.doc.meta.title).toBe('曲');
    expect(core2.state.doc.lanes.M.notes['0']).toBeUndefined();
    // 戻す前の版も残る
    expect(core2.state.vers.some((x) => x.name.includes('戻す前'))).toBe(true);
  });

  it('チャット・リアクション・同時再生・時刻合わせ', async () => {
    const { ca, cb, A, send } = await setup();
    await send(ca, { t: 'chat', x: 'ここ見て', at: { l: 'M', tick: 960 } });
    const m = last(cb, 'chat')!.m;
    expect(m.by).toBe(A);
    expect(m.at).toEqual({ l: 'M', tick: 960 });
    await send(cb, { t: 'react', id: m.id, e: '👍' });
    expect(last(ca, 'react')!.re['👍'].length).toBe(1);
    await send(cb, { t: 'playall', from: 3, mode: 'mine' });
    const p = last(ca, 'playall')!;
    expect(p.at - Date.now()).toBe(1500);
    await send(cb, { t: 'ping', c: 5 });
    expect(last(cb, 'pong')!.c).toBe(5);
  });

  it('音源をかけらに分けて保存し、戻せる', async () => {
    const { core } = await setup();
    const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
    expect(await core.putAudio('bad', 'abcd', bytes)).toBe('リンクの鍵が違います');
    expect(await core.putAudio(KEY, 'abcd', bytes)).toBeNull();
    const got = await core.getAudio(VKEY, 'abcd');
    expect(got instanceof Uint8Array && got.byteLength).toBe(2_000_000);
    expect((got as Uint8Array)[1_500_000]).toBe(1_500_000 % 251);
  });
});

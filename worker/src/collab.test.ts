import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollabCore, CollabLobbyCore, MemoryStore } from './collab';
import { emptyHead, type Lane } from '../../src/collab/protocol';

type Msg = Record<string, any>;
function conn() {
  const got: Msg[] = [];
  return { got, closed: false, send: (d: string | ArrayBuffer) => { if (typeof d === 'string') got.push(JSON.parse(d)); }, close() { this.closed = true; } };
}
const last = (c: ReturnType<typeof conn>, t: string) => [...c.got].reverse().find((m) => m.t === t);
const lane = (id: string, owner: string, main: boolean, course = 'Oni'): Lane => ({ id, course, name: id, owner, color: '#fff', main, order: 0, head: emptyHead(), notes: {}, events: {}, grads: {} });
const PASS = 'たいこ';
const ROOM = { name: '部屋', pass: PASS, unlisted: false, watch: true };
const q = (cid: string, extra: Record<string, unknown> = {}) => ({ cid, name: cid.toUpperCase(), color: '', pass: '', watch: false, ...extra });

describe('合作プロジェクト（サーバー）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = async () => {
    const store = new MemoryStore();
    const core = new CollabCore('P', store);
    const ca = conn();
    const cb = conn();
    const A = await core.join(ca, q('a', { create: ROOM }));
    const B = await core.join(cb, q('b', { pass: PASS }));
    if (typeof A === 'string' || typeof B === 'string') throw new Error(String(A) + B);
    const send = (c: typeof ca, m: Msg) => core.message(c, JSON.stringify(m));
    return { store, core, ca, cb, A: A.mid, B: B.mid, send };
  };

  it('作った人がリーダー。あいことばが違えば入れない。一度入った端末は次から要らない。見学は変更できない', async () => {
    const { core, A, ca, store } = await setup();
    expect(last(ca, 'hello')!.doc.leader).toBe(A);
    expect(last(ca, 'hello')!.room.pass).toBe(PASS);
    expect(await core.join(conn(), q('x', { pass: 'ちがう' }))).toBe('あいことばが違います');
    expect(await core.join(conn(), q('x'))).toBe('あいことばを入れてください');
    expect(typeof (await core.join(conn(), q('b')))).toBe('object');
    expect(await new CollabCore('Q', store).join(conn(), q('a'))).toContain('見つかりません');
    const cv = conn();
    const V = await core.join(cv, q('v', { watch: true }));
    expect(last(cv, 'hello')!.room.pass).toBe('');
    expect(typeof V !== 'string' && V.role).toBe('view');
    await core.message(cv, JSON.stringify({ t: 'ops', c: 1, ops: [{ o: 'm', v: { title: 'x' } }] }));
    expect(last(cv, 'ack')!.rej).toBe('all');
    expect(core.state.doc.meta.title).toBe('');
  });

  it('本譜面はリーダーだけ。本譜面の権限を渡すと編集できる', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }] });
    expect(core.state.doc.lanes.M.main).toBe(true);
    const put = (tick: number) => send(cb, { t: 'ops', c: tick, ops: [{ o: 'n', l: 'M', k: String(tick), v: { type: 'don' } }] });
    await put(0);
    expect(last(cb, 'ack')!.rej).toEqual([0]);
    expect(last(cb, 'lanes')!.lanes.M.id).toBe('M');
    await send(cb, { t: 'ops', c: 9, ops: [{ o: 'h', l: 'M', v: { bpm: 200 } }] });
    expect(core.state.doc.lanes.M.head.bpm).toBe(120);
    await send(ca, { t: 'cmd', x: 'perm', mid: B, perms: { any: true } });
    await put(500);
    expect(last(cb, 'ack')!.rej).toEqual([]);
    expect(core.state.doc.lanes.M.notes['500']).toBeTruthy();
    // A（リーダー）に届く
    expect(last(ca, 'ops')!.ops[0].k).toBe('500');
    // 小節の出どころ
    await send(cb, { t: 'ops', c: 10, ops: [{ o: 'pv', l: 'M', k: '0', v: { end: 6720 * 4, by: B, color: '#8fd18f' } }] });
    expect(core.state.doc.lanes.M.prov?.['0']?.by).toBe(B);
    await send(ca, { t: 'cmd', x: 'perm', mid: B, perms: { any: false } });
    await put(700);
    expect(last(cb, 'ack')!.rej).toEqual([0]);
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
    for (let i = 0; i < 6; i++) expect(typeof (await core.join(conn(), q('c' + i, { pass: PASS })))).toBe('object');
    expect(await core.join(conn(), q('z', { pass: PASS }))).toContain('満員');
    // 前からいる人は入り直せる
    expect(typeof (await core.join(conn(), q('b')))).toBe('object');
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
    await core2.join(c, q('a'));
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

  it('音源を変えると全部のレーンの OFFSET がずれる（送った人のレーンは除く）', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }] });
    await send(cb, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('L', B, false) }] });
    await send(cb, { t: 'cmd', x: 'audioSet', audio: { hash: 'h1', name: 'a.ogg', size: 1 }, shift: 1 });
    expect(core.state.doc.meta.audio).toBeNull();
    await send(ca, { t: 'cmd', x: 'audioSet', audio: { hash: 'h1', name: 'a.ogg', size: 1 }, shift: -0.5, skip: 'M' });
    expect(core.state.doc.meta.audio!.hash).toBe('h1');
    expect(core.state.doc.lanes.L.head.offset).toBe(-0.5);
    expect(core.state.doc.lanes.M.head.offset).toBe(0);
    expect(last(ca, 'ops')!.ops.length).toBe(2);
  });

  it('音源をかけらに分けて保存し、戻せる', async () => {
    const { core } = await setup();
    const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
    expect(await core.putAudio('nobody', 'abcd', bytes)).toBe('この部屋のメンバーではありません');
    expect(await core.putAudio('a', 'abcd', bytes)).toBeNull();
    // 見学できる部屋なら、メンバーでなくても受け取れる
    const got = await core.getAudio('nobody', 'abcd');
    expect(got instanceof Uint8Array && got.byteLength).toBe(2_000_000);
    expect((got as Uint8Array)[1_500_000]).toBe(1_500_000 % 251);
  });

  it('部屋の一覧に知らせる。設定を変えられる。2 週間だれも入らなければ消える', async () => {
    let now = 1_000_000;
    const store = new MemoryStore();
    const core = new CollabCore('P', store, { now: () => now });
    const got: Record<string, unknown>[] = [];
    core.onLobby = (i) => got.push(i as never);
    const ca = conn();
    await core.join(ca, q('a', { create: ROOM }));
    expect(got.at(-1)!.online).toBe(1);
    await core.message(ca, JSON.stringify({ t: 'cmd', x: 'room', pass: '新しい', unlisted: true, watch: false }));
    expect(got.at(-1)!.unlisted).toBe(true);
    expect(await core.join(conn(), q('x', { pass: PASS }))).toBe('あいことばが違います');
    expect(await core.join(conn(), q('x', { watch: true }))).toBe('この部屋は見学できません');
    const cy = conn();
    expect(typeof (await core.join(cy, q('y', { pass: '新しい' })))).toBe('object');
    core.leave(ca);
    core.leave(cy);
    await core.flush();
    now += 13 * 86400_000;
    expect(core.expired()).toBe(false);
    now += 2 * 86400_000;
    expect(core.expired()).toBe(true);
    await core.destroy();
    expect(got.at(-1)!.gone).toBe(true);
    expect(store.m.size).toBe(0);
  });

  it('部屋の一覧: 一覧に出さない部屋は番号で探したときだけ。2 週間たった部屋は出さない', () => {
    const lb = new CollabLobbyCore();
    const now = 100 * 86400_000;
    const r = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, title: '', leader: '', members: 1, online: 0, viewers: 0, watch: false, unlisted: false, lastActive: now, updatedAt: now, courses: [], ...extra }) as never;
    lb.update(r('AAAAAA'));
    lb.update(r('BBBBBB', { unlisted: true }));
    lb.update(r('CCCCCC', { lastActive: now - 15 * 86400_000 }));
    expect(lb.list(now).map((x) => x.id)).toEqual(['AAAAAA']);
    expect(lb.list(now, ['BBBBBB']).map((x) => x.id)).toEqual(['BBBBBB']);
    expect(lb.list(now, ['CCCCCC'])).toEqual([]);
    lb.update({ id: 'AAAAAA', gone: true });
    expect(lb.list(now)).toEqual([]);
  });
  it('壊れた値は受け取らない。本譜面の権限がない人は BPM なども置けない', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }] });
    await send(ca, { t: 'ops', c: 2, ops: [
      { o: 'n', l: 'M', k: '10', v: { type: 'xx' } },
      { o: 'e', l: 'M', k: '0:bpm', v: { tick: 0, kind: 'bpm', value: 0 } },
      { o: 'e', l: 'M', k: '0:measure', v: { tick: 0, kind: 'measure', num: 3, den: 0 } },
      { o: 'n', l: 'M', k: '20', v: { type: 'roll', endTick: 5 } },
    ] });
    expect(last(ca, 'ack')!.rej).toEqual([0, 1, 2, 3]);
    await send(cb, { t: 'ops', c: 3, ops: [
      { o: 'e', l: 'M', k: '960:bpm', v: { tick: 960, kind: 'bpm', value: 200 } },
      { o: 'e', l: 'M', k: '960:scroll', v: { tick: 960, kind: 'scroll', value: 2 } },
    ] });
    expect(last(cb, 'ack')!.rej).toEqual([0, 1]);
  });

  it('受け取りを返す前に保存する。送りすぎても変更は捨てない', async () => {
    const { store, A, ca, send } = await setup();
    await send(ca, { t: 'ops', c: 1, ops: [{ o: 'new', lane: lane('M', A, true) }] });
    expect(last(ca, 'ack')!.rej).toEqual([]);
    expect((store.m.get('lane:M') as Lane).id).toBe('M');
    for (let i = 0; i < 300; i++) await send(ca, { t: 'cur', l: 'M', tick: i });
    await send(ca, { t: 'ops', c: 2, ops: [{ o: 'n', l: 'M', k: '0', v: { type: 'don' } }] });
    expect(last(ca, 'ack')!.c).toBe(2);
    expect((store.m.get('lane:M') as Lane).notes['0']).toEqual({ type: 'don' });
  });

  it('外した人は、あいことばを知っていても入れない。自分から抜けると枠が空き、リーダーは渡る', async () => {
    const { core, A, B, ca, cb, send } = await setup();
    await send(ca, { t: 'cmd', x: 'kick', mid: B });
    expect(cb.closed).toBe(true);
    expect(await core.join(conn(), q('b', { pass: PASS }))).toBe('この部屋には入れません');
    const cc = conn();
    const C = await core.join(cc, q('c', { pass: PASS }));
    if (typeof C === 'string') throw new Error(C);
    await send(ca, { t: 'cmd', x: 'leave' });
    expect(ca.closed).toBe(true);
    expect(core.member(A)).toBeUndefined();
    expect(last(cc, 'members')!.leader).toBe(C.mid);
  });

  it('リーダーが 2 週間来なければ、次に入った人がリーダーになる', async () => {
    let now = 1_000_000;
    const core = new CollabCore('P', new MemoryStore(), { now: () => now });
    const ca = conn();
    const cb = conn();
    const A = await core.join(ca, q('a', { create: ROOM }));
    const B = await core.join(cb, q('b', { pass: PASS }));
    if (typeof A === 'string' || typeof B === 'string') throw new Error('join');
    core.leave(ca);
    core.leave(cb);
    now += 3 * 86400_000;
    const c1 = conn();
    await core.join(c1, q('b'));
    expect(last(c1, 'hello')!.doc.leader).toBe(A.mid);
    core.leave(c1);
    now += 15 * 86400_000;
    const c2 = conn();
    await core.join(c2, q('b'));
    expect(last(c2, 'hello')!.doc.leader).toBe(B.mid);
  });

  it('あいことばを何度も間違えると、しばらく入れない（メンバーの端末は入れる）', async () => {
    const { core } = await setup();
    for (let i = 0; i < 10; i++) await core.join(conn(), q('x' + i, { pass: 'ちがう' }));
    expect(await core.join(conn(), q('y', { pass: PASS }))).toContain('しばらく');
    expect(typeof (await core.join(conn(), q('a')))).toBe('object');
  });
});

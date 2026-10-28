import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { courseToLane, diff, laneToChart, stateOf } from './bridge';
import { applyOp, barAt, canApply, canEditLane, emptyDoc, type CollabDoc } from './protocol';

const TJA = `TITLE:t
BPM:150
OFFSET:-1.2
WAVE:a.ogg

COURSE:Oni
LEVEL:8
BALLOON:5
#START
1020,
#GOGOSTART
#SCROLL 1.5
1122,
#GOGOEND
#BPMCHANGE 180
7008,
#END
`;

const docWith = (): CollabDoc => {
  const chart = parseTJA(TJA);
  const doc = emptyDoc();
  doc.meta.title = chart.title;
  doc.members.a = { id: 'a', name: 'A', color: '#fff', perms: { main: true, any: true }, viewer: false, lastSeen: 0 };
  doc.members.b = { id: 'b', name: 'B', color: '#fff', perms: { main: false, any: false }, viewer: false, lastSeen: 0 };
  doc.leader = 'a';
  doc.lanes.L = courseToLane(chart, chart.courses[0], { id: 'L', name: 'おに', owner: 'a', color: '#fff', main: true, order: 0 });
  return doc;
};

describe('合作: レーン ⇔ 譜面', () => {
  it('レーンから作った譜面は元の譜面と同じ（音符・命令・BPM・OFFSET）', () => {
    const chart = parseTJA(TJA);
    const doc = docWith();
    const back = laneToChart(doc, doc.lanes.L);
    expect(back.bpm).toBe(150);
    expect(back.offset).toBe(-1.2);
    expect(back.courses[0].notes).toEqual(chart.courses[0].notes);
    expect(back.courses[0].events.map((e) => `${e.tick}:${e.kind}`)).toEqual(chart.courses[0].events.map((e) => `${e.tick}:${e.kind}`));
    // 比べる形も同じ → 差分なし
    expect(diff('L', stateOf(chart, chart.courses[0]), stateOf(back, back.courses[0]), back).ops).toEqual([]);
  });

  it('変えた所だけが変更になり、当てると相手のレーンも同じになる。元に戻す変更で戻る', () => {
    const doc = docWith();
    const chart = laneToChart(doc, doc.lanes.L);
    const prev = stateOf(chart, chart.courses[0]);
    const c = chart.courses[0];
    c.notes.push({ tick: 6720 * 3, type: 'ka' });
    c.notes.splice(0, 1);
    c.events.push({ tick: 6720 * 2, kind: 'scroll', value: 2 });
    chart.offset = -1.25;
    const next = stateOf(chart, c);
    const { ops, inverse } = diff('L', prev, next, chart);
    expect(ops.map((o) => o.o).sort()).toEqual(['e', 'h', 'n', 'n']);
    const other = docWith();
    for (const op of ops) applyOp(other, op);
    const got = laneToChart(other, other.lanes.L);
    expect(diff('L', next, stateOf(got, got.courses[0]), got).ops).toEqual([]);
    for (const op of inverse) applyOp(other, op);
    const back = laneToChart(other, other.lanes.L);
    expect(diff('L', prev, stateOf(back, back.courses[0]), back).ops).toEqual([]);
  });

  it('本譜面は、リーダーと本譜面の権限がある人だけ。案は作った人だけ', () => {
    const doc = docWith();
    expect(canEditLane(doc, 'b', 'L', [100])).toBe(false);
    expect(canEditLane(doc, 'b', 'L', null)).toBe(false);
    doc.members.b.perms = { main: true, any: true };
    expect(canEditLane(doc, 'b', 'L', [100])).toBe(true);
    applyOp(doc, { o: 'new', lane: { ...structuredClone(doc.lanes.L), id: 'P', main: false, owner: 'b' } });
    expect(canEditLane(doc, 'b', 'P', [100])).toBe(true);
    expect(canEditLane(doc, 'a', 'P', [100])).toBe(false);
    expect(barAt(doc.lanes.L, 6720 * 4 + 10)).toBe(2);
  });

  it('本譜面の小節の出どころは、本譜面を編集できる人だけ付けられる', () => {
    const doc = docWith();
    const op = { o: 'pv', l: 'L', k: '0', v: { end: 6720 * 4, by: 'b', color: '#8fd18f' } } as const;
    expect(canApply(doc, 'b', op)).toBe(false);
    expect(canApply(doc, 'a', op)).toBe(true);
    expect(applyOp(doc, op)).toBe(true);
    expect(doc.lanes.L.prov?.['0']?.by).toBe('b');
    expect(canApply(doc, 'a', { o: 'pv', l: 'L', k: '0', v: { end: -1, by: 'b', color: '#fff' } })).toBe(false);
    applyOp(doc, { o: 'pv', l: 'L', k: '0', v: null });
    expect(doc.lanes.L.prov?.['0']).toBeUndefined();
  });
});

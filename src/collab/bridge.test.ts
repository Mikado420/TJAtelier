import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { courseToLane, diff, laneToChart, stateOf } from './bridge';
import { applyOp, barAt, canEditLane, emptyDoc, type CollabDoc } from './protocol';

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

  it('担当の人は、担当の小節の中だけ編集できる（#MEASURE で小節が変わっても小節で合わせる）', () => {
    const doc = docWith();
    const BAR = 6720 * 4;
    doc.groups.A = { id: 'A', name: 'A', color: '#f00', ranges: [{ lane: 'L', from: 1, to: 1 }], members: ['b'] };
    expect(canEditLane(doc, 'b', 'L', [100])).toBe(true);
    expect(canEditLane(doc, 'b', 'L', [BAR])).toBe(false);
    expect(canEditLane(doc, 'b', 'L', null)).toBe(false);
    // 連打の終わりが範囲の終わりちょうどなら置ける。越えたらだめ
    expect(canEditLane(doc, 'b', 'L', [0, BAR])).toBe(true);
    expect(canEditLane(doc, 'b', 'L', [0, BAR + 1])).toBe(false);
    // 1 小節目を 2/4 にすると、範囲もその長さになる
    doc.lanes.L.events['0:measure'] = { tick: 0, kind: 'measure', num: 2, den: 4 };
    expect(canEditLane(doc, 'b', 'L', [BAR / 2 + 10])).toBe(false);
    expect(barAt(doc.lanes.L, BAR / 2 + 10)).toBe(2);
    // 担当を外すと編集できない
    doc.groups.A.members = [];
    expect(canEditLane(doc, 'b', 'L', [100])).toBe(false);
  });
});

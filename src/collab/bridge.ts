/**
 * 合作のレーン ⇔ エディタの譜面（EChart）の変換と、変わった所だけを変更（Op）にする差分。
 *
 * エディタはいつもどおり 1 曲の譜面を編集する（難易度は 1 つ = 開いているレーン）。
 * 編集のたびに、前の状態と比べて変わった音符・命令・グラデ・ヘッダーだけを Op にして送る。
 * ほかの人の変更が届いたら、レーンから譜面を作り直してエディタに入れる。
 */
import { sortCourse, type EChart, type ECourse, type EEvent, type ENote } from '../chart/model';
import type { Grad } from '../editor/grad';
import type { CollabDoc, EventVal, GradVal, Lane, LaneHead, NoteVal, Op, SongMetaC } from './protocol';

/** 比べるための形（値は JSON の文字にしておく） */
export interface LaneState {
  notes: Map<string, string>;
  events: Map<string, string>;
  grads: Map<string, string>;
  head: string;
  meta: string;
}

const noteVal = (n: ENote): NoteVal => {
  const v: NoteVal = { type: n.type };
  if (n.endTick !== undefined) v.endTick = n.endTick;
  if (n.hits !== undefined) v.hits = n.hits;
  return v;
};

/** 命令の鍵（同じ位置・同じ種類が 2 つあるとき（ゴーゴーの終わりと始まりなど）は 2 つ目に :1） */
function eventKeys(events: EEvent[]): [string, EEvent][] {
  const seen = new Map<string, number>();
  return events.map((e) => {
    const base = `${Math.round(e.tick)}:${e.kind}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [n ? `${base}:${n}` : base, e];
  });
}

export const gradKey = (g: { start: number; end: number }) => `${Math.round(g.start)}-${Math.round(g.end)}`;

const gradVal = (g: Grad): GradVal => ({
  id: gradKey(g), start: g.start, end: g.end, from: g.from, to: g.to, mode: g.mode, digits: g.digits,
  ...(g.basis ? { basis: g.basis } : {}), ...(g.speed ? { speed: g.speed } : {}),
});

export function headOf(chart: EChart, c: ECourse): LaneHead {
  return { bpm: chart.bpm, offset: chart.offset, level: c.level, scrollMode: c.scrollMode ?? '', extra: c.extra.map((x) => [x[0], x[1]] as [string, string]) };
}

export function metaOf(chart: EChart, audio: SongMetaC['audio']): Partial<SongMetaC> {
  return { title: chart.title, subtitle: chart.subtitle, demoStart: chart.demoStart, extra: chart.extra.map((x) => [x[0], x[1]] as [string, string]), audio };
}

const metaKey = (m: Partial<SongMetaC>) => JSON.stringify([m.title, m.subtitle, m.demoStart, m.extra]);

/** エディタの譜面（1 難易度）から比べる形を作る */
export function stateOf(chart: EChart, c: ECourse): LaneState {
  const notes = new Map<string, string>();
  for (const n of c.notes) notes.set(String(Math.round(n.tick)), JSON.stringify(noteVal(n)));
  const events = new Map<string, string>();
  for (const [k, e] of eventKeys(c.events)) events.set(k, JSON.stringify(e));
  const grads = new Map<string, string>();
  for (const g of c.grads ?? []) grads.set(gradKey(g), JSON.stringify(gradVal(g)));
  return { notes, events, grads, head: JSON.stringify(headOf(chart, c)), meta: metaKey(metaOf(chart, null)) };
}

/** レーンから比べる形を作る */
export function stateOfLane(doc: CollabDoc, lane: Lane): LaneState {
  const chart = laneToChart(doc, lane);
  return stateOf(chart, chart.courses[0]);
}

/**
 * 前と今を比べて、変わった所の Op と、それを元に戻す Op を作る
 */
export function diff(laneId: string, prev: LaneState, next: LaneState, chart: EChart): { ops: Op[]; inverse: Op[] } {
  const ops: Op[] = [];
  const inverse: Op[] = [];
  const parse = <T>(s: string | undefined) => (s === undefined ? null : (JSON.parse(s) as T));
  const maps: ['n' | 'e' | 'g', 'notes' | 'events' | 'grads'][] = [['n', 'notes'], ['e', 'events'], ['g', 'grads']];
  for (const [o, f] of maps) {
    const a = prev[f];
    const b = next[f];
    for (const [k, v] of b) {
      const old = a.get(k);
      if (old === v) continue;
      ops.push({ o, l: laneId, k, v: parse(v) } as Op);
      inverse.push({ o, l: laneId, k, v: parse(old) } as Op);
    }
    for (const [k, v] of a) {
      if (b.has(k)) continue;
      ops.push({ o, l: laneId, k, v: null } as Op);
      inverse.push({ o, l: laneId, k, v: parse(v) } as Op);
    }
  }
  if (prev.head !== next.head) {
    ops.push({ o: 'h', l: laneId, v: JSON.parse(next.head) });
    inverse.push({ o: 'h', l: laneId, v: JSON.parse(prev.head) });
  }
  if (prev.meta !== next.meta) {
    const m = metaOf(chart, null);
    delete m.audio;
    const [title, subtitle, demoStart, extra] = JSON.parse(prev.meta);
    ops.push({ o: 'm', v: m });
    inverse.push({ o: 'm', v: { title, subtitle, demoStart, extra } });
  }
  return { ops, inverse };
}

/** レーンから、エディタで開く譜面（難易度 1 つ）を作る */
export function laneToChart(doc: CollabDoc, lane: Lane): EChart {
  const course: ECourse = {
    name: lane.course,
    level: lane.head.level,
    notes: Object.entries(lane.notes).map(([k, v]) => ({ tick: Number(k), ...v })),
    events: Object.entries(lane.events)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([, v]) => ({ ...v }) as EEvent),
    extra: lane.head.extra.map((x) => [x[0], x[1]] as [string, string]),
    grads: Object.values(lane.grads).map((g) => {
      const out: Grad = { start: g.start, end: g.end, from: g.from, to: g.to, mode: g.mode, digits: g.digits };
      if (g.basis) out.basis = g.basis;
      if (g.speed) out.speed = g.speed;
      return out;
    }).sort((a, b) => a.start - b.start),
  };
  if (lane.head.scrollMode) course.scrollMode = lane.head.scrollMode;
  // 同じ位置・同じ種類の命令は、鍵の :1 の順に並べる（並べ替えは安定なので順番が保たれる）
  course.events.sort((a, b) => a.tick - b.tick);
  sortCourse(course);
  return {
    title: doc.meta.title,
    subtitle: doc.meta.subtitle,
    wave: doc.meta.audio?.name ?? '',
    bpm: lane.head.bpm,
    offset: lane.head.offset,
    demoStart: doc.meta.demoStart,
    extra: doc.meta.extra.map((x) => [x[0], x[1]] as [string, string]),
    courses: [course],
  };
}

/** エディタの譜面（ふつうの曲）から、レーンの中身を作る（共有を始めるとき） */
export function courseToLane(chart: EChart, c: ECourse, base: Pick<Lane, 'id' | 'name' | 'owner' | 'color' | 'main' | 'order'>): Lane {
  const st = stateOf(chart, c);
  const notes: Record<string, NoteVal> = {};
  for (const [k, v] of st.notes) notes[k] = JSON.parse(v);
  const events: Record<string, EventVal> = {};
  for (const [k, v] of st.events) events[k] = JSON.parse(v);
  const grads: Record<string, GradVal> = {};
  for (const [k, v] of st.grads) grads[k] = JSON.parse(v);
  return { ...base, course: c.name, head: headOf(chart, c), notes, events, grads };
}

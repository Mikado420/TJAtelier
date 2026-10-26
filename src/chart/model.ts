import type { BarLine, BeatPoint, Course, JposMove, Note, NoteType } from './types';
import type { Grad } from '../editor/grad';

/**
 * 編集用の譜面モデル。
 * 時刻（秒）ではなく「tick（拍の分割）」で位置を持つので、BPM を変えてもノーツが拍からずれない。
 * TPB = 1拍（4分音符）あたりの tick 数。1〜8, 12, 16, 24, 32, 48, 64 分割や 5・7 連符も整数で表せる値。
 */
export const TPB = 6720;

export interface ENote {
  tick: number;
  type: NoteType;
  /** 連打・風船の終点 */
  endTick?: number;
  /** 風船の打数 */
  hits?: number;
}

export type EEvent =
  | { tick: number; kind: 'bpm'; value: number }
  /** pin: グラデの始点・終点に、グラデの値の代わりに置いた #SCROLL（グラデを置き直しても消さない） */
  | { tick: number; kind: 'scroll'; value: number; pin?: boolean }
  | { tick: number; kind: 'measure'; num: number; den: number }
  | { tick: number; kind: 'gogo'; on: boolean }
  | { tick: number; kind: 'barline'; on: boolean }
  | { tick: number; kind: 'delay'; value: number }
  /** #JPOSSCROLL: 判定枠を time 秒かけて dist ピクセル動かす（dir: 1 = 右、0 = 左） */
  | { tick: number; kind: 'jpos'; time: number; dist: number; dir: 0 | 1 };

export type EventKind = EEvent['kind'];

export interface ECourse {
  name: string;
  level: number;
  notes: ENote[];
  events: EEvent[];
  /** LEVEL / BALLOON 以外の難易度ごとのヘッダ（SCOREINIT など）をそのまま保持 */
  extra: [string, string][];
  /**
   * 譜面の流れ方（#START の直前の #HBSCROLL）。拍の数で位置を決めるので、BPM が変わった瞬間に
   * レーン全体の速さが変わる。#SCROLL も効く（前の版の 'bm'・読み込んだ #BMSCROLL も同じ扱い）
   */
  scrollMode?: 'hb' | 'bm';
  /** グラデ（エディタの中だけで使う。.tja には書き込まない） */
  grads?: Grad[];
}

export interface EChart {
  title: string;
  subtitle: string;
  wave: string;
  bpm: number;
  offset: number;
  demoStart: number;
  /** 未対応のヘッダ（GENRE, SONGVOL など）をそのまま保持して書き出す */
  extra: [string, string][];
  courses: ECourse[];
}

export const COURSE_NAMES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'] as const;

export function newCourse(name = 'Oni', level = 1): ECourse {
  return { name, level, notes: [], events: [], extra: [] };
}

export function newChart(title = '新しい譜面', bpm = 120): EChart {
  return {
    title,
    subtitle: '',
    wave: '',
    bpm,
    offset: 0,
    demoStart: 0,
    extra: [],
    courses: [newCourse('Oni', 1)],
  };
}

export const isLong = (t: NoteType) => t === 'roll' || t === 'bigRoll' || t === 'balloon';

const EVENT_ORDER: EventKind[] = ['measure', 'bpm', 'scroll', 'gogo', 'barline', 'delay', 'jpos'];

export function sortCourse(c: ECourse) {
  c.notes.sort((a, b) => a.tick - b.tick);
  c.events.sort((a, b) => a.tick - b.tick || EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind));
}

// ---------- 小節 ----------

export interface Measure {
  index: number;
  start: number;
  length: number; // tick
  num: number;
  den: number;
}

/** #MEASURE num/den の 1 小節の tick（整数。とても短い小節でも 1 tick） */
export const measureTicks = (num: number, den: number) => Math.max(1, Math.round((TPB * 4 * num) / den));

/**
 * #MEASURE num/den の小節の中で、1 tick が本当は何 tick ぶんの長さか（本来の長さ ÷ 整数にした長さ）。
 * tick は整数で持つので、#MEASURE 1/40000 のような短い小節（本来 0.672 tick）は 1 tick に丸められる。
 * 秒に直すときにこれを掛けて、本来の長さで計算する（極端に遅い・速い BPM でもずれないように）
 */
export const measureScale = (num: number, den: number) => (TPB * 4 * num) / den / measureTicks(num, den);

/** untilTick を含むところまでの小節一覧 */
export function measures(c: ECourse, untilTick: number): Measure[] {
  const ms = c.events.filter((e) => e.kind === 'measure') as Extract<EEvent, { kind: 'measure' }>[];
  const out: Measure[] = [];
  let num = 4;
  let den = 4;
  let start = 0;
  let mi = 0;
  for (let index = 0; ; index++) {
    while (mi < ms.length && ms[mi].tick <= start) {
      num = ms[mi].num;
      den = ms[mi].den;
      mi++;
    }
    const length = measureTicks(num, den);
    out.push({ index, start, length, num, den });
    start += length;
    if (start > untilTick) break;
    if (index > 100000) break; // 念のため
  }
  return out;
}

export function measureAt(list: Measure[], tick: number): Measure {
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return list[lo];
}

/** 曲の内容（ノーツ・イベント）の最後の tick */
export function contentEnd(c: ECourse): number {
  let end = 0;
  for (const n of c.notes) end = Math.max(end, n.endTick ?? n.tick);
  for (const e of c.events) end = Math.max(end, e.tick);
  return end;
}

// ---------- 時間変換 ----------

interface Point {
  tick: number;
  time: number;
  bpm: number;
  /** この tick から先の、1 tick の本当の長さ（measureScale） */
  scale: number;
}

export class Timing {
  private readonly points: Point[] = [];

  constructor(chart: EChart, private readonly course: ECourse) {
    let time = 0 - chart.offset; // -chart.offset だと 0 のとき -0 になる
    let tick = 0;
    let bpm = chart.bpm > 0 ? chart.bpm : 120;
    let scale = 1;
    this.points.push({ tick: 0, time, bpm, scale });
    for (const e of course.events) {
      if (e.kind !== 'bpm' && e.kind !== 'delay' && e.kind !== 'measure') continue;
      time += ((e.tick - tick) * scale / TPB) * (60 / bpm);
      tick = e.tick;
      if (e.kind === 'bpm' && e.value > 0) bpm = e.value;
      if (e.kind === 'delay') time += e.value;
      if (e.kind === 'measure') scale = measureScale(e.num, e.den);
      this.points.push({ tick, time, bpm, scale });
    }
  }

  private pointAtTick(tick: number): Point {
    const p = this.points;
    let lo = 0;
    let hi = p.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (p[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    return p[lo];
  }

  tickToTime(tick: number): number {
    const p = this.pointAtTick(tick);
    return p.time + ((tick - p.tick) * p.scale / TPB) * (60 / p.bpm);
  }

  timeToTick(time: number): number {
    const p = this.points;
    let idx = 0;
    for (let i = 0; i < p.length; i++) if (p[i].time <= time) idx = i;
    const pt = p[idx];
    return pt.tick + ((time - pt.time) * pt.bpm * TPB) / 60 / pt.scale;
  }

  bpmAt(tick: number): number {
    return this.pointAtTick(tick).bpm;
  }

  private lastValue<K extends 'scroll' | 'gogo' | 'barline'>(kind: K, tick: number) {
    let v: EEvent | undefined;
    for (const e of this.course.events) {
      if (e.tick > tick) break;
      if (e.kind === kind) v = e;
    }
    return v as Extract<EEvent, { kind: K }> | undefined;
  }

  scrollAt(tick: number) {
    return this.lastValue('scroll', tick)?.value ?? 1;
  }
  gogoAt(tick: number) {
    return this.lastValue('gogo', tick)?.on ?? false;
  }
  barlineAt(tick: number) {
    return this.lastValue('barline', tick)?.on ?? true;
  }
}

/**
 * #HBSCROLL の拍の位置。tick → 拍の位置と、時刻 → 拍の位置の表を作る。
 * 拍の位置は BPM だけで決める（#SCROLL は入れない）。#SCROLL は、ふつうと同じく
 * 音符・小節線ごとの速さに掛ける（scrollAhead）ので、#BPMCHANGE が無ければふつうの流れ方と同じになる
 */
export function beatTable(chart: EChart, course: ECourse) {
  type P = { tick: number; time: number; beat: number; bpm: number; scale: number };
  let bpm = chart.bpm > 0 ? chart.bpm : 120;
  let p: P = { tick: 0, time: 0 - chart.offset, beat: 0, bpm, scale: 1 };
  const pts: P[] = [p];
  const time: BeatPoint[] = [{ time: p.time, beat: 0, rate: bpm / 60 }];
  for (const e of course.events) {
    if (e.kind !== 'bpm' && e.kind !== 'delay' && e.kind !== 'measure') continue;
    const dBeat = ((e.tick - p.tick) * p.scale) / TPB;
    const q: P = { ...p, tick: e.tick, time: p.time + dBeat * (60 / p.bpm), beat: p.beat + dBeat };
    if (e.kind === 'bpm' && e.value > 0) q.bpm = e.value;
    if (e.kind === 'measure') q.scale = measureScale(e.num, e.den);
    if (e.kind === 'delay') {
      // DELAY の間は止まる
      time.push({ time: q.time, beat: q.beat, rate: 0 });
      q.time += e.value;
    }
    time.push({ time: q.time, beat: q.beat, rate: q.bpm / 60 });
    pts.push(q);
    p = q;
  }
  const beatOf = (tick: number) => {
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].tick <= tick) lo = mid;
      else hi = mid - 1;
    }
    const a = pts[lo];
    return a.beat + ((tick - a.tick) * a.scale) / TPB;
  };
  return { beatOf, points: time };
}

/** 編集用モデル → プレイ用（秒ベース）に変換 */
export function toPlayable(chart: EChart, course: ECourse): Course {
  sortCourse(course);
  const t = new Timing(chart, course);
  const mode = course.scrollMode;
  const bt = mode ? beatTable(chart, course) : null;
  const notes: Note[] = course.notes.map((n) => {
    const note: Note = {
      type: n.type,
      time: t.tickToTime(n.tick),
      bpm: t.bpmAt(n.tick),
      scroll: t.scrollAt(n.tick),
      gogo: t.gogoAt(n.tick),
    };
    if (n.endTick !== undefined) note.endTime = t.tickToTime(n.endTick);
    if (n.type === 'balloon') note.hits = n.hits ?? 5;
    if (bt) {
      note.beat = bt.beatOf(n.tick);
      if (n.endTick !== undefined) note.endBeat = bt.beatOf(n.endTick);
    }
    return note;
  });
  const bars: BarLine[] = [];
  for (const m of measures(course, contentEnd(course))) {
    if (m.start > contentEnd(course)) break;
    if (!t.barlineAt(m.start)) continue;
    bars.push({ time: t.tickToTime(m.start), bpm: t.bpmAt(m.start), scroll: t.scrollAt(m.start), ...(bt ? { beat: bt.beatOf(m.start) } : {}) });
  }
  // ゴーゴー区間は「直前に通過したノーツ」ではなくイベントの時刻で決める
  // （#GOGOEND の後しばらくノーツがなくても、その時刻で解除されるように）
  const gogo: [number, number][] = [];
  let from: number | null = null;
  for (const e of course.events) {
    if (e.kind !== 'gogo') continue;
    const time = t.tickToTime(e.tick);
    if (e.on && from === null) from = time;
    else if (!e.on && from !== null) {
      gogo.push([from, time]);
      from = null;
    }
  }
  if (from !== null) gogo.push([from, Infinity]);
  // 判定枠の移動（#JPOSSCROLL）
  const jpos: JposMove[] = [];
  for (const e of course.events) {
    if (e.kind !== 'jpos') continue;
    jpos.push({ start: t.tickToTime(e.tick), time: e.time, dx: (e.dir ? 1 : -1) * e.dist });
  }
  return {
    name: course.name, level: course.level, notes, bars, gogo,
    ...(mode && bt ? { scrollMode: mode, beatPoints: bt.points } : {}),
    ...(jpos.length ? { jpos } : {}),
  };
}

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
  | { tick: number; kind: 'scroll'; value: number; pin?: boolean; im?: number }
  | { tick: number; kind: 'measure'; num: number; den: number }
  | { tick: number; kind: 'gogo'; on: boolean }
  | { tick: number; kind: 'barline'; on: boolean }
  | { tick: number; kind: 'delay'; value: number }
  /** #JPOSSCROLL: 判定枠を time 秒かけて dist ピクセル動かす（dir: 1 = 右、0 = 左） */
  | { tick: number; kind: 'jpos'; time: number; dist: number; dir: 0 | 1 }
  /** #LYRIC: 歌詞（次の #LYRIC まで出し続ける。空なら消す） */
  | { tick: number; kind: 'lyric'; text: string }
  /** #SECTION: 分岐の判定に使う数をここから数え直す */
  | { tick: number; kind: 'section' }
  /** #LEVELHOLD: ここから先は分岐しない */
  | { tick: number; kind: 'levelhold' };

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
  /** 譜面分岐の区間（時刻の順。区間の中の普通譜面は notes・events にある） */
  branches?: EBranch[];
  /** BALLOONNOR・BALLOONEXP・BALLOONMAS で風船の打数を書く */
  balloonPaths?: boolean;
}

/** 分岐の 1 つの譜面（区間の中の音符と命令） */
export interface BranchPart {
  notes: ENote[];
  events: EEvent[];
}

/** 譜面分岐の区間 [start, end)（#BRANCHSTART の小節から） */
export interface EBranch {
  start: number;
  end: number;
  /** p = 精度（%）・r = 連打数・s = スコア */
  type: 'p' | 'r' | 's';
  /** 玄人譜面になる値 */
  x: number;
  /** 達人譜面になる値 */
  y: number;
  /** 区間の終わりに #BRANCHEND を書く */
  close: boolean;
  e: BranchPart;
  m: BranchPart;
}

/** 0 = 普通・1 = 玄人・2 = 達人 */
export type BranchNo = 0 | 1 | 2;

/** 分岐しても全部の譜面で同じにする命令（時間の流れ） */
export const SHARED_KINDS = new Set<EEvent['kind']>(['bpm', 'measure', 'delay']);

/** その tick がどの区間か（区間は時刻の順に並んでいる。無ければ -1） */
function secOf(bs: EBranch[], tick: number): number {
  let lo = 0;
  let hi = bs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = bs[mid];
    if (tick < b.start) hi = mid - 1;
    else if (tick >= b.end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * その分岐で通したときの譜面（区間の外は共通、区間の中はその分岐の音符・命令。時間の流れは普通譜面のもの）。
 * 普通（0）・分岐なしは course そのもの。音符・命令は同じものを指す（写さない）
 */
export function branchPath(c: ECourse, k: BranchNo): ECourse {
  const bs = c.branches ?? [];
  if (!k || !bs.length) return c;
  const part = (b: EBranch) => (k === 1 ? b.e : b.m);
  // 共通の所と区間の所を、時刻の順のまま 1 回でつなぐ（並べ直さない）
  const notes: ENote[] = [];
  let bi = 0;
  for (const n of c.notes) {
    while (bi < bs.length && bs[bi].end <= n.tick) notes.push(...part(bs[bi++]).notes);
    if (bi < bs.length && n.tick >= bs[bi].start) continue;
    notes.push(n);
  }
  while (bi < bs.length) notes.push(...part(bs[bi++]).notes);
  const events = [...c.events.filter((e) => SHARED_KINDS.has(e.kind) || secOf(bs, e.tick) < 0), ...bs.flatMap((b) => part(b).events.filter((e) => !SHARED_KINDS.has(e.kind)))];
  const path: ECourse = { ...c, notes, events };
  delete path.branches;
  path.events.sort(eventCmp);
  return path;
}

/** branchPath で作った譜面の変更を、元の譜面（c）に書き戻す */
export function setBranchPath(c: ECourse, k: BranchNo, path: ECourse) {
  const bs = c.branches ?? [];
  if (!k || !bs.length || path === c) return;
  const ins = (t: number) => secOf(bs, t) >= 0;
  // 区間ごとに 1 回で分ける
  const pn: ENote[][] = bs.map(() => []);
  const pe: EEvent[][] = bs.map(() => []);
  const outN: ENote[] = [];
  for (const n of path.notes) {
    const i = secOf(bs, n.tick);
    if (i >= 0) pn[i].push(n);
    else outN.push(n);
  }
  for (const e of path.events) {
    if (SHARED_KINDS.has(e.kind)) continue;
    const i = secOf(bs, e.tick);
    if (i >= 0) pe[i].push(e);
  }
  bs.forEach((b, i) => {
    const part = k === 1 ? b.e : b.m;
    part.notes = pn[i];
    part.events = pe[i];
  });
  c.notes = [...c.notes.filter((n) => ins(n.tick)), ...outN];
  c.events = [...c.events.filter((e) => ins(e.tick) && !SHARED_KINDS.has(e.kind)), ...path.events.filter((e) => !ins(e.tick) || SHARED_KINDS.has(e.kind))];
  c.name = path.name;
  c.level = path.level;
  c.extra = path.extra;
  if (path.scrollMode) c.scrollMode = path.scrollMode;
  else delete c.scrollMode;
  c.grads = path.grads;
  sortCourse(c);
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
  /**
   * 自分で書いた（読み込んだ）TJA のテキスト。コメント・空行・改行の位置を残すために持っておき、
   * 書き出すときは、これに譜面の変更だけを書き込む（tjaPatch.ts の tjaText）
   */
  source?: string;
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

const EVENT_ORDER: EventKind[] = ['section', 'measure', 'bpm', 'scroll', 'gogo', 'barline', 'delay', 'jpos', 'lyric', 'levelhold'];

/** #SCROLL の値（a、a+bi・a-bi・bi のような複素数も）を読む。i の部分は縦の速さ */
export function parseScroll(arg: string): { value: number; im: number } | null {
  const s = arg.replace(/\s+/g, '').toLowerCase();
  if (!s) return null;
  if (!s.endsWith('i')) {
    const v = Number(s);
    return Number.isFinite(v) ? { value: v, im: 0 } : null;
  }
  const body = s.slice(0, -1);
  // 実部と虚部の境目: 最後の + か -（先頭と、指数の e の直後は除く）
  let k = -1;
  for (let i = body.length - 1; i > 0; i--) if ((body[i] === '+' || body[i] === '-') && body[i - 1] !== 'e') { k = i; break; }
  const reS = k < 0 ? '' : body.slice(0, k);
  const imS = k < 0 ? body : body.slice(k);
  const re = reS === '' ? 0 : Number(reS);
  const im = imS === '' || imS === '+' ? 1 : imS === '-' ? -1 : Number(imS);
  return Number.isFinite(re) && Number.isFinite(im) ? { value: re, im } : null;
}

/** #SCROLL の値を文字にする（虚部があれば a+bi） */
export function scrollText(value: number, im = 0, digits = 6): string {
  const f = (v: number) => String(Number(v.toFixed(digits)));
  if (!im) return f(value);
  const a = Math.abs(im);
  return `${f(value)}${im < 0 ? '-' : '+'}${a === 1 ? '' : f(a)}i`;
}

const eventCmp = (a: EEvent, b: EEvent) => a.tick - b.tick || EVENT_ORDER.indexOf(a.kind) - EVENT_ORDER.indexOf(b.kind);

export function sortCourse(c: ECourse) {
  const ev = eventCmp;
  c.notes.sort((a, b) => a.tick - b.tick);
  c.events.sort(ev);
  if (c.branches) {
    c.branches.sort((a, b) => a.start - b.start);
    for (const b of c.branches) for (const p of [b.e, b.m]) { p.notes.sort((x, y) => x.tick - y.tick); p.events.sort(ev); }
  }
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
  for (const b of c.branches ?? []) {
    // 区間の終わり（#BRANCHEND の位置）まで小節を書く
    if (Number.isFinite(b.end)) end = Math.max(end, b.end - 1);
    for (const p of [b.e, b.m]) {
      for (const n of p.notes) end = Math.max(end, n.endTick ?? n.tick);
      for (const e of p.events) end = Math.max(end, e.tick);
    }
  }
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
  /** #SCROLL の虚部（縦の速さ） */
  scrollImAt(tick: number) {
    return this.lastValue('scroll', tick)?.im ?? 0;
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

/** 編集用モデル → プレイ用（秒ベース）に変換。分岐があれば、全部の分岐の音符を入れて、区間と分岐の印を付ける */
export function toPlayable(chart: EChart, course: ECourse): Course {
  const bs = course.branches ?? [];
  if (!bs.length) return playOne(chart, course);
  sortCourse(course);
  const tagOf = (k: BranchNo) => (n: Note, tick: number) => {
    const i = secOf(bs, tick);
    if (i >= 0) { n.sec = i; n.br = k; }
  };
  const base = playOne(chart, course, tagOf(0));
  const paths = ([1, 2] as const).map((k) => ({ k, p: playOne(chart, branchPath(course, k), tagOf(k)) }));
  const notes = [...base.notes];
  for (const { p } of paths) for (const n of p.notes) if (n.sec !== undefined) notes.push(n);
  notes.sort((a, b) => a.time - b.time || (a.br ?? 0) - (b.br ?? 0));
  const t = new Timing(chart, course);
  const ms = measures(course, Math.max(0, ...bs.map((b) => b.start)));
  const branches = bs.map((b) => {
    const i = ms.findIndex((m) => m.start >= b.start);
    const judgeTick = i > 0 ? ms[i - 1].start : b.start;
    return { start: t.tickToTime(b.start), end: Number.isFinite(b.end) ? t.tickToTime(b.end) : Infinity, judge: t.tickToTime(judgeTick), type: b.type, x: b.x, y: b.y };
  });
  // #SECTION（どの分岐に書いてあっても）・#LEVELHOLD（分岐の中なら、その分岐にいるときだけ）
  const sections = new Set<number>();
  const holds: { time: number; br?: number }[] = [];
  ([0, 1, 2] as const).forEach((k) => {
    for (const e of branchPath(course, k).events) {
      const inSec = secOf(bs, e.tick) >= 0;
      if (e.kind === 'section') sections.add(t.tickToTime(e.tick));
      if (e.kind === 'levelhold' && (inSec || k === 0)) holds.push({ time: t.tickToTime(e.tick), ...(inSec ? { br: k } : {}) });
    }
  });
  return { ...base, notes, branches, sections: [...sections].sort((a, b) => a - b), holds: holds.sort((a, b) => a.time - b.time) };
}

/** 分岐の無い 1 本の譜面 → プレイ用 */
function playOne(chart: EChart, course: ECourse, tag?: (n: Note, tick: number) => void): Course {
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
    const im = t.scrollImAt(n.tick);
    if (im) note.scrollY = im;
    if (n.endTick !== undefined) note.endTime = t.tickToTime(n.endTick);
    if (n.type === 'balloon') note.hits = n.hits ?? 5;
    if (bt) {
      note.beat = bt.beatOf(n.tick);
      if (n.endTick !== undefined) note.endBeat = bt.beatOf(n.endTick);
    }
    tag?.(note, n.tick);
    return note;
  });
  const bars: BarLine[] = [];
  const cEnd = contentEnd(course);
  for (const m of measures(course, cEnd)) {
    if (m.start > cEnd) break;
    if (!t.barlineAt(m.start)) continue;
    const im = t.scrollImAt(m.start);
    bars.push({ time: t.tickToTime(m.start), bpm: t.bpmAt(m.start), scroll: t.scrollAt(m.start), ...(im ? { scrollY: im } : {}), ...(bt ? { beat: bt.beatOf(m.start) } : {}) });
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
  // 歌詞（#LYRIC）
  const lyrics = course.events.filter((e) => e.kind === 'lyric').map((e) => ({ time: t.tickToTime(e.tick), text: (e as { text: string }).text }));
  return {
    name: course.name, level: course.level, notes, bars, gogo,
    ...(mode && bt ? { scrollMode: mode, beatPoints: bt.points } : {}),
    ...(jpos.length ? { jpos } : {}),
    ...(lyrics.length ? { lyrics } : {}),
  };
}

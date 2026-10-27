import { TPB, type ECourse, type Timing } from '../chart/model';

/**
 * #DELAY のある譜面を、エディタで本来の位置に並べるための表。
 * 横の位置は「表示の位置」（tick と同じ単位）: DELAY の後ろは、その秒数ぶんの tick だけずらす。
 * プラスの DELAY は空きになり、マイナスの DELAY は前と重なる。重なった所だけ下の段（2 段目・3 段目）へ出す。
 */

/** 1 つの段の 1 区間。表示の位置 [a, b) にあり、tick = 表示の位置 - shift */
export interface Piece { a: number; b: number; shift: number; row: number }

interface Seg {
  /** tick の範囲 [t0, t1) */
  t0: number;
  t1: number;
  shift: number;
  /** 始まりの時刻（DELAY の後） */
  start: number;
  /** 終わりの時刻（次の DELAY の前） */
  end: number;
  /** 終わりのあたりの 1 秒あたりの tick */
  rateEnd: number;
}

export const MAX_ROWS = 3;
/** 段の境目ちょうどの音符が、計算の誤差で前の段に入らないように */
const EPS = 1e-6;

export class DelayLanes {
  readonly pieces: Piece[] = [];
  /** 段の数（1 なら DELAY で重なる所はない） */
  readonly rows: number = 1;
  private readonly segs: Seg[] = [];

  constructor(course: ECourse, private readonly timing: Timing) {
    // 同じ tick の DELAY はまとめる
    const ds = new Map<number, number>();
    for (const e of course.events) if (e.kind === 'delay' && e.value) ds.set(e.tick, (ds.get(e.tick) ?? 0) + e.value);
    const ticks = [...ds.keys()].sort((a, b) => a - b);
    let shift = 0;
    let t0 = -Infinity;
    let start = -Infinity;
    for (const tk of ticks) {
      const d = ds.get(tk)!;
      const rateBefore = 1 / Math.max(1e-9, timing.tickToTime(tk) - d - timing.tickToTime(tk - 1));
      const rateAfter = 1 / Math.max(1e-9, timing.tickToTime(tk + 1) - timing.tickToTime(tk));
      this.segs.push({ t0, t1: tk, shift, start, end: timing.tickToTime(tk) - d, rateEnd: rateBefore });
      shift += d * rateAfter;
      t0 = tk;
      start = timing.tickToTime(tk);
    }
    this.segs.push({ t0, t1: Infinity, shift, start, end: Infinity, rateEnd: 0 });
    if (this.segs.length === 1) {
      this.pieces.push({ a: -Infinity, b: Infinity, shift: 0, row: 0 });
      return;
    }

    // 段を決める: 上の段で空いている所はそこへ、ふさがっている所は下の段へ
    const occ: [number, number][][] = Array.from({ length: MAX_ROWS }, () => []);
    let rows = 1;
    for (const s of this.segs) {
      let rem: [number, number][] = [[s.t0 + s.shift, s.t1 + s.shift]];
      for (let r = 0; r < MAX_ROWS && rem.length; r++) {
        const next: [number, number][] = [];
        for (const [x, y] of rem) {
          if (r === MAX_ROWS - 1) {
            this.pieces.push({ a: x, b: y, shift: s.shift, row: r });
            occ[r].push([x, y]);
            rows = Math.max(rows, r + 1);
            continue;
          }
          const { free, used } = cut(x, y, occ[r]);
          for (const [p, q] of free) {
            this.pieces.push({ a: p, b: q, shift: s.shift, row: r });
            occ[r].push([p, q]);
            rows = Math.max(rows, r + 1);
          }
          next.push(...used);
        }
        rem = next;
      }
    }
    this.rows = rows;
  }

  get hasDelay() {
    return this.segs.length > 1;
  }

  private segOf(tick: number): Seg {
    const ss = this.segs;
    for (let i = ss.length - 1; i > 0; i--) if (tick >= ss[i].t0) return ss[i];
    return ss[0];
  }

  /** tick → 表示の位置 */
  disp(tick: number) {
    return this.segs.length === 1 ? tick : tick + this.segOf(tick).shift;
  }

  /** tick がどの段にあるか */
  rowOf(tick: number) {
    if (this.rows === 1) return 0;
    const s = this.segOf(tick);
    const d = tick + s.shift;
    for (const p of this.pieces) if (p.shift === s.shift && d >= p.a - EPS && d < p.b - EPS) return p.row;
    return 0;
  }

  /** 表示の位置と段 → tick（その段のそこに何もなければ null） */
  tickAt(d: number, row: number): number | null {
    if (this.segs.length === 1) return row === 0 ? d : null;
    for (const p of this.pieces) if (p.row === row && d >= p.a - EPS && d < p.b - EPS) return d - p.shift;
    return null;
  }

  /** 時刻 → 表示の位置（再生中の位置。DELAY の空きの間も止まらずに進む） */
  dispOfTime(t: number) {
    const ss = this.segs;
    let s = ss[0];
    for (let i = ss.length - 1; i > 0; i--) if (t >= ss[i].start) { s = ss[i]; break; }
    if (s.t0 === -Infinity && s.t1 === Infinity) return this.timing.timeToTick(t);
    if (t >= s.end) return s.t1 + s.shift + (t - s.end) * s.rateEnd;
    // 区間の中は tick → 時刻が増えていくので、二分探索
    let lo = s.t0 === -Infinity ? Math.min(s.t1, this.timing.timeToTick(t)) - TPB : s.t0;
    let hi = s.t1 === Infinity ? Math.max(lo, this.timing.timeToTick(t)) + TPB : s.t1;
    while (this.timing.tickToTime(lo) > t) lo -= TPB * 4;
    while (s.t1 === Infinity && this.timing.tickToTime(hi) < t) hi += TPB * 4;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (this.timing.tickToTime(mid) <= t) lo = mid;
      else hi = mid;
    }
    return lo + s.shift;
  }

  /** 表示の位置 → 時刻（波形用。1 段目の位置。空きは前後をつなぐ） */
  timeOfDisp(d: number) {
    if (this.segs.length === 1) return this.timing.tickToTime(d);
    for (const p of this.pieces) if (p.row === 0 && d >= p.a - EPS && d < p.b - EPS) return this.timing.tickToTime(d - p.shift);
    // 空き（プラスの DELAY）: 前の区間の終わりから続ける
    for (const s of this.segs) {
      const e = s.t1 + s.shift;
      if (d >= e) {
        const nx = this.segs[this.segs.indexOf(s) + 1];
        if (nx && d < nx.t0 + nx.shift) return s.end + (d - e) / s.rateEnd;
      }
    }
    return this.timing.tickToTime(d);
  }

  /** tick の範囲 [ta, tb) が、どの段のどこに出るか（表示の位置） */
  spans(ta: number, tb: number) {
    const out: { row: number; a: number; b: number }[] = [];
    for (const p of this.pieces) {
      const a = Math.max(ta + p.shift, p.a);
      const b = Math.min(tb + p.shift, p.b);
      if (b > a) out.push({ row: p.row, a, b });
    }
    return out;
  }

  /** 表示の位置の範囲 [da, db] に出る tick の範囲 */
  tickRange(da: number, db: number): [number, number] {
    if (this.segs.length === 1) return [da, db];
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of this.pieces) {
      const a = Math.max(da, p.a);
      const b = Math.min(db, p.b);
      if (b < a) continue;
      lo = Math.min(lo, a - p.shift);
      hi = Math.max(hi, b - p.shift);
    }
    return lo === Infinity ? [da, da] : [lo, hi];
  }
}

/** [x, y) を、ふさがっている所（occ）とそれ以外に分ける */
function cut(x: number, y: number, occ: [number, number][]) {
  const used: [number, number][] = [];
  for (const [p, q] of occ) {
    const a = Math.max(x, p);
    const b = Math.min(y, q);
    if (b > a) used.push([a, b]);
  }
  used.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const u of used) {
    const l = merged[merged.length - 1];
    if (l && u[0] <= l[1]) l[1] = Math.max(l[1], u[1]);
    else merged.push([u[0], u[1]]);
  }
  const free: [number, number][] = [];
  let c = x;
  for (const [a, b] of merged) {
    if (a > c) free.push([c, a]);
    c = Math.max(c, b);
  }
  if (c < y) free.push([c, y]);
  return { free, used: merged };
}

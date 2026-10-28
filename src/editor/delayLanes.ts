import { TPB, type ECourse, type Timing } from '../chart/model';

/**
 * #DELAY のある譜面を、エディタで本来の位置に並べるための表。
 * 横の位置は「表示の位置」（tick と同じ単位）。表示の位置は時刻だけで決まる（どの段の音符も、同じ時刻なら同じ x）。
 *   - DELAY のない所は表示の位置 = tick（今までどおり）
 *   - プラスの DELAY は空き（その間も前の速さで進む）
 *   - マイナスの DELAY で前と重なる所は、先に流れている区間の速さで進み、その区間が終わったら次の区間の速さに変わる
 * 時刻が重なる区間は、下の段（2 段目・3 段目）へ出す。
 */

/** 1 つの段の 1 区間。表示の位置 [a, b) にあり、区間 seg の音符が出る */
export interface Piece { a: number; b: number; row: number; seg: number }

interface Seg {
  /** tick の範囲 [t0, t1) */
  t0: number;
  t1: number;
  /** 始まりの時刻（DELAY の後） */
  start: number;
  /** 終わりの時刻（次の DELAY の前） */
  end: number;
}

/** 時刻 → 表示の位置 の 1 区間。区間 seg の流れ（表示の位置 = その時刻の tick + sh）か、空き（rate で進む） */
interface Flow { ta: number; tb: number; seg: number; sh: number; d0: number; rate: number }

export const MAX_ROWS = 3;
/** 段の境目ちょうどの音符が、計算の誤差で前の段に入らないように */
const EPS = 1e-6;

export class DelayLanes {
  readonly pieces: Piece[] = [];
  /** 段の数（1 なら DELAY で重なる所はない） */
  readonly rows: number = 1;
  private readonly segs: Seg[] = [];
  private readonly flows: Flow[] = [];

  constructor(course: ECourse, private readonly timing: Timing) {
    // 同じ tick の DELAY はまとめる
    const ds = new Map<number, number>();
    for (const e of course.events) if (e.kind === 'delay' && e.value) ds.set(e.tick, (ds.get(e.tick) ?? 0) + e.value);
    const ticks = [...ds.keys()].sort((a, b) => a - b);
    let t0 = -Infinity;
    let start = -Infinity;
    for (const tk of ticks) {
      this.segs.push({ t0, t1: tk, start, end: timing.tickToTime(tk) - ds.get(tk)! });
      t0 = tk;
      start = timing.tickToTime(tk);
    }
    this.segs.push({ t0, t1: Infinity, start, end: Infinity });
    if (this.segs.length === 1) {
      this.pieces.push({ a: -Infinity, b: Infinity, row: 0, seg: 0 });
      return;
    }

    // 時刻 → 表示の位置: 先に流れている区間が終わるまではその区間、終わったら次の区間。間が空いたら前の速さで進む
    this.flows.push({ ta: -Infinity, tb: this.segs[0].end, seg: 0, sh: 0, d0: 0, rate: 0 });
    let front = this.segs[0].end;
    let frontSeg = 0;
    for (let i = 1; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (s.end <= front) continue;
      let from = front;
      if (s.start > front) {
        // 空き: 前の区間の終わりの速さで進む
        const d0 = this.dispOfTime(front);
        const rate = this.rateAt(frontSeg, front);
        this.flows.push({ ta: front, tb: s.start, seg: -1, sh: 0, d0, rate });
        from = s.start;
      }
      const d = this.dispOfTime(from);
      this.flows.push({ ta: from, tb: s.end, seg: i, sh: d - this.segTick(i, from), d0: 0, rate: 0 });
      front = s.end;
      frontSeg = i;
    }

    // 段を決める: 上の段で空いている所はそこへ、ふさがっている所は下の段へ
    const occ: [number, number][][] = Array.from({ length: MAX_ROWS }, () => []);
    let rows = 1;
    this.segs.forEach((s, i) => {
      const x = s.start === -Infinity ? -Infinity : this.dispOfTime(s.start);
      const y = s.end === Infinity ? Infinity : this.dispOfTime(s.end);
      if (!(y > x)) return;
      let rem: [number, number][] = [[x, y]];
      for (let r = 0; r < MAX_ROWS && rem.length; r++) {
        const next: [number, number][] = [];
        for (const [p, q] of rem) {
          if (r === MAX_ROWS - 1) {
            this.pieces.push({ a: p, b: q, row: r, seg: i });
            occ[r].push([p, q]);
            rows = Math.max(rows, r + 1);
            continue;
          }
          const { free, used } = cut(p, q, occ[r]);
          for (const [a, b] of free) {
            this.pieces.push({ a, b, row: r, seg: i });
            occ[r].push([a, b]);
            rows = Math.max(rows, r + 1);
          }
          next.push(...used);
        }
        rem = next;
      }
    });
    this.rows = rows;
  }

  get hasDelay() {
    return this.segs.length > 1;
  }

  private segIndexOf(tick: number) {
    const ss = this.segs;
    for (let i = ss.length - 1; i > 0; i--) if (tick >= ss[i].t0) return i;
    return 0;
  }

  /** 区間 i の中で、時刻 t の tick（区間の外へも、同じ流れのまま伸ばす） */
  private segTick(i: number, t: number) {
    const s = this.segs[i];
    const tm = this.timing;
    let lo = Number.isFinite(s.t0) ? s.t0 : Math.min(Number.isFinite(s.t1) ? s.t1 : 0, tm.timeToTick(t)) - TPB;
    let hi = Number.isFinite(s.t1) ? s.t1 : Math.max(lo, tm.timeToTick(t)) + TPB;
    // 区間の中では tick → 時刻は増えていく。区間の外の時刻は、端の速さでそのまま伸ばす
    const startRate = Number.isFinite(s.t0) ? 1 / Math.max(1e-9, tm.tickToTime(s.t0 + 1) - tm.tickToTime(s.t0)) : 0;
    const time = (tk: number) =>
      Number.isFinite(s.t1) && tk >= s.t1
        ? s.end + (tk - s.t1) / this.rateAt(i, s.end)
        : Number.isFinite(s.t0) && tk < s.t0
          ? s.start + (tk - s.t0) / startRate
          : tm.tickToTime(tk);
    let guard = 0;
    while (time(lo) > t && guard++ < 4000) lo -= TPB * 64;
    guard = 0;
    while (time(hi) < t && guard++ < 4000) hi += TPB * 64;
    for (let k = 0; k < 50; k++) {
      const mid = (lo + hi) / 2;
      if (time(mid) <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** 区間 i の、時刻 t のあたりの 1 秒あたりの tick */
  private rateAt(i: number, t: number) {
    const s = this.segs[i];
    const tk = Number.isFinite(s.t1) && t >= s.end ? s.t1 : this.segTick(i, t);
    const a = Math.max(Number.isFinite(s.t0) ? s.t0 : -Infinity, tk - 1);
    const b = a + 1;
    const dt = this.timing.tickToTime(b) - this.timing.tickToTime(a) - (Number.isFinite(s.t1) && b >= s.t1 ? this.timing.tickToTime(s.t1) - s.end : 0);
    return 1 / Math.max(1e-9, dt);
  }

  /** tick → 表示の位置（その音符の鳴る時刻の位置） */
  disp(tick: number) {
    if (this.segs.length === 1) return tick;
    const t = this.timing.tickToTime(tick);
    // その時刻に流れている区間の音符なら、tick をずらすだけ（探さなくてよい）
    const f = this.flowAt(t);
    if (f.seg !== -1 && f.seg === this.segIndexOf(tick)) return tick + f.sh;
    return this.dispOfTime(t);
  }

  private flowAt(t: number): Flow {
    const fs = this.flows;
    for (let i = fs.length - 1; i > 0; i--) if (t >= fs[i].ta) return fs[i];
    return fs[0];
  }

  /** tick がどの段にあるか */
  rowOf(tick: number) {
    if (this.rows === 1) return 0;
    const i = this.segIndexOf(tick);
    const d = this.disp(tick);
    for (const p of this.pieces) if (p.seg === i && d >= p.a - EPS && d < p.b - EPS) return p.row;
    for (const p of this.pieces) if (p.seg === i) return p.row;
    return 0;
  }

  /** 表示の位置と段 → tick（その段のそこに何もなければ null） */
  tickAt(d: number, row: number): number | null {
    if (this.segs.length === 1) return row === 0 ? d : null;
    for (const p of this.pieces) if (p.row === row && d >= p.a - EPS && d < p.b - EPS) return this.segTick(p.seg, this.timeOfDisp(d));
    return null;
  }

  /** 時刻 → 表示の位置（再生中の位置。DELAY の空きの間も止まらずに進む） */
  dispOfTime(t: number) {
    if (this.segs.length === 1) return this.timing.timeToTick(t);
    const f = this.flowAt(t);
    if (f.seg === -1) return f.d0 + (t - f.ta) * f.rate;
    return this.segTick(f.seg, t) + f.sh;
  }

  /** 表示の位置 → 時刻（波形用。どの段でも同じ） */
  timeOfDisp(d: number) {
    if (this.segs.length === 1) return this.timing.tickToTime(d);
    const fs = this.flows;
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      if (i > 0 && d < this.dispOfTime(f.ta)) continue;
      if (f.seg === -1) return f.ta + (d - f.d0) / f.rate;
      const s = this.segs[f.seg];
      const tk = d - f.sh;
      if (Number.isFinite(s.t1) && tk >= s.t1) return s.end + (tk - s.t1) / this.rateAt(f.seg, s.end);
      return this.timing.tickToTime(tk);
    }
    return this.timing.tickToTime(d);
  }

  /** tick の範囲 [ta, tb) が、どの段のどこに出るか（表示の位置） */
  spans(ta: number, tb: number) {
    const out: { row: number; a: number; b: number }[] = [];
    if (this.segs.length === 1) return [{ row: 0, a: ta, b: tb }];
    for (const p of this.pieces) {
      const s = this.segs[p.seg];
      const x = Math.max(ta, s.t0);
      const y = Math.min(tb, s.t1);
      if (!(y > x)) continue;
      const a = Math.max(this.disp(x), p.a);
      const b = Math.min(Number.isFinite(y) && y === s.t1 ? this.dispOfTime(s.end) : this.disp(y), p.b);
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
      lo = Math.min(lo, this.segTick(p.seg, this.timeOfDisp(a)));
      hi = Math.max(hi, this.segTick(p.seg, this.timeOfDisp(b)));
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

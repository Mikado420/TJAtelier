import {
  branchPath, measureAt, measures, newChart, newCourse, setBranchPath, sortCourse, Timing, TPB, contentEnd, isLong,
  type BranchNo, type EBranch, type EChart, type ECourse, type EEvent, type ENote, type Measure,
} from '../chart/model';
import type { NoteType } from '../chart/types';
import type { AudioFile } from '../io/load';
import { applyGrad, gradMatches, markPins, type Grad } from './grad';

/** scroll = #SCROLL（1 か所をタップ×2 でその位置だけ、2 か所でグラデ）、bpm = #BPMCHANGE、measure = #MEASURE */
export type Tool = NoteType | 'erase' | 'gogo' | 'scroll' | 'bpm' | 'measure' | 'select';

/** 1拍あたりの分割数（Malody の 1/n 表記と同じ） */
/** グリッド: 1 小節（4/4、全音符）を何分割するか。1/16 なら 16 分音符 */
export const DIVISORS = [8, 12, 16, 24, 32, 48, 64];

export interface TapResult {
  message?: string;
  /** UI 側で打数を聞く風船 */
  editBalloon?: ENote;
  /** UI 側で設定を聞くグラデ（新しく作る範囲） */
  newGrad?: { start: number; end: number };
  /** UI 側で設定を変えるグラデ */
  editGrad?: Grad;
  /** UI 側で選ばせる、グラデの始点・終点（つなぎ目）の上のタップ（before = ここで終わるグラデ、after = ここから始まるグラデ） */
  gradPick?: { tick: number; before?: Grad; after?: Grad };
  /** 範囲を選び終えた */
  selected?: boolean;
  /** UI 側で値を聞く、1 か所の命令（#SCROLL / #BPMCHANGE / #MEASURE） */
  point?: { kind: 'scroll' | 'bpm' | 'measure'; tick: number };
}

/**
 * エディタの状態と編集操作。描画・DOM からは独立。
 * 変更はすべて mutate() を通すので Undo/Redo と自動保存が効く。
 */
export class Editor {
  chart: EChart;
  courseIndex = 0;
  audio: AudioFile | null = null;
  tool: Tool = 'don';
  /** 1 小節（4/4、全音符 = 4 拍）を何分割するか */
  divisor = 16;
  /** 連打・風船・ゴーゴーの始点（終点のタップ待ち） */
  pendingLong: number | null = null;
  timing!: Timing;
  /** 選んでいる範囲（選択ツール。両端を含む） */
  sel: { start: number; end: number } | null = null;
  /** コピーしたノーツ（範囲の始まりからの位置）と範囲の長さ。曲を替えても残る */
  clip: { notes: ENote[]; span: number } | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<(structural: boolean) => void>();
  private measureCache: Measure[] = [];

  constructor(chart: EChart = newChart()) {
    this.chart = chart;
    this.refresh();
  }

  /** 譜面分岐: 編集している分岐（0 = 普通・1 = 玄人・2 = 達人） */
  branch: BranchNo = 0;
  /** 玄人・達人を編集しているときの、その分岐で通した譜面（変更は mutate のあとで書き戻す） */
  private path: { of: ECourse; k: BranchNo; c: ECourse } | null = null;

  /** 難易度の譜面そのもの（分岐の区間を持つ。区間の中の音符は普通譜面） */
  get mainCourse(): ECourse {
    return this.chart.courses[this.courseIndex];
  }

  /** 編集する譜面（玄人・達人を開いているときは、その分岐で通した譜面） */
  get course(): ECourse {
    const main = this.mainCourse;
    if (!this.branch || !main?.branches?.length) return main;
    const p = this.path;
    if (p && p.of === main && p.k === this.branch) return p.c;
    const c = branchPath(main, this.branch);
    this.path = { of: main, k: this.branch, c };
    return c;
  }

  /** 開く分岐を替える */
  setBranch(k: BranchNo) {
    if (this.branch === k) return;
    this.branch = k;
    this.path = null;
    this.pendingLong = null;
    this.emit(true);
  }

  onChange(fn: (structural: boolean) => void) {
    this.listeners.add(fn);
  }

  /** structural=true: 譜面の内容が変わった（保存対象） */
  emit(structural = false) {
    if (structural) { this.refresh(); this.version++; }
    for (const fn of this.listeners) fn(structural);
  }

  private refresh() {
    if (!this.chart.courses.length) this.chart.courses.push(newCourse());
    this.courseIndex = Math.min(this.courseIndex, this.chart.courses.length - 1);
    this.path = null;
    for (const c of this.chart.courses) sortCourse(c);
    this.timing = new Timing(this.chart, this.course);
    this.measureCache = [];
  }

  load(chart: EChart, audio: AudioFile | null, courseIndex?: number) {
    this.chart = chart;
    this.audio = audio;
    // 指定がなければ一番難しい（最後の）難易度を開く
    this.courseIndex = courseIndex ?? Math.max(0, chart.courses.length - 1);
    this.pendingLong = null;
    this.sel = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit(true);
  }

  // ---------- Undo / Redo ----------

  private snapshot() {
    // 元のテキスト（source）は大きいので写さない（戻したあとも今のテキストに変更を書き込めば合う）
    return JSON.stringify({ chart: { ...this.chart, source: undefined }, courseIndex: this.courseIndex });
  }

  private restore(s: string) {
    const o = JSON.parse(s) as { chart: EChart; courseIndex: number };
    if (this.chart.source) o.chart.source = this.chart.source;
    this.path = null;
    this.chart = o.chart;
    this.courseIndex = o.courseIndex;
    this.pendingLong = null;
    this.sel = null;
    this.emit(true);
  }

  mutate(fn: () => void) {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    fn();
    // 玄人・達人の変更を、難易度の譜面に書き戻す
    const p = this.path;
    if (p) setBranchPath(p.of, p.k, p.c);
    this.path = null;
    this.applyGrads();
    this.emit(true);
  }

  // ---------- 譜面分岐 ----------

  /** 小節 [a, b) を分岐の区間にする（玄人・達人は普通譜面を写す）。重なる区間があれば作らない */
  addBranch(startTick: number, endTick: number): EBranch | null {
    const main = this.mainCourse;
    const ms = this.measuresUntil(endTick + 1);
    const a = measureAt(ms, startTick).start;
    const m2 = measureAt(ms, Math.max(startTick, endTick));
    const b = m2.start + m2.length;
    if ((main.branches ?? []).some((x) => x.start < b && a < x.end)) return null;
    let out: EBranch | null = null;
    this.mutate(() => {
      const c = this.mainCourse;
      const notes = c.notes.filter((n) => n.tick >= a && n.tick < b);
      const events = c.events.filter((e) => e.tick >= a && e.tick < b && e.kind !== 'bpm' && e.kind !== 'measure' && e.kind !== 'delay');
      const copy = () => ({ notes: notes.map((n) => ({ ...n })), events: events.map((e) => ({ ...e })) });
      out = { start: a, end: b, type: 'p', x: 60, y: 80, close: true, e: copy(), m: copy() };
      (c.branches ??= []).push(out);
      sortCourse(c);
    });
    return out;
  }

  /** 区間を消す（その区間は、開いている分岐の譜面を残す） */
  removeBranch(b: EBranch) {
    this.mutate(() => {
      const c = this.mainCourse;
      const k = this.branch;
      if (k) {
        const part = k === 1 ? b.e : b.m;
        c.notes = [...c.notes.filter((n) => n.tick < b.start || n.tick >= b.end), ...part.notes];
        c.events = [...c.events.filter((e) => e.tick < b.start || e.tick >= b.end || e.kind === 'bpm' || e.kind === 'measure' || e.kind === 'delay'), ...part.events];
      }
      c.branches = (c.branches ?? []).filter((x) => x !== b);
      if (!c.branches.length) delete c.branches;
      sortCourse(c);
    });
    this.path = null;
  }

  /** 区間の条件を変える */
  setBranchCond(b: EBranch, type: EBranch['type'], x: number, y: number) {
    this.mutate(() => {
      const t = (this.mainCourse.branches ?? []).find((q) => q.start === b.start) ?? b;
      t.type = type;
      t.x = x;
      t.y = y;
    });
  }

  /** グラデの範囲の #SCROLL を置き直す（範囲の中の音符が増えたり減ったりしても、値が合うように） */
  private applyGrads() {
    for (const c of this.chart.courses) {
      if (!c.grads?.length) continue;
      sortCourse(c);
      for (const g of c.grads) applyGrad(c, g, this.chart.bpm);
    }
  }

  /**
   * 譜面全体を差し替える（TJA のテキストを書き換えたとき）。
   * pushUndo = false のときは元に戻すの記録を増やさない（入力中の自動反映は、書き始めの 1 回だけ記録する）
   */
  replaceChart(chart: EChart, pushUndo = true) {
    const apply = () => {
      const name = this.chart.courses[this.courseIndex]?.name;
      // グラデは .tja に書かないので、前の譜面から引き継ぐ。#SCROLL がグラデのとおりに残っているものだけ
      for (const c of chart.courses) {
        const old = this.chart.courses.find((o) => o.name === c.name);
        if (!old?.grads?.length) continue;
        sortCourse(c);
        const keep = old.grads.filter((g) => gradMatches(c, g, chart.bpm, !old.grads!.some((o) => o !== g && o.start === g.end)));
        if (keep.length) c.grads = keep.map((g) => ({ ...g }));
        for (const g of c.grads ?? []) markPins(c, g, chart.bpm, !c.grads!.some((o) => o !== g && o.start === g.end));
      }
      this.chart = chart;
      const i = chart.courses.findIndex((c) => c.name === name);
      this.courseIndex = i >= 0 ? i : Math.max(0, Math.min(this.courseIndex, chart.courses.length - 1));
      this.pendingLong = null;
    };
    if (pushUndo) this.mutate(apply);
    else {
      apply();
      this.emit(true);
    }
  }

  get canUndo() { return this.undoStack.length > 0; }
  /** 譜面が変わるたびに増える数（描き直しの目印） */
  get undoCount() { return this.version; }
  private version = 0;
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snapshot());
    this.restore(s);
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snapshot());
    this.restore(s);
  }

  // ---------- 小節・スナップ ----------

  measuresUntil(tick: number): Measure[] {
    const last = this.measureCache[this.measureCache.length - 1];
    if (!last || last.start + last.length <= tick) {
      this.measureCache = measures(this.course, Math.max(tick, contentEnd(this.course)) + TPB * 64);
    }
    return this.measureCache;
  }

  measureOf(tick: number): Measure {
    return measureAt(this.measuresUntil(Math.max(0, tick)), Math.max(0, tick));
  }

  /** グリッドの間隔（tick）。13 分割のように割り切れないときは小数（置く位置は snap で整数に丸める） */
  get step() {
    return (TPB * 4) / this.divisor;
  }

  snap(tick: number): number {
    if (tick <= 0) return 0;
    return this.snapFree(tick);
  }

  /** 判定枠の位置用: 曲の頭より前（1 小節ぶん）も、同じ間隔のグリッドに寄せる */
  snapView(tick: number): number {
    if (tick >= 0) return this.snapFree(tick);
    const step = this.step;
    return Math.max(this.minPos, Math.round(Math.round(tick / step) * step));
  }

  /**
   * 判定枠を動かせる一番前: 音源の頭（0 秒）より 1 小節ほど前。
   * 1 小節目の長さで後ろへ小節を並べた位置にそろえるので、OFFSET は変わらない（少なくとも 1 小節目の 1 つ前の小節までは戻れる）
   */
  get minPos() {
    const len = this.measureOf(0).length;
    const audioStart = this.timing.timeToTick(0);
    return Math.min(-len, (Math.floor(audioStart / len) - 1) * len);
  }

  private snapFree(tick: number): number {
    const m = this.measureOf(tick);
    const step = this.step;
    // 小節の長さで割り切れない間隔のとき、小節の終わりを越えたら次の小節の頭に
    return Math.max(0, m.start + Math.min(m.length, Math.round(Math.round((tick - m.start) / step) * step)));
  }

  /** 「小節 3 ・ 2.5拍」のような表示 */
  label(tick: number): string {
    const m = this.measureOf(tick);
    const beat = (tick - m.start) / TPB + 1;
    return `${m.index + 1}小節 ${Number(beat.toFixed(3))}拍`;
  }

  // ---------- ノーツ ----------

  private noteAt(tick: number) {
    return this.course.notes.find((n) => n.tick === tick);
  }

  /** tick が連打・風船の途中〜終点にあるならそのノーツ */
  private longCovering(tick: number) {
    return this.course.notes.find(
      (n) => n.endTick !== undefined && n.tick < tick && tick <= n.endTick,
    );
  }

  private remove(n: ENote) {
    const i = this.course.notes.indexOf(n);
    if (i >= 0) this.course.notes.splice(i, 1);
  }

  /**
   * グリッドに乗っていないノーツ（グリッドを変えた後など）のうち、タップした位置に一番近いもの。
   * tol（tick）以内で、グリッドの点よりもそのノーツの方が近いときだけ
   */
  private offGridNear(rawTick: number, tol: number) {
    const tick = this.snap(rawTick);
    let best: ENote | undefined;
    let bd = Infinity;
    for (const n of this.course.notes) {
      const d = Math.abs(n.tick - rawTick);
      if (d > tol || d > Math.abs(tick - rawTick) + 1 || this.snap(n.tick) === n.tick) continue;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  tap(rawTick: number, tol = 0): TapResult {
    const tick = this.snap(rawTick);
    const tool = this.tool;
    // グリッドから外れたノーツが、グリッドの点より近くにあればそちらを優先
    const exact = this.offGridNear(rawTick, tol) ?? this.noteAt(tick);
    const covering = this.longCovering(tick);

    if (tool === 'select') return this.tapSelect(tick, exact);
    if (tool === 'gogo') return this.tapGogo(tick);
    if (tool === 'scroll') return this.tapScroll(tick);
    if (tool === 'bpm') return { point: { kind: 'bpm', tick } };
    if (tool === 'measure') return { point: { kind: 'measure', tick: this.measureOf(tick).start } };

    // 置いてあるノーツ（連打・風船はその範囲のどこでも）をタップしたら、選んでいる音符に関係なく消す。
    // ただし風船を選んでいて風船の始点をタップしたときは、打数を変える
    const target = exact ?? covering;
    if (this.pendingLong === null && target) {
      if (tool === 'balloon' && target === exact && exact.type === 'balloon') return { editBalloon: exact };
      this.mutate(() => this.remove(target));
      return {};
    }
    if (tool === 'erase') return {};

    if (!isLong(tool)) {
      this.mutate(() => this.course.notes.push({ tick, type: tool }));
      return {};
    }

    // 連打・風船
    if (this.pendingLong === null) {
      this.pendingLong = tick;
      this.emit();
      return { message: '終点をタップ' };
    }

    const a = this.pendingLong;
    this.pendingLong = null;
    if (tick === a) {
      this.emit();
      return { message: '取り消しました' };
    }
    const start = Math.min(a, tick);
    const end = Math.max(a, tick);
    this.mutate(() => {
      // 範囲内のノーツと重なる連打を消す
      this.course.notes = this.course.notes.filter((n) => {
        const nEnd = n.endTick ?? n.tick;
        return nEnd < start || n.tick > end;
      });
      const note: ENote = { tick: start, type: tool, endTick: end };
      if (tool === 'balloon') note.hits = Math.max(3, Math.round(((end - start) / TPB) * 2));
      this.course.notes.push(note);
    });
    return {};
  }

  // ---------- 範囲の選択・コピー・貼り付け ----------

  /** 選択: 始点と終点をタップして範囲を選ぶ。始点と同じ位置をもう一度タップすると、その位置だけ */
  private tapSelect(tick: number, exact?: ENote): TapResult {
    if (this.pendingLong === null) {
      this.sel = null;
      this.pendingLong = exact ? exact.tick : tick;
      this.emit();
      return { message: '終点をタップ' };
    }
    const a = this.pendingLong;
    const b = exact ? exact.tick : tick;
    this.pendingLong = null;
    this.sel = { start: Math.min(a, b), end: Math.max(a, b) };
    this.emit();
    return { selected: true };
  }

  /** 選んでいる範囲のノーツ（始点が範囲の中にあるもの） */
  selectedNotes(): ENote[] {
    const s = this.sel;
    if (!s) return [];
    return this.course.notes.filter((n) => n.tick >= s.start && n.tick <= s.end);
  }

  clearSelection() {
    this.sel = null;
    if (this.tool === 'select') this.pendingLong = null;
    this.emit();
  }

  /** 選んでいる範囲をコピーする（コピーした数を返す） */
  copySelection(): number {
    const s = this.sel;
    if (!s) return 0;
    const notes = this.selectedNotes().map((n) => {
      const c: ENote = { ...n, tick: n.tick - s.start };
      if (n.endTick !== undefined) c.endTick = n.endTick - s.start;
      return c;
    });
    this.clip = { notes, span: s.end - s.start };
    return notes.length;
  }

  /** 選んでいる範囲のノーツを消す */
  deleteSelection(): number {
    const list = this.selectedNotes();
    if (!list.length) return 0;
    this.mutate(() => { this.course.notes = this.course.notes.filter((n) => !list.includes(n)); });
    return list.length;
  }

  cutSelection(): number {
    const n = this.copySelection();
    this.deleteSelection();
    return n;
  }

  /** コピーしたノーツを at から貼り付ける（その範囲にあったノーツは置き換える）。貼った範囲を選んだ状態にする */
  paste(at: number): number {
    const clip = this.clip;
    if (!clip) return 0;
    const start = Math.max(0, at);
    const end = start + clip.span;
    const added = clip.notes.map((n) => {
      const c: ENote = { ...n, tick: n.tick + start };
      if (n.endTick !== undefined) c.endTick = n.endTick + start;
      return c;
    });
    const lastEnd = Math.max(end, ...added.map((n) => n.endTick ?? n.tick));
    this.mutate(() => {
      // 貼る範囲にかかるノーツ（連打の途中も）を消してから置く
      this.course.notes = this.course.notes.filter((n) => {
        const nEnd = n.endTick ?? n.tick;
        return nEnd < start || n.tick > lastEnd;
      });
      this.course.notes.push(...added);
    });
    this.sel = { start, end };
    this.emit();
    return added.length;
  }

  /** ゴーゴータイムの区間 [始まり, 終わり]（終わりがなければ Infinity） */
  gogoRanges(): [number, number][] {
    const ranges: [number, number][] = [];
    let from: number | null = null;
    for (const e of this.course.events) {
      if (e.kind !== 'gogo') continue;
      if (e.on && from === null) from = e.tick;
      if (!e.on && from !== null) { ranges.push([from, e.tick]); from = null; }
    }
    if (from !== null) ranges.push([from, Infinity]);
    return ranges;
  }

  /** ゴーゴー: 始点と終点をタップして区間を作る。区間の中をタップするとその区間を消す */
  private tapGogo(tick: number): TapResult {
    const ranges = this.gogoRanges();
    if (this.pendingLong === null) {
      const hit = ranges.find(([a, b]) => tick >= a && tick < b);
      if (hit) {
        this.mutate(() => {
          this.course.events = this.course.events.filter(
            (e) => !(e.kind === 'gogo' && e.tick >= hit[0] && (hit[1] === Infinity || e.tick <= hit[1])),
          );
        });
        return { message: 'ゴーゴーを消しました' };
      }
      this.pendingLong = tick;
      this.emit();
      return { message: 'ゴーゴーの終点をタップ' };
    }
    const p = this.pendingLong;
    this.pendingLong = null;
    if (tick === p) {
      this.emit();
      return { message: '取り消しました' };
    }
    let start = Math.min(p, tick);
    let end = Math.max(p, tick);
    // 重なる・つながる区間はひとつにまとめる
    for (const [a, b] of ranges) {
      if (a <= end && b >= start) {
        start = Math.min(start, a);
        end = Math.max(end, b === Infinity ? end : b);
      }
    }
    this.mutate(() => {
      this.course.events = this.course.events.filter((e) => !(e.kind === 'gogo' && e.tick >= start && e.tick <= end));
      this.course.events.push({ tick: start, kind: 'gogo', on: true }, { tick: end, kind: 'gogo', on: false });
    });
    return {};
  }

  /** その位置を含むグラデ */
  gradAt(tick: number): Grad | undefined {
    return this.course.grads?.find((g) => tick >= g.start && tick <= g.end);
  }

  /**
   * SCROLL: 同じ位置を 2 回タップするとその位置の #SCROLL（値は UI 側で聞く）、
   * 別の位置をタップするとその間をグラデにする。グラデの中をタップするとグラデの設定を開く
   */
  private tapScroll(tick: number): TapResult {
    if (this.pendingLong === null) {
      // グラデの始点・終点の上: どのグラデを開くか、ここから新しく作るかを UI で選ばせる
      // （そのまま開くと、終点から次のグラデを作れず、つなぎ目では後ろのグラデを開けない）
      const before = this.course.grads?.find((g) => g.end === tick);
      const after = this.course.grads?.find((g) => g.start === tick);
      if (before || after) return { gradPick: { tick, before, after } };
      const g = this.gradAt(tick);
      if (g) return { editGrad: g };
      this.pendingLong = tick;
      this.emit();
      return { message: '同じ位置: SCROLL ／ 別の位置: グラデ' };
    }
    const p = this.pendingLong;
    this.pendingLong = null;
    this.emit();
    if (tick === p) return { point: { kind: 'scroll', tick } };
    return { newGrad: { start: Math.min(p, tick), end: Math.max(p, tick) } };
  }

  /** SCROLL・グラデの始点をここに決めて、次のタップを待つ（つなぎ目から新しいグラデを作るとき） */
  startScrollAt(tick: number) {
    this.pendingLong = tick;
    this.emit();
  }

  /** その位置・種類の命令 */
  eventAt(kind: 'scroll' | 'bpm' | 'measure' | 'lyric', tick: number): EEvent | undefined {
    return this.course.events.find((e) => e.kind === kind && e.tick === tick);
  }

  /** グラデを追加・変更する（old を渡すと置き換え）。重なる別のグラデは外す（その #SCROLL は新しい値で上書き） */
  setGrad(g: Grad, old?: Grad) {
    this.mutate(() => {
      const c = this.course;
      const list = (c.grads ?? []).filter((x) => x !== old && (x.end <= g.start || x.start >= g.end));
      // 前のグラデの #SCROLL を消す（始点・終点に重ねて置いたものは残す）
      if (old) c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= old.start && e.tick <= old.end && !e.pin));
      list.push(g);
      list.sort((a, b) => a.start - b.start);
      c.grads = list;
    });
  }

  /** グラデを消す（置いていた #SCROLL も消す。始点・終点に重ねて置いたものは残す） */
  removeGrad(g: Grad) {
    this.mutate(() => {
      const c = this.course;
      c.grads = (c.grads ?? []).filter((x) => x !== g);
      c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= g.start && e.tick <= g.end && !e.pin));
    });
  }

  /** 自動で測った BPM・OFFSET を入れる（全部の難易度の #BPMCHANGE を置き換える。音符の拍の位置はそのまま） */
  applyTempo(plan: { bpm: number; offset: number; changes: { tick: number; bpm: number }[]; measures?: { tick: number; num: number; den: number }[] }) {
    this.mutate(() => {
      this.chart.bpm = plan.bpm;
      this.chart.offset = plan.offset;
      for (const c of this.chart.courses) {
        c.events = c.events.filter((e) => e.kind !== 'bpm' && (!plan.measures || e.kind !== 'measure'));
        for (const ch of plan.changes) c.events.push({ tick: ch.tick, kind: 'bpm', value: ch.bpm });
        for (const m of plan.measures ?? []) c.events.push({ tick: m.tick, kind: 'measure', num: m.num, den: m.den });
      }
    });
  }

  setBalloonHits(n: ENote, hits: number) {
    if (!(hits > 0)) return;
    this.mutate(() => { n.hits = Math.round(hits); });
  }

  // ---------- イベント ----------

  addEvent(ev: EEvent) {
    if (ev.kind === 'measure') ev = { ...ev, tick: this.measureOf(ev.tick).start };
    // グラデの始点・終点に置く #SCROLL は、グラデの値の代わりにする（グラデを置き直しても消さない）
    if (ev.kind === 'scroll') {
      const t = ev.tick;
      ev = { tick: t, kind: 'scroll', value: ev.value, ...(ev.im ? { im: ev.im } : {}) };
      if (this.course.grads?.some((g) => g.start === t || g.end === t)) ev.pin = true;
    }
    this.mutate(() => {
      const ev2 = ev;
      this.course.events = this.course.events.filter((e) => !(e.tick === ev2.tick && e.kind === ev2.kind));
      this.course.events.push(ev2);
    });
  }

  removeEvent(ev: EEvent) {
    this.mutate(() => {
      this.course.events = this.course.events.filter((e) => e !== ev);
    });
  }

  // ---------- 難易度 ----------

  selectCourse(i: number) {
    this.courseIndex = i;
    this.path = null;
    this.pendingLong = null;
    this.sel = null;
    this.emit(true);
  }

  addCourse(name: string, level: number, copyFrom?: ECourse) {
    this.mutate(() => {
      const src = copyFrom === this.path?.c ? this.mainCourse : copyFrom;
      const c = src
        ? { ...(JSON.parse(JSON.stringify(src)) as ECourse), name, level }
        : newCourse(name, level);
      this.chart.courses.push(c);
      this.courseIndex = this.chart.courses.length - 1;
    });
  }

  removeCourse(i: number) {
    if (this.chart.courses.length <= 1) return;
    this.mutate(() => {
      this.chart.courses.splice(i, 1);
      this.courseIndex = Math.min(this.courseIndex, this.chart.courses.length - 1);
    });
  }
}

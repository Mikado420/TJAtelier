import { measures, measureTicks, scrollText, Timing, TPB, type EChart, type EEvent, type ECourse, type ENote, type Measure } from '../chart/model';
import { drawAny, drawRoll, hexPath, noteSkin } from '../render/notes';
import { drawTndeNote } from '../render/tndeNotes';
import { localPoint, pixelRatio } from '../orient';
import type { Editor } from './editor';
import { gradParts, inGradHole, type Grad } from './grad';
import { DelayLanes } from './delayLanes';

/**
 * Malody 風の横スクロール作譜画面。
 * Malody の太鼓エディタのスクリーンショット（2000×924）から測った座標を「基準座標」とし、
 * 画面の高さに合わせて拡大縮小する（横幅は画面に合わせて伸びる）。
 *   左の列 (x 0〜235)     … 拡大縮小・再生の六角形、再生位置の線、x 160〜235 は密度推移（上下にドラッグで移動）
 *   判定枠 (x 410)        … 再生位置。Malody と同じ金色の二重の輪
 *   x 262 付近            … 曲の長さ（上）と現在時刻（下）を縦書きで
 *   レーン (y 352〜570)   … ノーツ（半径 54、大音符 83）と拍の点
 *   レーンの上 (y 120〜340) … 音源の波形
 * 横ドラッグ＝スクロール、タップ＝配置、2本指ピンチ＝拡大縮小、波形をタップ＝その位置へ移動。
 */

export const REF_H = 924;
const R = {
  colLine1: 72, // 密度推移の左端
  densW: 75, // 密度推移の幅（Malody と同じ）
  laneX: 147, // レーンの左端（密度推移のすぐ右）
  laneTop: 352,
  laneBottom: 570,
  laneCY: 461,
  noteR: 54,
  bigR: 83,
  play: { x: 230, y: 461, r: 55 },
  judgeX: 410, // 判定枠（再生位置）
  judgeR: 72,
  judgeR2: 49,
  timeX: 176,
  waveX: 205,
  waveTop: 40, // 曲名の表示をなくした分、波形を上へ広げる
  waveBottom: 336,
  evTop: 576,
  evBottom: 616,
  /** #DELAY で重なった所に出す段の間のすき間（段は上下にスクロールして見る） */
  subGap: 16,
  /** 合作: ほかのレーン（譜面）との間（段の間に足す） */
  laneGap: 50,
};

/** プレビュー（プレイ画面のレーンの帯: 幅 2000・高さ 271。renderer.ts の PV_TOP〜PV_BOTTOM）の高さ ÷ 幅 */
const PREVIEW_ASPECT = 271 / 2000;

/** 斜めの形の傾き（CSS の --tan = tan(8°) と同じ） */
const TILT_TAN = 0;

const C = {
  bg: '#2a2d31',
  col: 'rgba(29,32,35,0.94)',
  colLine: '#4d9fbe',
  lane: '#22313a',
  laneEdge: '#7fc0d8',
  /** レーンの下端の細い線（stack の配置） */
  laneLine: '#3c5a69',
  /** レーンとタイムラインの間の色（タイムラインの波形の所と同じに見える色でつなぐ） */
  tlBg: '#0e1114',
  /** プレビューとレーンの間のすき間 */
  pvGap: '#0c0e10',
  gogo: 'rgba(255,110,40,0.16)',
  measure: 'rgba(255,255,255,0.8)',
  text: '#f4f4f4',
  sub: '#9a9aa2',
  btn: '#3b4045',
  btnEdge: '#ffffff',
  play: '#4d9fbe',
  wave: '#4d9fbe',
  subLane: '#22313a',
  emptyLane: 'rgba(18,22,26,0.7)',
  event: '#c27dff',
};

/** 拍の中の位置の細かさ別の点の色（Malody 風） */
const DOT_COLORS: Record<number, string> = {
  1: '#d8d8dc',
  2: '#b23fcf',
  3: '#e0457b',
  4: '#3a9fc6',
  6: '#e8a33c',
  8: '#d8d050',
  12: '#55c08a',
  16: '#8c8c96',
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
/** 小節の中の拍の位置（小節の頭は除く） */
const beatRels = (len: number) => { const r: number[] = []; for (let t = TPB; t < len; t += TPB) r.push(t); return r; };

/** レーンの下に出す短い文字（種類は色で見分ける） */
export function eventShort(e: EEvent): string {
  switch (e.kind) {
    case 'bpm': return `♩${Number(e.value.toFixed(3))}`;
    case 'scroll': return `×${scrollText(e.value, e.im, 3)}`;
    case 'measure': return `${e.num}/${e.den}`;
    case 'gogo': return e.on ? 'GOGO▶' : 'GOGO■';
    case 'barline': return e.on ? '|ON' : '|OFF';
    case 'delay': return `⏱${e.value}s`;
    case 'jpos': return `◎${e.dir ? '→' : '←'}${Number(e.dist.toFixed(1))}`;
    case 'lyric': return e.text ? `♪${e.text.length > 12 ? `${e.text.slice(0, 12)}…` : e.text}` : '♪―';
    case 'section': return 'SECTION';
    case 'levelhold': return 'HOLD';
  }
}

/** 種類ごとの色（ツールのアイコンと同じ） */
export const EVENT_COLOR: Record<EEvent['kind'], string> = {
  scroll: '#c792ea',
  bpm: '#5cc8f0',
  measure: '#ffd21f',
  gogo: '#ff8a3a',
  barline: '#a8a8b0',
  delay: '#8fd18f',
  jpos: '#ff9ec7',
  lyric: '#7fd6f5',
  section: '#f0b64a',
  levelhold: '#f0b64a',
};

/** エディタには出さず、TJA の文字でだけ書く命令（#LYRIC・#SECTION・#LEVELHOLD） */
export const TJA_ONLY = new Set<EEvent['kind']>(['lyric', 'section', 'levelhold']);

/** レーンの下に出す種類（設定で切り替える） */
export type EventShow = Record<EEvent['kind'], boolean>;

/** レーンの下の 1 つの表示（グラデはまとめて 1 つ） */
export interface EventItem {
  tick: number;
  events: EEvent[];
  grad?: Grad;
  /** 譜面分岐の区間（その番号） */
  branch?: number;
}

/** 譜面分岐の色（普通・玄人・達人） */
export const BRANCH_COLOR = ['#9aa3aa', '#3a96d2', '#c846be'];
export const BRANCH_NAME = ['NORMAL', 'EXPERT', 'MASTER'];

export function eventText(e: EEvent): string {
  switch (e.kind) {
    case 'bpm': return `BPM ${Number(e.value.toFixed(3))}`;
    case 'scroll': return `SCROLL ${scrollText(e.value, e.im, 3)}`;
    case 'measure': return `拍子 ${e.num}/${e.den}`;
    case 'gogo': return e.on ? 'GOGO 開始' : 'GOGO 終了';
    case 'barline': return e.on ? '小節線 ON' : '小節線 OFF';
    case 'delay': return `DELAY ${e.value}s`;
    case 'jpos': return `判定枠 ${e.dir ? '右' : '左'}へ ${Number(e.dist.toFixed(1))}px（${Number(e.time.toFixed(3))} 秒）`;
    case 'lyric': return e.text ? `歌詞「${e.text}」` : '歌詞を消す';
    case 'section': return '#SECTION';
    case 'levelhold': return '#LEVELHOLD';
  }
}

const fmtTime = (t: number) => {
  const sign = t < 0 ? '-' : '';
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
};

/** レーンを指でスライドしたときの速さ（指の動きの何倍流すか） */
const SCROLL_GAIN = 1.6;

interface Box { x: number; y: number; r: number }

/** 音符の並び（tick の順）のうち、[a, b] に掛かるものの範囲 [lo, hi)。連打・風船の長さの分だけ前から見る */
const longest = new WeakMap<ENote[], { rev: number; span: number }>();
function visRange(notes: ENote[], a: number, b: number, rev = 0): [number, number] {
  let c = longest.get(notes);
  if (!c || c.rev !== rev) {
    let span = 0;
    for (const n of notes) if (n.endTick !== undefined) span = Math.max(span, n.endTick - n.tick);
    c = { rev, span };
    longest.set(notes, c);
  }
  const span = c.span;
  const first = (t: number) => {
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].tick < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [first(a - span - 1), first(b + 1)];
}

/** 合作: ほかのレーン（波形の所に、時刻をそろえて小さく並べる） */
export interface GhostRow {
  id: string;
  name: string;
  color: string;
  main: boolean;
  /** 音符（秒） */
  notes: { t: number; e?: number; type: string }[];
  /** 小節線（秒） */
  bars: number[];
  /** レーンの譜面そのもの（縦に並べて、命令・GOGO なども描くため） */
  chart?: EChart;
  /** 本譜面の小節の出どころ（そのレーンの tick） */
  bands?: { a: number; b: number; color: string; label: string }[];
  /** ここだけ明るく、ほかは暗くする範囲（そのレーンの tick。譜面分岐の区間） */
  focus?: [number, number][];
  /** 見比べで鳴らしている */
  compare?: boolean;
}

/** ほかのレーンを描くための表（譜面が変わったら作り直す） */
/** 波形を x の一定の幅ごとにまとめたもの */
interface WaveCols { x0: number; bw: number; pk: Float32Array; rm: Float32Array }

interface GhostGeo { chart: EChart; course: ECourse; timing: Timing; lanes: DelayLanes; ms: Measure[]; gogo: [number, number][] }

/** 合作: ほかの人が見ている場所 */
export interface CursorMark { color: string; name: string; t: number }

export class EditorView {
  private ctx: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  /** 基準座標 → 画面 px の倍率（画面の高さ / 924） */
  s = 1;
  /** 判定線（再生位置）の tick */
  pos = 0;
  /** 1拍あたりの px */
  zoom = 180;
  playing = false;
  /** 曲の長さ（秒）。左上に縦書きで表示 */
  duration = 0;
  private wave: { peaks: Float32Array; rate: number; rms?: Float32Array } | null = null;

  /** tol: そのあたりのノーツとみなす幅（tick。音符の半径ぶん） */
  onTap: (tick: number, tol: number) => void = () => {};
  /** レーンを 0.3 秒押したまま（動かさない）。true を返したら、離してもタップにしない（x, y は画面の位置） */
  onLongPress: (tick: number, tol: number, x: number, y: number) => boolean = () => false;
  private pressTimer = 0;
  /** レーンの下のイベントの文字をタップしたとき（重なってまとめたものは全部） */
  onEventTap: (items: EventItem[]) => void = () => {};
  /** レーンの下に出す種類 */
  evShow: EventShow = { bpm: true, scroll: true, measure: true, gogo: true, barline: true, delay: true, jpos: true, lyric: true, section: true, levelhold: true };
  /** 最後に描いたイベントの文字の位置（タップの判定用） */
  private evBoxes: { x1: number; x2: number; y1: number; y2: number; items: EventItem[] }[] = [];
  onUserScroll: () => void = () => {};
  /** 合作: ほかのレーン（最大 3 段） */
  ghosts: GhostRow[] = [];
  /** 合作: ほかの人の見ている場所 */
  cursors: CursorMark[] = [];
  /** 合作: 本譜面の担当（A・B…）の範囲（tick）。レーンの上の縁に色で出す */
  bands: { a: number; b: number; color: string; label: string; mine: boolean }[] = [];
  /** 譜面分岐の区間と、条件の短い文字 */
  branches: { a: number; b: number; label: string }[] = [];
  /** 編集している分岐 */
  branchNo = 0;
  /** 合作: ほかのレーンの名前をタップしたとき */
  onGhostTap: (id: string) => void = () => {};
  /** ほかのレーンの名前の帯の「見比べ」ボタン */
  onGhostCompare: ((id: string) => void) | null = null;
  private cmpBoxes: { x1: number; x2: number; y1: number; y2: number; id: string }[] = [];
  /** 最後に描いたほかのレーンの名前の位置 */
  private ghostBoxes: { x1: number; x2: number; y1: number; y2: number; id: string }[] = [];
  onPlayToggle: () => void = () => {};
  onZoomChange: (z: number) => void = () => {};
  onResize: () => void = () => {};

  private pointers = new Map<number, { x: number; y: number }>();
  private drag: { startX: number; startY: number; lastX: number; lastY: number; moved: boolean; scrub?: boolean; v?: boolean; tl?: boolean; long?: boolean } | null = null;
  private pinch: { d0: number; z0: number } | null = null;
  private hoverX: number | null = null;
  private hoverY = 0;
  /** 今見ている段（上下のスクロール。0 = いつものレーン。途中の値はスクロール中） */
  private vrowRaw = 0;
  private vAnim = 0;
  get vrow() {
    return Math.min(Math.max(0, this.vrowRaw), Math.min(this.totalRows - 1, this.maxV));
  }
  /**
   * 合作: ほかのレーンも、自分のレーンの下に同じ大きさで並べる（#DELAY の段と同じ形。譜面ごとに少し間をあける）。
   * 上下にスクロールして見る
   */
  lanesFull = true;
  private fgCache: { src: GhostRow[]; on: boolean; out: GhostRow[] } | null = null;
  private get fullGhosts() {
    const on = this.stack && this.lanesFull;
    const c = this.fgCache;
    if (c && c.src === this.ghosts && c.on === on) return c.out;
    const out = on ? this.ghosts.filter((g) => g.chart) : [];
    this.fgCache = { src: this.ghosts, on, out };
    return out;
  }
  /** 段の並びの表（譜面・ほかのレーンが変わったときだけ作り直す） */
  private rowsCache: { fg: GhostRow[]; lanes: DelayLanes; map: [number, number][]; total: number; counts: number[] } | null = null;
  private get rowsInfo() {
    const fg = this.fullGhosts;
    const lanes = this.lanes;
    const c = this.rowsCache;
    if (c && c.fg === fg && c.lanes === lanes) return c;
    const map: [number, number][] = [];
    for (let r = 0; r < lanes.rows; r++) map.push([0, r]);
    const counts = fg.map((g) => this.geoOf(g).lanes.rows);
    counts.forEach((n, i) => { for (let r = 0; r < n; r++) map.push([i + 1, r]); });
    const info = { fg, lanes, map, total: map.length, counts };
    this.rowsCache = info;
    return info;
  }
  private geoCache = new WeakMap<EChart, GhostGeo>();
  private geoOf(g: GhostRow): GhostGeo {
    const chart = g.chart!;
    let geo = this.geoCache.get(chart);
    if (!geo) {
      const course = chart.courses[0];
      const timing = new Timing(chart, course);
      let end = 0;
      for (const n of course.notes) end = Math.max(end, n.endTick ?? n.tick);
      for (const e of course.events) end = Math.max(end, e.tick);
      const gogo: [number, number][] = [];
      let from: number | null = null;
      for (const e of course.events) {
        if (e.kind !== 'gogo') continue;
        if (e.on && from === null) from = e.tick;
        if (!e.on && from !== null) { gogo.push([from, e.tick]); from = null; }
      }
      if (from !== null) gogo.push([from, Infinity]);
      geo = { chart, course, timing, lanes: new DelayLanes(course, timing), ms: measures(course, end + TPB * 4 * 64), gogo };
      this.geoCache.set(chart, geo);
    }
    return geo;
  }
  /** 段の並び（譜面ごと）: [譜面の番号（0 = 自分、1〜 = ほかのレーン）, その譜面の中の段] */
  private get rowMap(): [number, number][] {
    return this.rowsInfo.map;
  }
  /** 段の数（自分のレーンの #DELAY の段 ＋ ほかのレーンの段） */
  get totalRows() {
    return this.rowsInfo.total;
  }
  /** 段 r の頭の位置（段 0 の頭から。途中の値はスクロール中）。譜面が変わる所は少し間をあける */
  private rowOff(r: number) {
    const L = this.L;
    return this.rowOffWith(r, L.laneH, L.subGap, L.lgap);
  }
  /**
   * rowOff の計算（L を使わない形。L の中からも呼ぶ）。
   * 自分のレーンの段の下には命令の欄（subGap）、ほかのレーンの段の間は細いすき間（lgap）。途中の値は間を比例で
   */
  private rowOffWith(r: number, laneH: number, subGap: number, lgap: number) {
    const own = this.rowsInfo.lanes.rows;
    const n = Math.floor(r);
    const ownN = Math.min(n, own);
    let y = ownN * (laneH + subGap) + Math.max(0, n - own) * (laneH + lgap);
    const f = r - n;
    if (f > 0) y += f * (laneH + (n < own ? subGap : lgap));
    return y;
  }
  /** 再生中の時刻（DELAY の空きの間も判定枠を進めるため） */
  posTime: number | null = null;
  private lanesCache: { timing: unknown; lanes: DelayLanes } | null = null;

  /** #DELAY の段の表（タイミングが変わったら作り直す） */
  get lanes(): DelayLanes {
    const t = this.ed.timing;
    if (!this.lanesCache || this.lanesCache.timing !== t) this.lanesCache = { timing: t, lanes: new DelayLanes(this.ed.course, t) };
    return this.lanesCache.lanes;
  }
  dirty = true;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly ed: Editor) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bind();
  }

  resize() {
    const dpr = pixelRatio();
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.s = Math.max(0.2, this.h / REF_H);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.invalidate();
    this.onResize();
  }

  invalidate() {
    this.dirty = true;
  }

  setWave(peaks: Float32Array | null, rate = 0, rms?: Float32Array) {
    this.wave = peaks ? { peaks, rate, rms } : null;
    this.invalidate();
  }

  // ---------- レイアウト（基準座標 × 倍率） ----------

  /**
   * 配置。true = 上から「タイムライン（小節の見出し・波形・音符の段。3 小節先まで）→ レーン（縦の真ん中）→ 命令 → ツール」。
   * false = これまでの配置（波形がレーンの上）
   */
  stack = true;
  /** 下に重ねるツールの台が使う高さ（px）。CSS の .tools と同じ式 */
  private get toolsH() {
    const s = this.s;
    return 40 * s + Math.max(38, 124 * s) + 12 + 6;
  }

  /** プレビュー（プレイ画面のレーンの帯）を出す */
  showPreview = true;
  /** 下の段の左に DOM のボタン（分岐の切り替え）が占める幅。今の位置の表示はその右に出す */
  barReserve = 0;
  /** 上下のスクロールで行ける一番下の段（全部見えていれば 0） */
  private maxV = Infinity;

  /** 配置は大きさ・段・スクロールが変わったときだけ計算し直す（1 フレームに何度も使うため） */
  private lMemo: { s: number; w: number; h: number; stack: boolean; pv: boolean; info: unknown; vrow: number; L: ReturnType<EditorView['calcL']> } | null = null;
  get L() {
    const info = this.stack ? this.rowsInfo : this.lanes;
    const vrow = this.stack ? this.vrow : 0;
    const m = this.lMemo;
    if (m && m.s === this.s && m.w === this.w && m.h === this.h && m.stack === this.stack && m.pv === this.showPreview && m.info === info && m.vrow === vrow) return m.L;
    const L = this.calcL();
    this.lMemo = { s: this.s, w: this.w, h: this.h, stack: this.stack, pv: this.showPreview, info, vrow, L };
    return L;
  }

  private calcL() {
    const s = this.s;
    const box = (b: { x: number; y: number; r: number }): Box => ({ x: b.x * s, y: b.y * s, r: b.r * s });
    if (this.stack) {
      // 上から: プレビュー（出し入れできる）→ レーンの段（全部入るまで縮める。波形はレーンの下地）→ 下の段（今の位置・分岐・拡大率）→ ツール
      const evH = Math.max(16, (R.evBottom - R.evTop) * s);
      // 段と段の間は命令の欄（#DELAY の段ごとに、その段の命令を下に出す）
      const subGap = evH + 12 * s;
      // ほかのレーンの段の間（名前はレーンの中に出す）
      const laneGap = 6 * s;
      const lgap = laneGap;
      const colW = R.laneX * s;
      const barBot = this.h - this.toolsH - 2;
      const barH = Math.max(30, 46 * s);
      const barTop = barBot - barH;
      const pvW = Math.max(0, this.w - colW);
      const base = (R.laneBottom - R.laneTop) * s;
      /** 段を縮める下限（元の大きさに対する比） */
      const kMin = 0.5;
      // プレビューは、レーン 1 段が元の大きさで入る分を残して置く
      const pvH = this.showPreview ? Math.max(0, Math.min(pvW * PREVIEW_ASPECT, barTop - 10 * s - base - subGap - 6 * s)) : 0;
      const laneY = pvH + 6 * s;
      const avail = Math.max(base * kMin, barTop - 4 * s - laneY);
      const total = this.totalRows;
      // 全部の段（と、自分のレーンの命令の欄）がちょうど入る高さにする（空いていれば高くして波形を大きく見せる）。
      // 音符・判定枠は元の大きさまで
      const gaps = this.rowOffWith(total, 0, subGap, lgap);
      const kH = Math.min(3.5, Math.max(kMin, (avail - gaps) / total / base));
      const k = Math.min(1, kH);
      const laneH = base * kH;
      const blockH = total > 1 ? avail : laneH;
      const off = (r: number) => this.rowOffWith(r, laneH, subGap, lgap);
      const endAll = off(total);
      let maxV = 0;
      while (maxV < total - 1 && endAll - off(maxV) > blockH + 0.5) maxV++;
      this.maxV = maxV;
      let vis = 0;
      while (vis < total && off(vis) + laneH <= blockH + 0.5) vis++;
      const cy = laneY + laneH / 2;
      // 自分のレーンの命令の段: 自分のレーンの最後の段のすぐ下（スクロールといっしょに動く）
      const ownBottom = laneY + off(this.lanes.rows - 1) - off(this.vrow) + laneH;
      return {
        sub: this.lanes.rows - 1,
        rows: total,
        vis: Math.max(1, vis),
        maxV,
        k,
        blockH,
        subGap,
        laneGap,
        lgap,
        s,
        colW,
        colLine1: R.colLine1 * s,
        laneY,
        laneH,
        evY: ownBottom,
        evH,
        evTop: ownBottom + 6 * s,
        /** 下の段の上端（拡大率・分岐のボタンはこの段の中） */
        ctlTop: barTop,
        cy,
        playX: R.judgeX * s,
        r: R.noteR * s * k,
        bigR: R.bigR * s * k,
        judgeR: R.judgeR * s * k,
        judgeR2: R.judgeR2 * s * k,
        waveX: colW,
        waveY: barTop,
        waveH: 0,
        play: { x: R.play.x * s, y: cy, r: R.play.r * s * Math.max(0.7, k) },
        tlX: colW,
        tlTop: barTop,
        tlBottom: barBot,
        /** プレビュー（プレイ画面のレーン）を置く所 */
        pv: { x: colW, y: 0, w: pvW, h: pvH },
      };
    }
    const laneY = R.laneTop * s;
    const laneH = (R.laneBottom - R.laneTop) * s;
    return {
      vis: 1,
      maxV: 0,
      k: 1,
      judgeR: R.judgeR * s,
      judgeR2: R.judgeR2 * s,
      rows: this.lanes.rows,
      laneGap: 0,
      lgap: 0,
      blockH: laneH,
      ctlTop: 0,
      tlX: 0,
      tlTop: 0,
      tlBottom: 0,
      /** #DELAY で重なった所の段の数（0 なら段はいつものレーンだけ） */
      sub: this.lanes.rows - 1,
      subGap: R.subGap * s,
      s,
      colW: R.laneX * s,
      colLine1: R.colLine1 * s,
      laneY,
      laneH,
      evY: R.laneBottom * s,
      evH: (R.evBottom - R.evTop) * s,
      evTop: R.evTop * s,
      cy: R.laneCY * s,
      playX: R.judgeX * s,
      r: R.noteR * s,
      bigR: R.bigR * s,
      waveX: R.waveX * s,
      waveY: R.waveTop * s,
      waveH: (R.waveBottom - R.waveTop) * s,
      play: box(R.play),
      pv: { x: 0, y: 0, w: 0, h: 0 },
    };
  }

  /** 初期の拡大率（プレイ画面と同じ間隔） */
  /** プレイ画面のハイスピード（初期の拡大率をプレイ画面と同じ音符の間隔にするため） */
  playSpeed = 1;

  /**
   * 初期の拡大率: プレイ画面と同じ「音符の大きさに対する間隔」。
   * プレイ画面はハイスピード 1.0 で 1 小節 1470px・音符の半径 54px（1 拍 367.5px）。エディタの音符の半径も 54 なので同じ比率にする
   */
  get defaultZoom() {
    return (1470 / 4) * (R.noteR / 54) * this.playSpeed * this.s;
  }

  /** 判定枠の表示の位置 */
  private get dpos() {
    const ln = this.lanes;
    return this.playing && this.posTime !== null && ln.hasDelay ? ln.dispOfTime(this.posTime) : ln.disp(this.pos);
  }

  /** 表示の位置 → x */
  private xOfD(d: number, dpos = this.dpos) {
    return this.L.playX + ((d - dpos) / TPB) * this.zoom;
  }

  /** 表示の位置（x → ） */
  private dOf(x: number) {
    return this.dpos + ((x - this.L.playX) / this.zoom) * TPB;
  }

  xOf(tick: number) {
    return this.xOfD(this.lanes.disp(tick));
  }

  /**
   * タイムラインはレーンを縮めたもの（音符の大きさと間隔の比はレーンと同じ）。
   * 拡大率 100% で判定枠の x から右端までが 3 小節。レーンを拡大・縮小すると同じ割合で変わる
   */
  get tlScale() {
    return 1;
  }
  /** タイムラインの 1 拍の px */
  get tlZoom() {
    return Math.max(4, this.zoom * this.tlScale);
  }
  private xOfTl(d: number, dpos = this.dpos) {
    return this.L.playX + ((d - dpos) / TPB) * this.tlZoom;
  }
  private dOfTl(x: number) {
    return this.dpos + ((x - this.L.playX) / this.tlZoom) * TPB;
  }

  /** x と段 → tick（DELAY の空きなど、その段のそこに何もなければ null） */
  tickOf(x: number, row = 0) {
    return this.lanes.tickAt(this.dOf(x), row);
  }

  /** 段ごとの縦の位置（0 = いつものレーン、1〜 = 下に出る段） */
  rowGeom(row: number) {
    const L = this.L;
    const y = L.laneY + this.rowOff(row) - this.rowOff(this.vrow);
    return { y, h: L.laneH, cy: y + (L.cy - L.laneY), r: L.r, bigR: L.bigR };
  }

  /** y → 段（どの段でもなければ -1） */
  private rowAtY(y: number) {
    const L = this.L;
    const near = Math.round(this.vrow);
    if (y < L.laneY) return y >= L.laneY - L.r * 0.5 ? near : -1;
    if (y > L.laneY + L.blockH) return y <= L.evTop + L.evH ? near : -1;
    for (let r = 0; r < L.rows; r++) {
      const g = this.rowGeom(r);
      if (y >= g.y && y <= g.y + g.h) return r;
    }
    return -1;
  }

  /** 見ている段を、一番近い段へなめらかに寄せる */
  private settleRow(to = Math.round(this.vrow)) {
    cancelAnimationFrame(this.vAnim);
    const from = this.vrow;
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 160);
      this.vrowRaw = from + (to - from) * (1 - (1 - p) * (1 - p));
      this.invalidate();
      if (p < 1) this.vAnim = requestAnimationFrame(step);
    };
    this.vAnim = requestAnimationFrame(step);
  }

  /** 密度推移の縦の範囲（下が曲の始め、上が終わり） */
  private get graph() {
    const s = this.L.s;
    return { top: 18 * s, bottom: this.h - 18 * s };
  }

  /** 曲の長さ（秒）。音源がなければ最後のノーツ＋2 秒 */
  private lenKey = '';
  private lenT = 0;
  private songLength() {
    const key = `${this.ed.undoCount}|${this.ed.courseIndex}|${this.ed.branch}`;
    if (key !== this.lenKey) {
      this.lenKey = key;
      const notes = this.ed.course.notes;
      let last = 0;
      for (const n of notes) last = Math.max(last, n.endTick ?? n.tick);
      this.lenT = notes.length ? this.ed.timing.tickToTime(last) + 2 : 0;
    }
    return Math.max(this.duration, this.lenT, 1);
  }

  private scrubTo(y: number) {
    const g = this.graph;
    const p = Math.min(1, Math.max(0, (g.bottom - y) / (g.bottom - g.top)));
    const tick = this.ed.timing.timeToTick(p * this.songLength());
    this.pos = Math.max(0, this.ed.snap(tick));
    this.invalidate();
  }

  /**
   * 判定枠（再生位置）は自由に動かせるが、手を離したら一番近いグリッドへ寄せる（短くなめらかに動かす）
   */
  private settleAnim = 0;
  private settleTimer = 0;

  settle() {
    cancelAnimationFrame(this.settleAnim);
    if (this.playing) return;
    const from = this.pos;
    const to = this.ed.snapView(from);
    if (Math.abs(to - from) < 1) {
      this.pos = to;
      this.invalidate();
      return;
    }
    const t0 = performance.now();
    const step = () => {
      const p = Math.min(1, (performance.now() - t0) / 120);
      const k = 1 - (1 - p) * (1 - p);
      this.pos = from + (to - from) * k;
      this.invalidate();
      if (p < 1) this.settleAnim = requestAnimationFrame(step);
    };
    this.settleAnim = requestAnimationFrame(step);
  }

  private stopSettle() {
    cancelAnimationFrame(this.settleAnim);
    clearTimeout(this.settleTimer);
  }

  scrollBy(ticks: number) {
    this.pos = Math.max(this.ed.minPos, this.pos + ticks);
    this.invalidate();
  }

  setZoom(z: number) {
    this.zoom = Math.min(2400, Math.max(20, z));
    this.onZoomChange(this.zoom);
    this.invalidate();
  }

  // ---------- 入力 ----------

  /** 小さい画面でも押しやすいよう、当たり判定は見た目より少し大きく */
  private inBox(b: Box, x: number, y: number) {
    return Math.hypot(x - b.x, y - b.y) <= Math.max(b.r + 6, 22);
  }

  private bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.stopSettle();
      c.setPointerCapture(e.pointerId);
      const pt = localPoint(e, c);
      this.pointers.set(e.pointerId, pt);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d0: Math.abs(a.x - b.x) || 1, z0: this.zoom };
        this.drag = null;
      } else if (this.pointers.size === 1) {
        cancelAnimationFrame(this.vAnim);
        this.drag = { startX: pt.x, startY: pt.y, lastX: pt.x, lastY: pt.y, moved: false };
        // 長押し（0.3 秒）
        clearTimeout(this.pressTimer);
        const d0 = this.drag;
        const cx = e.clientX;
        const cy = e.clientY;
        this.pressTimer = window.setTimeout(() => {
          if (this.drag !== d0 || d0.moved || this.pointers.size !== 1) return;
          const at = this.laneTickAt(pt.x, pt.y);
          if (at && this.onLongPress(at.tick, at.tol, cx, cy)) d0.long = true;
        }, 300);
        // 密度推移の列を押したら、上下に動かしてその位置へ移動する
        const L = this.L;
        if (pt.x >= L.colLine1 && pt.x <= L.colW && !this.inBox(L.play, pt.x, pt.y)) {
          this.drag.scrub = true;
          this.drag.moved = true;
          this.onUserScroll();
          this.scrubTo(pt.y);
        } else if (this.stack && pt.y >= L.tlTop && pt.y <= L.tlBottom) {
          this.drag.tl = true;
        }
      }
    });

    c.addEventListener('pointermove', (e) => {
      const pt = localPoint(e, c);
      const L = this.L;
      if (e.pointerType === 'mouse') {
        this.hoverX = pt.y >= L.laneY - 10 && pt.y <= L.evTop + L.evH && pt.x > L.colW ? pt.x : null;
        this.hoverY = pt.y;
        this.invalidate();
      }
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, pt);
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.abs(a.x - b.x);
        if (this.pinch.d0 > 20 && d > 20) this.setZoom((this.pinch.z0 * d) / this.pinch.d0);
        return;
      }
      if (!this.drag) return;
      if (this.drag.scrub) {
        this.scrubTo(pt.y);
        return;
      }
      const dx = pt.x - this.drag.lastX;
      // #DELAY の段があるときは、レーンを縦にドラッグして段を切り替える
      if (this.drag.v) {
        this.vrowRaw = this.vrow - (pt.y - this.drag.lastY) / (L.laneH + (this.vrow < L.sub + 1 ? L.subGap : L.lgap));
        this.drag.lastY = pt.y;
        this.invalidate();
        return;
      }
      const ax = Math.abs(pt.x - this.drag.startX);
      const ay = Math.abs(pt.y - this.drag.startY);
      if (!this.drag.moved && L.maxV > 0 && ay > 8 && ay > ax && this.drag.startX > L.colW && this.drag.startY >= L.laneY && this.drag.startY <= L.laneY + L.blockH) {
        this.drag.moved = true;
        this.drag.v = true;
        this.drag.lastY = pt.y;
        return;
      }
      if (!this.drag.moved && ax > 8 && this.drag.startX > L.colW) {
        this.drag.moved = true;
        this.onUserScroll();
      }
      // 指の動きより少し速く流す（長い譜面でも移動しやすいように）
      // タイムラインは見えている長さが違うので、指と音符が同じだけ動くようにする
      if (this.drag.moved) this.scrollBy(this.drag.tl ? (-dx / this.tlZoom) * TPB : (-dx * SCROLL_GAIN / this.zoom) * TPB);
      this.drag.lastX = pt.x;
    });

    const end = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      clearTimeout(this.pressTimer);
      if (this.pinch) {
        if (this.pointers.size === 0) this.pinch = null;
        return;
      }
      if (this.drag?.long) {
        this.drag = null;
        return;
      }
      if (e.type === 'pointerup' && this.drag && !this.drag.moved) {
        const pt = localPoint(e, c);
        this.tap(pt.x, pt.y);
      }
      // 横にスクロールして離したら、一番近いグリッドへ寄せる
      if (this.drag?.v) this.settleRow();
      else if (this.drag?.moved && !this.drag.scrub) this.settle();
      this.drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hoverX = null;
      this.invalidate();
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // マウスのホイール（縦）は拡大・縮小。横のスクロール（トラックパッドの横・Shift ＋ ホイール）で移動
        const horiz = Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (e.ctrlKey || e.metaKey || (!horiz && !e.shiftKey)) {
          this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.002));
        } else if (e.shiftKey && !horiz && this.L.maxV > 0 && e.altKey) {
          // Shift + Alt + ホイールで段を切り替える
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          if (d) this.settleRow(Math.min(this.L.maxV, Math.max(0, Math.round(this.vrow) + Math.sign(d))));
        } else {
          this.onUserScroll();
          this.stopSettle();
          const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          this.scrollBy((d / this.zoom) * TPB);
          // ホイールが止まったらグリッドへ寄せる
          this.settleTimer = window.setTimeout(() => this.settle(), 160);
        }
      },
      { passive: false },
    );
  }

  private tap(x: number, y: number) {
    const L = this.L;
    if (this.inBox(L.play, x, y)) return this.onPlayToggle();
    if (x <= L.colW) return;
    {
      const c = this.cmpBoxes.find((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2);
      if (c && this.onGhostCompare) return this.onGhostCompare(c.id);
    }
    // 下の段（今の位置・ボタン）は、タップしても何もしない
    if (this.stack && y >= L.tlTop && y <= L.tlBottom) return;
    if (y >= L.waveY && y <= L.waveY + L.waveH) {
      // ほかのレーンの名前をタップ → そのレーンへ
      const g = this.ghostBoxes.find((b) => x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2);
      if (g) return this.onGhostTap(g.id);
      // 波形をタップ → その位置へ移動
      this.onUserScroll();
      const t = this.tickOf(x);
      if (t !== null) this.pos = this.ed.snapView(t);
      this.invalidate();
      return;
    }
    // レーンの下のイベントの文字をタップ → そのイベント（まとめたものは一覧）
    {
      const b = this.evBoxes.find((bx) => x >= bx.x1 && x <= bx.x2 && y >= bx.y1 - 4 && y <= bx.y2 + 4);
      if (b) return this.onEventTap(b.items);
    }
    // 曲の頭より前と、再生ボタンの中心より左には置けない
    if (x < L.play.x) return;
    const row = this.rowAtY(y);
    if (row < 0) return;
    if (row > L.sub) {
      const g = this.fullGhosts[this.rowMap[row][0] - 1];
      if (g) this.onGhostTap(g.id);
      return;
    }
    const t = this.tickOf(x, row);
    if (t !== null && t > -this.ed.step / 2) this.onTap(t, (this.rowGeom(row).r / this.zoom) * TPB);
  }

  /** レーンの上の位置なら、その tick と当たりの幅（長押し用。曲の頭より前・ほかのレーンは null） */
  private laneTickAt(x: number, y: number): { tick: number; tol: number } | null {
    const L = this.L;
    if (x <= L.colW || x < L.play.x || this.inBox(L.play, x, y)) return null;
    if (y >= L.waveY && y <= L.waveY + L.waveH) return null;
    if (this.stack && y >= L.tlTop && y <= L.tlBottom) return null;
    const row = this.rowAtY(y);
    if (row < 0 || row > L.sub) return null;
    const t = this.tickOf(x, row);
    return t !== null && t > -this.ed.step / 2 ? { tick: t, tol: (this.rowGeom(row).r / this.zoom) * TPB } : null;
  }

  // ---------- 描画 ----------

  frame() {
    if (!this.dirty) return;
    // 隠れていて大きさが 0 のとき（プレイ中など）は描かない（見えるようになって大きさが戻ってから描く）
    if (!this.canvas.width || !this.canvas.height) return;
    this.dirty = false;
    noteSkin.fn = this.tnde ? drawTndeNote : null;
    try {
      this.draw();
    } finally {
      noteSkin.fn = null;
    }
  }
  /** 音符を TNDE スキンの絵で描く */
  tnde = false;
  /** 字（TNDE スキンではプレイ画面の下の曲名と同じ丸ゴシック） */
  private get ff() {
    return this.tnde ? `'TNDE Seurat', 'Makinas 4 Flat', sans-serif` : `'Makinas 4 Flat', sans-serif`;
  }

  private draw() {
    const { ctx, ed } = this;
    const L = this.L;
    const s = L.s;
    const course = ed.course;
    const ln = this.lanes;
    /** レーンの枠の中だけに描く（#DELAY の段をスクロールしたとき、はみ出さないように） */
    const laneClip = (fn: () => void) => {
      ctx.save();
      ctx.beginPath();
      if (L.rows > 1) ctx.rect(L.colW, L.laneY, this.w - L.colW, L.blockH);
      else ctx.rect(L.colW, L.laneY - L.bigR, this.w - L.colW, L.laneH + L.bigR * 2);
      ctx.clip();
      fn();
      ctx.restore();
    };
    const dpos = this.dpos;
    const xd = (d: number) => this.xOfD(d, dpos);
    const xt = (tick: number) => xd(ln.disp(tick));
    const geomOf = (tick: number) => this.rowGeom(ln.rowOf(tick));
    const [leftTick, rightTick] = ln.tickRange(this.dOf(L.colW - L.bigR * 2), this.dOf(this.w + L.bigR * 2));
    /** tick の範囲が画面のどこに出るか（段ごと） */
    const spansX = (ta: number, tb: number) =>
      ln.spans(ta, tb)
        .map((sp) => ({ g: this.rowGeom(sp.row), x1: Math.max(L.colW, xd(sp.a)), x2: Math.min(this.w, xd(sp.b)) }))
        .filter((sp) => sp.x2 > sp.x1);

    // 背景は透明（後ろの六角形の模様を見せる。CSS の .stage）
    ctx.clearRect(0, 0, this.w, this.h);

    // 波形（上のタイムライン、またはこれまでのレーンの上の波形）
    if (this.stack) {
      // レーンとタイムラインを 1 つのまとまりに: 間（命令の段・段の間）もタイムラインの台と同じ色で埋める
      ctx.fillStyle = C.tlBg;
      ctx.fillRect(L.colW, L.laneY, this.w - L.colW, L.tlTop - L.laneY);
      this.drawBar(L);
      // 波形（レーンの下地。時刻は自分のレーンの 1 段目にそろえる）
      this.wave0 = this.waveCols(L.colW, this.w, (x) => ln.timeOfDisp(this.dOf(x)));
    } else {
      ctx.fillStyle = 'rgba(29,32,35,0.9)';
      ctx.fillRect(L.waveX, L.waveY, this.w - L.waveX, L.waveH);
      this.drawWave(L);
      this.drawGhosts(L);
    }

    laneClip(() => {
      // レーン（#DELAY の段は、重なった所だけ緑がかった色。それ以外は何もない所なので暗く）
      for (let r = 0; r <= L.sub; r++) {
        const g = this.rowGeom(r);
        if (g.y > L.laneY + L.blockH || g.y + g.h < L.laneY) continue;
        ctx.fillStyle = r === 0 ? C.lane : C.emptyLane;
        ctx.fillRect(L.colW, g.y, this.w - L.colW, g.h);
      }
      for (const p of ln.pieces) {
        if (p.row === 0) continue;
        const g = this.rowGeom(p.row);
        const x1 = Math.max(L.colW, xd(p.a));
        const x2 = Math.min(this.w, xd(p.b));
        if (x2 <= x1) continue;
        ctx.fillStyle = C.subLane;
        ctx.fillRect(x1, g.y, x2 - x1, g.h);
      }

      // ゴーゴー区間
      const ranges = this.ed.gogoRanges();
      ctx.fillStyle = C.gogo;
      for (const [a, b] of ranges) for (const sp of spansX(a, b)) ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, sp.g.h);

      // 譜面分岐の区間（玄人・達人はその色に染める。上の縁に分岐の色の帯）
      for (const br of this.branches) {
        const c = BRANCH_COLOR[this.branchNo];
        for (const sp of spansX(br.a, br.b)) {
          if (this.branchNo) {
            ctx.globalAlpha = 0.26;
            ctx.fillStyle = c;
            ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, sp.g.h);
          }
          ctx.globalAlpha = 0.95;
          ctx.fillStyle = c;
          ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, Math.max(4, 10 * s));
          ctx.globalAlpha = 1;
        }
      }

      // 波形（レーンの下地）。#DELAY の段は、その段に出ている所の時刻で
      if (this.stack && this.wave0) {
        for (let r = 0; r <= L.sub; r++) {
          const g = this.rowGeom(r);
          if (g.y > L.laneY + L.blockH || g.y + g.h < L.laneY) continue;
          const cols = r === 0 ? this.wave0 : this.waveCols(L.colW, this.w, (x) => {
            const t = ln.tickAt(this.dOf(x), r);
            return t === null ? null : ed.timing.tickToTime(t);
          });
          if (cols) this.paintWave(cols, g.y, g.h);
        }
      }

      // 合作: 本譜面の小節の出どころ（レーンの上の縁に案の色の帯・頭に名前）
      for (const bd of this.bands) {
        const bh = Math.max(3, 8 * s);
        for (const sp of spansX(bd.a, bd.b)) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = bd.color;
          ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, bh);
          ctx.globalAlpha = 1;
        }
        const x = xt(bd.a);
        if (x >= L.colW - 4 && x <= this.w) {
          const g = geomOf(bd.a);
          ctx.font = `800 ${Math.round(Math.max(9, 15 * s))}px ${this.ff}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillStyle = bd.color;
          ctx.fillText(bd.label, Math.max(L.colW + 2, x + 3 * s), g.y + bh + 2 * s);
        }
      }

      // グラデの範囲（レーンの下の端に紫の帯。右へ行くほど濃く）
      for (const g of course.grads ?? []) {
        const bh = Math.max(4, 10 * s);
        const grd = ctx.createLinearGradient(xt(g.start), 0, xt(g.end), 0);
        grd.addColorStop(0, 'rgba(199,146,234,0.25)');
        grd.addColorStop(1, 'rgba(199,146,234,0.9)');
        ctx.fillStyle = grd;
        // #DELAY で重なって別の段に出ている所（グラデをかけない所）には出さない
        for (const [a, b] of gradParts(g)) for (const sp of spansX(a, b)) ctx.fillRect(sp.x1, sp.g.y + sp.g.h - bh, sp.x2 - sp.x1, bh);
      }
    });

    ctx.save();
    const edge = Math.max(1, 2 * s);
    if (this.stack) {
      // 段ごとに下端だけ目立たない細い線
      ctx.fillStyle = C.laneLine;
    } else {
      ctx.fillStyle = C.laneEdge;
      ctx.shadowColor = 'rgba(30,136,255,0.8)';
      ctx.shadowBlur = 8 * s;
    }
    // 段ごとに上下の縁（見えている段だけ。スクロール中は枠からはみ出さない）
    ctx.beginPath();
    ctx.rect(L.colW, L.laneY - edge, this.w - L.colW, L.blockH + edge * 2);
    ctx.clip();
    for (let r = 0; r <= L.sub; r++) {
      const g = this.rowGeom(r);
      if (g.y > L.laneY + L.blockH + 1 || g.y + g.h < L.laneY - 1) continue;
      if (!this.stack) ctx.fillRect(L.colW, g.y - edge / 2, this.w - L.colW, edge);
      ctx.fillRect(L.colW, g.y + g.h - edge / 2, this.w - L.colW, edge);
      if (!L.sub) break;
    }
    ctx.restore();
    if (this.stack) {
      // プレビューとレーンの間: ほぼ黒のすき間で切り離す
      const y0 = L.pv.y + L.pv.h;
      ctx.fillStyle = C.pvGap;
      ctx.fillRect(L.colW, y0, this.w - L.colW, L.laneY + edge / 2 - y0);
    }

    // 見えていない段に音符がある所: 上下の縁を緑にして知らせる。右の端に、見ている段の印
    if (L.rows > 1) {
      const cur = Math.round(this.vrow);
      const last = cur + L.vis - 1;
      const bh = Math.max(3, 6 * s);
      ctx.fillStyle = EVENT_COLOR.delay;
      for (const p of ln.pieces) {
        if ((p.row >= cur && p.row <= last) || p.row === 0) continue;
        const x1 = Math.max(L.colW, xd(p.a));
        const x2 = Math.min(this.w, xd(p.b));
        if (x2 <= x1) continue;
        if (p.row > last) ctx.fillRect(x1, L.laneY + L.blockH - bh, x2 - x1, bh);
        else ctx.fillRect(x1, L.laneY, x2 - x1, bh);
      }
      const dr = Math.max(3, 6 * s);
      const gap = dr * 3;
      const y0 = L.laneY + L.blockH / 2 - ((L.rows - 1) * gap) / 2;
      for (let r = 0; r < L.rows && L.maxV > 0; r++) {
        ctx.fillStyle = r >= cur && r <= last ? EVENT_COLOR.delay : 'rgba(255,255,255,0.3)';
        ctx.beginPath();
        ctx.arc(this.w - dr * 2.5, y0 + r * gap, dr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /** その小節の頭で小節線を出すか（#BARLINEOFF / #BARLINEON） */
    const barShown = (tick: number) => {
      let on = true;
      let at = -1;
      for (const e of course.events) if (e.kind === 'barline' && e.tick <= tick && e.tick >= at) { on = e.on; at = e.tick; }
      return on;
    };
    // グリッド（小節線＋分割の点）
    // 曲の頭より前には小節線・グリッドを出さない
    const ms = ed.measuresUntil(Math.max(0, rightTick));
    const step = ed.step;
    const stepPx = (step / TPB) * this.zoom;
    for (const m of ms) {
      if (m.start + m.length < leftTick) continue;
      if (m.start > rightTick) break;
      // 小節の中のグリッドの数（小節の長さで割り切れない間隔でも、小節の中に入る所は全部）
      const count = Math.ceil(m.length / step - 1e-6);
      // 波形の上の目安の線: 拍ごとに薄い線、グリッドごとにさらに薄い線（小節線だけはレーンまで通す）
      const lw1 = Math.max(1, s);
      const beatPx = this.zoom;
      if (beatPx >= 6 && !this.stack) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        for (let rel = TPB; rel < m.length; rel += TPB) {
          if (ln.rows > 1 && ln.rowOf(m.start + rel) !== 0) continue;
          const x = xt(m.start + rel);
          if (x >= L.colW && x <= this.w) ctx.fillRect(x - lw1 / 2, L.waveY, lw1, L.waveH);
        }
      }
      if (stepPx >= 7 && !this.stack) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        for (let k = 1; k < count; k++) {
          const rel = Math.round(k * step);
          if (rel % TPB === 0) continue;
          if (ln.rows > 1 && ln.rowOf(m.start + rel) !== 0) continue;
          const x = xt(m.start + rel);
          if (x >= L.colW && x <= this.w) ctx.fillRect(x - lw1 / 2, L.waveY, lw1, L.waveH);
        }
      }
      // 間隔が狭くて点を描かないときは、拍の点だけ（細かいグリッドで回数が増えすぎないように）
      const pts = stepPx >= 7 ? Array.from({ length: Math.max(0, count - 1) }, (_, i) => Math.round((i + 1) * step)) : beatRels(m.length);
      laneClip(() => {
      for (const rel of pts) {
        const inBeat = rel % TPB;
        if (stepPx < 7 && inBeat !== 0) continue;
        const x = xt(m.start + rel);
        if (x < L.colW || x > this.w) continue;
        const d = inBeat === 0 ? 1 : TPB / gcd(TPB, inBeat);
        const g = geomOf(m.start + rel);
        ctx.fillStyle = DOT_COLORS[d] ?? '#6c6c74';
        hexPath(ctx, x, g.cy, (inBeat === 0 ? 13 : 9) * s * Math.max(0.7, L.k));
        ctx.fill();
      }
      });
      const x = xt(m.start);
      if (x >= L.colW - 1 && x <= this.w + 1) {
        const row = ln.rowOf(m.start);
        const g = this.rowGeom(row);
        const lw = Math.max(1, 2 * s);
        ctx.font = `600 ${Math.round(28 * s)}px ${this.ff}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        // 波形の上の小節線と番号は、いつものレーンの小節だけ
        if (row === 0 && !this.stack) {
          ctx.fillStyle = C.measure;
          ctx.fillRect(x - lw / 2, L.waveY, lw, L.laneY - L.waveY);
          ctx.fillStyle = C.text;
          ctx.fillText(String(m.index + 1), x + 6 * s, L.waveY + 6 * s);
        }
        // 譜面分岐を決める小節（分岐の 1 小節前。直前で決める分岐はその前のとても短い小節）の線は黄色（#BARLINEOFF の所は除く）
        // （とても短い小節のすぐ後の線はほぼ同じ所に重なるので、短い小節の線が黄色ならそれも黄色）
        const tinyBefore = course.events.find((e) => e.kind === 'measure' && e.num / e.den <= 1 / 1000 && e.tick < m.start && e.tick + measureTicks(e.num, e.den) === m.start);
        const brBar = (this.branches.some((b) => b.a === m.start + m.length || (m.start === 0 && b.a === 0)) && barShown(m.start))
          || (!!tinyBefore && this.branches.some((b) => b.a === m.start) && barShown(tinyBefore.tick));
        laneClip(() => {
          ctx.fillStyle = brBar ? '#ffd400' : C.measure;
          ctx.fillRect(x - lw / 2, g.y, lw, g.h);
          if (row !== 0 || this.stack) {
            ctx.fillStyle = C.text;
            ctx.fillText(String(m.index + 1), x + 6 * s, g.y + 6 * s);
          }
        });
      }
    }

    // イベント（レーンの下）: 短い文字を種類ごとの色で。文字が重なるときは先頭だけ出して「+N」にまとめる
    // 上下にスクロールする配置では、レーンの所より上（タイムライン）にはみ出さない
    ctx.save();
    if (this.stack) {
      ctx.beginPath();
      ctx.rect(0, L.laneY, this.w, this.h - L.laneY);
      ctx.clip();
    }
    ctx.font = `600 ${Math.round(22 * s)}px ${this.ff}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const grads = course.grads ?? [];
    /** その tick の命令を出す段の、命令の欄の上端（上下にスクロールする配置では、#DELAY の段ごとにその段の下） */
    const evRowY = (tick: number) => (this.stack ? this.rowGeom(ln.rowOf(tick)).y + L.laneH + 6 * s : L.evTop);
    const evItems: EventItem[] = [];
    // 分岐を直前で決めるためのとても短い小節（#MEASURE 1/9999）と、その後で元の拍子に戻す #MEASURE は、分岐の印にまとめる
    const preTicks = new Set<number>();
    for (const e of course.events) {
      if (e.kind !== 'measure' || e.num / e.den > 1 / 1000) continue;
      const after = e.tick + measureTicks(e.num, e.den);
      if (!this.branches.some((b) => b.a === after)) continue;
      preTicks.add(e.tick);
      preTicks.add(after);
    }
    for (const e of course.events) {
      // GOGO はレーンの色で分かるので、イベントとしては出さない
      if (e.kind === 'gogo' || TJA_ONLY.has(e.kind) || !this.evShow[e.kind]) continue;
      if ((e.kind === 'measure' || e.kind === 'barline') && preTicks.has(e.tick)) continue;
      if (e.tick > rightTick) continue;
      const x = xt(e.tick);
      if (x >= L.colW && x <= this.w) {
        // 三角の印はすべてに出す（その命令がある段の下）
        const ey = evRowY(e.tick);
        ctx.fillStyle = EVENT_COLOR[e.kind];
        ctx.beginPath();
        ctx.moveTo(x, ey - 6 * s + 2);
        ctx.lineTo(x - 9 * s, ey - 2 * s);
        ctx.lineTo(x + 9 * s, ey - 2 * s);
        ctx.closePath();
        ctx.fill();
      }
      // グラデの中の #SCROLL は、グラデの始点の 1 つにまとめる
      // （グラデの中に単体で置いた #SCROLL は、ふつうの命令と同じく出す）
      const g = e.kind === 'scroll' ? grads.find((x) => e.tick >= x.start && e.tick < x.end && !(e.pin && e.tick !== x.start) && !inGradHole(x, e.tick)) : undefined;
      if (g) {
        const it = evItems.find((x) => x.grad === g);
        if (it) it.events.push(e);
        else evItems.push({ tick: g.start, events: [e], grad: g });
        continue;
      }
      evItems.push({ tick: e.tick, events: [e] });
    }
    // 譜面分岐の区間の始まり（条件）
    this.branches.forEach((br, i) => {
      if (br.a > rightTick) return;
      const x = xt(br.a);
      if (x >= L.colW && x <= this.w) {
        const ey = evRowY(br.a);
        ctx.fillStyle = BRANCH_COLOR[this.branchNo];
        ctx.beginPath();
        ctx.moveTo(x, ey - 6 * s + 2);
        ctx.lineTo(x - 9 * s, ey - 2 * s);
        ctx.lineTo(x + 9 * s, ey - 2 * s);
        ctx.closePath();
        ctx.fill();
      }
      evItems.push({ tick: br.a, events: [], branch: i });
    });
    evItems.sort((a, b) => a.tick - b.tick);
    const label = (it: EventItem) => (it.branch !== undefined ? this.branches[it.branch]?.label ?? '' : it.grad ? `×${it.grad.from}→${it.grad.to}` : eventShort(it.events[0]));
    const color = (it: EventItem) => (it.branch !== undefined ? BRANCH_COLOR[Math.max(1, this.branchNo)] : EVENT_COLOR[it.events[0].kind]);
    const pad = 7 * s;
    const boxH = 30 * s;
    this.evBoxes = [];
    let cur: { x1: number; x2: number; y1: number; y2: number; items: EventItem[] } | null = null;
    const flush = () => {
      if (!cur) return;
      const y0 = cur.y1;
      const first = cur.items[0];
      const t = label(first);
      const tw = ctx.measureText(t).width;
      const more = cur.items.length - 1;
      ctx.fillStyle = 'rgba(30,30,36,0.92)';
      ctx.fillRect(cur.x1, y0, cur.x2 - cur.x1, boxH);
      ctx.fillStyle = color(first);
      ctx.fillRect(cur.x1, y0, Math.max(2, 3 * s), boxH);
      ctx.fillText(t, cur.x1 + pad, y0 + boxH / 2);
      if (more > 0) {
        const bx = cur.x1 + pad + tw + 6 * s;
        ctx.fillStyle = '#4a4a55';
        ctx.fillRect(bx, y0 + 4 * s, cur.x2 - bx - 4 * s, boxH - 8 * s);
        ctx.fillStyle = '#fff';
        ctx.fillText(`+${more}`, bx + 5 * s, y0 + boxH / 2);
      }
      this.evBoxes.push(cur);
    };
    evItems.sort((a, b) => xt(a.tick) - xt(b.tick));
    // 段ごとに並べる（同じ段の中で重なるものだけまとめる）
    evItems.sort((a, b) => evRowY(a.tick) - evRowY(b.tick) || xt(a.tick) - xt(b.tick));
    for (const it of evItems) {
      const x = xt(it.tick);
      if (x < L.colW || x > this.w) continue;
      const w = ctx.measureText(label(it)).width + pad * 2;
      const y1 = evRowY(it.tick) + 2 * s;
      if (cur && cur.y1 === y1 && x < cur.x2 + 4 * s) {
        // 前の文字に重なる → まとめる（幅は「+N」の分だけ広げる）
        cur.items.push(it);
        const base = ctx.measureText(label(cur.items[0])).width + pad * 2;
        const badge = ctx.measureText(`+${cur.items.length - 1}`).width + 16 * s;
        cur.x2 = Math.max(cur.x2, cur.x1 + base + badge);
        continue;
      }
      flush();
      cur = { x1: x + 2 * s, x2: x + 2 * s + w, y1, y2: y1 + boxH, items: [it] };
    }
    flush();
    ctx.restore();

    // 判定枠（白と青の二重の輪。ここが再生位置）
    ctx.save();
    ctx.shadowColor = 'rgba(30,136,255,0.9)';
    ctx.shadowBlur = 10 * s;
    ctx.lineWidth = Math.max(1.5, 4 * s);
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(L.playX, L.cy, L.judgeR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    ctx.lineWidth = Math.max(1, 3 * s);
    ctx.strokeStyle = '#4d9fbe';
    ctx.beginPath();
    ctx.arc(L.playX, L.cy, L.judgeR2, 0, Math.PI * 2);
    ctx.stroke();

    // 選んでいる範囲（水色の帯。両端の音符が収まるよう少し広げる）
    laneClip(() => {
    if (ed.sel) {
      const pad = L.r * 1.2;
      for (const sp of ln.spans(ed.sel.start - pad / this.zoom * TPB, ed.sel.end + pad / this.zoom * TPB)) {
        const g = this.rowGeom(sp.row);
        const x1 = Math.max(L.colW, xd(sp.a));
        const x2 = Math.min(this.w, xd(sp.b));
        if (x2 <= x1) continue;
        ctx.fillStyle = 'rgba(147,205,226,0.16)';
        ctx.fillRect(x1, g.y, x2 - x1, g.h);
        ctx.strokeStyle = 'rgba(147,205,226,0.85)';
        ctx.lineWidth = Math.max(1, 2 * s);
        ctx.setLineDash([6 * s, 5 * s]);
        ctx.strokeRect(x1, g.y + 1, x2 - x1, g.h - 2);
        ctx.setLineDash([]);
      }
    }
    });

    // ノーツ（後ろから描く）
    ctx.save();
    ctx.beginPath();
    if (L.rows > 1) ctx.rect(L.colW, L.laneY, this.w - L.colW, L.blockH);
    else ctx.rect(L.colW, L.laneY - L.bigR, this.w - L.colW, L.laneH + L.bigR * 2);
    ctx.clip();
    const notes = course.notes;
    const [lo0, hi0] = visRange(notes, leftTick, rightTick, ed.undoCount);
    for (let i = hi0 - 1; i >= lo0; i--) {
      const n = notes[i];
      const endT = n.endTick ?? n.tick;
      if (endT < leftTick || n.tick > rightTick) continue;
      const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
      const x = xt(n.tick);
      const ex = n.endTick !== undefined ? xt(n.endTick) : undefined;
      const g = geomOf(n.tick);
      if (n.type === 'balloon' && ex !== undefined) {
        // 風船は、受け付けている範囲を半透明のオレンジの連打で示す
        ctx.globalAlpha = 0.45;
        drawRoll(ctx, x, ex, g.cy, g.r, 'balloon');
        ctx.globalAlpha = 1;
        drawAny(ctx, n.type, x, g.cy, g.r, undefined, n.hits ?? 5);
      } else {
        drawAny(ctx, n.type, x, g.cy, big ? g.bigR : g.r, ex, n.type === 'balloon' ? n.hits ?? 5 : null);
      }
    }

    // 選んでいるノーツに水色の輪
    if (ed.sel) {
      ctx.strokeStyle = '#93cde2';
      ctx.lineWidth = Math.max(1.5, 4 * s);
      for (const n of ed.selectedNotes()) {
        if (n.tick < leftTick || n.tick > rightTick) continue;
        const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
        const g = geomOf(n.tick);
        ctx.beginPath();
        ctx.arc(xt(n.tick), g.cy, (big ? g.bigR : g.r) + 5 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 連打の始点（終点待ち）
    if (ed.pendingLong !== null) {
      const x = xt(ed.pendingLong);
      const g = geomOf(ed.pendingLong);
      ctx.setLineDash([8 * s, 8 * s]);
      ctx.strokeStyle = ed.tool === 'gogo' ? '#ff6e28' : ed.tool === 'scroll' ? '#c792ea' : ed.tool === 'select' ? '#7cc4ff' : '#fbbf14';
      ctx.lineWidth = Math.max(2, 5 * s);
      ctx.beginPath();
      if (ed.tool === 'gogo' || ed.tool === 'scroll' || ed.tool === 'select') {
        // ゴーゴー・グラデの始点は縦の点線
        ctx.moveTo(x, g.y);
        ctx.lineTo(x, g.y + g.h);
      } else {
        ctx.arc(x, g.cy, g.r * 1.15, 0, Math.PI * 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // マウス位置のプレビュー
    const hRow = this.hoverX !== null ? this.rowAtY(this.hoverY) : -1;
    const hTick = this.hoverX !== null && hRow >= 0 ? this.tickOf(this.hoverX, hRow) : null;
    if (hTick !== null && !this.drag) {
      const t = ed.snap(hTick);
      const x = xt(t);
      const g = geomOf(t);
      const L = { ...this.L, laneY: g.y, laneH: g.h, cy: g.cy, r: g.r, bigR: g.bigR };
      ctx.globalAlpha = 0.4;
      if (ed.tool === 'gogo' || ed.tool === 'scroll' || ed.tool === 'bpm' || ed.tool === 'measure' || ed.tool === 'select') {
        ctx.fillStyle = { gogo: '#ff6e28', scroll: '#c792ea', bpm: '#5cc8f0', measure: '#e0a400', select: '#7cc4ff' }[ed.tool];
        ctx.fillRect(x - Math.max(1, 2 * s), L.laneY, Math.max(2, 4 * s), L.laneH);
      } else if (ed.tool === 'erase') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, L.cy, L.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const big = ed.tool === 'bigDon' || ed.tool === 'bigKa' || ed.tool === 'bigRoll';
        drawAny(ctx, ed.tool, x, L.cy, big ? L.bigR : L.r, x + this.zoom);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    this.drawFullGhosts(L);
    this.drawCursors(L);
    this.drawColumn(L);
  }

  /** 下の段（stack の配置）: 左に分岐のボタン（DOM）、その右に今の小節・BPM・拍子。右は拡大率のボタン（DOM） */
  private drawBar(L: Lay) {
    const { ctx, ed } = this;
    const s = L.s;
    const x0 = L.colW;
    const top = L.tlTop;
    const bot = L.tlBottom;
    if (bot - top < 20) return;
    ctx.fillStyle = 'rgba(20,23,26,0.95)';
    ctx.fillRect(x0, top, this.w - x0, bot - top);
    ctx.fillStyle = C.laneLine;
    ctx.fillRect(x0, top, this.w - x0, Math.max(1, s));
    const font = (w: number, px: number) => `${w} ${Math.round(px)}px ${this.ff}`;
    const at = Math.max(0, ed.snap(this.pos));
    const mm = ed.measureOf(at);
    const f0 = font(800, Math.max(12, 26 * s));
    const f1 = font(700, Math.max(11, 20 * s));
    const f2 = font(700, Math.max(8, 13 * s));
    // 桁数が変わっても位置が動かないよう、決まった幅の枠に左寄せで書く
    ctx.font = f0;
    const wBar = ctx.measureText('8888').width;
    ctx.font = f2;
    const wLbl = ctx.measureText('BPM').width;
    ctx.font = f1;
    const wBpm = ctx.measureText('888.88').width;
    const gap = 10 * s + 2;
    const bx = x0 + 10 + this.barReserve;
    const lx = bx + wBar + gap;
    const vx = lx + wLbl + 4;
    const mx = vx + wBpm + gap;
    const cy = (top + bot) / 2 + 1;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = f0;
    ctx.fillStyle = C.text;
    ctx.fillText(String(mm.index + 1), bx, cy);
    ctx.font = f2;
    ctx.fillStyle = C.sub;
    ctx.fillText('BPM', lx, cy);
    ctx.font = f1;
    ctx.fillStyle = C.text;
    ctx.fillText(String(Number(ed.timing.bpmAt(at).toFixed(2))), vx, cy);
    ctx.fillText(`${mm.num}/${mm.den}`, mx, cy);
  }

  /** 今のフレームの、自分のレーンの 1 段目の時刻での波形（ほかの段も時刻でそろえて使う） */
  private wave0: WaveCols | null = null;

  /** 波形を x の 1px ごとの最大振幅・RMS にする（timeAt が null の所は空） */
  private waveCols(x0: number, x1: number, timeAt: (x: number) => number | null): WaveCols | null {
    const wv = this.wave;
    if (!wv || x1 <= x0) return null;
    const bw = 1;
    const n = Math.ceil((x1 - x0) / bw) + 1;
    const pk = new Float32Array(n);
    const rm = new Float32Array(n);
    const len = wv.peaks.length;
    let prev = timeAt(x0);
    for (let i = 0; i < n; i++) {
      const next = timeAt(x0 + (i + 1) * bw);
      if (prev !== null && next !== null) {
        let i0 = Math.floor(Math.min(prev, next) * wv.rate);
        let i1 = Math.ceil(Math.max(prev, next) * wv.rate);
        if (i1 >= 0 && i0 < len) {
          i0 = Math.max(0, i0);
          i1 = Math.min(len - 1, Math.max(i1, i0));
          let p = 0;
          let q = 0;
          for (let j = i0; j <= i1; j++) {
            if (wv.peaks[j] > p) p = wv.peaks[j];
            if (wv.rms && wv.rms[j] > q) q = wv.rms[j];
          }
          pk[i] = p;
          rm[i] = Math.min(p, q * 1.2);
        }
      }
      prev = next;
    }
    return { x0, bw, pk, rm };
  }

  /** 波形をレーンの下地に描く（上下対称の外形を薄く、RMS の芯を少し濃く） */
  private paintWave(c: WaveCols, y: number, h: number) {
    const ctx = this.ctx;
    const cy = y + h / 2;
    const A = h * 0.46;
    const n = c.pk.length;
    const shape = (v: Float32Array, color: string) => {
      ctx.beginPath();
      ctx.moveTo(c.x0, cy);
      for (let i = 0; i < n; i++) ctx.lineTo(c.x0 + i * c.bw, cy - v[i] * A);
      for (let i = n - 1; i >= 0; i--) ctx.lineTo(c.x0 + i * c.bw, cy + v[i] * A);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    };
    shape(c.pk, 'rgba(255,255,255,0.12)');
    if (this.wave?.rms) shape(c.rm, 'rgba(255,255,255,0.15)');
  }

  /** 秒 → x（今の表示で） */
  private xOfTime(t: number) {
    return this.xOfD(this.lanes.dispOfTime(t));
  }

  /** 合作: ほかのレーンを、波形の下の方に小さく並べる（時刻をそろえる） */
  private drawGhosts(L: Lay, area?: { top: number; bottom: number }) {
    this.ghostBoxes = [];
    const rows = this.ghosts.slice(0, 3);
    if (!rows.length) return;
    const ctx = this.ctx;
    const s = L.s;
    // 上は合作の帯、下は小節・BPM の表示の分をあける（上のタイムラインでは、渡された範囲）
    const top = area ? area.top : L.waveY + 72 * s;
    const bottom = area ? area.bottom : L.waveY + L.waveH - 70 * s;
    const rh = Math.min(76 * s, (bottom - top) / rows.length);
    const x0 = L.waveX;
    const dOf = (x: number) => (area ? this.dOfTl(x) : this.dOf(x));
    const xOfTime = (t: number) => (area ? this.xOfTl(this.lanes.dispOfTime(t)) : this.xOfTime(t));
    const tL = this.lanes.timeOfDisp(dOf(x0 - 40 * s));
    const tR = this.lanes.timeOfDisp(dOf(this.w + 40 * s));
    rows.forEach((g, k) => {
      const y = top + k * rh;
      const cy = y + rh / 2;
      ctx.fillStyle = 'rgba(16,20,24,0.78)';
      ctx.fillRect(x0, y + 2 * s, this.w - x0, rh - 4 * s);
      ctx.fillStyle = g.color;
      ctx.fillRect(x0, y + 2 * s, Math.max(2, 4 * s), rh - 4 * s);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y, this.w - x0, rh);
      ctx.clip();
      // 小節線
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (const b of g.bars) {
        if (b < tL || b > tR) continue;
        const x = xOfTime(b);
        ctx.fillRect(x - 0.5, y + 4 * s, 1, rh - 8 * s);
      }
      // 音符（小さく）
      const r = Math.max(3, Math.min(rh * 0.3, 15 * s));
      for (const n of g.notes) {
        if ((n.e ?? n.t) < tL || n.t > tR) continue;
        const x = xOfTime(n.t);
        const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
        const ex = n.e !== undefined ? xOfTime(n.e) : undefined;
        drawAny(ctx, n.type as never, x, cy, big ? r * 1.4 : r, ex, null);
      }
      ctx.restore();
      // 名前（右の端。タップでそのレーンへ）
      const label = `${g.main ? '★' : ''}${g.name}`;
      ctx.font = `600 ${Math.round(Math.max(10, 17 * s))}px ${this.ff}`;
      const tw = ctx.measureText(label).width;
      const pw = tw + 22 * s;
      const ph = Math.min(rh - 8 * s, 30 * s);
      const px = x0 + 10 * s;
      const py = cy - ph / 2;
      ctx.fillStyle = 'rgba(8,10,12,0.85)';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = g.color;
      ctx.lineWidth = Math.max(1, 1.5 * s);
      ctx.strokeRect(px, py, pw, ph);
      ctx.fillStyle = '#f4f4f4';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, px + 11 * s, cy);
      this.ghostBoxes.push({ x1: px - 6 * s, x2: px + pw + 6 * s, y1: y, y2: y + rh, id: g.id });
    });
  }

  /**
   * 合作: ほかのレーンを、自分のレーンの下に同じ大きさで描く（自分のレーンと同じ描き方: GOGO・小節線・拍の点・命令・グラデ・#DELAY の段）。
   * 横の位置は時刻でそろえる。譜面の間には名前と、その譜面の命令を出す
   */
  private drawFullGhosts(L: Lay) {
    this.cmpBoxes = [];
    const gs = this.fullGhosts;
    if (!gs.length) return;
    const ctx = this.ctx;
    const s = L.s;
    const x0 = L.colW;
    const own = this.lanes;
    const tL = own.timeOfDisp(this.dOf(x0 - L.bigR * 2));
    const tR = own.timeOfDisp(this.dOf(this.w + L.bigR * 2));
    const map = this.rowMap;
    const lw = Math.max(1, 2 * s);
    const font = (w: number, px: number) => `${w} ${Math.round(px)}px ${this.ff}`;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, L.laneY, this.w - x0, L.blockH);
    ctx.clip();
    gs.forEach((g, gi) => {
      const geo = this.geoOf(g);
      const ln = geo.lanes;
      const first = map.findIndex(([c]) => c === gi + 1);
      if (first < 0) return;
      const rowG = (r: number) => this.rowGeom(first + r);
      const top = rowG(0).y;
      const bottom = rowG(ln.rows - 1).y + L.laneH;
      if (top > L.laneY + L.blockH || bottom < L.laneY) return;
      /** そのレーンの表示の位置 → 画面の x（時刻でそろえる） */
      const X = (d: number) => this.xOfTime(ln.timeOfDisp(d));
      const Xt = (tick: number) => this.xOfTime(geo.timing.tickToTime(tick));
      const [leftTick, rightTick] = ln.tickRange(ln.dispOfTime(tL), ln.dispOfTime(tR));
      const spans = (a: number, b: number) =>
        ln.spans(a, b).map((sp) => ({ g: rowG(sp.row), x1: Math.max(x0, X(sp.a)), x2: Math.min(this.w, X(sp.b)) })).filter((sp) => sp.x2 > sp.x1);

      const label = `${g.main ? '★' : ''}${g.name}`;
      const grads = geo.course.grads ?? [];

      // レーン（#DELAY で重なった所だけ下の段。ほかは暗く）
      for (let r = 0; r < ln.rows; r++) {
        const q = rowG(r);
        ctx.fillStyle = r === 0 ? C.lane : C.emptyLane;
        ctx.fillRect(x0, q.y, this.w - x0, q.h);
      }
      for (const pc of ln.pieces) {
        if (pc.row === 0) continue;
        const q = rowG(pc.row);
        const x1 = Math.max(x0, X(pc.a));
        const x2 = Math.min(this.w, X(pc.b));
        if (x2 > x1) { ctx.fillStyle = C.subLane; ctx.fillRect(x1, q.y, x2 - x1, q.h); }
      }
      // レーンの色（うっすら）
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = g.color;
      for (let r = 0; r < ln.rows; r++) ctx.fillRect(x0, rowG(r).y, this.w - x0, L.laneH);
      ctx.globalAlpha = 1;
      // 波形（時刻でそろえるので、自分のレーンの 1 段目と同じ）
      if (this.wave0) this.paintWave(this.wave0, rowG(0).y, L.laneH);
      // ゴーゴー
      ctx.fillStyle = C.gogo;
      for (const [a, b] of geo.gogo) for (const sp of spans(a, b)) ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, sp.g.h);
      // 本譜面の小節の出どころ
      for (const bd of g.bands ?? []) {
        const bh = Math.max(3, 8 * s);
        ctx.fillStyle = bd.color;
        for (const sp of spans(bd.a, bd.b)) ctx.fillRect(sp.x1, sp.g.y, sp.x2 - sp.x1, bh);
        const x = Xt(bd.a);
        if (x >= x0 - 4 && x <= this.w) {
          ctx.font = `800 ${Math.round(Math.max(9, 15 * s))}px ${this.ff}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(bd.label, Math.max(x0 + 2, x + 3 * s), rowG(ln.rowOf(bd.a)).y + bh + 2 * s);
        }
      }
      // グラデ（下の端に紫の帯）
      for (const gr of grads) {
        const bh = Math.max(4, 10 * s);
        const grd = ctx.createLinearGradient(Xt(gr.start), 0, Xt(gr.end), 0);
        grd.addColorStop(0, 'rgba(199,146,234,0.25)');
        grd.addColorStop(1, 'rgba(199,146,234,0.9)');
        ctx.fillStyle = grd;
        for (const sp of spans(gr.start, gr.end)) ctx.fillRect(sp.x1, sp.g.y + sp.g.h - bh, sp.x2 - sp.x1, bh);
      }
      // 小節線・拍の点・小節番号
      const step = this.ed.step;
      const stepPx = (step / TPB) * this.zoom;
      ctx.font = `600 ${Math.round(28 * s)}px ${this.ff}`;
      ctx.textBaseline = 'top';
      for (const m of geo.ms) {
        if (m.start + m.length < leftTick) continue;
        if (m.start > rightTick) break;
        const count = Math.ceil(m.length / step - 1e-6);
        const pts = stepPx >= 7 ? Array.from({ length: Math.max(0, count - 1) }, (_, k) => Math.round((k + 1) * step)) : beatRels(m.length);
        for (const rel of pts) {
          const inBeat = rel % TPB;
          if (stepPx < 7 && inBeat !== 0) continue;
          const x = Xt(m.start + rel);
          if (x < x0 || x > this.w) continue;
          const d = inBeat === 0 ? 1 : TPB / gcd(TPB, inBeat);
          ctx.fillStyle = DOT_COLORS[d] ?? '#6c6c74';
          hexPath(ctx, x, rowG(ln.rowOf(m.start + rel)).cy, (inBeat === 0 ? 13 : 9) * s * Math.max(0.7, L.k));
          ctx.fill();
        }
        const x = Xt(m.start);
        if (x >= x0 - 1 && x <= this.w + 1) {
          const q = rowG(ln.rowOf(m.start));
          ctx.fillStyle = C.measure;
          ctx.fillRect(x - lw / 2, q.y, lw, q.h);
          ctx.fillStyle = C.text;
          ctx.fillText(String(m.index + 1), x + 6 * s, q.y + 6 * s);
        }
      }
      // 判定枠（自分のレーンと同じ位置に、細く）
      ctx.lineWidth = Math.max(1, 2 * s);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      for (let r = 0; r < ln.rows; r++) {
        ctx.beginPath();
        ctx.arc(L.playX, rowG(r).cy, L.judgeR, 0, Math.PI * 2);
        ctx.stroke();
      }
      // 音符（後ろから）
      const notes = geo.course.notes;
      const [lo2, hi2] = visRange(notes, leftTick, rightTick);
      for (let i = hi2 - 1; i >= lo2; i--) {
        const n = notes[i];
        const endT = n.endTick ?? n.tick;
        if (endT < leftTick || n.tick > rightTick) continue;
        const x = Xt(n.tick);
        const ex = n.endTick !== undefined ? Xt(n.endTick) : undefined;
        const q = rowG(ln.rowOf(n.tick));
        const big = n.type === 'bigDon' || n.type === 'bigKa' || n.type === 'bigRoll';
        if (n.type === 'balloon' && ex !== undefined) {
          ctx.globalAlpha = 0.45;
          drawRoll(ctx, x, ex, q.cy, q.r, 'balloon');
          ctx.globalAlpha = 1;
          drawAny(ctx, n.type, x, q.cy, q.r, undefined, n.hits ?? 5);
        } else {
          drawAny(ctx, n.type, x, q.cy, big ? q.bigR : q.r, ex, n.type === 'balloon' ? n.hits ?? 5 : null);
        }
      }
      // 区間の外を暗く
      if (g.focus) {
        const fs = g.focus.flatMap(([a, b]) => spans(a, b));
        ctx.fillStyle = 'rgba(12,14,17,0.62)';
        for (let r = 0; r < ln.rows; r++) {
          const q = rowG(r);
          ctx.beginPath();
          ctx.rect(x0, q.y, this.w - x0, q.h);
          for (const sp of fs) if (sp.g.y === q.y) ctx.rect(sp.x1, q.y, sp.x2 - sp.x1, q.h);
          ctx.fill('evenodd');
        }
      }
      // 下端の細い線（自分のレーンと同じ）
      ctx.fillStyle = C.laneLine;
      for (let r = 0; r < ln.rows; r++) {
        const q = rowG(r);
        ctx.fillRect(x0, q.y + q.h - lw / 2, this.w - x0, lw);
      }
      // 譜面の下: 命令（GOGO 以外。自分のレーンと同じ形）
      {
        ctx.font = `600 ${Math.round(22 * s)}px ${this.ff}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const evs = geo.course.events.filter((e) => e.kind !== 'gogo' && !TJA_ONLY.has(e.kind) && this.evShow[e.kind] && e.tick >= leftTick && e.tick <= rightTick).sort((a, b) => a.tick - b.tick);
        const bh = Math.min(30 * s, L.laneH * 0.24);
        ctx.font = `600 ${Math.round(Math.min(22 * s, bh * 0.72))}px ${this.ff}`;
        const pad = 7 * s;
        const ends = new Map<number, number>();
        for (const e of evs) {
          if (e.kind === 'scroll' && !e.pin && grads.some((gr) => e.tick > gr.start && e.tick < gr.end)) continue;
          const x = Xt(e.tick);
          if (x < x0 || x > this.w) continue;
          const er = ln.rowOf(e.tick);
          const ry = rowG(er).y + L.laneH;
          const by = ry - bh - 3 * s;
          const end = ends.get(er) ?? -Infinity;
          if (x < end) continue;
          const gr = e.kind === 'scroll' ? grads.find((q) => q.start === e.tick) : undefined;
          const t = gr ? `×${gr.from}→${gr.to}` : eventShort(e);
          const w = ctx.measureText(t).width + pad * 2;
          ctx.fillStyle = 'rgba(30,30,36,0.92)';
          ctx.fillRect(x + 2 * s, by, w, bh);
          ctx.fillStyle = EVENT_COLOR[e.kind];
          ctx.fillRect(x + 2 * s, by, Math.max(2, 3 * s), bh);
          ctx.fillText(t, x + 2 * s + pad, by + bh / 2);
          ends.set(er, x + 2 * s + w + 4 * s);
        }
      }
      // 名前（レーンの左上）
      {
        const nh = Math.max(16, Math.min(34 * s, L.laneH * 0.26));
        ctx.font = font(800, nh * 0.6);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        const py = top + 4 * s;
        ctx.fillStyle = 'rgba(10,12,14,0.85)';
        ctx.fillRect(x0 + 4, py, tw + 20 * s, nh);
        ctx.fillStyle = g.color;
        ctx.fillRect(x0 + 4, py, Math.max(3, 5 * s), nh);
        ctx.fillStyle = '#f4f4f4';
        ctx.fillText(label, x0 + 4 + 12 * s, py + nh / 2);
        // 右上: 見比べで鳴らすボタン（スピーカー）
        if (this.onGhostCompare) {
          const bh = nh;
          const bw = bh * 1.5;
          const bx = this.w - 10 * s - bw;
          const by = py;
          ctx.fillStyle = g.compare ? C.play : '#2e353c';
          ctx.fillRect(bx, by, bw, bh);
          const u = bh / 24;
          const cx = bx + bw / 2 - 12 * u;
          const cy = by;
          ctx.save();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = Math.max(1.2, 2 * u);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(cx + 4 * u, cy + 9 * u); ctx.lineTo(cx + 8 * u, cy + 9 * u); ctx.lineTo(cx + 13 * u, cy + 5 * u); ctx.lineTo(cx + 13 * u, cy + 19 * u); ctx.lineTo(cx + 8 * u, cy + 15 * u); ctx.lineTo(cx + 4 * u, cy + 15 * u); ctx.closePath();
          ctx.moveTo(cx + 16 * u, cy + 9 * u); ctx.quadraticCurveTo(cx + 18 * u, cy + 12 * u, cx + 16 * u, cy + 15 * u);
          if (g.compare) { ctx.moveTo(cx + 18.5 * u, cy + 7 * u); ctx.quadraticCurveTo(cx + 22 * u, cy + 12 * u, cx + 18.5 * u, cy + 17 * u); }
          ctx.stroke();
          ctx.restore();
          this.cmpBoxes.push({ x1: bx - 6 * s, x2: bx + bw + 6 * s, y1: by - 4 * s, y2: by + bh + 4 * s, id: g.id });
        }
      }
    });
    ctx.restore();
  }

  /** 合作: ほかの人の見ている場所（色の縦線と名前） */
  private drawCursors(L: Lay) {
    if (!this.cursors.length) return;
    const ctx = this.ctx;
    const s = L.s;
    ctx.font = `600 ${Math.round(Math.max(9, 14 * s))}px ${this.ff}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const c of this.cursors) {
      const x = this.xOfTime(c.t);
      if (x < L.colW || x > this.w) continue;
      const y0 = this.stack ? L.laneY : L.waveY;
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = c.color;
      ctx.fillRect(x - Math.max(1, 1.5 * s), y0, Math.max(2, 3 * s), (this.stack ? Math.max(L.evTop + L.evH, L.laneY + L.blockH) : L.evTop + L.evH) - y0);
      const tw = ctx.measureText(c.name).width + 12 * s;
      ctx.fillRect(x - tw / 2, y0, tw, 20 * s);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#111';
      ctx.fillText(c.name, x, y0 + 18 * s);
    }
  }

  private drawWave(L: Lay) {
    const wv = this.wave;
    const ctx = this.ctx;
    const mid = L.waveY + L.waveH / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(L.waveX, mid, this.w - L.waveX, 1);
    if (!wv) return;
    const ln = this.lanes;
    // 波形の棒は曲の中の位置（表示の位置）に固定した区切りで作る。画面の位置で区切ると、スクロールのたびに
    // 区切りが曲に対してずれて、波形が揺れて見えるため
    const step = 2;
    const binTicks = (step / this.zoom) * TPB;
    const dpos = this.dpos;
    const k0 = Math.floor(this.dOf(L.waveX) / binTicks);
    const k1 = Math.ceil(this.dOf(this.w) / binTicks);
    ctx.fillStyle = C.wave;
    let prevT = ln.timeOfDisp(k0 * binTicks);
    for (let k = k0; k < k1; k++) {
      const nextT = ln.timeOfDisp((k + 1) * binTicks);
      let i0 = Math.floor(Math.min(prevT, nextT) * wv.rate);
      let i1 = Math.ceil(Math.max(prevT, nextT) * wv.rate);
      prevT = nextT;
      if (i1 < 0 || i0 >= wv.peaks.length) continue;
      i0 = Math.max(0, i0);
      i1 = Math.min(wv.peaks.length - 1, Math.max(i1, i0));
      let peak = 0;
      for (let i = i0; i <= i1; i++) if (wv.peaks[i] > peak) peak = wv.peaks[i];
      const hh = Math.max(0.5, peak * (L.waveH / 2 - 3));
      const x = this.xOfD(k * binTicks, dpos);
      const x0 = Math.max(L.waveX, x);
      const x1 = Math.min(this.w, x + step - 0.5);
      if (x1 > x0) ctx.fillRect(x0, mid - hh, x1 - x0, hh * 2);
    }
  }

  /**
   * 密度推移（Malody の左の列と同じ縦向き。下が曲の始め、上が終わり）。
   * 曲を短い区間に分け、1 秒あたりのノーツ数を右端から左へ伸びる棒で描く。今の位置に横線
   */
  private densKey = '';
  private densD = new Float32Array(0);
  private densK = new Float32Array(0);
  private densMax = 0;
  private densN = 0;

  /** 密度のグラフの数え直し（譜面が変わったときだけ） */
  private drawDensityBars(L: Lay) {
    const s = L.s;
    const g = this.graph;
    const len = this.songLength();
    const step = Math.max(3, 7 * s);
    const n = Math.max(8, Math.floor((g.bottom - g.top) / step));
    // ドン（赤）とカッ（水色）を分けて数え、右端からドン → カッの順に積む（連打・風船はドンに数える）
    const key = `${this.ed.undoCount}|${this.ed.courseIndex}|${this.ed.branch}|${n}|${len}`;
    if (this.densKey !== key) {
      this.densKey = key;
      const dn = new Float32Array(n);
      const kn = new Float32Array(n);
      const timing = this.ed.timing;
      for (const note of this.ed.course.notes) {
        const t = timing.tickToTime(note.tick);
        const i = Math.floor((t / len) * n);
        if (i < 0 || i >= n) continue;
        // ドンは 1・3、カッは 2・4 だけ数える（連打・風船は数えない）
        if (note.type === 'ka' || note.type === 'bigKa') kn[i] += 1;
        else if (note.type === 'don' || note.type === 'bigDon') dn[i] += 1;
      }
      this.densD = dn;
      this.densK = kn;
      let max = 0;
      for (let i = 0; i < n; i++) max = Math.max(max, dn[i] + kn[i]);
      this.densMax = max;
      this.densN = n;
    }
  }

  /** 密度のグラフの棒 */
  private paintDensityBars(L: Lay) {
    const ctx = this.ctx;
    const s = L.s;
    const g = this.graph;
    const x1 = L.colLine1 + R.densW * s;
    const maxW = (R.densW - 6) * s;
    const n = this.densN;
    const dons = this.densD;
    const kas = this.densK;
    const max = this.densMax;
    const bh = ((g.bottom - g.top) / n) * 0.8;
    for (let i = 0; i < n; i++) {
      const total = dons[i] + kas[i];
      if (!total || !max) continue;
      const w = Math.max(1, (total / max) * maxW);
      const wd = (dons[i] / total) * w;
      const y = g.bottom - ((i + 1) * (g.bottom - g.top)) / n;
      ctx.fillStyle = '#f2442b';
      ctx.fillRect(x1 - wd, y, wd, bh);
      ctx.fillStyle = '#5ec4d4';
      ctx.fillRect(x1 - w, y, w - wd, bh);
    }
  }

  /** 左の列の動かない部分（地・線・密度のグラフ・再生ボタン）を描いておいた絵 */
  private colCache: { c: HTMLCanvasElement; key: string } | null = null;

  /** 左の列（Malody と同じ配置） */
  private drawColumn(L: Lay) {
    const s = L.s;
    // 動かない部分は、変わったときだけ描き直して貼る（再生中に密度のグラフを毎フレーム描き直さない）
    this.drawDensityBars(L);
    const dpr = this.canvas.width / Math.max(1, this.w);
    const key = `${this.densKey}|${this.densMax}|${this.canvas.width}x${this.canvas.height}|${L.colW}|${L.colLine1}|${L.laneY}|${L.evY}|${L.cy}|${L.play.x}|${L.play.y}|${L.play.r}|${this.graph.top}|${this.graph.bottom}|${this.playing ? 1 : 0}`;
    let cc = this.colCache;
    if (!cc || cc.key !== key) {
      const c = cc?.c ?? document.createElement('canvas');
      // 再生ボタンは列の右にはみ出すので、その分まで
      const cw = Math.min(this.canvas.width, Math.ceil(Math.max(L.colW, L.play.x + L.play.r * 1.4 + 8 * L.s) * dpr) + 1);
      const ch = this.canvas.height;
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
      const g = c.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cw, ch);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const prev = this.ctx;
      this.ctx = g;
      try {
        this.paintColumnBase(L);
      } finally {
        this.ctx = prev;
      }
      cc = this.colCache = { c, key };
    }
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(cc.c, 0, 0);
    ctx.restore();
    // 密度のグラフの上の、今の位置
    const g = this.graph;
    const len = this.songLength();
    const now = this.ed.timing.tickToTime(this.pos);
    const y = g.bottom - Math.min(1, Math.max(0, now / len)) * (g.bottom - g.top);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(L.colLine1, y - Math.max(1, 1.5 * s), R.densW * s, Math.max(2, 3 * s));
    this.drawColumnTime(L);
  }

  /** 左の列の動かない部分 */
  private paintColumnBase(L: Lay) {
    const ctx = this.ctx;
    const s = L.s;
    ctx.fillStyle = C.col;
    ctx.fillRect(0, 0, L.colW, this.h);
    ctx.fillStyle = C.colLine;
    const lw = Math.max(1, 2 * s);
    ctx.fillRect(L.colLine1, 0, lw, this.h);
    ctx.fillRect(L.colW - lw, 0, lw, L.laneY);
    ctx.fillRect(L.colW - lw, L.evY, lw, this.h - L.evY);

    this.paintDensityBars(L);

    // 再生位置の線（左端から再生ボタンまで）
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, L.cy - lw / 2, L.play.x, lw);
    ctx.fillStyle = C.play;
    ctx.fillRect(0, L.cy - 6 * s, 12 * s, 12 * s);

    // 再生のボタン: 四角
    const hex = (b: Box, label: 'play' | 'pause') => {
      ctx.save();
      // 左端からはみ出さないよう、少し右に寄せる
      const hw = b.r * 0.84;
      const hh = b.r * 0.8;
      // 傾きは CSS の --tilt（8°）と同じ。上下の辺を高さ × tan だけずらす
      const sk = hh * 2 * TILT_TAN;
      ctx.translate(Math.max(b.x, hw + sk / 2 + 2), b.y);
      ctx.beginPath();
      ctx.moveTo(-hw + sk / 2, -hh);
      ctx.lineTo(hw + sk / 2, -hh);
      ctx.lineTo(hw - sk / 2, hh);
      ctx.lineTo(-hw - sk / 2, hh);
      ctx.closePath();
      ctx.fillStyle = C.play;
      ctx.fill();
      ctx.fillStyle = '#fff';
      const k = b.r;
      if (label === 'play') {
        ctx.beginPath();
        ctx.moveTo(-k * 0.28, -k * 0.36);
        ctx.lineTo(k * 0.42, 0);
        ctx.lineTo(-k * 0.28, k * 0.36);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(-k * 0.3, -k * 0.34, k * 0.2, k * 0.68);
        ctx.fillRect(k * 0.1, -k * 0.34, k * 0.2, k * 0.68);
      }
      ctx.restore();
    };
    hex(L.play, this.playing ? 'pause' : 'play');
  }

  /** 左の列の時刻（縦書き） */
  private drawColumnTime(L: Lay) {
    const ctx = this.ctx;
    const s = L.s;
    // 曲の長さ（上）と現在時刻（下）を縦書きで（Malody と同じ位置）
    // 曲の頭より前（1 小節ぶん）にいるときは、音源の頭より前ならマイナスの時刻になる
    const time = this.ed.timing.tickToTime(this.pos);
    ctx.font = `700 ${Math.round(34 * s)}px ${this.ff}`;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    const vtext = (text: string, x: number, y: number, align: CanvasTextAlign) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = align;
      ctx.fillText(text, 0, 0);
      ctx.restore();
    };
    // 上のタイムラインの配置では、今の時刻だけを左の端に
    if (this.stack) {
      vtext(fmtTime(time), L.colLine1 / 2, this.h - 24 * s, 'left');
    } else {
      if (this.duration > 0) vtext(fmtTime(this.duration), R.timeX * s, 24 * s, 'right');
      vtext(fmtTime(time), R.timeX * s, this.h - 24 * s, 'left');
    }
  }
}

type Lay = EditorView['L'];

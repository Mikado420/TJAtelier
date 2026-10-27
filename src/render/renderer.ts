import { beatAt, jposAt, scrollAhead, type Course, type Note } from '../chart/types';
import { CLEAR_LINE, type Game, type HitKind, type Judge, type JudgeEvent, type NoteState } from '../engine/game';
import { drawEndFx, END_HOLD, type EndKind } from './endfx';
import { pixelRatio } from '../orient';
import { BIG_SCALE, clearTextCache, drawCachedText, drawAny, drawBalloon, drawNoteHead, isBig, outlinedText } from './notes';

/**
 * テストプレイ画面。太鼓の達人のプレイ画面（2000×1125 のスクリーンショット）から
 * 位置・大きさを測った「基準座標」で描き、画面サイズに合わせて拡大縮小する。
 * 公式の画像・キャラクターは使わず、配置と演出の動きだけを再現している。
 */

// ---------- 基準座標（2000×1125） ----------
const REF_W = 2000;
const REF_H = 1125;
const LANE_X = 515; // レーン左端（左パネルの右端）
// 参考動画（1920×1080）で測った位置を 2000×1125 に直した値
const LANE_TOP = 299;
const LANE_BOTTOM = 506;
const TEXT_BOTTOM = 550; // 音符文字の帯の下端
const JX = 634; // 判定枠の中心
const JY = 402;
const NR = 54; // 通常ノーツの半径（黒縁を含む）
const MEASURE_PX = 1470; // ハイスピード 1.0 で 1 小節が流れる距離
/** #JPOSSCROLL の距離（px）は、横 1280 の画面での px として、この画面の基準座標（横 2000）に直す */
const JPOS_SCALE = REF_W / 1280;
const GAUGE = { x1: 768, x2: 1812, y1: 258, y2: 291, segs: 50 };
const FLOWER = { x: 1912, y: 258, r: 96 };
const DRUM = { x: 417, y: 418, r: 76 };
const BALLOON_X = 690; // ふくらむ風船の吹き口（参考動画では判定枠の少し右） // 左パネルのコンボ太鼓
const FONT = "'M PLUS Rounded 1c', 'Hiragino Maru Gothic ProN', 'Arial Rounded MT Bold', system-ui, sans-serif";

const JUDGE_TEXT: Record<Judge, string> = { good: '良', ok: '可', bad: '不可' };
const COURSE_LABEL: Record<string, [string, string]> = {
  // 難易度の色（CSS の --c-easy など と同じ）: かんたん 朱色・ふつう 黄緑・むずかしい 青緑・おに 赤紫・裏おに 紫
  Easy: ['かんたん', '#e8603c'],
  Normal: ['ふつう', '#8cc63e'],
  Hard: ['むずかしい', '#1fa59a'],
  Oni: ['おに', '#c8337e'],
  Edit: ['おに', '#7b4bd0'],
};

interface Fx { t: number }
interface Burst extends Fx { judge: Judge; big: boolean }
/** ジャンルの色（タイトル横の丸とジャンル名の帯） */
const GENRE_COLOR: [RegExp, string][] = [
  [/ポップ|pop/i, '#3fc1c9'],
  [/アニメ|anime/i, '#f39a1e'],
  [/ボーカロイド|ボカロ|vocaloid/i, '#9aa4b1'],
  [/キッズ|どうよう|kids/i, '#f2799e'],
  [/バラエティ|variety/i, '#52b84a'],
  [/クラシック|classic/i, '#c9a227'],
  [/ゲーム|game/i, '#9a5ad6'],
  [/ナムコ|オリジナル|original/i, '#e5532d'],
];
interface Flyer extends Fx { note: Note }
interface Flash extends Fx { kind: HitKind; side: 'L' | 'R' }

export interface Layout {
  w: number;
  h: number;
  laneY: number;
  laneH: number;
  judgeX: number;
  /** 画面の横の中心（画面 px） */
  drumX: number;
  /** 太鼓の面（楕円）の横の半径（画面 px）。面の中がドン、それ以外（縁・画面の端まで）がカッ */
  drumHalf: number;
  /** 太鼓の面の中心の高さと、縦の半径（画面 px） */
  drumY: number;
  drumRY: number;
  /** これより上は指を置いておく場所（叩いても反応しない）。0 ならなし（画面 px） */
  restBottom: number;
  /** 背景の動画を「上だけ」に出すときの範囲（画面 px） */
  top: { x: number; y: number; w: number; h: number };
}

/** オンライン対戦の相手（小さいレーンで下に並べる） */
export interface Opponent {
  id: string;
  name: string;
  score: number;
  combo: number;
  gauge: number;
  /** 音符ごとの判定（0 まだ / 1 良 / 2 可 / 3 不可） */
  marks: Uint8Array;
  good: number;
  ok: number;
  bad: number;
  /** 最後に判定したとき */
  fx: { j: number; t: number; i: number } | null;
  status: '' | 'fin' | 'quit' | 'lost';
  /** 遊んでいる難易度（パネルに出す。Easy / Normal / Hard / Oni / Edit） */
  course?: string;
  /** パネルに出す説明（無ければ「オンライン対戦」） */
  tag?: string;
  /**
   * オンライン: 届いた判定（曲の時刻つき）。その時刻になったら（delay 遅らせて描く）印・光・数を当てる。
   * t が無い（前の版の相手）ときはすぐ当てる
   */
  queue?: { i: number; j: number; t?: number }[];
  /** オンライン: 相手が叩いたすべての入力（何もない所を叩いたものも）。t = 曲の時刻、k = 0 ドン左 / 1 ドン右 / 2 カッ左 / 3 カッ右 */
  taps?: { t: number; k: number }[];
  /** 相手のレーンを何秒遅らせて描くか（届くまでの遅れ。判定・叩いた所が音符とずれないように） */
  delay?: number;
  /** 届いたときの遅れの記録（秒） */
  lags?: number[];
  /** 自分と違う難易度で遊んでいるとき: その難易度の譜面（音符の位置はこれで求める） */
  lane?: { game: Game; course: Course; vis: number[]; bars: number[] };
}

/** ゲージが満タンのときの虹色（毎フレーム色の文字列を作らないよう前もって作っておく） */
const RAINBOW = Array.from({ length: 360 }, (_, h) => `hsl(${h},90%,58%)`);

const ease = (x: number) => 1 - (1 - x) * (1 - x);

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  layout!: Layout;
  speed = 1;
  /** タッチ用: 中央のドンの帯の幅（画面の幅に対する割合） */
  donWidth = 0.6;
  /** 画面上部（レーンより上）を「指置き」にする（iPhone の取りこぼし対策） */
  restZone = false;
  /** タッチ操作用の太鼓を画面下に描くか */
  touch = matchMedia('(pointer: coarse)').matches;
  /** タッチ用の太鼓を（半透明で）描くか。描かなくても叩ける */
  padVisible = true;
  /** オンライン対戦の相手（いなければ空） */
  opponents: Opponent[] = [];
  private hud: HTMLCanvasElement | null = null;
  /** HUD に描いてある相手のパネルの中身（変わったら描き直す） */
  private hudKeys = new Map<string, string>();

  /** オンライン対戦の相手を決める（背景・解像度を作り直す） */
  setOpponents(list: Opponent[]) {
    this.opponents = list;
    this.resize();
  }

  /** 自分のレーンで求めた、画面に入る音符 [番号, x, 終わりの x, …]（相手のレーンで使い回す） */
  private visNotes: number[] = [];
  private visBars: number[] = [];

  private dpr = 1;
  private s = 1;
  private ox = 0;
  private oy = 0;
  private vis = { x0: 0, y0: 0, x1: REF_W, y1: REF_H };
  /** 画面下の太鼓（画面 px） */
  private pad = { x: 0, top: 0, half: 1, w: 1, h: 1 };

  private bursts: Burst[] = [];
  private flyers: Flyer[] = [];
  private flashes: Flash[] = [];
  private touches: { kind: HitKind; x: number; y: number; t: number }[] = [];
  private judgeFx: { judge: Judge; t: number } | null = null;
  private comboPop = 0;
  private lastCombo = 0;
  private banner: { combo: number; t: number } | null = null;
  private flowerPop = 0;
  /** ゴーゴータイムの始まりに下の背景で上がる花火 */
  /** 床から噴き上がる火花の柱（ゴーゴーの始まり）。t = 噴き出し始めた時刻 */
  private fireworks: { x: number; t: number; n: number }[] = [];
  private wasGogo = false;
  /** 風船が割れた瞬間（白い輪） */
  private rainbow: number | null = null;
  /** 大音符の光の粒（飛んでいく音符の後ろに残るきらきら） */
  private sparkles: { x: number; y: number; vx: number; vy: number; t: number }[] = [];
  /** 加算された点数の表示（スコアの上に出る） */
  private scoreFx: { add: number; t: number } | null = null;
  private lastScore = 0;
  private rollFx: { count: number; t: number; balloon: boolean; hits: number } | null = null;
  private labels = new WeakMap<Game, Map<Note, string>>();
  private topPattern: CanvasPattern | null = null;
  private topTile: HTMLCanvasElement | null = null;
  private bandTile: HTMLCanvasElement | null = null;
  /** 動かない背景（上の模様・下の背景・帯）を前もって描いておいたもの */
  private bg: HTMLCanvasElement | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    // 動かない背景は、プレイ画面の canvas の後ろに置いた別の canvas に一度だけ描く。
    // 毎フレーム画面全体の背景を描き直さずに済むので、1 フレームの塗りが大きく減る（見た目は同じ）
    const bg = document.createElement('canvas');
    bg.className = 'game-bg';
    bg.setAttribute('aria-hidden', 'true');
    canvas.parentElement?.insertBefore(bg, canvas);
    this.bg = bg;
    // オンライン対戦の相手のパネル（点数などが変わったときだけ描き直す）。背景と手前の間に置く
    const hud = document.createElement('canvas');
    hud.className = 'game-bg game-hud';
    hud.setAttribute('aria-hidden', 'true');
    canvas.parentElement?.insertBefore(hud, canvas);
    this.hud = hud;
    this.ctx = canvas.getContext('2d')!;
    // Web フォントが後から読み込まれたら、前もって描いておいた文字の絵を作り直す
    document.fonts?.addEventListener?.('loadingdone', () => {
      this.dropSprites();
      clearTextCache();
    });
    this.makePatterns();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  // ---------- レイアウト ----------

  resize() {
    // 高解像度の端末でも描く量を抑える（3倍だと1フレームの塗りが多すぎて、叩いた処理が遅れることがある）
    // オンライン対戦で相手のレーンも描くときは、描く量が増えるので解像度を少し下げる
    this.dpr = Math.min(this.opponents.length ? 2 : 3, pixelRatio());
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);

    // 太鼓の達人の画面（16:9）の比率を固定して中央に置き、余った部分は黒帯
    this.s = Math.min(w / REF_W, h / REF_H);
    this.ox = (w - REF_W * this.s) / 2;
    this.oy = (h - REF_H * this.s) / 2;
    const s = this.s;
    this.vis = { x0: 0, y0: 0, x1: REF_W, y1: REF_H };

    // タッチ用の叩き分け（画面 px）: 画面の横の位置だけで決める。中央の帯＝ドン、左右の端＝カッ。
    // 帯の幅は donWidth（画面の幅に対する割合）。上下の位置は関係ない（レーンの上を叩いても同じ）
    this.pad = { x: w / 2, top: this.sy(TEXT_BOTTOM), half: (w * this.donWidth) / 2, w, h };

    this.layout = {
      w, h,
      laneY: this.sy(LANE_TOP),
      laneH: (TEXT_BOTTOM - LANE_TOP) * s,
      judgeX: this.sx(JX),
      drumX: this.pad.x,
      drumHalf: this.pad.half,
      drumY: this.drum().cy,
      drumRY: this.drum().ry,
      restBottom: this.restZone ? this.sy(LANE_TOP) : 0,
      top: { x: this.ox, y: this.oy, w: REF_W * s, h: this.sy(LANE_TOP) - this.oy },
    };
    for (const c of Object.values(this.burstSprites)) { c.width = 0; c.height = 0; }
    this.burstSprites = {};
    this.dropSprites();
    this.padFlash = null;
    this.buildBackground();
    if (this.hud) {
      // 相手がいないときは HUD の大きさを 0 にしてメモリを空ける
      const on = this.opponents.length > 0;
      this.hud.width = on ? this.canvas.width : 0;
      this.hud.height = on ? this.canvas.height : 0;
      this.hud.style.display = on ? '' : 'none';
    }
    this.hudKeys.clear();
  }

  /** 観戦（自分のレーンを描かず、参加している人だけを上から並べる） */
  spectate = false;

  /** 背景の動画の出し方（'' = 動画なし）。変えたら resize() で背景を描き直す */
  videoMode: '' | 'full' | 'top' = '';

  /** 観戦のとき: 画面に入る音符・小節線の位置だけ求める（自分のレーンは描かない） */
  private computeVis(game: Game, bars: Course['bars'], now: number, right: number) {
    const far = right * 1.5;
    this.visBars.length = 0;
    for (const b of bars) {
      const x = this.xOf(b.time, b.beat, b, now);
      if (x >= LANE_X && x <= far) this.visBars.push(x);
    }
    const vis = this.visNotes;
    vis.length = 0;
    const states = game.states;
    for (let i = states.length - 1; i >= 0; i--) {
      const n = states[i].note;
      const x = this.xOf(n.time, n.beat, n, now);
      const endX = n.endTime !== undefined ? this.xOf(n.endTime, n.endBeat, n, now) : x;
      if (endX < LANE_X - 120 || x > far + 120) continue;
      vis.push(i, x, endX);
    }
  }

  /** 曲の終わりの帯（Failed... / Clear! / Fullcombo!! / Perfect!!!） */
  private drawEnd(V: Rect, wall: number) {
    const f = this.endFx;
    if (!f) return;
    drawEndFx(this.ctx, f.kind, wall - f.t, { x0: LANE_X, x1: V.x1, top: LANE_TOP, bottom: LANE_BOTTOM, vx0: V.x0, vy0: V.y0, vx1: V.x1, vy1: V.y1 });
  }

  /** 相手の段の位置（上の端）と縮める割合 */
  private rowGeom(n: number) {
    const rowH = TEXT_BOTTOM - LANE_TOP + 12;
    const gap = 8;
    // 観戦のときは、自分のレーンの場所から並べる
    const top0 = this.spectate ? LANE_TOP - 6 : TEXT_BOTTOM + 12;
    const k = Math.min(1, (REF_H - top0) / (this.opponents.length * (rowH + gap)));
    return { top: top0 + n * (rowH + gap) * k, k, rowH };
  }

  /** 相手のパネルを、数が変わったものだけ HUD に描き直す */
  private updateHud() {
    const h = this.hud;
    if (!h) return;
    const hc = h.getContext('2d')!;
    for (let n = 0; n < this.opponents.length; n++) {
      const o = this.opponents[n];
      const no = this.spectate ? n + 1 : n + 2;
      const key = `${no}|${o.name}|${o.score}|${o.combo}|${o.good}|${o.ok}|${o.bad}|${Math.round(o.gauge)}|${o.status}`;
      if (this.hudKeys.get(o.id) === key) continue;
      this.hudKeys.set(o.id, key);
      const { top, k, rowH } = this.rowGeom(n);
      hc.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
      hc.translate(0, top);
      hc.scale(k, k);
      hc.translate(0, -(LANE_TOP - 6));
      hc.clearRect(0, LANE_TOP - 6, LANE_X, rowH);
      const prev = this.ctx;
      this.ctx = hc;
      try {
        this.paintOppPanel(o, no, 0);
      } finally {
        this.ctx = prev;
      }
      // タッチ用の太鼓（半透明）はパネルの上にも重ねる（背景の太鼓がパネルに隠れないように）
      if (this.touch && this.padVisible) {
        hc.save();
        hc.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        hc.beginPath();
        hc.rect(this.ox, this.oy + top * this.s, LANE_X * k * this.s, rowH * k * this.s);
        hc.clip();
        this.drawPadShape(hc);
        hc.restore();
      }
    }
  }

  /** レーンの動かない部分（黒い枠・濃い灰色の本体・音符文字の帯） */
  private paintLaneBase(c: CanvasRenderingContext2D, right: number) {
    c.fillStyle = '#000';
    c.fillRect(LANE_X - 6, LANE_TOP - 8, right - LANE_X + 6, TEXT_BOTTOM - LANE_TOP + 12);
    c.fillStyle = '#1b2025';
    c.fillRect(LANE_X, LANE_TOP, right - LANE_X, LANE_BOTTOM - LANE_TOP);
    c.fillStyle = '#5d6f7a';
    c.fillRect(LANE_X, LANE_BOTTOM, right - LANE_X, TEXT_BOTTOM - LANE_BOTTOM);
    c.fillStyle = '#000';
    c.fillRect(LANE_X, LANE_BOTTOM, right - LANE_X, 4);
  }

  /** 動かない背景を一度だけ描いておく（毎フレームはこれをコピーするだけ） */
  private buildBackground() {
    const bg = this.bg ?? document.createElement('canvas');
    bg.width = this.canvas.width;
    bg.height = this.canvas.height;
    const c = bg.getContext('2d')!;
    const vm = this.videoMode;
    c.clearRect(0, 0, bg.width, bg.height);
    // 背景の動画を全面に出すときは、後ろの動画が見えるように塗らない
    if (vm !== 'full') {
      c.fillStyle = '#000';
      c.fillRect(0, 0, bg.width, bg.height);
    }
    c.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
    c.save();
    c.beginPath();
    c.rect(0, 0, REF_W, REF_H);
    c.clip();
    const V = this.vis;
    if (vm) this.paintVideoBackground(c, V, vm);
    else this.paintPlainBackground(c, V);
    if (!this.spectate) {
      // 動画の上では、レーンを少し透かす
      c.globalAlpha = vm === 'full' ? 0.78 : 1;
      this.paintLaneBase(c, V.x1);
      c.globalAlpha = 1;
    }
    // オンライン対戦の相手のレーンの動かない部分
    for (let n = 0; n < this.opponents.length; n++) {
      const { top, k } = this.rowGeom(n);
      c.save();
      c.translate(0, top);
      c.scale(k, k);
      c.translate(0, -(LANE_TOP - 6));
      c.globalAlpha = vm === 'full' ? 0.78 : 1;
      this.paintLaneBase(c, V.x1 / k);
      c.restore();
    }
    this.finishBackground(c, bg);
  }

  /** 背景の動画があるとき: 全面なら塗らない、上だけなら上を空けて下はふつうの床 */
  private paintVideoBackground(c: CanvasRenderingContext2D, V: Rect, vm: 'full' | 'top') {
    if (vm === 'full') return;
    this.paintPlainBackground(c, V);
    c.clearRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
  }

  private paintPlainBackground(c: CanvasRenderingContext2D, V: Rect) {
    // 上: 濃紺に青の斜線
    const tg = c.createLinearGradient(0, V.y0, 0, LANE_TOP);
    tg.addColorStop(0, '#172a37');
    tg.addColorStop(1, '#0e1820');
    c.fillStyle = tg;
    c.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
    c.strokeStyle = 'rgba(77,159,190,0.16)';
    c.lineWidth = 4;
    c.beginPath();
    const tan = Math.tan((8 * Math.PI) / 180);
    for (let x = V.x0 - 200; x < V.x1 + 60; x += 34) {
      c.moveTo(x, LANE_TOP);
      c.lineTo(x + (LANE_TOP - V.y0) * tan, V.y0);
    }
    c.stroke();
    // 下: 暗い夜の床に、青い光の地平線と奥へ続くグリッド
    const top = TEXT_BOTTOM;
    const bot = V.y1;
    const g = c.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, '#0f1b24');
    g.addColorStop(1, '#070a0d');
    c.fillStyle = g;
    c.fillRect(V.x0, top, V.x1 - V.x0, bot - top);
    const hz = top + 40;
    const glow = c.createLinearGradient(0, hz - 60, 0, hz + 60);
    glow.addColorStop(0, 'rgba(90,180,214,0)');
    glow.addColorStop(0.5, 'rgba(90,180,214,0.28)');
    glow.addColorStop(1, 'rgba(90,180,214,0)');
    c.fillStyle = glow;
    c.fillRect(V.x0, hz - 60, V.x1 - V.x0, 120);
    c.fillStyle = 'rgba(147,205,226,0.8)';
    c.fillRect(V.x0, hz - 1, V.x1 - V.x0, 2);
    const vx = (V.x0 + V.x1) / 2;
    c.strokeStyle = 'rgba(77,159,190,0.32)';
    c.lineWidth = 2;
    c.beginPath();
    for (let k = -14; k <= 14; k++) {
      c.moveTo(vx + k * 40, hz);
      c.lineTo(vx + k * 260, bot);
    }
    for (let k = 1; k < 12; k++) {
      const y = hz + (bot - hz) * Math.pow(k / 11, 1.8);
      c.moveTo(V.x0, y);
      c.lineTo(V.x1, y);
    }
    c.stroke();
    // ぼんやりした青い光
    for (const [x, y, r] of [[V.x0 + 260, hz + 10, 260], [V.x1 - 380, hz + 30, 320], [vx, hz - 20, 200]] as const) {
      const lg = c.createRadialGradient(x, y, 8, x, y, r);
      lg.addColorStop(0, 'rgba(90,180,214,0.18)');
      lg.addColorStop(1, 'rgba(90,180,214,0)');
      c.fillStyle = lg;
      c.fillRect(x - r, y - r, r * 2, r * 2);
    }
  }

  private finishBackground(c: CanvasRenderingContext2D, bg: HTMLCanvasElement) {
    c.restore(); // 16:9 の枠の切り抜きを外す（太鼓は黒帯の上まで描く）
    // タッチ用の太鼓（画面 px の座標系）
    if (this.touch && this.padVisible) {
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawPadShape(c);
    }
    // 指置きの帯（動かないので背景に描いておく）
    if (this.restZone) {
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const prev = this.ctx;
      this.ctx = c;
      try {
        this.drawRest();
      } finally {
        this.ctx = prev;
      }
    }
    this.bg = bg;
  }

  /**
   * 毎フレーム同じ絵になる部分（左のパネル・曲名・ゲージの枠）は、一度だけ別の canvas に描いておき、
   * 毎フレームはそれを貼るだけにする。端末のピクセルの位置まで同じになるように描くので、見た目は変わらない
   */
  private gogoGrad: CanvasGradient | null = null;
  private gogoGrads = new Map<number, CanvasGradient>();
  private gogoGradRight = 0;
  private sprites = new Map<string, { c: HTMLCanvasElement; dx: number; dy: number; x0: number; y0: number }>();

  /** 前もって描いた絵を全部手放す（iPhone はキャンバスの大きさを 0 にしないとメモリがすぐ空かない） */
  private dropSprites() {
    for (const sp of this.sprites.values()) { sp.c.width = 0; sp.c.height = 0; }
    this.sprites.clear();
  }

  private drawSprite(key: string, x: number, y: number, w: number, h: number, paint: () => void, alpha = 1) {
    const sc = this.dpr * this.s;
    const k = `${key}|${this.canvas.width}x${this.canvas.height}`;
    let sp = this.sprites.get(k);
    if (!sp) {
      if (this.sprites.size > 24) this.sprites.clear();
      const dx = Math.floor(this.dpr * (this.s * x + this.ox));
      const dy = Math.floor(this.dpr * (this.s * y + this.oy));
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * sc) + 2;
      c.height = Math.ceil(h * sc) + 2;
      const g = c.getContext('2d')!;
      g.setTransform(sc, 0, 0, sc, this.dpr * this.ox - dx, this.dpr * this.oy - dy);
      const prev = this.ctx;
      this.ctx = g;
      try {
        paint();
      } finally {
        this.ctx = prev;
      }
      sp = { c, dx, dy, x0: x, y0: y };
      this.sprites.set(k, sp);
    }
    // 作った後で位置が変わったら（#JPOSSCROLL で判定枠が動いたときなど）、その分ずらして貼る
    const ox = Math.round(this.dpr * this.s * (x - sp.x0));
    const oy = Math.round(this.dpr * this.s * (y - sp.y0));
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (alpha !== 1) ctx.globalAlpha *= alpha;
    ctx.drawImage(sp.c, sp.dx + ox, sp.dy + oy);
    ctx.restore();
  }

  private sx(x: number) { return x * this.s + this.ox; }
  private sy(y: number) { return y * this.s + this.oy; }

  private makePatterns() {
    // 上部: 青海波（せいがいは）模様
    const t = document.createElement('canvas');
    t.width = 120;
    t.height = 60;
    const c = t.getContext('2d')!;
    c.fillStyle = '#e43b55';
    c.fillRect(0, 0, 120, 60);
    const wave = (x: number, y: number) => {
      for (let i = 4; i >= 1; i--) {
        c.beginPath();
        c.arc(x, y, i * 14, Math.PI, 0);
        c.fillStyle = i % 2 ? '#ef6b80' : '#e43b55';
        c.fill();
      }
    };
    for (const [x, y] of [[0, 30], [120, 30], [60, 60], [0, 90], [120, 90], [60, 0], [-60, 60], [180, 60]]) wave(x, y);
    this.topTile = t;
    void this.topTile;
    this.topPattern = this.ctx.createPattern(t, 'repeat');

    // 下の帯: 色違いの市松
    const b = document.createElement('canvas');
    b.width = 400;
    b.height = 66;
    const d = b.getContext('2d')!;
    const cols = ['#d6402c', '#f0b431', '#1d4d55'];
    for (let i = 0; i < 3; i++) {
      d.fillStyle = cols[i];
      d.fillRect(i * 133.4, 0, 134, 66);
      d.strokeStyle = 'rgba(255,255,255,0.18)';
      d.lineWidth = 3;
      for (let k = 0; k < 4; k++) {
        d.beginPath();
        d.arc(i * 133.4 + 66, 66, 18 + k * 14, Math.PI, 0);
        d.stroke();
      }
    }
    this.bandTile = b;
    void this.bandTile;
  }

  // ---------- 演出の受け口 ----------

  pushJudge(e: JudgeEvent) {
    const now = performance.now();
    // 叩かずに通り過ぎた音符（見逃し）は、判定は不可でも判定枠の上に「不可」を出さない
    if (!e.missed) this.judgeFx = { judge: e.judge, t: now };
    if (e.judge !== 'bad') {
      this.bursts.push({ t: now, judge: e.judge, big: isBig(e.note.type) });
      this.flyers.push({ t: now, note: e.note });
      if (this.bursts.length > 6) this.bursts.shift();
      if (this.flyers.length > 24) this.flyers.shift();
    }
  }

  pushRoll(s: NoteState) {
    const balloon = s.note.type === 'balloon';
    const hits = s.note.hits ?? 5;
    this.rollFx = { count: s.count, t: performance.now(), balloon, hits };
    if (balloon && s.count >= hits) {
      // 割れた: 虹を出す
      this.rainbow = performance.now();
      this.rollFx = null;
    }
    if (s.note.type !== 'balloon') this.flyers.push({ t: performance.now(), note: { ...s.note, type: s.note.type === 'bigRoll' ? 'bigDon' : 'don' } });
  }

  pushHit(kind: HitKind, side: 'L' | 'R') {
    this.flashes.push({ kind, side, t: performance.now() });
    if (this.flashes.length > 8) this.flashes.shift();
  }

  /** 曲の終わりの帯（クリア成功・クリア失敗・フルコンボ・全良） */
  private endFx: { kind: EndKind; t: number } | null = null;
  /** 帯を出す。見せる長さ（ms）を返す */
  showEnd(kind: EndKind) {
    this.endFx = { kind, t: performance.now() };
    return END_HOLD[kind];
  }

  reset() {
    this.endFx = null;
    // 曲ごとの絵（曲名・難易度のパネル）は曲が変わると使わないので手放す。
    // iPhone はキャンバスのメモリに上限があり、たまると画面が描けなくなって落ちる
    for (const [k, sp] of this.sprites) {
      if (k.startsWith('title:') || k.startsWith('panel:') || !k.endsWith(`|${this.canvas.width}x${this.canvas.height}`)) {
        sp.c.width = 0;
        sp.c.height = 0;
        this.sprites.delete(k);
      }
    }
    this.bursts = [];
    this.flyers = [];
    this.flashes = [];
    this.judgeFx = null;
    this.banner = null;
    this.rollFx = null;
    this.lastCombo = 0;
    this.lastScore = 0;
    this.scoreFx = null;
    this.fireworks = [];
    this.wasGogo = false;
    this.rainbow = null;
    this.sparkles = [];
  }

  // ---------- 描画 ----------

  /** 判定枠の中心（#JPOSSCROLL で動く） */
  private jx = JX;
  /** #HBSCROLL のときの今の拍の位置（null ならふつうの流れ方） */
  private beatNow: number | null = null;
  private scrollMode: Course['scrollMode'] = undefined;

  /**
   * 音符・小節線の x。ふつうは音符ごとの BPM・SCROLL の速さで流れる。
   * #HBSCROLL は拍の数の差で決め、音符ごとの SCROLL を掛ける（BPM が変わるとレーン全体の速さが変わる）
   */
  private xOf(time: number, beat: number | undefined, n: { bpm: number; scroll: number }, now: number) {
    return this.jx + scrollAhead(this.scrollMode, { time, bpm: n.bpm, scroll: n.scroll, beat }, now, this.beatNow) * (MEASURE_PX / 4) * this.speed;
  }

  draw(game: Game, course: Course, now: number, info: { title: string; course: string; level: number; genre?: string }) {
    const bars = course.bars;
    const ctx = this.ctx;
    const wall = performance.now();
    this.jx = JX + jposAt(course.jpos, now) * JPOS_SCALE;
    this.beatNow = course.beatPoints?.length ? beatAt(course.beatPoints, now) : null;
    this.scrollMode = this.beatNow !== null ? course.scrollMode : undefined;
    const st = game.stats;

    if (st.combo > this.lastCombo) {
      this.comboPop = wall;
      if (st.combo % 100 === 0) this.banner = { combo: st.combo, t: wall };
    }
    this.lastCombo = st.combo;
    if (st.score > this.lastScore) this.scoreFx = { add: st.score - this.lastScore, t: wall };
    this.lastScore = st.score;

    const gogo = course.gogo.some(([a, b]) => now >= a && now < b);
    if (gogo && !this.wasGogo) {
      this.startFireworks(wall);
      // 前の演出は消して、最初からやり直す（短い間隔のゴーゴーでも、始まるたびにはっきり点滅して見えるように）
      this.gogoStartWall = wall;
      this.gogoFlashWall = wall;
    }
    this.wasGogo = gogo;

    // 背景は後ろの canvas に描いてあるので、手前は消すだけ
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, REF_W, REF_H);
    ctx.clip();
    const V = this.vis;

    this.drawTop(V, gogo, wall);
    this.drawTitle(info);
    if (this.spectate) {
      // 観戦: 自分のレーンは無く、参加している人のレーンを上から並べる
      this.drawOpponents(V, game, course, now, wall);
      ctx.font = `900 40px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      outlinedText(ctx, '観戦中', 150, LANE_TOP - 70, '#fff', '#3a1300', 8);
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    // オンライン対戦では下は相手のレーンなので、花びら・花火は描かない
    if (!this.opponents.length) {
      this.drawBottom(V, wall);
      this.drawFireworks(wall);
    }
    this.drawLane(V, game, bars, now, gogo, wall);
    if (this.opponents.length) {
      this.drawOpponents(V, game, course, now, wall);
    }
    this.drawBursts(wall);
    this.drawPanel(st.score, st.combo, info, wall);
    // オンライン対戦: 自分の良・可・不可もパネルに出す
    if (this.opponents.length) {
      this.drawLayer('own-counts', `${st.good}|${st.ok}|${st.bad}`, 150, LANE_TOP + 60, 190, 116, () => this.paintCounts(st.good, st.ok, st.bad));
    }
    this.drawGauge(st.gauge, wall);
    this.drawRollBubble(wall);
    this.drawJudgeText(wall);
    this.drawTiming(wall);
    this.drawFlyers(wall);
    this.drawSparkles(wall);
    this.drawRainbow(wall);
    this.drawBanner(wall);
    this.drawEnd(V, wall);
    ctx.restore();
    if (this.touch) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.drawPad(wall);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawTop(V: Rect, gogo: boolean, wall: number) {
    const ctx = this.ctx;
    if (!this.bg) {
      ctx.fillStyle = this.topPattern ?? '#e43b55';
      ctx.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - V.y0);
    }
    if (gogo) {
      ctx.fillStyle = `rgba(120,200,235,${0.14 + 0.07 * Math.sin(wall / 120)})`;
      // レーンの黒い枠（背景の canvas に描いてある）には重ねない
      ctx.fillRect(V.x0, V.y0, V.x1 - V.x0, LANE_TOP - 8 - V.y0);
      ctx.fillRect(V.x0, LANE_TOP - 8, LANE_X - 6 - V.x0, 8);
    }
  }

  /** 下の背景は前もって描いてあるので、ここでは舞う花びら（パソコンのみ）だけ描く */
  private drawBottom(V: Rect, wall: number) {
    if (this.touch) return;
    const ctx = this.ctx;
    const top = TEXT_BOTTOM;
    ctx.fillStyle = 'rgba(147,205,226,0.55)';
    for (let i = 0; i < 26; i++) {
      const sp = 40 + (i * 37) % 60;
      const x = V.x0 + (((i * 173 + wall / 1000 * sp * 2) % (V.x1 - V.x0 + 100)) - 50);
      const y = top + 30 + (((i * 97 + wall / 1000 * sp) % (V.y1 - top - 90)));
      ctx.beginPath();
      ctx.ellipse(x, y, 9, 5, (wall / 600 + i) % Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }


  /** opp を渡すと、オンライン対戦の相手のレーンとして描く（相手が叩いた音符を消す・叩いた光は出さない） */
  private drawLane(V: Rect, game: Game, bars: Course['bars'], now: number, gogo: boolean, wall: number, opp?: Opponent) {
    const ctx = this.ctx;
    const right = V.x1;

    // 枠・レーン本体（平らな濃い灰色）・音符文字の帯は背景の canvas に描いてある（paintLaneBase）。
    // ゴーゴータイムだけ、レーンを赤紫に塗り直す
    if (gogo) {
      // 参考動画: 左（判定枠側）は暗い赤茶、右へ行くほど赤紫（グラデーションは一度だけ作って使い回す）
      const cached = this.gogoGrads.get(right);
      if (cached) {
        this.gogoGrad = cached;
        this.gogoGradRight = right;
      } else if (!this.gogoGrad || this.gogoGradRight !== right) {
        const g = ctx.createLinearGradient(LANE_X, 0, right, 0);
        g.addColorStop(0, '#48222a');
        g.addColorStop(0.3, '#5a2126');
        g.addColorStop(0.55, '#6d2b3a');
        g.addColorStop(0.8, '#7b3654');
        g.addColorStop(1, '#6a3550');
        this.gogoGrad = g;
        this.gogoGradRight = right;
        if (this.gogoGrads.size > 6) this.gogoGrads.clear();
        this.gogoGrads.set(right, g);
      }
      ctx.fillStyle = this.gogoGrad;
      ctx.fillRect(LANE_X, LANE_TOP, right - LANE_X, LANE_BOTTOM - LANE_TOP);
    }

    // 叩いたときにレーン全体が色づく（ドン＝赤茶、カッ＝青）
    for (const f of opp ? [] : this.flashes) {
      const a = 1 - (wall - f.t) / 170;
      if (a <= 0) continue;
      ctx.fillStyle = f.kind === 'don' ? `rgba(170,90,40,${0.2 * a})` : `rgba(40,140,170,${0.2 * a})`;
      ctx.fillRect(LANE_X, LANE_TOP, right - LANE_X, LANE_BOTTOM - LANE_TOP);
    }
    // 相手が叩いた入力（何もない所を叩いたものも）: その時刻になったら、自分と同じくレーンが色づき、判定枠が光る
    if (opp?.taps) {
      for (const f of opp.taps) {
        const ms = (now - Math.max(f.t, (f as { a?: number }).a ?? f.t)) * 1000;
        if (ms < 0 || ms > 170) continue;
        const a = 1 - ms / 170;
        const don = f.k < 2;
        ctx.fillStyle = don ? `rgba(170,90,40,${0.2 * a})` : `rgba(40,140,170,${0.2 * a})`;
        ctx.fillRect(LANE_X, LANE_TOP, right - LANE_X, LANE_BOTTOM - LANE_TOP);
      }
    }

    // 判定枠: 音符と同じ大きさの暗い円＋外側の細い輪。ゴーゴータイムは炎の玉になる
    if (gogo && !opp) this.drawFireball(wall);
    else {
      ctx.beginPath();
      ctx.arc(this.jx, JY, NR - 2, 0, Math.PI * 2);
      ctx.fillStyle = '#1d1d1d';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#6b6b6b';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(this.jx, JY, 73, 0, Math.PI * 2);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#5e5e5e';
      ctx.stroke();
    }
    if (!opp) this.drawJudgeGlow(wall);
    else if (opp.taps) {
      // 相手の叩いた所: 判定枠の輪が叩いた色に光る（面 = ドン、縁 = カッ）
      for (const f of opp.taps) {
        const ms = (now - Math.max(f.t, (f as { a?: number }).a ?? f.t)) * 1000;
        if (ms < 0 || ms > 160) continue;
        const a = 1 - ms / 160;
        ctx.beginPath();
        ctx.arc(this.jx, JY, f.k < 2 ? NR - 6 : 73, 0, Math.PI * 2);
        ctx.lineWidth = f.k < 2 ? 10 : 8;
        ctx.strokeStyle = f.k < 2 ? `rgba(255,90,40,${0.85 * a})` : `rgba(70,200,240,${0.9 * a})`;
        ctx.stroke();
      }
    }

    // 小節線（相手のレーンは、自分のレーンで求めた位置を使い回す）
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    if (opp) {
      for (const x of this.visBars) if (x <= right) ctx.fillRect(x - 1.5, LANE_TOP, 3, LANE_BOTTOM - LANE_TOP);
    } else {
      const share = false;
      if (share) this.visBars.length = 0;
      const far = share ? right * 1.5 : right;
      for (const b of bars) {
        const x = this.xOf(b.time, b.beat, b, now);
        if (x < LANE_X || x > far) continue;
        if (share) this.visBars.push(x);
        if (x <= right) ctx.fillRect(x - 1.5, LANE_TOP, 3, LANE_BOTTOM - LANE_TOP);
      }
    }


    // ノーツ
    const labels = this.labelsFor(game);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LANE_X, LANE_TOP - 80, right - LANE_X + 200, TEXT_BOTTOM - LANE_TOP + 80);
    ctx.clip();
    ctx.font = `800 31px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const states = game.states;
    // オンライン対戦: 画面に入る音符の位置を一度だけ求めて、相手のレーンでも使う（相手の数だけ計算し直さない）
    const share = false;
    const vis = this.visNotes;
    if (share) vis.length = 0;
    // 自分は後ろの音符から描く（手前の音符が上になる）。相手は、自分が入れた順（同じく後ろから）に描く
    const count = opp ? vis.length / 3 : states.length;
    for (let k = count - 1; k >= 0; k--) {
      const q = opp ? count - 1 - k : 0;
      const i = opp ? vis[q * 3] : k;
      const s = states[i];
      const n = s.note;
      let x: number;
      let endX: number;
      if (opp) {
        const m = opp.marks[i];
        const long = n.type === 'roll' || n.type === 'bigRoll' || n.type === 'balloon';
        if ((m === 1 || m === 2) && !long) continue;
        // 判定枠を過ぎて、まだ判定が届いていない音符は消しておく（届くまでの遅れの間、枠を通り過ぎて見えないように）
        if (!m && !long && opp.queue && now >= n.time && now - n.time < 0.4) continue;
        x = vis[q * 3 + 1];
        endX = vis[q * 3 + 2];
        if (x > right + 120) continue;
      } else {
        const hidden = s.done && !s.missed && n.type !== 'roll' && n.type !== 'bigRoll';
        if (hidden && !share) continue;
        x = this.xOf(n.time, n.beat, n, now);
        endX = n.endTime !== undefined ? this.xOf(n.endTime, n.endBeat, n, now) : x;
        // 相手のレーンは縮めると右に長くなるので、少し先まで入れておく
        if (endX < LANE_X - 120 || x > (share ? right * 1.5 : right) + 120) continue;
        if (share) vis.push(i, x, endX);
        if (hidden || x > right + 120) continue;
      }
      const r = isBig(n.type) ? NR * BIG_SCALE : NR;

      if (n.type === 'balloon') {
        if (s.done && s.count >= (n.hits ?? 5)) continue; // 割れた
        const active = now >= n.time && now <= (n.endTime ?? n.time);
        // 叩いている間は、レーンの音符の代わりにふくらむ風船を出す
        if (active && !opp && this.rollFx?.balloon) continue;
        if (active) x = this.jx;
        if (now > (n.endTime ?? n.time)) continue;
        drawBalloon(ctx, x, JY, r, null);
      } else if (n.type === 'roll' || n.type === 'bigRoll') {
        drawAny(ctx, n.type, x, JY, r, endX);
        // 音符の下: 「連打━━━━っ!!」
        const ly = (LANE_BOTTOM + TEXT_BOTTOM) / 2 + 3;
        const lx1 = Math.max(x + 44, LANE_X + 10);
        const lx2 = endX - 40;
        if (lx2 > lx1) {
          ctx.fillStyle = '#2a2a2a';
          ctx.fillRect(lx1, ly - 5, lx2 - lx1, 10);
          ctx.fillStyle = '#fff';
          ctx.fillRect(lx1, ly - 2, lx2 - lx1, 4);
        }
        if (endX > LANE_X) drawCachedText(ctx, 'っ!!', endX, ly, `900 32px ${FONT}`, '#fff', '#2a2a2a', 7);
      } else {
        drawNoteHead(ctx, x, JY, r, n.type);
      }

      const label = labels.get(n);
      if (label && x > LANE_X - 40) {
        drawCachedText(ctx, label, x, (LANE_BOTTOM + TEXT_BOTTOM) / 2 + 3, `900 32px ${FONT}`, '#fff', '#2a2a2a', 7);
      }
    }
    ctx.restore();
  }

  /**
   * オンライン対戦の相手（自分の段の下に、自分の段と同じ描き方で並べる）。
   * 左のパネル（2P・3P・4P の色）・レーン・判定の演出まで自分と同じ。2 人までは同じ大きさ、3 人のときは段ごと縮める
   */
  /**
   * 相手のレーンを何秒遅らせて描くか。新しく届いた判定・入力の遅れ（今の時刻 − その時刻）を記録し、
   * 遅れの大きい方（9 割が入る値）に合わせる。急に変えるとレーンが跳ねるので、少しずつ動かす
   */
  private oppDelay(o: Opponent, now: number) {
    const lags = (o.lags ??= []);
    const seen = (t: number | undefined) => {
      if (t === undefined || !Number.isFinite(t)) return;
      lags.push(Math.max(0, now - t));
      if (lags.length > 40) lags.shift();
    };
    for (const q of o.queue ?? []) if (!(q as { s?: 1 }).s) { (q as { s?: 1 }).s = 1; seen(q.t); }
    // 叩いた入力は、届いた時刻から光らせる（届くまでに消えてしまわないように）
    for (const tp of o.taps ?? []) if (!(tp as { s?: 1 }).s) { (tp as { s?: 1; a?: number }).s = 1; (tp as { a?: number }).a = now; seen(tp.t); }
    // 自分のレーンと相手のレーンの音符がずれないよう、相手のレーンも同じ時刻で描く（遅らせない）
    o.delay = 0;
    return 0;
  }

  /** その時刻（相手のレーンの時刻）までに届いている判定を当てる（音符を消す・数える・光らせる） */
  private applyOpp(o: Opponent, tn: number, wall: number) {
    const q = o.queue;
    if (!q?.length) return;
    let keep = 0;
    for (let n = 0; n < q.length; n++) {
      const e = q[n];
      if (e.t !== undefined && e.t > tn) {
        q[keep++] = e;
        continue;
      }
      if (e.i < 0 || e.i >= o.marks.length || e.j < 0 || e.j > 2) continue;
      if (!o.marks[e.i]) {
        if (e.j === 0) o.good++;
        else if (e.j === 1) o.ok++;
        else o.bad++;
      }
      o.marks[e.i] = e.j + 1;
      // 光・文字は、その判定の時刻から数える（まとめて届いても順に出る）
      o.fx = { j: e.j + 1, t: wall, i: e.i };
    }
    q.length = keep;
  }

  private drawOpponents(V: Rect, game: Game, course: Course, now: number, wall: number) {
    const ctx = this.ctx;
    const opps = this.opponents;
    for (const o of opps) {
      const tn = now - this.oppDelay(o, now);
      this.applyOpp(o, tn, wall);
    }
    this.updateHud();
    for (let n = 0; n < opps.length; n++) {
      const o = opps[n];
      const tn = now - (o.delay ?? 0);
      const { top, k, rowH } = this.rowGeom(n);
      ctx.save();
      // 段の中は自分の段と同じ座標で描く（上下にずらし、小さいときは左上を中心に縮める）
      ctx.translate(0, top);
      ctx.scale(k, k);
      ctx.translate(0, -(LANE_TOP - 6));
      const right = V.x1 / k;
      ctx.save();
      ctx.beginPath();
      ctx.rect(LANE_X - 6, LANE_TOP - 8, right - LANE_X + 6, rowH);
      ctx.clip();
      // レーンの動かない部分は背景に、パネルは HUD に描いてある
      // 相手の難易度の譜面（同じ難易度なら自分の譜面）を、遅らせた時刻で描く（音符・小節線・流れ方・判定枠の位置）
      const L = o.lane ?? { game, course, vis: (o as { _vis?: number[] })._vis ??= [], bars: (o as { _bars?: number[] })._bars ??= [] };
      const keep = { vn: this.visNotes, vb: this.visBars, bn: this.beatNow, sm: this.scrollMode, jx: this.jx };
      this.visNotes = L.vis;
      this.visBars = L.bars;
      this.beatNow = L.course.beatPoints?.length ? beatAt(L.course.beatPoints, tn) : null;
      this.scrollMode = this.beatNow !== null ? L.course.scrollMode : undefined;
      this.jx = JX + jposAt(L.course.jpos, tn) * JPOS_SCALE;
      this.computeVis(L.game, L.course.bars, tn, right);
      const lgogo = L.course.gogo.some(([a, b]) => tn >= a && tn < b);
      this.drawLane({ ...V, x1: right }, L.game, L.course.bars, tn, lgogo, wall, o);
      this.drawOppBurst(o, L.game, wall);
      ctx.restore();
      this.drawOppJudgeText(o, wall);
      this.visNotes = keep.vn;
      this.visBars = keep.vb;
      this.beatNow = keep.bn;
      this.scrollMode = keep.sm;
      this.jx = keep.jx;
      ctx.restore();
    }
  }

  /**
   * 変わったときだけ描き直す絵（今の座標系の x, y, w, h の範囲）。key が同じ間は、前に描いた絵を貼るだけ
   */
  private layers = new Map<string, { key: string; c: HTMLCanvasElement; sc: number }>();
  private drawLayer(id: string, key: string, x: number, y: number, w: number, h: number, paint: () => void) {
    const ctx = this.ctx;
    const m = ctx.getTransform();
    const sc = Math.hypot(m.a, m.b) || 1;
    const full = `${key}|${sc.toFixed(3)}`;
    let L = this.layers.get(id);
    if (!L || L.key !== full) {
      const c = L?.c ?? document.createElement('canvas');
      const cw = Math.ceil(w * sc) + 2;
      const ch = Math.ceil(h * sc) + 2;
      if (c.width !== cw || c.height !== ch) {
        c.width = cw;
        c.height = ch;
      }
      const g = c.getContext('2d')!;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cw, ch);
      g.setTransform(sc, 0, 0, sc, -x * sc, -y * sc);
      const prev = this.ctx;
      this.ctx = g;
      try {
        paint();
      } finally {
        this.ctx = prev;
      }
      L = { key: full, c, sc };
      this.layers.set(id, L);
      if (this.layers.size > 12) this.layers.delete(this.layers.keys().next().value!);
    }
    ctx.drawImage(L.c, x, y, L.c.width / L.sc, L.c.height / L.sc);
  }

  /** 判定枠の光（相手用。一度だけ描いて、濃さを変えて貼る） */
  private glowSprites: Partial<Record<Judge, HTMLCanvasElement>> = {};
  private glowSprite(judge: Judge) {
    let c = this.glowSprites[judge];
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const rg = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    if (judge === 'good') {
      rg.addColorStop(0, 'rgb(255,246,150)');
      rg.addColorStop(0.75, 'rgb(250,214,40)');
      rg.addColorStop(1, 'rgb(214,160,10)');
    } else {
      rg.addColorStop(0, 'rgb(255,255,255)');
      rg.addColorStop(1, 'rgb(200,215,230)');
    }
    g.fillStyle = rg;
    g.beginPath();
    g.arc(64, 64, 64, 0, Math.PI * 2);
    g.fill();
    this.glowSprites[judge] = c;
    return c;
  }

  /** 2P・3P・4P の色（パネルの上と下、名札の丸） */
  private static readonly PLAYER_COLOR: Record<number, [string, string, string]> = {
    1: ['#3388b8', '#1d5378', '#3a8fc0'],
    2: ['#e9452f', '#c9301f', '#e8352b'],
    3: ['#34b26f', '#1f8a52', '#1d9a5a'],
    4: ['#e8a032', '#c27c18', '#d98a10'],
  };

  /** 相手の左のパネル（自分のパネルと同じ形。色だけ違う） */
  private paintOppPanel(o: Opponent, no: number, wall: number) {
    const ctx = this.ctx;
    const [c1, c2, badge] = Renderer.PLAYER_COLOR[no] ?? Renderer.PLAYER_COLOR[2];
    const g = ctx.createLinearGradient(0, LANE_TOP - 6, 0, TEXT_BOTTOM);
    g.addColorStop(0, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, LANE_TOP - 6, LANE_X, TEXT_BOTTOM - LANE_TOP + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    for (let x = 30; x < LANE_X; x += 70) {
      for (let y = LANE_TOP + 30; y < TEXT_BOTTOM; y += 70) {
        ctx.beginPath();
        ctx.arc(x + ((y / 70) % 2) * 35, y, 18, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // スコア欄と点数
    ctx.fillStyle = 'rgba(0,0,30,0.45)';
    ctx.fillRect(0, LANE_TOP - 6, 316, 62);
    ctx.font = `900 50px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(o.score), 282, LANE_TOP + 28, '#fff', '#111', 9);
    // 魂ゲージ（スコア欄の右の細い帯）
    const gx = 326;
    const gw = LANE_X - 18 - gx;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, gx, LANE_TOP + 14, gw, 20, 10);
    ctx.fill();
    const v = Math.max(0, Math.min(1, o.gauge / 100));
    if (v > 0) {
      ctx.fillStyle = o.gauge >= CLEAR_LINE ? '#ffd23f' : '#ff5a3c';
      roundRect(ctx, gx + 3, LANE_TOP + 17, Math.max(14, (gw - 6) * v), 14, 7);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillRect(gx + 3 + (gw - 6) * (CLEAR_LINE / 100), LANE_TOP + 12, 3, 24);
    // 良・可・不可
    this.paintCounts(o.good, o.ok, o.bad);
    // 難易度
    if (o.course) {
      const CN: Record<string, [string, string]> = { Easy: ['かんたん', '#e8603c'], Normal: ['ふつう', '#8cc63e'], Hard: ['むずかしい', '#1fa59a'], Oni: ['おに', '#c8337e'], Edit: ['うら', '#7b4bd0'] };
      const [label, col] = CN[o.course] ?? [o.course, '#3b4045'];
      ctx.fillStyle = col;
      roundRect(ctx, 14, LANE_TOP + 92, 138, 36, 8);
      ctx.fill();
      ctx.font = `900 22px ${FONT}`;
      ctx.textAlign = 'center';
      outlinedText(ctx, label, 83, LANE_TOP + 111, '#fff', '#2a1208', 5);
    }
    // コンボ太鼓
    this.paintComboDrum(o.combo, 1);
    // 名札（色の丸・状態の帯・名前の帯）
    const state = o.status === 'fin' ? '終了' : o.status === 'quit' ? 'やめた' : o.status === 'lost' ? '通信が切れた' : o.tag ?? 'オンライン対戦';
    this.drawNameplate(`${no}P`, badge, state, o.name);
    void wall;
  }

  /** 良・可・不可の数（パネルの難易度の右） */
  private paintCounts(good: number, ok: number, bad: number) {
    const ctx = this.ctx;
    const rows: [string, number, string][] = [['良', good, '#ffd23a'], ['可', ok, '#ffffff'], ['不可', bad, '#9db4ff']];
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 3; i++) {
      const [label, v, color] = rows[i];
      const y = LANE_TOP + 80 + i * 31;
      ctx.font = `900 23px ${FONT}`;
      ctx.textAlign = 'left';
      outlinedText(ctx, label, 168, y, color, '#2a1208', 6);
      ctx.font = `900 27px ${FONT}`;
      ctx.textAlign = 'right';
      outlinedText(ctx, String(v), 318, y, '#fff', '#2a1208', 6);
    }
    ctx.textAlign = 'center';
  }

  /** コンボ太鼓（相手用。スプライトを使わずに描く） */
  private paintComboDrum(combo: number, scale: number) {
    const ctx = this.ctx;
    const { x, y, r } = DRUM;
    ctx.fillStyle = '#1d2b4a';
    ctx.beginPath();
    ctx.ellipse(x, y + 26, r, r * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#34507f';
    ctx.beginPath();
    ctx.ellipse(x, y + 18, r * 0.98, r * 0.88, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#16203a';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.93, 0, Math.PI * 2);
    ctx.fillStyle = '#f3e3c6';
    ctx.fill();
    this.paintComboNumber(combo, scale);
  }

  /** 相手の判定の光と、判定枠から広がる輪（自分と同じ演出） */
  private drawOppBurst(o: Opponent, game: Game, wall: number) {
    const fx = o.fx;
    if (!fx || fx.j === 3) return;
    const ms = wall - fx.t;
    if (ms < 0 || ms > 480) return;
    const ctx = this.ctx;
    const judge: Judge = fx.j === 1 ? 'good' : 'ok';
    // 判定枠の光
    const a = 0.85 * (ms < 100 ? 1 : ms < 240 ? 1 - ((ms - 100) / 140) * 0.6 : 0.4 * (1 - (ms - 240) / 240));
    const r = NR - 4;
    ctx.globalAlpha = a;
    ctx.drawImage(this.glowSprite(judge), this.jx - r, JY - r, r * 2, r * 2);
    // 広がる輪
    if (ms <= 200) {
      const big = isBig(game.states[fx.i]?.note.type ?? 'don');
      const kk = 0.92 + 0.12 * ease(Math.min(1, ms / 80));
      const half = (big ? 230 : 130) * kk;
      ctx.globalAlpha = 0.8 * (ms < 90 ? 1 : 1 - (ms - 90) / 110);
      ctx.drawImage(this.burstSprite(judge, big), this.jx - half, JY - half, half * 2, half * 2);
    }
    ctx.globalAlpha = 1;
  }

  /** 相手の「良」「可」「不可」（自分と同じく、レーンの上に出る。文字の絵は使い回す） */
  private drawOppJudgeText(o: Opponent, wall: number) {
    const fx = o.fx;
    if (!fx) return;
    const age = wall - fx.t;
    if (age > 400) return;
    const ctx = this.ctx;
    const judge: Judge = fx.j === 1 ? 'good' : fx.j === 2 ? 'ok' : 'bad';
    const rise = ease(Math.min(1, age / 60));
    const y = LANE_TOP - 6 - 30 * rise;
    ctx.globalAlpha = age < 300 ? 1 : 1 - (age - 300) / 100;
    drawCachedText(ctx, JUDGE_TEXT[judge], this.jx, y, `900 ${judge === 'bad' ? 56 : 68}px ${FONT}`, judge === 'good' ? '#ffc21a' : judge === 'ok' ? '#ffffff' : '#7f9cff', '#3a1300', 10);
    ctx.globalAlpha = 1;
  }


  /** 音符の下の文字（ドン / ド / コ / カッ / カ / 連打 / ふうせん） */
  private labelsFor(game: Game): Map<Note, string> {
    const cached = this.labels.get(game);
    if (cached) return cached;
    const map = new Map<Note, string>();
    const notes = game.states.map((s) => s.note);
    let prevShort = false;
    let prevLabel = '';
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const beat = 60 / n.bpm;
      if (n.type === 'roll' || n.type === 'bigRoll') { map.set(n, '連打'); prevShort = false; continue; }
      if (n.type === 'balloon') { map.set(n, 'ふうせん'); prevShort = false; continue; }
      const next = notes[i + 1];
      const gap = next ? next.time - n.time : Infinity;
      const short = gap < beat / 2 - 1e-3;
      const isDon = n.type === 'don' || n.type === 'bigDon';
      let label: string;
      if (isDon) {
        if (!short) label = 'ドン';
        else if (prevShort && prevLabel === 'ド' && gap <= beat / 4 + 1e-3) label = 'コ';
        else label = 'ド';
      } else {
        label = short ? 'カ' : 'カッ';
      }
      map.set(n, label);
      prevShort = short;
      prevLabel = label;
    }
    this.labels.set(game, map);
    return map;
  }

  /**
   * 判定したときの光（参考動画: 判定枠が黄色く光り、周りに細い光の筋と点の輪が広がる）。
   * 筋と点の輪は前もって一度だけ描いておき、毎フレームは拡大して貼るだけ。良＝金、可＝白
   */
  private burstSprites: Record<string, HTMLCanvasElement> = {};

  private burstSprite(judge: Judge, big = false): HTMLCanvasElement {
    const key = `${judge}${big ? ':big' : ''}`;
    const cached = this.burstSprites[key];
    if (cached) return cached;
    const R = big ? 230 : 130; // 基準座標での半径
    const px = Math.max(1, this.dpr * this.s * 1.6);
    const c = document.createElement('canvas');
    c.width = c.height = Math.ceil(R * 2 * px);
    const g = c.getContext('2d')!;
    g.scale(px, px);
    const good = judge === 'good';
    const ray1 = good ? '#ffe03a' : '#ffffff';
    const ray2 = good ? '#ff9a1a' : '#cfe6ff';
    // 光の筋（長短を交互に）
    g.lineCap = 'round';
    // 大音符は筋が長く、レーンの外まで伸びる
    const n = big ? 48 : 40;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 * i) / n;
      const long = i % 2 === 0;
      const r1 = 54;
      const r2 = big ? (long ? 150 : 118) : long ? 100 : 86;
      g.strokeStyle = long ? ray1 : ray2;
      g.lineWidth = long ? 4 : 3;
      g.beginPath();
      g.moveTo(R + Math.cos(ang) * r1, R + Math.sin(ang) * r1);
      g.lineTo(R + Math.cos(ang) * r2, R + Math.sin(ang) * r2);
      g.stroke();
    }
    // 外側の点の輪
    g.fillStyle = good ? '#ff8a12' : '#e8f2ff';
    for (let i = 0; i < 32; i++) {
      const ang = (Math.PI * 2 * (i + 0.5)) / 32;
      const rr = big ? 132 : 108;
      g.beginPath();
      g.arc(R + Math.cos(ang) * rr, R + Math.sin(ang) * rr, 4, 0, Math.PI * 2);
      g.fill();
    }
    this.burstSprites[key] = c;
    return c;
  }

  /** 判定枠の中の光（黄色い円）。叩いた直後は明るく、少しずつ暗くなって消える */
  private drawJudgeGlow(wall: number) {
    const ctx = this.ctx;
    const b = this.bursts[this.bursts.length - 1];
    if (!b) return;
    const ms = wall - b.t;
    if (ms < 0 || ms > 480) return;
    const a = 0.85 * (ms < 100 ? 1 : ms < 240 ? 1 - ((ms - 100) / 140) * 0.6 : 0.4 * (1 - (ms - 240) / 240));
    const r = NR - 4;
    // 光の円は一度だけ描いておき、濃さ（a）を変えて貼る
    this.drawSprite(`glow:${b.judge}`, this.jx - r - 2, JY - r - 2, r * 2 + 4, r * 2 + 4, () => {
      const c = this.ctx;
      const g = c.createRadialGradient(this.jx, JY, 4, this.jx, JY, r);
      if (b.judge === 'good') {
        g.addColorStop(0, 'rgb(255,246,150)');
        g.addColorStop(0.75, 'rgb(250,214,40)');
        g.addColorStop(1, 'rgb(214,160,10)');
      } else {
        g.addColorStop(0, 'rgb(255,255,255)');
        g.addColorStop(1, 'rgb(200,215,230)');
      }
      c.fillStyle = g;
      c.beginPath();
      c.arc(this.jx, JY, r, 0, Math.PI * 2);
      c.fill();
    }, a);
    void ctx;
  }

  private drawBursts(wall: number) {
    const ctx = this.ctx;
    for (const b of this.bursts) {
      const ms = wall - b.t;
      if (ms < 0 || ms > 200) continue;
      const k = 0.92 + 0.12 * ease(Math.min(1, ms / 80));
      const half = (b.big ? 230 : 130) * k;
      ctx.globalAlpha = 0.8 * (ms < 90 ? 1 : 1 - (ms - 90) / 110);
      ctx.drawImage(this.burstSprite(b.judge, b.big), this.jx - half, JY - half, half * 2, half * 2);
    }
    ctx.globalAlpha = 1;
    this.bursts = this.bursts.filter((b) => wall - b.t < 500);
  }

  private drawPanel(score: number, combo: number, info: { course: string; level: number }, wall: number) {
    const x0 = Math.min(0, this.vis.x0);
    // 動かない部分（パネル・スコア欄の帯・難易度・名札）
    this.drawSprite(`panel:${info.course}:${info.level}`, x0, LANE_TOP - 6, LANE_X - x0, TEXT_BOTTOM - LANE_TOP + 12, () => {
      const ctx = this.ctx;
      const x0 = Math.min(0, this.vis.x0);
      // 赤いパネル
      const g = ctx.createLinearGradient(0, LANE_TOP - 6, 0, TEXT_BOTTOM);
      g.addColorStop(0, '#3388b8');
      g.addColorStop(1, '#1d5378');
      ctx.fillStyle = g;
      ctx.fillRect(x0, LANE_TOP - 6, LANE_X - x0, TEXT_BOTTOM - LANE_TOP + 12);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      for (let x = 30; x < LANE_X; x += 70) {
        for (let y = LANE_TOP + 30; y < TEXT_BOTTOM; y += 70) {
          ctx.beginPath();
          ctx.arc(x + ((y / 70) % 2) * 35, y, 18, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // スコア欄（左上の暗い帯）
      ctx.fillStyle = 'rgba(0,12,30,0.5)';
      ctx.fillRect(x0, LANE_TOP - 6, 316 - x0, 62);

      // 難易度（丸いバッジ＋下に名前）
      const [label, col] = COURSE_LABEL[info.course] ?? [info.course, '#7b3fd1'];
      const bx = 99;
      const by = 394;
      ctx.beginPath();
      ctx.arc(bx, by, 40, 0, Math.PI * 2);
      ctx.fillStyle = '#3a3a46';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, by, 34, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.font = `900 30px ${FONT}`;
      outlinedText(ctx, `★${info.level}`, bx, by + 2, '#ffe25a', '#2a1640', 6);
      ctx.font = `900 ${label.length > 3 ? 20 : 26}px ${FONT}`;
      outlinedText(ctx, label, bx, by + 50, '#fff', '#2a1640', 6);

      // 名札（1P・称号・名前）
      this.drawNameplate();
    });
    const ctx = this.ctx;
    ctx.font = `900 50px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(score), 282, LANE_TOP + 28, '#fff', '#111', 9);
    this.drawScoreAdd(wall);

    // コンボ太鼓
    this.drawComboDrum(combo, wall);
  }

  /** 加算された点数（スコアの上にオレンジで出て、少し下がりながら消える） */
  private drawScoreAdd(wall: number) {
    const f = this.scoreFx;
    if (!f) return;
    const ms = wall - f.t;
    if (ms > 700) return;
    const ctx = this.ctx;
    const pop = ms < 60 ? 1.15 - 0.15 * (ms / 60) : 1;
    const fall = ms > 450 ? ((ms - 450) / 250) * 26 : 0;
    ctx.save();
    ctx.globalAlpha = ms > 450 ? 1 - (ms - 450) / 250 : 1;
    ctx.translate(276, LANE_TOP - 34 + fall);
    ctx.scale(pop, pop);
    ctx.font = `900 46px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const g = ctx.createLinearGradient(0, -22, 0, 22);
    g.addColorStop(0, '#ffe066');
    g.addColorStop(1, '#ff7a12');
    outlinedText(ctx, String(f.add), 0, 0, g, '#4a1800', 8);
    ctx.restore();
  }

  /** 左下の名札（オリジナルの意匠: 1P の丸・紫の称号の帯・白い名前の帯） */
  private drawNameplate(badge = '1P', badgeColor = '#3a8fc0', title = 'TJAtelier テストプレイ', name = 'プレイヤー') {
    const ctx = this.ctx;
    const y0 = 470;
    // 称号の帯
    ctx.fillStyle = '#14212b';
    roundRect(ctx, 46, y0, 290, 28, 14);
    ctx.fill();
    ctx.font = `800 17px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(title, 200, y0 + 15);
    // 名前の帯
    ctx.fillStyle = '#fff';
    roundRect(ctx, 46, y0 + 32, 290, 40, 20);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#2a2a2a';
    ctx.stroke();
    ctx.font = `900 24px ${FONT}`;
    ctx.fillStyle = '#222';
    ctx.fillText(name, 206, y0 + 53, 250);
    // 1P の丸
    ctx.beginPath();
    ctx.arc(38, y0 + 36, 34, 0, Math.PI * 2);
    ctx.fillStyle = badgeColor;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.font = `900 30px ${FONT}`;
    outlinedText(ctx, badge, 38, y0 + 38, '#fff', '#0e1a3a', 6);
  }

  /** 右上の曲名（ジャンルの色の丸＋曲名、下にジャンル名の帯） */
  private drawTitle(info: { title: string; genre?: string }) {
    const x = this.vis.x1 - 1400;
    this.drawSprite(`title:${info.title}:${info.genre ?? ''}`, x, 0, 1400, 170, () => this.paintTitle(info));
  }

  private paintTitle(info: { title: string; genre?: string }) {
    const ctx = this.ctx;
    // 右上の × をなくした（ポーズは左上）ので、曲名を右へ寄せる
    const right = this.vis.x1 - 40;
    const genre = info.genre?.trim();
    const col = (genre && GENRE_COLOR.find(([re]) => re.test(genre))?.[1]) || '#3fc1c9';
    ctx.font = `900 56px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, info.title, right, 68, '#fff', '#111', 11);
    if (genre) {
      ctx.font = `900 26px ${FONT}`;
      const gw = Math.max(240, ctx.measureText(genre).width + 60);
      ctx.fillStyle = col;
      roundRect(ctx, right + 10 - gw, 108, gw, 34, 17);
      ctx.fill();
      ctx.textAlign = 'center';
      outlinedText(ctx, genre, right + 10 - gw / 2, 126, '#fff', '#1a1a1a', 6);
    }
  }

  private drawComboDrum(combo: number, wall: number) {
    const ctx = this.ctx;
    const { x, y, r } = DRUM;
    // 胴と面（動かないので一度だけ描いて貼る）
    this.drawSprite('drum', x - r - 2, y - r - 2, r * 2 + 4, r * 2 + 34, () => {
      const c = this.ctx;
      // 胴
      c.fillStyle = '#16203a';
      c.beginPath();
      c.ellipse(x, y + 26, r, r * 0.9, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#34507f';
      c.beginPath();
      c.ellipse(x, y + 18, r * 0.98, r * 0.88, 0, 0, Math.PI * 2);
      c.fill();
      // 面
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fillStyle = '#121a2c';
      c.fill();
      c.beginPath();
      c.arc(x, y, r * 0.93, 0, Math.PI * 2);
      c.fillStyle = '#f3e3c6';
      c.fill();
    });

    // 叩いた場所が光る（面＝ドン、縁＝カッ）
    for (const f of this.flashes) {
      const a = 1 - (wall - f.t) / 160;
      if (a <= 0) continue;
      const start = f.side === 'L' ? Math.PI / 2 : -Math.PI / 2;
      ctx.beginPath();
      if (f.kind === 'don') {
        ctx.moveTo(x, y);
        ctx.arc(x, y, r * 0.93, start, start + Math.PI);
        ctx.fillStyle = `rgba(255,80,40,${0.75 * a})`;
        ctx.fill();
      } else {
        ctx.arc(x, y, r * 0.97, start, start + Math.PI);
        ctx.lineWidth = 12;
        ctx.strokeStyle = `rgba(70,200,240,${a})`;
        ctx.stroke();
      }
    }

    const p = Math.min(1, (wall - this.comboPop) / 90);
    this.paintComboNumber(combo, 1 + 0.22 * (1 - p));
  }

  /** コンボ太鼓の数（10 以上で出す。100 以上は金色） */
  private paintComboNumber(combo: number, scale: number) {
    if (combo < 10) return;
    const ctx = this.ctx;
    const { x, y } = DRUM;
    const digits = String(combo);    const size = digits.length >= 4 ? 50 : digits.length === 3 ? 64 : 76;
    ctx.save();
    ctx.translate(x, y - 8);
    ctx.scale(1, scale);
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 100 未満は銀色、100 以上は金色
    const sg = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
    sg.addColorStop(0, '#ffffff');
    sg.addColorStop(0.55, '#e6edf6');
    sg.addColorStop(1, '#a9bad0');
    let fill: string | CanvasGradient = sg;
    let edge = '#1c2638';
    if (combo >= 100) {
      edge = '#3a1606';
      const g = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
      g.addColorStop(0, '#fff7c2');
      g.addColorStop(0.5, '#ffd23a');
      g.addColorStop(1, '#ff9a12');
      fill = g;
    }
    outlinedText(ctx, digits, 0, 0, fill, edge, 11);
    ctx.restore();
    ctx.font = `900 26px ${FONT}`;
    ctx.textAlign = 'center';
    outlinedText(ctx, 'コンボ', x, y + 44, '#fff', '#1c2638', 6);
  }

  private drawGauge(gauge: number, wall: number) {
    const ctx = this.ctx;
    const clearX = GAUGE.x1 + ((GAUGE.x2 - GAUGE.x1) * CLEAR_LINE) / 100;
    const G = GAUGE;
    // 枠とクリア欄（動かないので貼るだけ）
    const clearOn = gauge >= CLEAR_LINE;
    this.drawSprite(`gauge:${clearOn}`, G.x1 - 12, G.y1 - 44, G.x2 - G.x1 + 34, G.y2 - G.y1 + 56, () => {
      const c = this.ctx;
      c.fillStyle = '#0b1015';
      roundRect(c, G.x1 - 8, G.y1 - 7, G.x2 - G.x1 + 16, G.y2 - G.y1 + 14, 10);
      c.fill();
      c.fillStyle = '#1d3442';
      roundRect(c, clearX - 4, G.y1 - 40, G.x2 - clearX + 12, 38, 8);
      c.fill();
      c.font = `800 26px ${FONT}`;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      outlinedText(c, 'クリア', clearX + 10, G.y1 - 21, clearOn ? '#ffe25a' : '#b9a46a', '#0b1015', 5);
    });

    // 目盛り
    const segW = (G.x2 - G.x1) / G.segs;
    const filled = Math.floor((gauge / 100) * G.segs + 1e-6);
    const full = gauge >= 100;
    for (let i = 0; i < G.segs; i++) {
      const x = G.x1 + i * segW;
      const clear = i >= (G.segs * CLEAR_LINE) / 100;
      let col: string;
      if (i < filled) {
        if (full) col = RAINBOW[Math.floor((i * 9 + wall / 4) % 360)];
        else col = clear ? '#ffd21f' : '#5ab4d6';
      } else col = clear ? '#3d3a1e' : '#1d3442';
      ctx.fillStyle = col;
      ctx.fillRect(x + 1, G.y1, segW - 2, G.y2 - G.y1);
      if (i < filled) {
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.fillRect(x + 1, G.y1, segW - 2, 7);
      }
    }

    // 魂の花
    const pop = Math.max(0, 1 - (wall - this.flowerPop) / 160);
    const fr = FLOWER.r * (1 + 0.1 * pop);
    const bright = gauge >= CLEAR_LINE;
    for (let i = 0; i < 12; i++) {
      const a = (Math.PI * 2 * i) / 12 + wall / 4000;
      ctx.beginPath();
      ctx.arc(FLOWER.x + Math.cos(a) * fr * 0.7, FLOWER.y + Math.sin(a) * fr * 0.7, fr * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = i % 2 ? (bright ? '#93cde2' : '#2a5a70') : bright ? '#5ab4d6' : '#1f3a48';
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(FLOWER.x, FLOWER.y, fr * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    drawNoteHead(ctx, FLOWER.x, FLOWER.y, fr * 0.52, 'don');
  }

  /**
   * 連打中の打数（参考動画: 判定枠の上に金色の扇が開き、白い大きな数字と「連打!!」）。
   * 風船のときは、ふくらんでいく風船と残りの打数の吹き出し
   */
  private drawRollBubble(wall: number) {
    const r = this.rollFx;
    if (!r) return;
    const age = wall - r.t;
    if (r.balloon) {
      if (age > 400) return;
      this.drawInflating(r.count, r.hits, age);
      return;
    }
    if (age > 900) return;
    const ctx = this.ctx;
    const cx = this.jx;
    const cy = 208;
    const pop = age < 70 ? 1.12 - 0.12 * (age / 70) : 1;
    ctx.save();
    ctx.globalAlpha = age < 700 ? 1 : 1 - (age - 700) / 200;
    ctx.translate(cx, cy - 60);
    ctx.scale(pop, pop);
    ctx.translate(0, 60);
    const R = 158;
    const a1 = (-155 * Math.PI) / 180;
    const a2 = (-25 * Math.PI) / 180;
    // 扇の紙
    ctx.beginPath();
    ctx.arc(0, 0, R, a1, a2);
    ctx.arc(0, 0, 34, a2, a1, true);
    ctx.closePath();
    const g = ctx.createRadialGradient(0, 0, 30, 0, 0, R);
    g.addColorStop(0, '#fff6c0');
    g.addColorStop(0.55, '#f9d23a');
    g.addColorStop(1, '#e0a00c');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#3a2400';
    ctx.stroke();
    // 骨
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(150,95,0,0.55)';
    for (let i = 1; i < 10; i++) {
      const a = a1 + ((a2 - a1) * i) / 10;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
      ctx.lineTo(Math.cos(a) * (R - 4), Math.sin(a) * (R - 4));
      ctx.stroke();
    }
    // 縁の白い線
    ctx.beginPath();
    ctx.arc(0, 0, R - 9, a1 + 0.03, a2 - 0.03);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke();
    // 要（かなめ）
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#c0392b';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#3a2400';
    ctx.stroke();
    // 数字と「連打!!」
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const digits = String(r.count);
    ctx.font = `900 ${digits.length >= 3 ? 64 : 76}px ${FONT}`;
    outlinedText(ctx, digits, 0, -92, '#fff', '#1a1a1a', 12);
    ctx.font = `900 26px ${FONT}`;
    outlinedText(ctx, '連打!!', 0, -40, '#fff', '#1a1a1a', 6);
    ctx.restore();
  }

  /**
   * 風船（参考動画: 判定枠の位置から右へ風船がふくらむ。小さいうちはオレンジ、大きくなるほど黄色→白っぽく。
   * 上に残りの打数の吹き出し）
   */
  private drawInflating(count: number, hits: number, age: number) {
    const ctx = this.ctx;
    const p = Math.min(1, count / Math.max(1, hits));
    const bump = age < 50 ? 5 * (1 - age / 50) : 0;
    const r = 48 + 118 * p + bump;
    const knot = BALLOON_X;
    const cx = knot + r * 0.98;
    const cy = JY;
    // 色: オレンジ → 黄色 → 淡い黄色
    const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const c1 = p < 0.5 ? mix([240, 128, 40], [248, 214, 64], p / 0.5) : mix([248, 214, 64], [252, 244, 176], (p - 0.5) / 0.5);
    const c2 = mix(c1, [255, 255, 255], 0.55);
    ctx.save();
    // 吹き口
    ctx.beginPath();
    ctx.moveTo(knot - 18, cy - 12);
    ctx.lineTo(knot + 6, cy - 6);
    ctx.lineTo(knot + 6, cy + 6);
    ctx.lineTo(knot - 18, cy + 12);
    ctx.closePath();
    ctx.fillStyle = `rgb(${mix(c1, [180, 70, 10], 0.4).join(',')})`;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#2a1608';
    ctx.stroke();
    // 玉
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.08, cx, cy, r);
    g.addColorStop(0, `rgb(${c2.join(',')})`);
    g.addColorStop(0.6, `rgb(${c1.join(',')})`);
    g.addColorStop(1, `rgb(${mix(c1, [200, 120, 20], 0.35).join(',')})`);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.97, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#2a1608';
    ctx.stroke();
    // つや
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.38, cy - r * 0.48, r * 0.14, r * 0.22, 0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fill();
    // 吹き出し（残りの打数）
    const sx = BALLOON_X + 120;
    const sy = 150;
    ctx.beginPath();
    ctx.ellipse(sx, sy, 84, 66, 0, 0, Math.PI * 2);
    ctx.moveTo(sx - 52, sy + 44);
    ctx.lineTo(sx - 92, sy + 96);
    ctx.lineTo(sx - 18, sy + 62);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#1a1a1a';
    ctx.stroke();
    ctx.font = `900 64px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1a1a';
    ctx.fillText(String(Math.max(0, hits - count)), sx, sy + 4);
    ctx.restore();
  }


  /** 風船が割れた瞬間（白い輪が広がって消えるだけの控えめな演出） */
  private drawRainbow(wall: number) {
    if (this.rainbow === null) return;
    const age = wall - this.rainbow;
    if (age > 260) {
      this.rainbow = null;
      return;
    }
    const ctx = this.ctx;
    const p = age / 260;
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.beginPath();
    ctx.arc(BALLOON_X + 160, JY, 120 + 90 * ease(p), 0, Math.PI * 2);
    ctx.lineWidth = 10 * (1 - p) + 2;
    ctx.strokeStyle = '#fffbe6';
    ctx.stroke();
    ctx.restore();
  }


  /** 大音符が飛んでいった跡のきらきら */
  private drawSparkles(wall: number) {
    if (!this.sparkles.length) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#fffbe0';
    this.sparkles = this.sparkles.filter((p) => wall - p.t < 520);
    for (const p of this.sparkles) {
      const age = wall - p.t;
      ctx.globalAlpha = 0.8 * (1 - age / 520);
      star(ctx, p.x + p.vx * age, p.y + p.vy * age, 6 * (1 - age / 700));
    }
    ctx.restore();
  }

  /** ゴーゴータイムが始まった時刻（ゴーゴースタートの演出用） */
  private gogoStartWall = -1e9;
  /** ゴーゴーが始まった最後の時刻（レーンを一瞬明るくする光） */
  private gogoFlashWall = -1e9;

  /**
   * 炎の形（玉の右上から 1 本の先がのびる）。玉と同じ色で、玉の下に描くと 1 つの炎の玉に見える。
   * 先の長さ・向きは約 16 コマ/秒で切り替える（アニメのコマ送りのように、ぬるぬるではなくパラパラ動く）
   */
  private flamePath(wall: number) {
    const ctx = this.ctx;
    const f = Math.floor(wall / 62); // コマ番号
    const n = (i: number, k: number) => Math.sin(f * (0.9 + i * 0.37) + k * 2.3 + i * 1.7); // コマごとに変わる値（-1〜1）
    const R = 95;
    const P = (ang: number, r: number) => [this.jx + Math.cos(ang) * r, JY + Math.sin(ang) * r] as const;
    // 先: 付け根の角度、長さ、向き（右上 -45° を基準に少し開く）
    const tips = [
      { a: -0.75, len: 60, dir: -0.6 },
    ].map((t, i) => ({ a: t.a, len: t.len * (0.82 + 0.22 * n(i, 0)), dir: t.dir + 0.12 * n(i, 1) }));
    ctx.beginPath();
    const [sx, sy] = P(0.35, R - 4);
    ctx.moveTo(sx, sy);
    let prevA = 0.35;
    // 右側から反時計回りに、谷 → 先 → 谷 … と外形をたどる
    for (let i = tips.length - 1; i >= 0; i--) {
      const t = tips[i];
      const [vx, vy] = P((prevA + t.a) / 2 + 0.05, R + 6); // 谷
      const [bx, by] = P(t.a, R + 4);
      const tx = bx + Math.cos(t.dir) * t.len;
      const ty = by + Math.sin(t.dir) * t.len;
      ctx.quadraticCurveTo(vx + (tx - vx) * 0.15, vy + (ty - vy) * 0.15, vx, vy);
      ctx.quadraticCurveTo(bx + (tx - bx) * 0.55 + 10, by + (ty - by) * 0.55 + 8, tx, ty);
      ctx.quadraticCurveTo(bx + (tx - bx) * 0.35 - 14, by + (ty - by) * 0.35 - 4, ...P(t.a - 0.32, R + 2));
      prevA = t.a - 0.32;
    }
    ctx.lineTo(...P(-2.9, R - 4));
    ctx.arc(this.jx, JY, R - 4, -2.9, 0.35, false);
    ctx.closePath();
  }

  /** ゴーゴータイムの判定枠: 炎の玉。ゴーゴーが始まった瞬間は、大きな炎がさっと広がって玉に収まる（控えめに・約 0.26 秒） */
  private drawFireball(wall: number) {
    const ctx = this.ctx;
    ctx.save();
    const since = wall - this.gogoStartWall;
    const sinceFlash = wall - this.gogoFlashWall;
    if (sinceFlash >= 0 && sinceFlash < 260) {
      // レーンも一瞬だけ明るく（ゴーゴーが始まるたび）
      ctx.fillStyle = `rgba(255,150,120,${0.16 * (1 - sinceFlash / 260)})`;
      ctx.fillRect(LANE_X, LANE_TOP, this.vis.x1 - LANE_X, LANE_BOTTOM - LANE_TOP);
    }
    if (since >= 0 && since < 260) {
      // ゴーゴースタート: 薄い大きな炎が玉から広がって消える
      const k = since / 260;
      const e = 1 - (1 - k) * (1 - k);
      ctx.save();
      ctx.globalAlpha = 0.4 * (1 - k);
      ctx.translate(this.jx, JY);
      const sc = 1.9 - 0.9 * e;
      ctx.scale(sc, sc);
      ctx.translate(-this.jx, -JY);
      this.flamePath(wall);
      ctx.fillStyle = '#ff9a7a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(this.jx, JY, 95, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // レーンの下の縁を右へ流れる小さな光
      ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - k)})`;
      for (let j = 0; j < 14; j++) {
        const x = this.jx + 60 + ((j * 97 + since * 3) % 900);
        const y = LANE_BOTTOM - 10 - ((j * 37) % 30);
        const r = 2 + (j % 3);
        ctx.fillRect(x - r, y - 0.6, r * 2, 1.2);
        ctx.fillRect(x - 0.6, y - r, 1.2, r * 2);
      }
    }
    // 炎（玉と同じ色）。縁だけ少し明るく
    this.flamePath(wall);
    ctx.fillStyle = '#f07436';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(255,190,140,0.55)';
    ctx.stroke();
    // 外の光と玉（動かないので一度だけ描いて貼る）
    this.drawSprite('fireball', this.jx - 120, JY - 120, 240, 240, () => this.paintFireball());
    ctx.restore();
  }

  private paintFireball() {
    const ctx = this.ctx;
    ctx.save();
    const glow = ctx.createRadialGradient(this.jx, JY, 80, this.jx, JY, 118);
    glow.addColorStop(0, 'rgba(240,116,54,0.9)');
    glow.addColorStop(1, 'rgba(240,116,54,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(this.jx, JY, 118, 0, Math.PI * 2);
    ctx.fill();
    // 玉
    ctx.beginPath();
    ctx.arc(this.jx, JY, 95, 0, Math.PI * 2);
    ctx.fillStyle = '#f07436';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(this.jx, JY, 81, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffcf8a';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.jx, JY, 55, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffe2a0';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(this.jx, JY, 47, 0, Math.PI * 2);
    ctx.fillStyle = '#f3a35f';
    ctx.fill();
    ctx.restore();
  }

  /**
   * ゴーゴータイムが始まったら、下の背景の床から噴き出す花火（参考動画: 白く光る火花の柱が横に並んで
   * 一斉に噴き上がり、上で火花が散って消える）
   */
  private startFireworks(wall: number) {
    // 噴いている最中に次のゴーゴーが始まったら、前の柱と火花はすぐに消して、新しく噴き出す（重ならない）
    this.fireworks = [];
    const V = this.vis;
    const step = 230;
    for (let x = V.x0 + step / 2; x < V.x1; x += step) {
      this.fireworks.push({ x: x + (Math.random() - 0.5) * 40, t: wall + Math.random() * 60, n: 150 });
    }
  }

  private drawFireworks(wall: number) {
    if (!this.fireworks.length) return;
    const ctx = this.ctx;
    const EMIT = FW_EMIT; // 噴き出している時間
    const LIFE = 700; // 1 粒の寿命
    const bottom = REF_H - 70;
    const top = TEXT_BOTTOM;
    const hgt = bottom - top;
    ctx.save();
    ctx.beginPath();
    // レーンの黒い枠（下端は TEXT_BOTTOM + 4）には重ねない
    ctx.rect(this.vis.x0, top + 4, this.vis.x1 - this.vis.x0, hgt - 4);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    this.fireworks = this.fireworks.filter((f) => wall - f.t < EMIT + LIFE);
    for (const f of this.fireworks) {
      const age = wall - f.t;
      if (age < 0) continue;
      // 火花の柱の光
      if (age < EMIT + 150) {
        const a = age < 80 ? age / 80 : age < EMIT ? 1 : 1 - (age - EMIT) / 150;
        const h = hgt * 0.95 * Math.min(1, age / 140);
        const g = ctx.createLinearGradient(0, bottom, 0, bottom - h);
        g.addColorStop(0, `rgba(255,252,240,${a})`);
        g.addColorStop(0.65, `rgba(255,228,160,${0.75 * a})`);
        g.addColorStop(1, 'rgba(255,190,90,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(f.x - 14, bottom);
        ctx.lineTo(f.x - 48, bottom - h);
        ctx.lineTo(f.x + 48, bottom - h);
        ctx.lineTo(f.x + 14, bottom);
        ctx.closePath();
        ctx.fill();
      }
      // 火花の粒（決まった乱数で、噴き出した時刻ごとに 1 粒）
      for (let i = 0; i < f.n; i++) {
        const pa = (age - (i / f.n) * EMIT) / 1000;
        if (pa < 0 || pa * 1000 > LIFE) continue;
        this.spark(f.x + i * 7.13, f.x * 1.7 + i * 3.91, f.x, pa, i, bottom, hgt, LIFE, 1);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /** 火花の粒を 1 つ描く（r1・r2 = 決まった乱数の元、pa = 噴き出してからの秒、boost = 勢い） */
  private spark(k1: number, k2: number, x: number, pa: number, i: number, bottom: number, hgt: number, LIFE: number, boost: number) {
    const ctx = this.ctx;
    const r1 = hash(k1);
    const r2 = hash(k2);
    const vy = -(hgt * 1.5 + r1 * hgt * 0.9) * boost;
    const vx = (r2 - 0.5) * 260 * boost;
    const g = hgt * 2.4;
    const px = x + vx * pa;
    const py = bottom + vy * pa + 0.5 * g * pa * pa;
    const life = (pa * 1000) / LIFE;
    ctx.globalAlpha = 1 - life;
    ctx.fillStyle = i % 4 === 0 ? '#ffd27a' : '#fffaf0';
    if (i % 3 === 0) star(ctx, px, py, 9);
    else {
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }



  private drawJudgeText(wall: number) {
    const j = this.judgeFx;
    if (!j) return;
    const age = wall - j.t;
    if (age > 400) return;
    const ctx = this.ctx;
    const rise = ease(Math.min(1, age / 60));
    const y = LANE_TOP - 6 - 30 * rise;
    const a = age < 300 ? 1 : 1 - (age - 300) / 100;
    ctx.globalAlpha = a;
    ctx.font = `900 ${j.judge === 'bad' ? 56 : 68}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fill: string | CanvasGradient;
    if (j.judge === 'good') {
      const g = ctx.createLinearGradient(0, y - 34, 0, y + 34);
      g.addColorStop(0, '#fff6b0');
      g.addColorStop(0.5, '#ffc21a');
      g.addColorStop(1, '#ff8a00');
      fill = g;
    } else if (j.judge === 'ok') fill = '#ffffff';
    else fill = '#7f9cff';
    outlinedText(ctx, JUDGE_TEXT[j.judge], this.jx, y, fill, '#3a1300', 10);
    ctx.globalAlpha = 1;
  }

  /** 叩いたノーツが弧を描いて魂ゲージへ飛んでいく */
  private drawFlyers(wall: number) {
    const ctx = this.ctx;
    const DUR = 420;
    const keep: Flyer[] = [];
    for (const f of this.flyers) {
      const p = (wall - f.t) / DUR;
      if (p >= 1) {
        this.flowerPop = wall;
        continue;
      }
      keep.push(f);
      const t = p * p * (3 - 2 * p) * 0.35 + p * 0.65;
      // 3次ベジェ: 判定枠 → 上へ → 右へ → 花
      const P0 = [this.jx, JY], P1 = [this.jx + 60, JY - 420], P2 = [FLOWER.x - 420, FLOWER.y - 330], P3 = [FLOWER.x, FLOWER.y];
      const u = 1 - t;
      const x = u * u * u * P0[0] + 3 * u * u * t * P1[0] + 3 * u * t * t * P2[0] + t * t * t * P3[0];
      const y = u * u * u * P0[1] + 3 * u * u * t * P1[1] + 3 * u * t * t * P2[1] + t * t * t * P3[1];
      const r = (isBig(f.note.type) ? NR * BIG_SCALE : NR) * (1 - 0.25 * t);
      if (isBig(f.note.type) && this.sparkles.length < 50 && Math.random() < 0.6) {
        for (let k = 0; k < 1; k++) {
          const a = Math.random() * Math.PI * 2;
          const sp = 0.03 + Math.random() * 0.08;
          this.sparkles.push({ x: x + Math.cos(a) * r * 0.6, y: y + Math.sin(a) * r * 0.6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: wall });
        }
      }
      drawNoteHead(ctx, x, y, r, f.note.type === 'balloon' ? 'balloon' : f.note.type);
    }
    this.flyers = keep;
  }

  /** 100 コンボごとの巻物 */
  private drawBanner(wall: number) {
    const b = this.banner;
    if (!b) return;
    const age = wall - b.t;
    if (age > 2100) { this.banner = null; return; }
    const ctx = this.ctx;
    const a = age < 150 ? age / 150 : age > 1800 ? 1 - (age - 1800) / 300 : 1;
    const sc = age < 150 ? 0.85 + 0.15 * (age / 150) : 1;
    const cx = 700;
    const cy = 115;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(cx, cy);
    ctx.scale(sc, sc);
    // 巻物
    ctx.fillStyle = '#c0331f';
    roundRect(ctx, -222, -86, 22, 172, 8);
    ctx.fill();
    roundRect(ctx, 200, -86, 22, 172, 8);
    ctx.fill();
    ctx.fillStyle = '#fbf2dc';
    ctx.fillRect(-202, -74, 404, 148);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#d9542b';
    ctx.strokeRect(-190, -62, 380, 124);
    const g = ctx.createLinearGradient(0, -50, 0, 50);
    g.addColorStop(0, '#fff3a0');
    g.addColorStop(0.5, '#ffb11a');
    g.addColorStop(1, '#f06a00');
    ctx.font = `900 96px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, String(b.combo), 70, 2, g, '#3a1300', 12);
    ctx.font = `900 40px ${FONT}`;
    ctx.textAlign = 'left';
    outlinedText(ctx, 'コンボ!', 78, 26, '#ff7a1a', '#3a1300', 7);
    ctx.restore();
  }

  /**
   * タッチ用の太鼓の形（画面 px）。画面の下に大きな太鼓の面を半分見せる。
   * 面の横幅がドンの帯（donWidth）と同じ。面の外（縁とその外側）がカッ。上下の位置は判定に関係ない
   */
  private drum() {
    const P = this.pad;
    // 大きさ 100%（面の横幅が画面の幅の 60.5%）のとき、面の上の端がレーンのすぐ下に来る位置を中心にして、
    // 縦横とも同じ割合で拡大縮小する。rx・ry は面の大きさ（その外側が縁）
    const base = (0.605 * P.w) / 2;
    const cy = P.top + Math.max(5, base * 0.045) + 0.03 * P.h + base * 0.66;
    const rx = P.half;
    const ry = rx * 0.66;
    const rim = Math.max(5, rx * 0.045);
    return { cx: P.x, cy, rx, ry, rim };
  }

  /** 叩いたときの光（ドン・カッ × 左右）の画像。画面 px の半分の細かさで作る（ぼんやり光るだけなので十分） */
  private padFlash: Record<string, { img: HTMLCanvasElement; x: number; y: number; w: number; h: number }> | null = null;

  private buildPadFlash() {
    const D = this.drum();
    const P = this.pad;
    const k = 0.5;
    const out: Record<string, { img: HTMLCanvasElement; x: number; y: number; w: number; h: number }> = {};
    const R = D.rim * 1.4;
    const top = Math.max(0, D.cy - D.ry - R);
    const h = Math.max(1, P.h - top);
    for (const kind of ['don', 'ka'] as const) {
      for (const side of ['L', 'R'] as const) {
        const outer = kind === 'don' ? D.rx : D.rx + R;
        const x0 = side === 'L' ? Math.max(0, D.cx - outer) : D.cx;
        const x1 = side === 'L' ? D.cx : Math.min(P.w, D.cx + outer);
        const w = Math.max(1, x1 - x0);
        const img = document.createElement('canvas');
        img.width = Math.max(1, Math.round(w * k));
        img.height = Math.max(1, Math.round(h * k));
        const c = img.getContext('2d')!;
        c.scale(k, k);
        c.translate(-x0, -top);
        c.beginPath();
        if (kind === 'don') {
          c.ellipse(D.cx, D.cy, D.rx, D.ry, 0, 0, Math.PI * 2);
          c.fillStyle = 'rgba(255,80,40,0.45)';
          c.fill();
        } else {
          c.ellipse(D.cx, D.cy, D.rx + R, D.ry + R, 0, 0, Math.PI * 2);
          c.ellipse(D.cx, D.cy, D.rx, D.ry, 0, 0, Math.PI * 2);
          c.fillStyle = 'rgba(70,200,240,0.7)';
          c.fill('evenodd');
        }
        out[`${kind}${side}`] = { img, x: x0, y: top, w, h };
      }
    }
    return out;
  }

  /** 太鼓の形（半透明）。画面 px の座標系で描く */
  private drawPadShape(ctx: CanvasRenderingContext2D) {
    const D = this.drum();
    const ell = (rx: number, ry: number) => {
      ctx.beginPath();
      ctx.ellipse(D.cx, D.cy, rx, ry, 0, 0, Math.PI * 2);
    };
    ctx.save();
    // 縁（黒い胴の縁と、ふちのでこぼこ）
    // 縁は控えめに（黒が目立ちすぎないよう、薄い灰色を半透明で）
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#3a3c44';
    // 縁のでこぼこ: 外周に小さな丸を少しずつ重ねて並べ、縁と 1 つの形にして塗る（重なった所が濃くならないように）
    const ax = D.rx + D.rim;
    const ay = D.ry + D.rim;
    const n = Math.max(32, Math.round((2 * Math.PI * Math.sqrt((ax * ax + ay * ay) / 2)) / (D.rim * 0.9)));
    ctx.beginPath();
    ctx.ellipse(D.cx, D.cy, ax, ay, 0, 0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2;
      const x = D.cx + Math.cos(a) * ax;
      const y = D.cy + Math.sin(a) * ay;
      ctx.moveTo(x + D.rim * 0.35, y);
      ctx.arc(x, y, D.rim * 0.35, 0, Math.PI * 2);
    }
    ctx.fill('nonzero');
    // 縁の鋲
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#e6e6ea';
    const m = Math.max(16, Math.round(D.rx / 22));
    for (let k = 0; k < m; k++) {
      const a = (k / m) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(D.cx + Math.cos(a) * (D.rx + D.rim * 0.5), D.cy + Math.sin(a) * (D.ry + D.rim * 0.5), Math.max(1.5, D.rim * 0.12), 0, Math.PI * 2);
      ctx.fill();
    }
    // 面（後ろの背景が透けるように薄く）
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#f7f1e3';
    ell(D.rx, D.ry);
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = Math.max(1, 3 * this.s);
    ctx.strokeStyle = '#ffffff';
    ell(D.rx * 0.97, D.ry * 0.97);
    ctx.stroke();
    ctx.restore();
  }

  /** 指置きの場所（レーンより上）。ほかの絵の上に重ねる */
  private drawRest() {
    const P = this.pad;
    if (this.restZone) {
      this.ctx.save();
      this.ctx.font = `800 ${Math.round(26 * this.s)}px ${FONT}`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      const rb = this.sy(LANE_TOP);
      this.ctx.save();
      this.ctx.fillStyle = 'rgba(40,200,120,0.18)';
      this.ctx.fillRect(0, 0, P.w, rb);
      this.ctx.strokeStyle = 'rgba(80,230,150,0.7)';
      this.ctx.setLineDash([8 * this.s, 6 * this.s]);
      this.ctx.lineWidth = Math.max(1, 3 * this.s);
      this.ctx.strokeRect(0, 0, P.w, rb);
      this.ctx.restore();
      this.ctx.fillStyle = 'rgba(255,255,255,0.8)';
      this.ctx.fillText('指置き（ここに 1 本ずっと触れておく・反応しません）', P.x, rb * 0.55);
      this.ctx.restore();
    }
  }

  /** 画面下の太鼓（タッチ用）。後ろの背景が見えるように半透明 */
  private drawPad(wall: number) {
    const ctx = this.ctx;
    // 叩き分けの帯は動かないので背景と一緒に前もって描いてある（drawPadShape）。ここでは光と波紋だけ
    if (!this.bg && this.padVisible) this.drawPadShape(ctx);
    if (!this.bg) this.drawRest();

    // 叩いた側が光る（ドン＝面の左半分／右半分、カッ＝縁の左側／右側）。太鼓を隠しているときは波紋だけ。
    // 光の形は前もって小さめの画像にしておき、毎フレームはそれを貼るだけにする（大きな形を毎回塗ると重くてカクつく）
    if (this.padVisible) {
      const fx = this.padFlash ?? (this.padFlash = this.buildPadFlash());
      for (const f of this.flashes) {
        const a = 1 - (wall - f.t) / 150;
        if (a <= 0) continue;
        const sp = fx[`${f.kind}${f.side}`];
        ctx.globalAlpha = a;
        ctx.drawImage(sp.img, sp.x, sp.y, sp.w, sp.h);
      }
      ctx.globalAlpha = 1;
    }

    // 指が触れた場所の波紋（ドン＝赤、カッ＝青）。どちらと判定されたかが分かるように
    for (const t of this.touches) {
      const p = (wall - t.t) / 260;
      if (p < 0 || p > 1) continue;
      ctx.beginPath();
      ctx.arc(t.x, t.y, (30 + 70 * ease(p)) * this.s, 0, Math.PI * 2);
      ctx.lineWidth = (10 * (1 - p) + 2) * this.s;
      ctx.strokeStyle = t.kind === 'don' ? `rgba(255,70,40,${1 - p})` : `rgba(60,190,240,${1 - p})`;
      ctx.stroke();
    }
  }

  /** 叩いたときのずれの表示（設定でオンのとき） */
  pushTiming(text: string, color: string) {
    this.timing = { text, color, t: performance.now() };
  }

  private timing: { text: string; color: string; t: number } | null = null;

  private drawTiming(wall: number) {
    const tm = this.timing;
    if (!tm) return;
    const age = wall - tm.t;
    if (age > 600) return;
    const ctx = this.ctx;
    ctx.globalAlpha = age < 450 ? 1 : 1 - (age - 450) / 150;
    ctx.font = `800 34px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    outlinedText(ctx, tm.text, this.jx, LANE_BOTTOM - 22, tm.color, '#000', 6);
    ctx.globalAlpha = 1;
  }

  /** 指が触れた場所（画面 px）を記録して波紋を出す */
  pushTouch(kind: HitKind, sx: number, sy: number) {
    this.touches.push({ kind, x: sx, y: sy, t: performance.now() });
    if (this.touches.length > 10) this.touches.shift();
  }
}

interface Rect { x0: number; y0: number; x1: number; y1: number }

/** 火花の柱が噴き出している時間（ms） */
const FW_EMIT = 650;

/** 0〜1 の決まった乱数 */
function hash(n: number) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** 4 本の角のきらきら */
function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  if (r <= 0) return;
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y);
  ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}


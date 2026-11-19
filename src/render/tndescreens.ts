/**
 * TNDE スキンの、曲の読み込み画面とリザルト画面（本家・TJAPlayer3 系と同じ動き）。
 * 座標は 1280×720 の単位（スキンの絵の大きさ）で書き、描くときに 1.5 倍して 1920×1080 に置く。
 * 動きの時間・位置は TJAPlayer3 系（OpenTaiko）の作りと、本家の参考動画で測った値
 */
import { stageNums, type TndeSkin, type PlateStyle } from './tnde';

const S = 1.5;
/** 曲名の字（大江戸勘亭流） */
const KANTEI = `'TNDE Kantei', 'TNDE Seurat', sans-serif`;
const P = (v: number) => v * S;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const rad = (deg: number) => (deg * Math.PI) / 180;
/** OpenTaiko の出るときの動き: 1.3 倍から 0.135 秒で 1 倍に */
const popOT = (u: number) => (u <= 135 ? 1.3 - Math.sin(rad(u / 1.5)) * 0.3 : 1);

/** 画面いっぱいの絵（切り出した絵は元の位置に）を描く */
function full(sk: TndeSkin, c: CanvasRenderingContext2D, name: string, a = 1, dx = 0, dy = 0) {
  const im = sk.pic(name);
  const m = sk.meta(name);
  if (!im || !m || a <= 0) return;
  sk.fade(c, a, () => sk.blit(c, im, P((m.x ?? 0) + dx), P((m.y ?? 0) + dy), P(m.w), P(m.h)));
}

/** 切り出した絵を、元の絵（ow×oh）を中心 (cx, cy) に k 倍で置いたように描く */
function centered(sk: TndeSkin, c: CanvasRenderingContext2D, name: string, cx: number, cy: number, kx: number, ky = kx, a = 1) {
  const im = sk.pic(name);
  const m = sk.meta(name);
  if (!im || !m || a <= 0 || kx <= 0 || ky <= 0) return;
  const ow = m.ow ?? m.w;
  const oh = m.oh ?? m.h;
  const x0 = cx - (ow * kx) / 2 + (m.x ?? 0) * kx;
  const y0 = cy - (oh * ky) / 2 + (m.y ?? 0) * ky;
  sk.fade(c, a, () => sk.blit(c, im, P(x0), P(y0), P(m.w * kx), P(m.h * ky)));
}

/** 絵の一部（sx, sy, sw, sh）を、中心 (cx, cy) に k 倍で */
function cell(sk: TndeSkin, c: CanvasRenderingContext2D, name: string, sx: number, sy: number, sw: number, sh: number, cx: number, cy: number, k = 1, a = 1) {
  const im = sk.pic(name);
  if (!im || a <= 0 || k <= 0) return;
  sk.fade(c, a, () => sk.blit(c, im, sx, sy, sw, sh, P(cx - (sw * k) / 2), P(cy - (sh * k) / 2), P(sw * k), P(sh * k)));
}

/** 白い字・黒い縁の 1 行（曲名など）を作っておく */
function textCanvas(text: string, px: number, maxW: number, fill = '#fff', stroke = '#000', lw = px * 0.22, family = `'TNDE Seurat', sans-serif`) {
  const cv = document.createElement('canvas');
  const g = cv.getContext('2d')!;
  const font = `${px}px ${family}`;
  g.font = font;
  const tw = Math.ceil(g.measureText(text).width);
  const pad = Math.ceil(lw) + 4;
  cv.width = tw + pad * 2;
  cv.height = Math.ceil(px * 1.4) + pad * 2;
  g.font = font;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  g.lineJoin = 'round';
  g.lineWidth = lw;
  g.strokeStyle = stroke;
  g.strokeText(text, cv.width / 2, cv.height / 2);
  g.fillStyle = fill;
  g.fillText(text, cv.width / 2, cv.height / 2);
  return { cv, tw, maxW };
}

/** 字の canvas を中心 (cx, cy)（1920×1080 の座標）に置く。幅が maxW を超えるときは横に縮める */
function putText(c: CanvasRenderingContext2D, t: ReturnType<typeof textCanvas>, cx: number, cy: number, a = 1) {
  if (a <= 0) return;
  const kx = t.tw > t.maxW ? t.maxW / t.tw : 1;
  c.save();
  c.globalAlpha *= a;
  c.drawImage(t.cv, cx - (t.cv.width * kx) / 2, cy - t.cv.height / 2, t.cv.width * kx, t.cv.height);
  c.restore();
}

// ====================================================================================
// 曲の読み込み画面
// ====================================================================================

/** 幕が閉じる時間・開く時間（ms） */
export const LOAD_CLOSE = 1000;
export const LOAD_OPEN = 800;

export class TndeLoading {
  private title: ReturnType<typeof textCanvas>;
  private sub: ReturnType<typeof textCanvas> | null;
  /** 出すヒント（Hints の何枚目か） */
  private hint: number;

  constructor(private readonly sk: TndeSkin, title: string, subtitle?: string) {
    // 曲名は勘亭流（プレイ画面と同じ字）。白い字に黒い縁
    this.title = textCanvas(title, 62, P(710), '#fff', '#000', 14, KANTEI);
    this.sub = subtitle ? textCanvas(subtitle, 40, P(710), '#000', 'rgba(0,0,0,0)', 0) : null;
    const n = sk.hintCount;
    this.hint = n ? Math.floor(Math.random() * n) : -1;
  }

  /** 幕（左右の半分ずつ）。exit = 開く */
  private back(c: CanvasRenderingContext2D, name: string, time: number, max: number, end: number, exit: boolean) {
    const im = this.sk.pic(name);
    if (!im) return;
    if (time - max >= end) time = end + max;
    const t = time >= max ? time - max : 0;
    const sx = 0.5 + ((exit ? 0.5 : 0) - t * (0.5 / end)) * (exit ? 1 : -1);
    const v = ((exit ? 1 : 0) - t / end) * (exit ? 1 : -1);
    this.sk.blit(c, im, 0, 0, 640, 720, P(-320 + v * 320), 0, P(640 * sx), P(720));
    this.sk.blit(c, im, 640, 0, 640, 720, P(960 - v * 320 + (1 - sx) * 640), 0, P(640 * sx), P(720));
  }

  /** 曲名の帯（真ん中を基準に横 sx・縦 sy 倍） */
  private plate(c: CanvasRenderingContext2D, a: number, sx: number, sy = 1) {
    const im = this.sk.pic('load/Plate');
    const m = this.sk.meta('load/Plate');
    if (!im || !m || a <= 0 || sx <= 0 || sy <= 0) return;
    const x0 = 640 - 640 * sx;
    const y0 = (1 - sy) * 360;
    this.sk.fade(c, a, () => this.sk.blit(c, im, P(x0 + (m.x ?? 0) * sx), P(y0 + (m.y ?? 0) * sy), P(m.w * sx), P(m.h * sy)));
  }

  /** どんちゃん・かっちゃん（左右の半分ずつ、X だけ内側へ、Y は上下） */
  private chara(c: CanvasRenderingContext2D, a: number, X: number, Y: number) {
    const im = this.sk.pic('load/Chara');
    const m = this.sk.meta('load/Chara');
    if (!im || !m || a <= 0) return;
    const oy = m.y ?? 0;
    this.sk.fade(c, a, () => {
      this.sk.blit(c, im, 0, 0, 640, m.h, P(-250 + X), P(Y + oy), P(640), P(m.h));
      this.sk.blit(c, im, 640, 0, m.w - 640, m.h, P(640 + 250 - X), P(Y + oy), P(m.w - 640), P(m.h));
    });
  }

  /** 曲名・ヒント（帯のまん中に曲名） */
  private texts(c: CanvasRenderingContext2D, a: number) {
    if (a <= 0) return;
    const m = this.sk.meta('load/Plate');
    const cy = m ? (m.y ?? 0) + m.h / 2 : 269;
    putText(c, this.title, P(640), P(this.sub ? cy - 15 : cy - 4), a);
    if (this.sub) putText(c, this.sub, P(640), P(cy + 30), a);
    if (this.hint >= 0) full(this.sk, c, `load/hint${this.hint}`, a);
  }

  /**
   * phase: close = 幕が閉じる（t: 0〜1000ms）、wait = 閉じたまま、open = 幕が開く（t: 0〜800ms。後ろはプレイ画面）
   */
  draw(c: CanvasRenderingContext2D, phase: 'close' | 'wait' | 'open', t: number) {
    if (phase === 'close' && t >= LOAD_CLOSE) phase = 'wait';
    if (phase === 'close') {
      this.back(c, t < 500 ? 'load/Fade' : 'load/Bg', t, 0, 500, false);
      const fv = clamp((t - 670) / 330);
      full(this.sk, c, 'load/BgWait', fv);
      this.plate(c, fv, fv);
      this.texts(c, fv);
      if (t > 680) {
        const X = Math.min(1, (t - 680) / 320) * 250;
        const Y = Math.sin(Math.min(320, t - 680) * (Math.PI / 320)) * -80;
        this.chara(c, clamp((t - 730) / 270), X, Y);
      }
      return;
    }
    if (phase === 'wait') {
      full(this.sk, c, 'load/BgWait');
      this.chara(c, 1, 250, 0);
      this.plate(c, 1, 1);
      this.texts(c, 1);
      return;
    }
    this.back(c, t < 300 ? 'load/Bg' : 'load/Fade', t, 300, 500, true);
    const fv = clamp(t / 140);
    full(this.sk, c, 'load/BgWait', 1 - fv);
    this.plate(c, 1 - fv, 1 + fv * 0.5, 1 - fv);
    if (this.hint >= 0) full(this.sk, c, `load/hint${this.hint}`, 1 - fv);
    const q = t <= 80 ? 0 : Math.pow(t - 80, 1.5) / Math.pow(220, 1.5);
    this.chara(c, t <= 80 ? 1 : clamp(1 - q), 250, t <= 80 ? (t / 80) * 30 : 30 - q * 320);
  }
}

// ====================================================================================
// リザルト画面
// ====================================================================================

export interface TndeResultData {
  title: string;
  /** 何曲目か */
  stage: number;
  /** 0 かんたん 1 ふつう 2 むずかしい 3 おに 4 おに（裏） */
  course: number;
  score: number;
  good: number;
  ok: number;
  bad: number;
  rolls: number;
  maxCombo: number;
  /** 魂ゲージ（0〜100） */
  gauge: number;
  /** クリアの線（%） */
  clearLine: number;
  crown: 'none' | 'clear' | 'fc' | 'dfc';
  /** 自己ベストを更新した（差） */
  best: number | null;
  plate: { name: string; title: string; profile?: PlateStyle };
}

/** 雲（11 個）: 中心の位置と、ゆっくり左へ流れる幅 */
const CLOUD_X = [642, 612, 652, 1148, 1180, 112, 8, 1088, 1100, 32, 412];
const CLOUD_Y = [202, 424, 636, 530, 636, 636, 102, 52, 108, 326, 644];
const CLOUD_MOVE = [150, 120, 180, 60, 90, 150, 120, 50, 45, 120, 180];
/** クリアの雲（金）の位置（赤の雲と少し違う。参考動画で測った） */
const GOLD_X = [634, 608, 694, 1134, 1154, 78, 8, 1088, 1100, 32, 412];
const GOLD_Y = [198, 452, 630, 528, 646, 628, 102, 52, 108, 326, 644];
/** 背景のきらめき（6 個） */
const SHINE_X = [885, 1255, 725, 890, 1158, 1140];
const SHINE_Y = [650, 405, 645, 420, 202, 585];
const SHINE_K = [0.44, 0.6, 0.4, 0.15, 0.35, 0.6];
/** 花火（3 つ） */
const WORK_X = [800, 900, 1160];
const WORK_Y = [435, 185, 260];
const WORK_AT = [1000, 2000, 3000];
/** 桜（回る花 5 つ） */
const FLOWER_X = [48, 125, 48, 240, 87];
const FLOWER_Y = [549, 585, 546, 501, 509];
const FLOWER_SPEED = [5, 3, -6, 4, -2];
const FLOWER_AT = [10, 30, 50, 100, 190];
/** パネルのきらめき（6 個） */
const PSHINE_X = [333, 342, 184, 198, 189, 309];
const PSHINE_Y = [670, 620, 650, 687, 558, 542];

export type ResultSound = 'resGauge' | 'resPom' | 'rankIn' | 'crownClear' | 'crownFc' | 'crownDfc' | 'best' | 'resClear' | 'resFailed';

export class TndeResult {
  /** 始まってからの時間（ms。黒から明るくなり始めたところが 0） */
  t = 0;
  private played = new Set<string>();
  private title: ReturnType<typeof textCanvas>;
  private bestText: ReturnType<typeof textCanvas> | null;
  private coin: ReturnType<typeof textCanvas>;
  /*
   * 時刻は OpenTaiko（TJAPlayer3 系）のリザルトと同じ（明るくなり始めたところが 0、ms）:
   * 2 秒でゲージが 59ms ごとに 2% ずつ伸びる → 伸び終わって 1 秒で 良・可・不可・連打数・最大コンボ数が 0.42 秒ずつ →
   * その 0.84 秒あとにスコア → 1 秒あとにスコアランク → 2.5 秒あとに王冠 → 山・ふきだし・どんちゃん
   */
  /** ゲージの 2% の数（0〜50） */
  private readonly G: number;
  /** ゲージが伸び始める・伸び終わる時刻 */
  private readonly GS = 2000;
  private readonly GE: number;
  /** 良の数が出る時刻（このあと 0.42 秒ずつ） */
  private readonly A: number;
  /** スコアが出る時刻 */
  private readonly S: number;
  private readonly tBand: number;
  private readonly tRank: number;
  private readonly tCrown: number;
  /** 山が出て、背景・ふきだし・どんちゃんが変わる時刻 */
  private readonly M: number;
  private gaugeSnd: { stop(): void } | null = null;
  private readonly rank: number;
  private readonly cleared: boolean;
  private readonly textRow = Math.floor(Math.random() * 3);
  /** 切り替わってからの時間（どんちゃんの動き） */
  private charaT = 0;
  private bandCv: HTMLCanvasElement | null = null;
  private songsCv: HTMLCanvasElement | null = null;

  constructor(private readonly sk: TndeSkin, private readonly d: TndeResultData, private readonly sound: (n: ResultSound) => { stop(): void } | null) {
    this.cleared = d.gauge >= d.clearLine;
    const ranks = [500000, 600000, 700000, 800000, 900000, 950000, 1000000];
    this.rank = ranks.filter((r) => d.score >= r).length;
    this.G = Math.floor(clamp(d.gauge, 0, 100) / 2);
    this.GE = this.GS + this.G * 59;
    this.A = 3000 + this.G * 59;
    this.S = this.A + 420 * 4 + 840;
    this.tBand = this.S + 183;
    this.tRank = this.S + 1000;
    this.tCrown = this.S + 2500;
    this.M = 10275 + 66 * this.G;
    // 曲名は勘亭流（プレイ画面と同じ字）
    this.title = textCanvas(d.title, 52, P(660), '#fff', '#000', 14, KANTEI);
    this.coin = textCanvas('0コイン', 38, 999, '#fff', '#000', 10, KANTEI);
    this.bestText = d.best !== null ? textCanvas(`${d.best}`, 27, 999, '#fff8dc', 'rgba(0,0,0,0)', 0) : null;
  }

  /** 動きが全部終わったか */
  get done() {
    return this.t >= this.M + 1500;
  }

  /** 叩いたら、山が出るところまで飛ばす（OpenTaiko と同じ。それまでの音は鳴らさない） */
  skip() {
    if (this.t >= this.M) return false;
    this.t = this.M;
    for (const k of ['g', 'ge', 'n0', 'n1', 'n2', 'n3', 'n4', 'sc', 'rk', 'cr', 'bs']) this.played.add(k);
    this.gaugeSnd?.stop();
    this.gaugeSnd = null;
    return true;
  }

  private once(key: string, at: number, f: () => void) {
    if (this.t >= at && !this.played.has(key)) {
      this.played.add(key);
      f();
    }
  }

  private sounds() {
    const { A, S } = this;
    this.once('g', this.GS, () => { this.gaugeSnd = this.sound('resGauge'); });
    // 満タンでなければ、伸び終わったところでゲージの音を止める
    if (this.G < 50) this.once('ge', this.GE, () => { this.gaugeSnd?.stop(); this.gaugeSnd = null; });
    for (let k = 0; k < 5; k++) this.once(`n${k}`, A + 420 * k, () => this.sound('resPom'));
    this.once('sc', S, () => this.sound('resPom'));
    if (this.d.best !== null) this.once('bs', this.tBand, () => this.sound('best'));
    if (this.rank > 0) this.once('rk', this.tRank + 180, () => this.sound('rankIn'));
    if (this.d.crown !== 'none') {
      const n = ({ clear: 'crownClear', fc: 'crownFc', dfc: 'crownDfc' } as const)[this.d.crown];
      this.once('cr', this.tCrown + 180, () => this.sound(n));
    }
    this.once('mt', this.M, () => {
      this.charaT = 0;
      this.sound(this.cleared ? 'resClear' : 'resFailed');
    });
  }

  draw(c: CanvasRenderingContext2D, dt: number) {
    this.t += dt;
    this.charaT += dt;
    this.sounds();
    const { sk, d, t, M } = this;
    const mtOn = t >= M;
    // 背景は 0.23 秒で切り替わる（参考動画で測った）
    const clearF = this.cleared && mtOn ? clamp((t - M) / 230) : 0;

    // ---------- 背景 ----------
    full(sk, c, 'res/Bg0');
    full(sk, c, 'res/Bg1', clearF);
    full(sk, c, 'res/Mt0', 1 - clearF);
    if (clearF > 0) {
      // 山がぴょんと伸びる（下を基準に縦だけ）
      const v = (t - M) / 3;
      const ky = v <= 90 ? 1 - Math.sin(rad(v)) * 0.18
        : v <= 225 ? 0.82 + Math.sin(rad((v - 90) / 1.5)) * 0.58
          : v <= 245 ? 1.4
            : v <= 335 ? 0.9 + Math.sin(rad(v - 155)) * 0.5
              : v <= 515 ? 0.9 + Math.sin(rad(v - 335)) * 0.4 : 0.9;
      const im = sk.pic('res/Mt1');
      const m = sk.meta('res/Mt1');
      if (im && m) sk.fade(c, clearF, () => sk.blit(c, im, P(m.x ?? 0), P(720 - (720 - (m.y ?? 0)) * ky), P(m.w), P(m.h * ky)));
    }
    // 雲（赤い背景の雲 → クリアなら金の雲）
    for (let i = 10; i >= 0; i--) {
      const red = CLOUD_MOVE[i] * Math.tanh(t / 10000);
      const gold = CLOUD_MOVE[i] * Math.tanh(Math.max(0, t - M) / 10000);
      if (clearF > 0) centered(sk, c, `res/cloud1_${i}`, GOLD_X[i] - gold, GOLD_Y[i], 1, 1, clearF);
      centered(sk, c, `res/cloud0_${i}`, CLOUD_X[i] - red, CLOUD_Y[i], 1, 1, 1 - clearF);
    }
    if (this.cleared && mtOn) {
      // きらめき（前半 2 つ・後半 4 つが 0.5 秒ずつ）
      const st = t % 1000;
      const q = st % 500;
      for (let i = 0; i < 6; i++) {
        if ((i < 2) !== (st < 500)) continue;
        const a = q >= 100 && q <= 400 ? 1 : Math.min(q, 500 - q) / 100;
        centered(sk, c, 'res/Shine', SHINE_X[i], SHINE_Y[i], SHINE_K[i], SHINE_K[i], a);
      }
      // 花火（山が出たときに 3 つ同時に、そのあと 1 秒ずつずらして繰り返す）
      for (let i = 0; i < 3; i++) {
        let v: number;
        if (t <= M + 1000) v = t - M;
        else v = ((t - M - 1000) % 4000) - WORK_AT[i];
        if (v < 0) continue;
        const k = v <= 255 ? 0.6 * (v / 225) : 0.6;
        const a = v <= 255 ? v / 255 : Math.max(0, 510 - (v - 255)) / 2 / 255;
        centered(sk, c, `res/Work${i}`, WORK_X[i], WORK_Y[i], k, k, a);
      }
    }

    // ---------- 上の帯・曲名・何曲目 ----------
    full(sk, c, 'res/Header');
    putText(c, this.title, 958, 100);
    this.drawSongCount(c);

    // ---------- パネル ----------
    full(sk, c, 'res/Panel0');
    const db = sk.pic('res/DifficultyBar');
    // 本家の参考動画に合わせた位置・大きさ（前より少し右・少し大きい）
    if (db) sk.blit(c, db, 0, clamp(d.course, 0, 4) * 50, 153, 50, 38, 160, 153 * 1.55, 50 * 1.55);
    this.drawGauge(c);
    this.drawCounts(c);
    if (t >= this.S) {
      this.drawBand(c);
      this.drawScore(c);
    }
    this.drawRank(c);
    this.drawCrown(c);
    this.drawChara(c);
    if (this.cleared && t >= M && d.gauge >= 80) this.drawFlowers(c);
    if (t >= M) this.drawBubble(c);
    sk.plate(c, { ...d.plate, wall: performance.now() }, P(28) + 6, P(621) - 443.5);
    this.drawCoin(c);
  }

  /**
   * 右上の何曲目: 帯は白と本家の灰色がかった青（右を斜めに切る）、字はプレイ画面と同じ丸ゴシック。
   * 一度だけ 2 倍の細かさで描いておく
   */
  private drawSongCount(c: CanvasRenderingContext2D) {
    const X = 1630, Y = 0, W = 290, H = 76, Z = 2;
    if (!this.songsCv) {
      const cv = document.createElement('canvas');
      cv.width = W * Z;
      cv.height = H * Z;
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(Z, 0, 0, Z, -X * Z, -Y * Z);
      const x0 = 1650, y0 = 15, x1 = 1906, y1 = 65, r = (y1 - y0) / 2;
      const path = () => {
        g.beginPath();
        g.moveTo(x0 + r, y0);
        g.lineTo(x1 - r, y0);
        g.arc(x1 - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
        g.lineTo(x0 + r, y1);
        g.arc(x0 + r, y0 + r, r, Math.PI / 2, Math.PI * 1.5);
        g.closePath();
      };
      // 下の影
      g.save();
      g.shadowColor = 'rgba(120,115,105,0.5)';
      g.shadowBlur = 4 * Z;
      g.shadowOffsetY = 4 * Z;
      g.fillStyle = '#fff';
      path();
      g.fill();
      g.restore();
      g.save();
      path();
      g.clip();
      g.fillStyle = '#fff';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      g.fillStyle = '#b9cbdb';
      g.beginPath();
      g.moveTo(1805, y0);
      g.lineTo(x1, y0);
      g.lineTo(x1, y1);
      g.lineTo(1788, y1);
      g.closePath();
      g.fill();
      g.restore();
      stageNums(g, this.d.stage, 1702, 1842, 43, 36, 6.75);
      g.lineJoin = 'round';
      g.strokeStyle = '#000';
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `34px 'TNDE Seurat', sans-serif`;
      g.lineWidth = 6.5;
      g.strokeText('曲目', 1745, 41);
      g.fillText('曲目', 1745, 41);
      g.font = `28px 'TNDE Seurat', sans-serif`;
      g.lineWidth = 5.5;
      g.strokeText('曲', 1863, 44);
      g.fillText('曲', 1863, 44);
      this.songsCv = cv;
    }
    c.drawImage(this.songsCv, X, Y, W, H);
  }

  /** 下のまん中の「0コイン」（黒い間も出しておく） */
  drawCoin(c: CanvasRenderingContext2D) {
    putText(c, this.coin, 970, 1055);
  }

  /**
   * ゲージ: 2 秒から 59ms ごとに 2% ずつ伸びる。満タンになったら虹（1/60 秒ごと）と魂の炎（33ms ごと）。
   * 位置は OpenTaiko と同じ（1280×720 の座標）
   */
  private drawGauge(c: CanvasRenderingContext2D) {
    const { sk, t, G, GS, GE } = this;
    full(sk, c, 'res/Gauge_Base', 1, 55, 140);
    const v = t < GS ? 0 : Math.min(G, Math.floor((t - GS) / 59));
    const g = sk.pic('res/Gauge');
    if (g && v > 0) sk.blit(c, g, 0, 0, 9.74 * v, 36, P(57), P(140), P(9.74 * v), P(36));
    const st = sk.pic('res/Soul_Text');
    const soulText = (cellI: number) => { if (st) sk.blit(c, st, cellI * 37, 0, 37, 37, P(575 - 18.5), P(159 - 18.5), P(37), P(37)); };
    if (v === 50 && t >= GE) {
      const u = t - GE;
      const n = sk.meta('res/Rainbow')?.n ?? 1;
      sk.anim(c, 'res/Rainbow', Math.floor(u / (1000 / 60)) % n, P(57), P(144));
      // 魂の炎（9 コマ目は何も出さない）
      const k = Math.floor(u / 33) % 9;
      const f = sk.pic('res/Result_Soul_Fire');
      if (f && k < 8) sk.blit(c, f, k * 150, 0, 150, 131, P(576 - 75), P(160 - 65.5), P(150), P(131));
      soulText(1);
      if (k % 2 === 0) soulText(2);
    } else {
      if (g) sk.blit(c, g, v < 40 ? 0 : 42, 35, 42, 20, P(441), P(142), P(42), P(20));
      soulText(v <= 30 ? 0 : 1);
    }
  }

  /** 良・可・不可・連打数・最大コンボ数（右寄せ。出るときに少し大きく） */
  private drawCounts(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    if (!sk.pic('res/Number')) return;
    const W = 355 / 11;
    const H = 40;
    const vals = [d.good, d.ok, d.bad, d.rolls, d.maxCombo];
    const ys = [209.3, 250.7, 292, 333.3, 374.7];
    // 1 つずつ 0.42 秒ごとに、1.3 倍から 0.135 秒で 1 倍に
    for (let k = 0; k < 5; k++) {
      const u = t - (this.A + 420 * k);
      if (u < 0) break;
      const pop = popOT(u);
      const ds = String(Math.max(0, vals[k])).split('').reverse();
      ds.forEach((ch, j) => cell(sk, c, 'res/Number', W * Number(ch), 0, W, H, 574 - 20.9 * j, ys[k], 0.967 * pop));
    }
  }

  /** スコア: 1.65 倍まで膨らんで 0.27 秒で戻り、少し沈んで 1 倍に（OpenTaiko と同じ） */
  private drawScore(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    const u = t - this.S;
    const k = u <= 270 ? 1 + Math.sin(rad(u / 1.5)) * 0.65 : u <= 360 ? 1 - Math.sin(rad(u - 270)) * 0.1 : 1;
    const ds = String(Math.max(0, Math.floor(d.score))).split('').reverse();
    ds.forEach((ch, j) => cell(sk, c, 'res/Score_Number', 51 * Number(ch), 0, 51, 60, 284.7 - 31.1 * j, 242, 0.967 * k));
  }

  /**
   * 「ベストスコア更新!」の帯: 上から金の帯が下りてきて（字はまだ無い）、字が出て黄色く光り、白い光が左から右へ流れる。
   * 時刻は数字が出てからの ms（参考動画で測った）
   */
  private drawBand(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    if (d.best === null) return;
    const u = t - this.tBand;
    if (u < 0) return;
    const im = sk.pic('res/BestScore');
    if (!im) return;
    const X = 75, Y = 274, BW = 288 * 1.5, BH = 29 * 1.5;
    // 帯（と差の数字）を 1 枚に描いておく
    let cv = this.bandCv;
    if (!cv) {
      cv = this.bandCv = document.createElement('canvas');
      cv.width = Math.ceil(BW);
      cv.height = Math.ceil(BH);
      const g = cv.getContext('2d')!;
      sk.blit(g, im, 0, 0, BW, BH);
      const tc = this.bestText;
      // 差の数字は黒い所の右（矢印の左）にそろえる（本家の参考動画で測った）
      if (tc && d.best > 0) g.drawImage(tc.cv, 462 - X - tc.tw - (tc.cv.width - tc.tw) / 2, 297 - Y - tc.cv.height / 2);
    }
    const slide = u < 150 ? 1 - u / 150 : 0;
    const a = clamp(u / 100);
    c.save();
    c.globalAlpha *= a;
    c.drawImage(cv, X, Y - 18 * slide * slide);
    // 字が出るまでは、字の所を金で隠す
    if (u < 300) {
      const hide = u < 250 ? 1 : 1 - (u - 250) / 50;
      const gr = c.createLinearGradient(X, Y, X + BW * 0.62, Y + BH);
      gr.addColorStop(0, '#fffbe0');
      gr.addColorStop(0.45, '#f7d23a');
      gr.addColorStop(1, '#d9a400');
      c.globalAlpha = a * hide;
      c.fillStyle = gr;
      c.beginPath();
      c.roundRect(X + 6, Y - 18 * slide * slide + 6, BW * 0.6, BH - 12, (BH - 12) / 2);
      c.fill();
    }
    c.restore();
    // 黄色く光る（字が出たところから 0.2 秒）
    const fl = u >= 270 && u < 470 ? 1 - (u - 270) / 200 : 0;
    if (fl > 0) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha *= fl * 0.85;
      const g2 = this.tint(cv, '#ffe600');
      c.drawImage(g2, X, Y);
      c.restore();
    }
    // 白い光が左から右へ（0.3 秒）
    const sw = u >= 520 && u < 820 ? (u - 520) / 300 : -1;
    if (sw >= 0) {
      const sx = X - 120 + (BW + 240) * sw;
      const m = this.tint(cv, '#ffffff', (g) => {
        g.globalCompositeOperation = 'destination-in';
        g.beginPath();
        g.moveTo(sx - X - 40, 0);
        g.lineTo(sx - X + 60, 0);
        g.lineTo(sx - X + 20, BH);
        g.lineTo(sx - X - 80, BH);
        g.closePath();
        g.fill();
      });
      c.drawImage(m, X, Y);
    }
  }

  private tintCv: HTMLCanvasElement | null = null;
  /** 絵の形のまま 1 色に塗った絵（clip で一部だけにもできる） */
  private tint(src: HTMLCanvasElement, col: string, clip?: (g: CanvasRenderingContext2D) => void) {
    const cv = (this.tintCv ??= document.createElement('canvas'));
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext('2d')!;
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = col;
    g.fillRect(0, 0, cv.width, cv.height);
    if (clip) {
      g.fillStyle = '#fff';
      clip(g);
    }
    return cv;
  }

  /** きらっと光る絵の段（0 = ふつう、1〜3 = 光） */
  private flash(base: number) {
    const v = this.t % 3000;
    const f = [base, base + 40, base + 80, base + 120, base + 160, base + 200, base + 240, base + 280];
    if ((v >= f[0] && v <= f[1]) || (v >= f[4] && v <= f[5])) return 1;
    if ((v >= f[1] && v <= f[2]) || (v >= f[5] && v <= f[6])) return 2;
    if ((v >= f[2] && v <= f[3]) || (v >= f[6] && v <= f[7])) return 3;
    return 0;
  }

  /**
   * 判子のように押す: 0.18 秒で薄い所から濃く、3.2 倍から 1 倍に縮む（OpenTaiko と同じ時間・式）。
   * そのあと 0.09 秒で少し沈んで戻る（深さは本家の動画で測った: ランク 0.9 倍・王冠 0.85 倍）
   */
  private stamp(u: number, dip: number) {
    if (u <= 180) return { k: 1 + Math.sin(rad((u + 90) / 1.5)) * 1.4, a: u / 180 };
    if (u <= 270) return { k: 1 - Math.sin(rad((u - 180) * 2)) * (1 - dip), a: 1 };
    return { k: 1, a: 1 };
  }

  /**
   * 押されるときの残像（本家の動画: 縮む間、少し前の大きさのものが薄く後ろに残る）。
   * 50ms 前・100ms 前の大きさで、薄く重ねる
   */
  private ghosts(u: number, draw: (k: number, a: number) => void) {
    if (u > 180) return;
    const a = u / 180;
    for (const [d, f] of [[100, 0.3], [50, 0.5]] as const) {
      const v = Math.max(-90, u - d);
      draw(1 + Math.sin(rad((v + 90) / 1.5)) * 1.4, a * f);
    }
  }

  private drawRank(c: CanvasRenderingContext2D) {
    if (this.rank <= 0 || this.t < this.tRank) return;
    const u = this.t - this.tRank;
    const sx = this.flash(1500) * 142, sy = (this.rank - 1) * 124;
    this.ghosts(u, (k, a) => cell(this.sk, c, 'res/ScoreRank', sx, sy, 142, 124, 133.3, 340.7, k, a));
    const { k, a } = this.stamp(u, 0.9);
    cell(this.sk, c, 'res/ScoreRank', sx, sy, 142, 124, 133.3, 340.7, k, a);
  }

  private drawCrown(c: CanvasRenderingContext2D) {
    if (this.d.crown === 'none' || this.t < this.tCrown) return;
    const u = this.t - this.tCrown;
    const sx = this.flash(2000) * 101, sy = { clear: 0, fc: 1, dfc: 2 }[this.d.crown] * 92;
    this.ghosts(u, (k, a) => cell(this.sk, c, 'res/Crown', sx, sy, 101, 92, 262.7, 339.3, k, a));
    const { k, a } = this.stamp(u, 0.85);
    cell(this.sk, c, 'res/Crown', sx, sy, 101, 92, 262.7, 339.3, k, a);
  }

  /** どんちゃん（数字が出るまではふつう、背景が変わったらクリア・失敗の動き）。本家の大きさ・位置で */
  private drawChara(c: CanvasRenderingContext2D) {
    const { sk, t, M } = this;
    const K = 1.04;
    const OX = -44;
    const OY = 393.3;
    // 元の絵（1280×720 の画面の絵）の位置を、どんちゃんの位置・大きさに合わせる
    const place = (name: string, i: number) => {
      const m = sk.meta(name);
      const fx = m?.x !== undefined ? (m.x + 4) * K + OX : OX;
      const fy = m?.y !== undefined ? (m.y - 409) * K + OY : OY;
      sk.anim(c, name, i, P(fx), P(fy), S * K);
    };
    const at = (name: string, ms: number, loop: boolean) => {
      const n = sk.meta(name)?.n ?? 1;
      const i = Math.floor(this.charaT / ms);
      return loop ? i % n : Math.min(n - 1, i);
    };
    // 1 コマ 1/60 秒（OpenTaiko の Result_Donchan と同じ。失敗は入りを 1 回、そのあとくり返し）
    const F = 1000 / 60;
    if (t < M) place('res/DonNormal', Math.floor(Math.max(0, t) / F) % (sk.meta('res/DonNormal')?.n ?? 1));
    else if (this.cleared) place('res/DonClear', at('res/DonClear', F, true));
    else {
      const n = sk.meta('res/DonFailed')?.n ?? 1;
      if (this.charaT < n * F) place('res/DonFailed', at('res/DonFailed', F, false));
      else place('res/DonFailedLoop', Math.floor((this.charaT - n * F) / F) % (sk.meta('res/DonFailedLoop')?.n ?? 1));
    }
  }

  private drawFlowers(c: CanvasRenderingContext2D) {
    const { sk, t, M } = this;
    const pop = popOT(t - M);
    const fl = sk.meta('res/Flower');
    if (fl) cell(sk, c, 'res/Flower', 0, 0, fl.w, fl.h / 2, 168, 582, 0.9 * pop);
    const ft = t % 1500;
    for (let i = 0; i < 5; i++) {
      const s0 = FLOWER_AT[i];
      let a: number;
      if (ft < s0 || ft > s0 + 2 * 100 + 300) a = 0;
      else if (ft >= s0 + 100 && ft <= s0 + 400) a = 1;
      else a = (ft >= s0 + 400 ? 100 - (ft - s0 - 400) : ft - s0) / 100;
      if (a <= 0) continue;
      const im = sk.pic(`res/FlowerR${i + 1}`);
      const m = sk.meta(`res/FlowerR${i + 1}`);
      if (!im || !m) continue;
      c.save();
      c.globalAlpha *= a;
      // 花の位置は大きい桜に合わせて 1.5 倍に広げる
      c.translate(P(168 + (FLOWER_X[i] - 182) * 1.5), P(582 + (FLOWER_Y[i] - 602) * 1.5));
      c.rotate((ft - s0) / (FLOWER_SPEED[i] * 360));
      sk.blit(c, im, P(-m.w * 0.45), P(-m.h * 0.45), P(m.w * 0.9), P(m.h * 0.9));
      c.restore();
    }
    // パネルのきらめき
    const st = t % 1000;
    const q = st % 500;
    for (let i = 0; i < 6; i++) {
      if ((i < 3) !== (st < 500)) continue;
      const a = q >= 100 && q <= 400 ? 1 : Math.min(q, 500 - q) / 100;
      centered(sk, c, 'res/Shine', 168 + (PSHINE_X[i] - 182) * 1.5, 582 + (PSHINE_Y[i] - 602) * 1.5, 0.2, 0.2, a);
    }
  }

  private drawBubble(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    const pop = popOT(t - this.M);
    const mood = d.gauge >= 100 ? 3 : d.gauge >= 80 ? 2 : d.gauge >= 40 ? 1 : 0;
    const w = 1339 / 4;
    const h = 644 / 3;
    cell(sk, c, 'res/Speech_Bubble', mood * w, this.textRow * h, w, h, 443.5, 529.5, pop);
  }
}

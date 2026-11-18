/**
 * TNDE スキンの、曲の読み込み画面とリザルト画面（本家・TJAPlayer3 系と同じ動き）。
 * 座標は 1280×720 の単位（スキンの絵の大きさ）で書き、描くときに 1.5 倍して 1920×1080 に置く。
 * 動きの時間・位置は TJAPlayer3 系（OpenTaiko）の作りと、本家の参考動画で測った値
 */
import type { TndeSkin, PlateStyle } from './tnde';

const S = 1.5;
/** 曲名の字（大江戸勘亭流） */
const KANTEI = `'TNDE Kantei', 'TNDE Seurat', sans-serif`;
const P = (v: number) => v * S;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const rad = (deg: number) => (deg * Math.PI) / 180;

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
  /** 始まってからの時間（ms） */
  t = 0;
  private played = new Set<string>();
  private gaugeSnd: { stop(): void } | null = null;
  private title: ReturnType<typeof textCanvas>;
  private songCount: ReturnType<typeof textCanvas>[];
  private bestText: ReturnType<typeof textCanvas> | null;
  private coin: ReturnType<typeof textCanvas>;
  private readonly G: number;
  private readonly A: number;
  private readonly SC: number;
  private readonly M: number;
  private readonly rank: number;
  private readonly cleared: boolean;
  private readonly textRow = Math.floor(Math.random() * 3);
  /** 切り替わってからの時間（どんちゃんの動き） */
  private charaT = 0;

  constructor(private readonly sk: TndeSkin, private readonly d: TndeResultData, private readonly sound: (n: ResultSound) => { stop(): void } | null) {
    this.G = Math.floor(clamp(d.gauge, 0, 100) / 2);
    this.A = 3000 + this.G * 59;
    this.SC = this.A + 420 * 4 + 840;
    this.M = 10275 + 66 * this.G;
    this.cleared = d.gauge >= d.clearLine;
    const ranks = [500000, 600000, 700000, 800000, 900000, 950000, 1000000];
    this.rank = ranks.filter((r) => d.score >= r).length;
    // 曲名は勘亭流（プレイ画面と同じ字）
    this.title = textCanvas(d.title, 52, P(660), '#fff', '#000', 14, KANTEI);
    // 何曲目: 黒い字に白い縁（参考動画で測った大きさ）
    this.songCount = [textCanvas(String(Math.max(1, d.stage)), 36, 999, '#111', '#fff', 5, KANTEI), textCanvas('∞', 28, 999, '#111', '#fff', 5, KANTEI)];
    this.coin = textCanvas('0コイン', 38, 999, '#fff', '#000', 10, KANTEI);
    this.bestText = d.best !== null ? textCanvas(`${d.best}`, 26, 999, '#fff', 'rgba(0,0,0,0)', 0) : null;
  }

  /** 動きが全部終わったか */
  get done() {
    return this.t >= Math.max(this.SC + 2800, this.M + 600);
  }

  /** 叩いたら、途中を飛ばして山が出るところへ */
  skip() {
    if (this.t >= this.M) return false;
    for (const k of ['g', 'p0', 'p1', 'p2', 'p3', 'p4', 'sc', 'rk', 'cr']) this.played.add(k);
    this.gaugeSnd?.stop();
    this.gaugeSnd = null;
    this.t = this.M;
    return true;
  }

  private once(key: string, at: number, f: () => void) {
    if (this.t >= at && !this.played.has(key)) {
      this.played.add(key);
      f();
    }
  }

  private sounds() {
    const { t } = this;
    this.once('g', 2000, () => { this.gaugeSnd = this.sound('resGauge'); });
    // ゲージが伸び終わったら止める（満タンまで行ったときは鳴らしきる）
    if (this.gaugeSnd && t >= 2000 + this.G * 59 && this.G < 50) {
      this.gaugeSnd.stop();
      this.gaugeSnd = null;
    }
    for (let k = 0; k < 5; k++) this.once(`p${k}`, this.A + 420 * k, () => this.sound('resPom'));
    this.once('sc', this.SC, () => this.sound(this.d.best !== null ? 'best' : 'resPom'));
    if (this.rank > 0) this.once('rk', this.SC + 1180, () => this.sound('rankIn'));
    if (this.d.crown !== 'none') {
      const n = ({ clear: 'crownClear', fc: 'crownFc', dfc: 'crownDfc' } as const)[this.d.crown];
      this.once('cr', this.SC + 2680, () => this.sound(n));
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
    const clearF = this.cleared && mtOn ? clamp(((t - M) * 3) / 255) : 0;

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
    full(sk, c, 'res/SongCount');
    const sc = sk.meta('res/SongCount');
    if (sc) {
      putText(c, this.songCount[0], 1686, 41);
      putText(c, this.songCount[1], 1831, 46);
    }

    // ---------- パネル ----------
    full(sk, c, 'res/Panel0');
    const db = sk.pic('res/DifficultyBar');
    if (db) sk.blit(c, db, 0, clamp(d.course, 0, 4) * 50, 153, 50, P(27), P(102), P(153), P(50));
    this.drawGauge(c);
    this.drawCounts(c);
    this.drawScore(c);
    this.drawRank(c);
    this.drawCrown(c);
    this.drawChara(c);
    if (mtOn && d.gauge >= 80) this.drawFlowers(c);
    if (mtOn) this.drawBubble(c);
    sk.plate(c, { ...d.plate, wall: performance.now() }, P(28) + 6, P(621) - 443.5);
    this.drawCoin(c);
  }

  /** 下のまん中の「0コイン」（黒い間も出しておく） */
  drawCoin(c: CanvasRenderingContext2D) {
    putText(c, this.coin, 970, 1055);
  }

  private drawGauge(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    full(sk, c, 'res/Gauge_Base', 1, 55, 140);
    if (t < 2000) {
      // ゲージが伸び始めるまでも、暗い「魂」は出しておく
      const st0 = sk.pic('res/Soul_Text');
      if (st0) sk.blit(c, st0, 0, 0, 37, 37, P(575 - 18.5), P(159 - 18.5), P(37), P(37));
      return;
    }
    const seg = Math.min(this.G, Math.floor((t - 2000) / 59));
    const pct = seg * 2;
    const g = sk.pic('res/Gauge');
    if (g && pct > 0) sk.blit(c, g, 0, 0, (487 * pct) / 100, 36, P(57), P(140), P((487 * pct) / 100), P(36));
    const full100 = seg >= 50;
    if (full100) {
      const n = sk.meta('res/Rainbow')?.n ?? 1;
      sk.anim(c, 'res/Rainbow', Math.floor((t - 2000 - 50 * 59) / (1000 / 60)) % n, P(57), P(144));
    }
    const lit = pct >= d.clearLine;
    if (g) sk.blit(c, g, lit ? 42 : 0, 35, 42, 20, P(441), P(142), P(42), P(20));
    // 魂: 満タンなら炎も
    if (full100) {
      const f = sk.pic('res/Result_Soul_Fire');
      if (f) {
        const k = Math.floor(t / 33) % 8;
        sk.blit(c, f, k * 150, 0, 150, 131, P(576 - 75), P(160 - 65.5), P(150), P(131));
      }
    }
    const st = sk.pic('res/Soul_Text');
    if (st) sk.blit(c, st, (full100 ? 2 : lit ? 1 : 0) * 37, 0, 37, 37, P(575 - 18.5), P(159 - 18.5), P(37), P(37));
  }

  /** 良・可・不可・連打数・最大コンボ数（右寄せ。出るときに 1.3 倍から縮む） */
  private drawCounts(c: CanvasRenderingContext2D) {
    const { sk, t, d } = this;
    const im = sk.pic('res/Number');
    if (!im) return;
    const W = 355 / 11;
    const H = 40;
    const vals = [d.good, d.ok, d.bad, d.rolls, d.maxCombo];
    const ys = [188, 230, 272, 314, 356];
    for (let k = 0; k < 5; k++) {
      const at = this.A + 420 * k;
      if (t < at) break;
      const pop = t <= at + 135 ? 1.3 - Math.sin(rad((t - at) / (135 / 90))) * 0.3 : 1;
      const ds = String(Math.max(0, vals[k])).split('').reverse();
      ds.forEach((ch, j) => {
        const cx = 490 - 22 * j + W * 2 + W / 2;
        cell(sk, c, 'res/Number', W * Number(ch), 0, W, H, cx, ys[k] + H / 2, pop);
      });
    }
  }

  private drawScore(c: CanvasRenderingContext2D) {
    const { sk, t, d, SC } = this;
    if (t < SC) return;
    const u = t - SC;
    const k = u <= 270 ? 1 + Math.sin(rad(u / 1.5)) * 0.65 : u <= 360 ? 1 - Math.sin(rad(u - 270)) * 0.1 : 1;
    if (d.best !== null) {
      full(sk, c, 'res/BestScore', 1, 50, 183);
      if (this.bestText && d.best > 0) {
        const tc = this.bestText;
        c.save();
        c.drawImage(tc.cv, P(313) - tc.tw - (tc.cv.width - tc.tw) / 2, P(197.5) - tc.cv.height / 2);
        c.restore();
      }
    }
    const ds = String(Math.max(0, Math.floor(d.score))).split('').reverse();
    ds.forEach((ch, j) => cell(sk, c, 'res/Score_Number', 51 * Number(ch), 0, 51, 60, 295 - 33 * j, 212 + 30, k));
  }

  /** 出るときの動き（大きく → 縮んで → 戻る）。at = 出始め */
  private stamp(at: number) {
    const u = this.t - at;
    if (u < 0) return null;
    if (u <= 180) return { a: u / 180, k: 1 + Math.sin(rad((u + 90) / 1.5)) * 1.4 };
    if (u <= 270) return { a: 1, k: 0.5 + Math.sin(rad(u - 180)) * 0.5 };
    return { a: 1, k: 1 };
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

  private drawRank(c: CanvasRenderingContext2D) {
    if (this.rank <= 0) return;
    const s = this.stamp(this.SC + 1000);
    if (!s) return;
    cell(this.sk, c, 'res/ScoreRank', this.flash(1500) * 142, (this.rank - 1) * 124, 142, 124, 135, 339, s.k, s.a);
  }

  private drawCrown(c: CanvasRenderingContext2D) {
    if (this.d.crown === 'none') return;
    const s = this.stamp(this.SC + 2500);
    if (!s) return;
    const row = { clear: 0, fc: 1, dfc: 2 }[this.d.crown];
    cell(this.sk, c, 'res/Crown', this.flash(2000) * 101, row * 92, 101, 92, 262, 336, s.k, s.a);
  }

  /** どんちゃん（山が出るまではふつう、出たらクリア・失敗の動き） */
  private drawChara(c: CanvasRenderingContext2D) {
    const { sk, t, M } = this;
    const at = (name: string, ms: number, loop: boolean) => {
      const n = sk.meta(name)?.n ?? 1;
      const i = Math.floor(this.charaT / ms);
      return loop ? i % n : Math.min(n - 1, i);
    };
    if (t < M) {
      sk.anim(c, 'res/DonNormal', Math.floor(t / 36) % (sk.meta('res/DonNormal')?.n ?? 1), P(-4), P(409));
    } else if (this.cleared) {
      sk.anim(c, 'res/DonClear', at('res/DonClear', 33, true), P(-4), P(409));
    } else {
      const n = sk.meta('res/DonFailed')?.n ?? 1;
      const m = sk.meta('res/DonFailed');
      if (this.charaT < n * 33) sk.anim(c, 'res/DonFailed', at('res/DonFailed', 33, false), P(m?.x ?? 0), P(m?.y ?? 0));
      else {
        const L = sk.meta('res/DonFailedLoop');
        const ln = L?.n ?? 1;
        sk.anim(c, 'res/DonFailedLoop', Math.floor((this.charaT - n * 33) / 66) % ln, P(L?.x ?? 0), P(L?.y ?? 0));
      }
    }
  }

  private drawFlowers(c: CanvasRenderingContext2D) {
    const { sk, t, M } = this;
    const u = t - M;
    const pop = u <= 135 ? 1.3 - Math.sin(rad(u / (135 / 90))) * 0.3 : 1;
    const fl = sk.meta('res/Flower');
    if (fl) cell(sk, c, 'res/Flower', 0, 0, fl.w, fl.h / 2, 182, 602, 0.6 * pop);
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
      c.translate(P(FLOWER_X[i]), P(FLOWER_Y[i]));
      c.rotate((ft - s0) / (FLOWER_SPEED[i] * 360));
      sk.blit(c, im, P(-m.w * 0.3), P(-m.h * 0.3), P(m.w * 0.6), P(m.h * 0.6));
      c.restore();
    }
    // パネルのきらめき
    const st = t % 1000;
    const q = st % 500;
    for (let i = 0; i < 6; i++) {
      if ((i < 3) !== (st < 500)) continue;
      const a = q >= 100 && q <= 400 ? 1 : Math.min(q, 500 - q) / 100;
      centered(sk, c, 'res/Shine', PSHINE_X[i], PSHINE_Y[i], 0.15, 0.15, a);
    }
  }

  private drawBubble(c: CanvasRenderingContext2D) {
    const { sk, t, M, d } = this;
    const u = t - M;
    const pop = u <= 135 ? 1.3 - Math.sin(rad(u / (135 / 90))) * 0.3 : 1;
    const mood = d.gauge >= 100 ? 3 : d.gauge >= 80 ? 2 : d.gauge >= 40 ? 1 : 0;
    const w = 1339 / 4;
    const h = 644 / 3;
    cell(sk, c, 'res/Speech_Bubble', mood * w, this.textRow * h, w, h, 430, 526, 0.9 * pop);
  }
}

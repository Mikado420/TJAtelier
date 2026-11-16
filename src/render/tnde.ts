import type { Course, Note } from '../chart/types';
import { CLEAR_LINE, type Game, type HitKind, type Judge } from '../engine/game';

/**
 * TNDE スキン（TaikoNijiiroDondaEX Ver4.1 用スキン）のプレイ画面。
 * 座標は 1920×1080 の画面の px。TNDE（TJAPlayer3 系）は 1280×720 で配置を決めているので、
 * その値（参考動画で測って確かめた）を 1.5 倍して使う。重ねる順・演出の速さも TJAPlayer3 と同じにしている
 */
export const TW = 1920;
export const TH = 1080;
const S = 1.5;
/** 1280×720 の値を 1920×1080 に */
const P = (v: number) => v * S;

/** 判定枠の中心の x（音符が判定される位置）。参考動画では 619 */
export const TJX = 619;
/** 判定枠・音符の上の端と、演出の中心の y */
const FIELD_Y = P(192);
const JUDGE_Y = P(256);
/** ハイスピード 1.0・4/4 で 1 小節が流れる距離 */
export const T_MEASURE = 1424;
const LANE_X = P(332);
const NOTE = P(130);
const HALF = NOTE / 2;

interface ImgInfo { f: string; w: number; h: number }
interface AnimInfo { f: string; w: number; h: number; n: number; cols: number; step: number }
interface Manifest { img: Record<string, ImgInfo>; anim: Record<string, AnimInfo> }

export interface TndeFx {
  bursts: { t: number; judge: Judge; big: boolean }[];
  flyers: { t: number; note: Note }[];
  flashes: { t: number; kind: HitKind; side: 'L' | 'R' }[];
  judgeFx: { judge: Judge; t: number } | null;
  rollFx: { count: number; t: number; balloon: boolean; hits: number } | null;
  rainbow: number | null;
  comboPop: number;
  gogoStart: number;
}

/** 曲の情報（ジャンルの帯は曲のフォルダ、stage は曲えらびから何曲目か） */
/** ネームプレートの見た目 */
export interface PlateStyle {
  /** 称号の帯: 木・金・紫、色を指定した金・紫 */
  titleStyle: 'wood' | 'gold' | 'purple' | 'goldc' | 'purplec';
  titleColor: string;
  danOn: boolean;
  /** 段位（3 文字まで） */
  dan: string;
  danFrame: 'silver' | 'gold' | 'rainbow';
  /** 赤合格 = 白い字、金合格 = 金の字 */
  danPass: 'red' | 'gold';
}
export const DEFAULT_PROFILE: PlateStyle = { titleStyle: 'purple', titleColor: '#2e9bff', danOn: false, dan: '初段', danFrame: 'gold', danPass: 'red' };

/** 称号の字の色（紫の帯は濃い紫、木・金は焦げ茶、色を指定した帯はその色をうんと暗く） */
function titleInk(p: PlateStyle) {
  if ((p.titleStyle === 'goldc' || p.titleStyle === 'purplec') && /^#[0-9a-f]{6}$/i.test(p.titleColor)) return shade(p.titleColor, 0.2);
  return p.titleStyle === 'purple' || p.titleStyle === 'purplec' ? '#220432' : '#2a1400';
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60) + 360) % 360, mx ? d / mx : 0, mx];
}
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}

export interface TndeInfo {
  title: string;
  course: string;
  level: number;
  genre?: string;
  folder?: { name: string; color: string; custom: boolean };
  stage?: number;
}

export interface TndeFrame {
  /** 動画用の画面: レーンと左のパネルだけ描く（背景・ゲージ・キャラ・曲名は描かない） */
  laneOnly?: boolean;
  /** 背景の動画（画像）を出している所: full = 全面（上下の背景を描かない）、bottom = 下だけ（下の背景・踊り子・モブを描かない） */
  bgMode?: '' | 'full' | 'bottom';
  game: Game;
  course: Course;
  now: number;
  wall: number;
  info: TndeInfo;
  /** 判定枠からの距離（4 分音符の数 × ハイスピード） */
  adv: (time: number, beat: number | undefined, n: { bpm: number; scroll: number }) => number;
  advY: (time: number, beat: number | undefined, n: { bpm: number; scrollY?: number }) => number;
  jpos: number;
  labels: (n: Note) => string | undefined;
  fx: TndeFx;
  name: string;
  title: string;
  /** ネームプレートの見た目（称号の帯・段位） */
  profile?: PlateStyle;
}

/** SENotes.png の行 */
const SE_ROW: Record<string, number> = { ドン: 0, ド: 1, コ: 2, カッ: 3, カ: 4, 'ドン(大)': 5, 'カッ(大)': 6, 連打: 7, '連打(大)': 10, ふうせん: 11 };
/** Notes.png の列（130px ごと） */
const NOTE_COL: Record<string, number> = { don: 1, ka: 2, bigDon: 3, bigKa: 4, roll: 5, bigRoll: 8, balloon: 11 };
const COURSE_IMG: Record<string, string> = { Easy: 'course/Easy', Normal: 'course/Normal', Hard: 'course/Hard', Oni: 'course/Oni', Edit: 'course/Edit' };
/** 字の無いジャンルの帯の色（字の縁の色を決める） */
const GENRE_COL: Record<string, string> = { 1: '#43bfd4', 2: '#ff90d3', 3: '#cd8aed', 4: '#2ae23e', 5: '#ff7029', 6: '#ddac04', 7: '#ffbf00', 8: '#cdcfdd' };
const GENRES: [RegExp, string][] = [
  [/ポップ|pop/i, '1'], [/アニメ|anime/i, '2'], [/ゲーム|game/i, '3'], [/ボーカロイド|ボカロ|vocaloid/i, '8'], [/キッズ|どうよう|kids/i, '7'],
  [/バラエティ|variety/i, '4'], [/クラシック|classic/i, '6'], [/ナムコ|オリジナル|original/i, '5'],
];

/** 踊り子 1（3 人で 1 枚）の動き: [絵の番号, 長さ（16 分の数）]。16 拍で 1 回り（参考動画で数えた） */
const DANCE_A: [number, number][] = [[0, 2], [1, 2], [2, 2], [1, 2], [0, 2], [1, 2], [2, 1], [2, 1], [4, 1], [5, 1], [6, 2], [7, 2], [8, 2], [7, 2], [6, 2], [7, 2], [8, 2], [5, 2]];
const DANCE_B = [10, 11, 3, 11, 10, 11, 3, 11, 10, 13, 14, 15, 14, 13, 14, 15, 14, 13];

/** 点数・コンボ・連打数が増えたときの縦の伸び（TJAPlayer3 と同じ表） */
const SCORE_SCALE = [1, 1.111, 1.222, 1.185, 1.148, 1.129, 1.111, 1.074, 1.065, 1.033, 1.015, 1];
const COMBO_SCALE = [0, 0.072, 0.17, 0.146, 0.108, 0.096, 0.084, 0.066, 0.044, 0.033, 0.022, 0.011, 0];
const COMBO_SCALE_EX = [0, 0.072, 0.2, 0.16, 0.13, 0.1, 0.084, 0.076, 0.044, 0.033, 0.022, 0.011, 0];
const ROLL_SCALE = [0, 0.123, 0.164, 0.164, 0.164, 0.137, 0.11, 0.082, 0.055, 0];
/** ゴーゴーの始まりの炎の大きさ（18 ms ごと） */
const FIRE_SCALE = [0.8, 1.2, 1.7, 2.5, 2.3, 2.2, 2.0, 1.8, 1.7, 1.6, 1.6, 1.5, 1.5, 1.4, 1.3, 1.2, 1.1, 1.0];
/** ゴーゴーの始まりに下から噴き上がる光（1280×720 の、下の真ん中の位置と傾き） */
/** モブの跳ねる拍のずれ（参考動画で測った） */
const MOB_PHASE = 0.17;
/** クリアの背景を測ったときの曲の時刻（魔宵月の動画の 96 秒） */
const CLEAR_T0 = 82.398;
/** クリアの背景の松と梅: [部品, 動画の 96 秒での x, y, 部品の幅（1280×720）] */
const CLEAR_DECO: [string, number, number, number][] = [
  ['657_727', 107, 560, 131], ['238_798', 231.5, 700, 72], ['0_1346', 310.5, 734, 64], ['358_759', 411.5, 642, 120],
  ['1130_785', 480, 690, 74], ['592_820', 763, 733, 64], ['0_1346', 852, 790, 64], ['657_727', 858.5, 593, 131],
  ['782_821', 1049, 734, 64], ['845_720', 1143, 583, 95], ['782_821', 1364, 895, 64], ['657_727', 1467, 778, 131],
  ['657_727', 1616, 548, 131], ['782_821', 1634, 880, 64], ['238_798', 1789, 676, 72], ['0_757', 1794.5, 639, 114],
  ['657_727', 1876, 786, 131],
];
/** 連打のキャラが出てくる x（1280×720） */
const ROLL_X = [56, -10, 200, 345, 100, 451, 600, 260, -30, 534, 156, 363];
const SPLASH = [[80, 740, -0.2793], [300, 730, -0.1396], [520, 720, 0], [760, 720, 0], [980, 730, 0.1396], [1160, 740, 0.2793]];

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** 時刻 t0 から何コマ目か（1 コマ ms ミリ秒） */
const step = (wall: number, t0: number, ms: number) => Math.floor((wall - t0) / ms);

export class TndeSkin {
  /** 読み込んだ絵（ImageBitmap にして、描くたびに読み直されないようにする。作れなかったときだけ img） */
  private imgs = new Map<string, ImageBitmap | HTMLImageElement>();
  private loading = new Map<string, Promise<ImageBitmap | HTMLImageElement | null>>();
  private man!: Manifest;
  ready = false;
  private beatTab: { course: Course; cum: number[] } | null = null;
  /** 曲ごとに決める背景（上・下）と踊り子 */
  private pick = { up: 2, down: 5, dancer: 1, key: '' };
  /** 読み込んである絵の組（背景・踊り子） */
  private loadedSet = '';

  constructor(private readonly base: string) {}

  static async load(base: string, title?: string) {
    const s = new TndeSkin(base);
    const r = await fetch(`${base}skin.json`);
    if (!r.ok) throw new Error('skin.json');
    s.man = await r.json();
    // プレイ画面の字: 曲名・称号・名前は勘亭流、ジャンル・曲目は丸ゴシック
    await Promise.all(
      [['TNDE Seurat', 'FOT-Seurat_Pro_B.otf'], ['TNDE Kantei', 'FOT-OedoKtr.otf']].map(async ([name, file]) => {
        try {
          const ff = new FontFace(name, `url(${base}${file})`);
          document.fonts.add(ff);
          // 字の読み込みは 10 秒まで待つ（来なければ、届いたときから使う）
          await Promise.race([ff.load(), new Promise((r) => setTimeout(r, 10000))]);
        } catch { /* 字が無くても描ける */ }
      }),
    );
    if (title !== undefined) s.choose(title);
    await s.sync();
    s.ready = true;
    return s;
  }

  /** 曲を始める前に、その曲で使う絵を読み込んでおく */
  async prepare(title: string) {
    this.choose(title);
    await this.sync();
  }

  /** 今の曲で使う絵か（背景・踊り子・ゲージは曲や難易度ごとに 1 組だけ使う） */
  private wants(name: string) {
    const p = this.pick;
    // 曲が決まるまでは、曲ごとに変わる絵（背景・踊り子・モブ）は読み込まない
    if (!p.key && !this.force && /^(bg\/Bg_(up|down)\/|dancer\/Normal1$|mob$)/.test(name)) return false;
    let m = /^bg\/Bg_up\/([^/]+)\//.exec(name);
    if (m) return m[1] === String(p.up);
    m = /^bg\/Bg_down\/([^/]+)\//.exec(name);
    if (m) return m[1] === String(p.down);
    if (/^gauge\/(base|fill|rainbow)\d$/.test(name)) return name.endsWith('3');
    if (/^footer\d$/.test(name)) return name === 'footer1';
    if (name === 'dancer/In1') return false;
    if (name === 'dancer/Normal1') return p.dancer === 1;
    if (name === 'mob') return p.down !== 5;
    if (/^genre\/\d$/.test(name)) return false;
    return true;
  }

  /** 使う絵を読み込み、使わない絵を手放す */
  private sync() {
    const set = `${this.pick.key ? '' : '-'}${this.pick.up}|${this.pick.down}|${this.pick.dancer}`;
    const names = [...Object.keys(this.man.img), ...Object.keys(this.man.anim)];
    if (set !== this.loadedSet) {
      this.loadedSet = set;
      for (const n of names) {
        if (this.wants(n)) continue;
        const im = this.imgs.get(n);
        if (im && 'close' in im) im.close();
        this.imgs.delete(n);
        this.loading.delete(n);
      }
      this.dropCaches();
    }
    return Promise.all(names.filter((n) => this.wants(n)).map((n) => this.fetchImg(n))).then(() => {});
  }

  private fetchImg(name: string) {
    let p = this.loading.get(name);
    if (p) return p;
    const info = this.man.img[name] ?? this.man.anim[name];
    if (!info) return Promise.resolve(null);
    const url = this.base + info.f;
    p = this.queue(() => loadBitmap(url)).then((v) => {
      if (!v) {
        // 読み込めなかった絵は、次にまた読み込み直せるようにしておく
        if (this.loading.get(name) === p) this.loading.delete(name);
        return null;
      }
      if (this.loading.get(name) !== p) { if ('close' in v) v.close(); return null; }
      this.imgs.set(name, v);
      return v;
    });
    this.loading.set(name, p);
    return p;
  }

  private img(name: string) {
    return this.imgs.get(name) ?? null;
  }

  /** 一度に読み込む絵の数をしぼる（iPhone は一度にたくさん頼むと止まりやすい） */
  private running = 0;
  private waiting: (() => void)[] = [];
  private queue<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((res, rej) => {
      const go = () => {
        this.running++;
        job().then(res, rej).finally(() => {
          this.running--;
          this.waiting.shift()?.();
        });
      };
      if (this.running < 6) go();
      else this.waiting.push(go);
    });
  }

  /** 絵を 1.5 倍で貼る（sx..sh は絵の中の範囲、x, y は左上） */
  private put(c: CanvasRenderingContext2D, name: string, x: number, y: number, sx = 0, sy = 0, sw?: number, sh?: number, kx = S, ky = kx) {
    const im = this.img(name);
    if (!im) return;
    const w = sw ?? im.width - sx;
    const h = sh ?? im.height - sy;
    if (w <= 0 || h <= 0) return;
    c.drawImage(im, sx, sy, w, h, x, y, w * kx, h * ky);
  }

  /** 絵の範囲を、(cx, cy) を中心に k 倍（1.5 倍の上にさらに）で貼る */
  private putC(c: CanvasRenderingContext2D, name: string, cx: number, cy: number, sx: number, sy: number, sw: number, sh: number, k = 1) {
    const w = sw * S * k;
    const h = sh * S * k;
    this.put(c, name, cx - w / 2, cy - h / 2, sx, sy, sw, sh, S * k);
  }

  /** 連番の絵の n 番目 */
  private frame(c: CanvasRenderingContext2D, name: string, n: number, x: number, y: number, k = S) {
    const a = this.man.anim[name];
    const im = this.img(name);
    if (!a || !im) return;
    const i = Math.max(0, Math.min(a.n - 1, Math.floor(n)));
    c.drawImage(im, (i % a.cols) * a.w, Math.floor(i / a.cols) * a.h, a.w, a.h, x, y, a.w * k, a.h * k);
  }

  private count(name: string) {
    return this.man.anim[name]?.n ?? 1;
  }

  /**
   * 動かない絵をまとめて 1 枚の絵にしておき、毎フレームはそれを貼るだけにする（見た目は同じで、塗る量が減る）。
   * x, y, w, h は 1920×1080 の座標。絵の細かさは今の拡大率に合わせ、key か拡大率が変わったら描き直す
   */
  private caches = new Map<string, { key: string; cv: HTMLCanvasElement }>();
  /** parts: まとめた絵のうち、この範囲（[x, y, w, h] のいくつか）だけを貼る */
  private cached(c: CanvasRenderingContext2D, id: string, key: string, x: number, y: number, w: number, h: number, paint: (g: CanvasRenderingContext2D) => void, parts?: number[][]) {
    const t = c.getTransform();
    const k = Math.hypot(t.a, t.b);
    const full = `${key}|${k.toFixed(4)}`;
    let e = this.caches.get(id);
    if (!e || e.key !== full) {
      const cv = e?.cv ?? document.createElement('canvas');
      cv.width = Math.max(1, Math.ceil(w * k));
      cv.height = Math.max(1, Math.ceil(h * k));
      const g = cv.getContext('2d');
      // 絵のメモリが足りないとき（iPhone は canvas の合計に上限がある）は、まとめずにそのまま描く
      if (!g) {
        cv.width = cv.height = 0;
        this.caches.delete(id);
        c.save();
        if (parts) { c.beginPath(); for (const [px, py, pw, ph] of parts) c.rect(px, py, pw, ph); c.clip(); }
        paint(c);
        c.restore();
        return;
      }
      g.setTransform(k, 0, 0, k, -x * k, -y * k);
      g.clearRect(x, y, w, h);
      g.imageSmoothingEnabled = true;
      paint(g);
      e = { key: full, cv };
      this.caches.set(id, e);
    }
    if (!parts) { c.drawImage(e.cv, x, y, w, h); return; }
    const sx = e.cv.width / w;
    const sy = e.cv.height / h;
    for (const [px, py, pw, ph] of parts) c.drawImage(e.cv, (px - x) * sx, (py - y) * sy, pw * sx, ph * sy, px, py, pw, ph);
  }

  /** まとめた絵を手放す（iPhone はキャンバスの大きさを 0 にしないとメモリがすぐ空かない） */
  dropCaches() {
    for (const e of this.caches.values()) {
      e.cv.width = 0;
      e.cv.height = 0;
    }
    this.caches.clear();
    this.tinted.clear();
  }

  /** 足し算で重ねる（光の演出） */
  private add(c: CanvasRenderingContext2D, alpha: number, f: () => void) {
    if (alpha <= 0) return;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = Math.min(1, alpha);
    f();
    c.restore();
  }

  private alpha(c: CanvasRenderingContext2D, alpha: number, f: () => void) {
    if (alpha <= 0) return;
    if (alpha >= 1) { f(); return; }
    c.save();
    c.globalAlpha = alpha;
    f();
    c.restore();
  }

  /** 曲の始めからの拍の数（BPM が変わっても続けて数える） */
  private beatOf(course: Course, now: number) {
    const bars = course.bars;
    if (!bars.length) return now * 2;
    if (this.beatTab?.course !== course) {
      const cum = [0];
      for (let i = 1; i < bars.length; i++) cum.push(cum[i - 1] + ((bars[i].time - bars[i - 1].time) * bars[i - 1].bpm) / 60);
      this.beatTab = { course, cum };
    }
    const cum = this.beatTab.cum;
    if (now < bars[0].time) return ((now - bars[0].time) * bars[0].bpm) / 60;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bars[m].time <= now) lo = m;
      else hi = m - 1;
    }
    return cum[lo] + ((now - bars[lo].time) * bars[lo].bpm) / 60;
  }

  /** 上の背景の流れのずらし（px。見比べ用） */
  bgPhase = 0;

  /** 背景・踊り子を決める（指定しなければ曲名で決まる） */
  force: { up: number; down: number; dancer: number } | null = null;

  private choose(title: string) {
    if (this.force) { this.pick = { ...this.force, key: '' }; return; }
    if (this.pick.key === title) return;
    const h = hash(title);
    this.pick = { key: title, up: [2, 3][h % 2], down: [1, 2, 4, 5][(h >>> 3) % 4], dancer: (h >>> 7) % 2 ? 1 : 2 };
  }

  // ---------- 状態の変わり目 ----------

  private last = { combo: 0, gauge: 0, gogo: false, score: 0, roll: 0, balloon: 0, popped: -1 };
  /** どんちゃんの 1 回だけの動き。beats = 何拍で終わるか（風船は ms） */
  private charaOnce: { name: string; t: number; ms: number } | null = null;
  /** 風船が終わってから、ふだんの動きに戻るまで */
  private balloonUntil = 0;
  private gogoAt = -1e9;
  /** クリアになった時（背景がクリアの絵に 0.2 秒で変わる） */
  private clearAt = -1e9;
  private scoreAt = -1e9;
  private comboAt = -1e9;
  /** コンボが 50・300 になってから音符の顔が変わり始めるまで（664 ms） */
  private faceLagAt = -1e9;
  private bannerFx: { n: number; t: number } | null = null;
  private rollAt = -1e9;
  private rollNumAt = -1e9;
  private balloonNumAt = -1e9;
  private balloonHitAt = -1e9;
  /** 見えている点数（叩いた点は少し遅れて足される） */
  private shownScore = 0;

  /** 連打の音符の赤み（0〜100）。叩くのをやめて 0.15 秒（100 なら 1.5 秒）たつと、2 ms に 1 ずつ戻る */
  private rollTint = { level: 0, count: 0, at: -1e9 };
  private rollLevel(wall: number) {
    const T = this.rollTint;
    const hold = T.level >= 100 ? 1500 : 150;
    return Math.max(0, T.level - Math.max(0, (wall - T.at - hold) / 2));
  }
  private rollCharas: { t: number; x: number; type: number }[] = [];
  private seed = 7;
  private rnd() {
    this.seed = (this.seed * 16807) % 2147483647;
    return this.seed;
  }
  /** 連打のキャラの絵の組（曲ごとに決める） */
  private rollSeries = 0;

  reset() {
    this.rollTint = { level: 0, count: 0, at: -1e9 };
    this.rollCharas = [];
    this.rollSeries = this.rnd() % 3;
    this.stageAt = -1;
    this.charaOnce = null;
    this.bannerFx = null;
    this.clearAt = this.gogoAt = this.scoreAt = this.comboAt = this.faceLagAt = this.rollAt = this.rollNumAt = this.balloonNumAt = -1e9;
    this.balloonUntil = 0;
    this.last = { combo: 0, gauge: 0, gogo: false, score: 0, roll: 0, balloon: 0, popped: -1 };
    this.fireworks = [];
  }

  private watch(F: TndeFrame, gogo: boolean, beatSec: number) {
    const st = F.game.stats;
    const { wall } = F;
    const L = this.last;
    const max = st.gauge >= 100;
    if (st.combo < L.combo && st.combo === 0 && st.score < L.score) this.reset();
    const busy = () => !!this.charaOnce && wall - this.charaOnce.t < this.charaOnce.ms;
    const act = (name: string, ms: number) => { if (wall >= this.balloonUntil) this.charaOnce = { name, t: wall, ms }; };
    if (gogo && !L.gogo) {
      this.gogoAt = wall;
      act(max ? 'chara/GoGoStart_Max' : 'chara/GoGoStart', beatSec * 2000);
    }
    if (st.gauge >= CLEAR_LINE && L.gauge < CLEAR_LINE) this.clearAt = st.gauge - L.gauge > 30 ? -1e9 : wall;
    if (st.gauge >= 100 && L.gauge < 100) act('chara/Soulin', beatSec * 2000);
    else if (st.gauge >= CLEAR_LINE && L.gauge < CLEAR_LINE) act('chara/Clearin', beatSec * 2000);
    if (st.combo > L.combo) {
      this.comboAt = wall;
      // 1 フレームに 2 つ以上増えても、ちょうどの数を通り過ぎたら出す
      // 途中から始めたときなど、一度に大きく増えたときは出さない
      const crossed = (k: number) => L.combo < k && st.combo >= k && st.combo - L.combo <= 4;
      if (crossed(50) || crossed(300)) this.faceLagAt = wall;
      const hundred = Math.floor(st.combo / 100) * 100;
      if (crossed(50)) this.bannerFx = { n: 50, t: wall };
      else if (hundred >= 100 && crossed(hundred)) this.bannerFx = { n: hundred, t: wall };
      if (Math.floor(st.combo / 10) > Math.floor(L.combo / 10) && st.combo - L.combo <= 4 && !gogo && !(busy() && this.charaOnce!.name === 'chara/Clearin')) {
        act(max ? 'chara/10combo_Max' : 'chara/10combo', beatSec * 2000);
      }
    }
    if (st.score > L.score) this.scoreAt = wall;
    const r = F.fx.rollFx;
    if (r && r.t !== L.roll) {
      L.roll = r.t;
      if (r.balloon) {
        this.balloonNumAt = wall;
        this.balloonHitAt = wall;
        if (!this.charaOnce || this.charaOnce.name !== 'chara/Balloon_Breaking') this.charaOnce = { name: 'chara/Balloon_Breaking', t: wall, ms: 1e9 };
        this.balloonUntil = wall + 1e9;
      } else {
        // 連打の音符の色: 1 打ごとに赤みが 10 増える（100 まで）
        const T = this.rollTint;
        if (r.count < T.count) T.level = 0;
        T.level = Math.min(100, this.rollLevel(wall) + 10 * Math.max(1, r.count - T.count));
        T.count = r.count;
        T.at = wall;
        // 下から斜めに上がっていく連打のキャラ
        this.rollCharas.push({ t: wall, x: P(ROLL_X[this.rnd() % ROLL_X.length]), type: this.rnd() % 6 });
        if (this.rollCharas.length > 64) this.rollCharas.shift();
        // 連打の枠: 出ていなければ開くところから、出ていれば開いたまま延ばす
        if (wall - this.rollAt > 2400) this.rollAt = wall;
        else this.rollAt = wall - 5 * 40;
        this.rollNumAt = wall;
      }
    }
    if (F.fx.rainbow !== null && F.fx.rainbow !== L.popped) {
      L.popped = F.fx.rainbow;
      const n = this.count('chara/Balloon_Broke');
      this.charaOnce = { name: 'chara/Balloon_Broke', t: wall, ms: n * 32 };
      this.balloonUntil = wall + 500;
    } else if (this.charaOnce?.name === 'chara/Balloon_Breaking' && (!r || !r.balloon || wall - r.t > 300)) {
      // 割らずに終わった
      const n = this.count('chara/Balloon_Miss');
      this.charaOnce = { name: 'chara/Balloon_Miss', t: wall, ms: n * 32 };
      this.balloonUntil = wall + 500;
    }
    // 点数は 0.4 秒ほど遅れて増える（TJAPlayer3 は加算を少し遅らせて見せる）。ここではすぐ近づける
    this.shownScore = st.score;
    L.combo = st.combo;
    L.gauge = st.gauge;
    L.gogo = gogo;
    L.score = st.score;
  }

  // ---------- 1 フレーム ----------

  draw(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { game, course, now, wall } = F;
    this.choose(F.info.title);
    if (`${this.pick.key ? '' : '-'}${this.pick.up}|${this.pick.down}|${this.pick.dancer}` !== this.loadedSet) void this.sync();
    const beat = this.beatOf(course, now);
    const b0 = course.bars[0];
    this.dancePhase = b0 ? (b0.time * b0.bpm) / 60 + 0.55 : 0;
    const bpm = this.bpmAt(course, now);
    const st = game.stats;
    const gogo = course.gogo.some(([a, b]) => now >= a && now < b);
    const clear = st.gauge >= CLEAR_LINE;
    c.imageSmoothingEnabled = true;
    this.watch(F, gogo, 60 / bpm);
    const jx = TJX + F.jpos * S;
    // TJAPlayer3 と同じ重ね順（lane = 動画用の画面: レーンと左のパネルだけ）
    const all = !F.laneOnly;
    if (all) {
      const noUp = F.bgMode === 'full';
      const noDown = !!F.bgMode;
      if (!noUp) this.drawUp(c, wall, beat, clear, now);
      if (!noDown) {
        this.drawDown(c, wall, beat, clear, now);
        this.drawFooter(c);
      }
      this.drawChara(c, beat, gogo, F);
      if (!noDown) this.drawMob(c, beat, wall);
    }
    this.drawLane(c, F, gogo);
    if (all) this.drawGauge(c, st.gauge, wall);
    this.drawJudgeFrame(c, F, gogo, jx);
    this.drawNotes(c, F, beat, jx);
    this.drawPanel(c, F);
    if (all) this.drawSplash(c, wall);
    this.drawCombo(c, st.combo, wall);
    this.drawScore(c, wall);
    if (all) {
      this.drawRainbow(c, F);
      this.drawFireworks(c, wall);
      this.drawSoulFx(c, F);
      this.drawFlyers(c, F, jx);
    }
    this.drawExplosion(c, F, jx);
    if (all) {
      this.drawTitle(c, F);
      this.drawComboBanner(c, wall);
    }
    this.drawRoll(c, F);
    this.drawJudgeText(c, F, jx);
    if (all) this.drawBalloonChara(c, F);
  }

  private bpmAt(course: Course, now: number) {
    let bpm = course.bars[0]?.bpm ?? 120;
    for (const b of course.bars) {
      if (b.time > now) break;
      bpm = b.bpm;
    }
    return bpm > 0 ? bpm : 120;
  }

  // ---------- 上の背景 ----------

  private drawUp(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean, now: number) {
    const u = this.pick.up;
    // 上の背景は 1 秒に 92.4px ずつ左へ流れる（参考動画で測った）
    const sc = (wall / 1000) * 92.4 - this.bgPhase;
    const fade = clear ? Math.min(1, (wall - this.clearAt) / 200) : 0;
    if (u === 2) {
      const tw = 326 * S;
      const o = -(((sc % tw) + tw) % tw);
      // 地・富士・波（参考動画で測った位置: 富士は地の絵の 247px 右、波は 70px 左）を、横に並べた 1 枚の絵にして貼る
      this.drawStrip(c, 'up2', clear, fade, tw, sc, (g, kk) => {
        for (let i = -1; i * tw < TW + tw * 2; i++) {
          const x = i * tw;
          this.put(g, `bg/Bg_up/2/Main${kk}`, x, -2);
          this.put(g, `bg/Bg_up/2/MT${kk}`, x + 247, 102);
          this.put(g, `bg/Bg_up/2/Surf${kk}`, x - 70, 44);
        }
      }, ['', '_Clear']);
      // イカと鯛: 2.1 秒ごとに、イカ（1.1 秒）→ 鯛（0.9 秒）の順に波の間から跳ねる（参考動画で測った）
      const ph = ((wall / 1000) % 2.1 + 2.1) % 2.1;
      for (let x = o - tw; x < TW + tw; x += tw) {
        if (ph < 1.15) {
          // イカ: 回りながら真上近くまで跳ね上がり（いちばん上は画面の上からはみ出す）、また沈む
          const d = (ph - 0.58) / 0.58;
          const y = -15 + 140 * d * d;
          const cell = Math.floor(ph / 0.05) % 9;
          this.put(c, 'bg/Bg_up/2/Ika', x + 290 - 330 * ph, y, cell * (1230 / 9), 0, 1230 / 9, 136);
        } else if (ph < 2.05) {
          // 鯛: 右から左へ弧を描いて跳ね、頭がだんだん下を向く
          const q = ph - 1.15;
          const d = (q - 0.35) / 0.35;
          const cy = 110 + 110 * d * d;
          const im = this.img('bg/Bg_up/2/Fish');
          if (im && cy < 300) {
            c.save();
            c.translate(x + 470 - 290 * q, cy);
            c.rotate(((30 + 70 * (q / 0.9)) * Math.PI) / 180);
            c.drawImage(im, (-im.width * S) / 2, (-im.height * S) / 2, im.width * S, im.height * S);
            c.restore();
          }
        }
      }
      // 下のうろこ（青海波）: 3 段（イカ・鯛はこの後ろに沈む）
      this.drawScales(c, now, sc, clear, fade);
    } else {
      const tw = 335 * S;
      const o = -(((sc % tw) + tw) % tw);
      const bob = Math.abs(Math.sin(beat * Math.PI)) * 14;
      // 3 段（桃・青・橙）のうち、ふだんは桃、クリアからは橙（0.2 秒で変わる）
      this.drawStrip(c, 'up3', clear, fade, tw, sc, (g, kk) => {
        const v = kk ? 2 : 0;
        for (let x = -tw; x < TW + tw * 2; x += tw) this.put(g, 'bg/Bg_up/3/Base', x, -3, v * 335, 0, 335, 188);
      }, ['', '_Clear']);
      const layer = (v: number) => {
        for (let x = o - tw, i = 0; x < TW + tw; x += tw, i++) this.put(c, 'bg/Bg_up/3/Chara', x + 258, 10 - bob, (i % 2) * 328, v * 233, 328, 233);
        const im = this.img('bg/Bg_up/3/Flower');
        if (im) {
          for (let i = 0; i < 14; i++) {
            const q = (wall / 6000 + i / 14) % 1;
            const px = ((i * 397) % TW) - q * 300 + 150;
            const py = q * 320 - 30;
            c.drawImage(im, 0, v * 184, 641, 184, px - 60, py - 20, 641 * 0.25, 184 * 0.25);
          }
        }
      };
      if (fade < 1) layer(0);
      this.alpha(c, fade, () => layer(2));
    }
  }

  /**
   * 横に流れる背景: 1 周期ぶん余分に並べた 1 枚の絵を作っておき、流れた分だけずらして貼る。
   * variants = [ふだん, クリア]。クリアになったら fade（0〜1）で重ねて切り替える
   */
  private drawStrip(c: CanvasRenderingContext2D, id: string, clear: boolean, fade: number, period: number, sc: number, paint: (g: CanvasRenderingContext2D, kk: string) => void, variants: string[]) {
    const o = -(((sc % period) + period) % period);
    const one = (kk: string) => {
      c.save();
      c.translate(o, 0);
      this.cached(c, `${id}${kk}`, kk, -period, -3, TW + period * 3, 303, (g) => paint(g, kk));
      c.restore();
    };
    const base = variants[0];
    if (variants.length < 2) { one(base); return; }
    if (!clear || fade < 1) one(base);
    if (clear) this.alpha(c, fade, () => one(variants[1]));
  }

  /**
   * 鯛と富士の上の背景の、下のうろこ（青海波）。参考動画（魔宵月）で測った:
   * 3 段で、段ごとに 1 色。うろこは 82.5px ごとに並び、2 段目は半分ずれる。
   * 2 秒で 1 往復、まっすぐ上下する（1・3 段目と 2 段目は逆向き）
   */
  private drawScales(c: CanvasRenderingContext2D, now: number, sc: number, clear: boolean, fade: number) {
    const DX = 82.5;
    // 曲の時刻 0.7 秒（から 2 秒ごと）に 1 段目がいちばん上（参考動画で測った）
    const u = ((((now - 0.7) % 2) + 2) % 2) / 2;
    const w = 1 - 2 * Math.abs(2 * u - 1);
    // [真ん中の上の端の y, 振れ幅, 横のずれ, 絵（ふだん）, 絵（クリア）]
    const rows: [number, number, number, number, number][] = [
      [192, 4 * w, 0, 0, 3],
      [210.5, -10.5 * w, DX / 2, 1, 2],
      [224.5, 2.5 * w, 0, 0, 1],
    ];
    // 地の絵との横の位置の関係も参考動画で測った（27px 右）
    const o = -(((sc % DX) + DX) % DX) + 27;
    const one = (kk: string) => {
      const n = kk ? 4 : 3;
      const tw = (kk ? 234 : 176) / n;
      rows.forEach(([y0, dy, shift, t0, t1], r) => {
        const t = kk ? t1 : t0;
        c.save();
        c.translate(o + shift, y0 + dy);
        this.cached(c, `scale${kk}${r}`, `${t}`, -DX * 2, 0, TW + DX * 4, 54 * S, (g) => {
          for (let x = -DX * 2; x < TW + DX * 2; x += DX) this.put(g, `bg/Bg_up/2/Hair${kk}`, x, 0, t * tw, 0, tw, 54);
        });
        c.restore();
      });
    };
    if (!clear || fade < 1) one('');
    if (clear) this.alpha(c, fade, () => one('_Clear'));
  }

  // ---------- 下の背景・踊り子・帯 ----------

  private static readonly GLOW: Record<number, number[]> = { 1: [1], 2: [1], 3: [2, 5], 4: [1], 5: [1, 2, 3] };
  private static readonly LAYERS: Record<number, number> = { 1: 2, 2: 2, 3: 8, 4: 3, 5: 6 };
  /** 光る絵のある範囲（[左, 上, 右, 下]。重ならないように分けた） */
  private static readonly GLOW_AT: Record<number, number[][]> = {
    1: [[0, 0, 1280, 225]],
    2: [[0, 0, 1280, 198]],
    3: [[186, 0, 1093, 327]],
    4: [[149, 101, 1274, 173]],
    5: [[0, 0, 1280, 131], [269, 169, 990, 243], [45, 243, 1234, 310]],
  };

  private drawDown(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean, now: number) {
    const d = this.pick.down;
    const n = TndeSkin.LAYERS[d] ?? 1;
    const glow = TndeSkin.GLOW[d] ?? [];
    const pulse = 0.8 + 0.2 * Math.cos((((beat % 1) + 1) % 1) * Math.PI * 2);
    // 光る絵の濃さが 0.8 のものと 1 のものを 1 枚ずつ作っておき、2 枚目を重ねる濃さで光らせる
    const bake = (a: number) => (g: CanvasRenderingContext2D) => {
      for (let i = 0; i < n; i++) {
        if (d === 4 && i === 3) continue;
        g.globalAlpha = glow.includes(i) ? a : 1;
        this.put(g, `bg/Bg_down/${d}/${i}`, 0, 540);
      }
      g.globalAlpha = 1;
    };
    // クリアの背景が出きったら、その下は見えないので描かない
    if (!clear || wall - this.clearAt < 200) {
      this.cached(c, 'down0', `${d}`, 0, 540, TW, 540, bake(0.8));
      // 光る絵のある所だけ重ねる（重ならない四角に分けてある。1280×360 の絵の中の位置）
      const parts = (TndeSkin.GLOW_AT[d] ?? []).map(([x0, y0, x1, y1]) => [x0 * S, 540 + y0 * S, (x1 - x0) * S, (y1 - y0) * S]);
      if (parts.length) this.alpha(c, (pulse - 0.8) / 0.2, () => this.cached(c, 'down1', `${d}`, 0, 540, TW, 540, bake(1), parts));
    }
    if (d === 4) this.drawPetals(c, wall);
    if (clear) this.drawClearDown(c, wall, now);
    this.drawRollCharas(c, wall);
    this.drawDancers(c, beat, wall);
  }

  /**
   * 桜の花びら: 両側の桜の木の枝の所から、ひらひら揺れながら速めに落ちる（参考動画で測った: 1 秒に 400px ほど落ち、
   * 横に 200〜300px 流れ、0.6〜1 秒で消える）。一度に 8 枚ほど
   */
  private drawPetals(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('bg/Bg_down/4/3');
    if (!im) return;
    const LIFE = 1000;
    const EVERY = 120;
    const first = Math.floor((wall - LIFE) / EVERY);
    for (let k = first; k * EVERY <= wall; k++) {
      // 花びらごとの決まった乱数
      let h = (k * 2654435761) >>> 0;
      const r = () => ((h = (Math.imul(h ^ (h >>> 15), 2246822507) + 0x9e3779b9) >>> 0) / 4294967296);
      const t = (wall - k * EVERY) / 1000;
      const life = 0.6 + r() * 0.4;
      if (t < 0 || t > life) continue;
      const left = r() < 0.3;
      const x0 = left ? r() * 360 : 585 + r() * 1335;
      const y0 = 560 + r() * 160;
      const dir = r() < 0.5 ? -1 : 1;
      const vx = dir * (150 + r() * 150);
      const vy = 380 + r() * 80;
      const ph = r() * 6.28;
      const x = x0 + vx * t + Math.sin(ph + t * 9) * 12;
      const y = y0 + vy * t - 60 * t * t;
      const a = Math.min(1, (life - t) / 0.15);
      const flip = Math.cos(ph + t * 11);
      c.save();
      c.globalAlpha = a;
      c.translate(x, y);
      c.rotate(ph + t * 4);
      c.scale(flip, 1);
      c.drawImage(im, (-im.width * S) / 2, (-im.height * S) / 2, im.width * S, im.height * S);
      c.restore();
    }
  }

  /**
   * 踊り子（16 拍で 1 回りの振り付け）。真ん中の 3 人はいつも、左の白い犬はゲージ 40% から、右の黒い犬は 80% から
   * 出てくる（出てくるときは In の動き）。dancer = 2 の曲は犬を 4 匹並べる
   */
  private drawDancers(c: CanvasRenderingContext2D, beat: number, wall: number) {
    const b16 = ((((beat + this.dancePhase) * 4) % 64) + 64) % 64;
    let fr = 0;
    if (b16 < 32) {
      let t = b16;
      for (const [f, len] of DANCE_A) {
        if (t < len) { fr = f; break; }
        t -= len;
      }
    } else fr = DANCE_B[Math.floor(((b16 - 32) / 32) * 36) % 18];
    const g = this.last.gauge;
    // [下の真ん中の x（1280×720）, 何番の犬, 出てくるゲージ]
    const dogs: [number, number, number][] =
      this.pick.dancer === 1 ? [[215, 2, 40], [1070, 3, CLEAR_LINE]] : [[430, 2, 0], [640, 3, 0], [856, 2, 0], [215, 3, 40], [1070, 2, CLEAR_LINE]];
    if (this.pick.dancer === 1) this.frame(c, 'dancer/Normal1', fr, 427, 553);
    dogs.forEach(([x, set, need], i) => {
      if (g < need) { this.inAt[i] = -1; return; }
      if (this.inAt[i] < 0) this.inAt[i] = need ? wall : -1e9;
      const k = ((wall - this.inAt[i]) / 1000) * 30;
      const name = k < this.count(`dancer/In${set}`) ? `dancer/In${set}` : `dancer/Normal${set}`;
      const a = this.man.anim[name];
      if (!a) return;
      this.frame(c, name, name.includes('/In') ? k : fr, P(x) - (a.w * S) / 2, 842.5 - (a.h * S) / 2);
    });
  }
  private inAt = [-1, -1, -1, -1, -1];
  private dancePhase = 0;

  /**
   * クリアの下の背景（金の市松・雲・こま・松と梅）。0.2 秒で現れる。
   * 並べ方はスキンに書かれていないので、参考動画（魔宵月）で部品ごとに位置と流れる速さを測った
   */
  private drawClearDown(c: CanvasRenderingContext2D, wall: number, now: number) {
    const fade = Math.min(1, (wall - this.clearAt) / 200);
    // 動画で測ったときの曲の時刻（ここで下の位置になる）
    const t = now - CLEAR_T0;
    this.alpha(c, fade, () => {
      const piece = (g: CanvasRenderingContext2D, name: string, x: number, y: number) => this.put(g, `bg/clear/${name}`, x, y);
      // 市松（動かない）
      this.cached(c, 'clear0', '', 0, 540, TW, 540, (g) => this.put(g, 'bg/clear/0_0', 0, 540, 0, 0, 1280, 392));
      // 大きな金の雲（1 秒に 57px 左へ）。1920px でひと回りする 1 枚の絵にしておき、2 回貼る
      const loop = (id: string, v: number, h0: number, h: number, paint: (g: CanvasRenderingContext2D) => void) => {
        const x = -((((v * t) % TW) + TW) % TW);
        const draw = (dx: number) => {
          c.save();
          c.translate(dx, 0);
          this.cached(c, id, '', 0, h0, TW, h, paint);
          c.restore();
        };
        draw(x);
        draw(x + TW);
      };
      const wrapIn = (g: CanvasRenderingContext2D, x: number, w: number, f: (x: number) => void) => {
        const p = ((x % TW) + TW) % TW;
        f(p);
        if (p + w > TW) f(p - TW);
        void g;
      };
      loop('clear1', 57, 470, 400, (g) => {
        wrapIn(g, 975, 475 * S, (x) => piece(g, '43_1575', x, 475));
        wrapIn(g, 958, 483 * S, (x) => piece(g, '664_1760', x, 521));
      });
      // 上のふちの金の雲（動かない）
      this.cached(c, 'clear2', '', 0, 540, TW, 116, (g) => {
        this.put(g, 'bg/clear/0_0', -24, 540, 0, 380, 1280, 77);
        this.put(g, 'bg/clear/0_0', -24 + TW, 540, 0, 380, 1280, 77);
      });
      // 松と梅（1 秒に 90px 左へ。1920px でひと回り）
      loop('clear3', 90, 540, 540, (g) => {
        for (const [name, x, y, w] of CLEAR_DECO) wrapIn(g, x, w * S, (xx) => piece(g, name, xx, y));
      });
      // こま（動かない）
      piece(c, '228_2176', 340, 582);
      piece(c, '23_2660', 36, 765);
      piece(c, '856_2853', 1284, 516);
    });
  }

  /** 連打のキャラ: 画面の下から、1 ms に 0.6px（1280×720）ずつ右上へ */
  private drawRollCharas(c: CanvasRenderingContext2D, wall: number) {
    this.rollCharas = this.rollCharas.filter((r) => wall - r.t < 1300);
    for (const r of this.rollCharas) {
      const d = P(0.6 * (wall - r.t));
      const a = this.man.anim[`fx/roll${this.rollSeries}`];
      if (a) this.frame(c, `fx/roll${this.rollSeries}`, r.type, r.x + d, TH - d);
    }
  }

  /**
   * 魂ゲージが満タンの間、下に出るモブ（前の列と、後ろの群れ）。1 拍ごとに跳ねる。後ろの群れは跳ね上がった所でポーズが変わる。
   * 位置・跳ね方は参考動画（銀の黎明か、黒の晶華か。）で測った。神社の背景（魔宵月）のモブは素材が無いので出さない
   */
  private drawMob(c: CanvasRenderingContext2D, beat: number, wall: number) {
    if (this.pick.down === 5) return;
    if (this.last.gauge < 100) { this.mobAt = -1; return; }
    if (this.mobAt < 0) this.mobAt = wall;
    // 下から 0.15 秒で出てくる
    const rise = Math.max(0, 1 - (wall - this.mobAt) / 150);
    const lift = rise * rise * 420;
    const f = (((beat + MOB_PHASE) % 1) + 1) % 1;
    const s = Math.sin(f * Math.PI);
    const mid = 310 - 95 * s + lift;
    const pose = f > 0.3 && f < 0.7;
    if (pose) this.put(c, 'mob', 0, mid - 476 + 636 * S, 0, 636, 1280, 319);
    else this.put(c, 'mob', 0, mid + 317 * S, 0, 317, 1280, 319);
    this.put(c, 'mob', 0, 745 - 55 * s + lift, 0, 0, 1280, 317);
  }
  private mobAt = -1;

  /** 下の帯（参考動画では絵を右へ 648px ずらした位置で止まっている） */
  private drawFooter(c: CanvasRenderingContext2D) {
    this.put(c, 'footer1', 648, TH - 44 * S);
    this.put(c, 'footer1', 648 - 1280 * S, TH - 44 * S);
  }

  // ---------- どんちゃん ----------

  private drawChara(c: CanvasRenderingContext2D, beat: number, gogo: boolean, F: TndeFrame) {
    const st = F.game.stats;
    const { wall } = F;
    const once = this.charaOnce;
    if (once?.name === 'chara/Balloon_Breaking' || wall < this.balloonUntil) return; // 風船のどんちゃんは手前に描く
    if (once && !once.name.startsWith('chara/Balloon')) {
      const p = (wall - once.t) / once.ms;
      if (p < 1) {
        this.frame(c, once.name, p * this.count(once.name), 0, 0);
        return;
      }
      this.charaOnce = null;
    }
    const max = st.gauge >= 100;
    const clear = st.gauge >= CLEAR_LINE;
    const name = gogo ? (max ? 'chara/GoGo_Max' : 'chara/GoGo') : max ? 'chara/Clear_Max' : clear ? 'chara/Clear' : 'chara/Normal';
    // ふだんは 4 拍、ゴーゴー・クリアは 2 拍でひと回り（ゴーゴーは参考動画で測った）
    const beats = name === 'chara/Clear' || name === 'chara/Clear_Max' ? 2 : 4;
    const ph = (((beat / beats) % 1) + 1) % 1;
    this.frame(c, name, ph * this.count(name), 0, 0);
  }

  /** 風船を割っているどんちゃん（いちばん手前） */
  private drawBalloonChara(c: CanvasRenderingContext2D, F: TndeFrame) {
    const once = this.charaOnce;
    if (!once || !once.name.startsWith('chara/Balloon')) return;
    const { wall } = F;
    const n = this.count(once.name);
    // 絵は 1 枚おきにしてあるので 32 ms ごと（元は 16 ms ごと）。割っている間は叩くたびに最初から
    if (once.name === 'chara/Balloon_Breaking') {
      this.frame(c, once.name, Math.min(n - 1, step(wall, this.balloonHitAt, 32)), 0, 0);
      return;
    }
    // 割れた・割れなかった: 0.5 秒かけて消えながら
    const i = step(wall, once.t, 32);
    if (i < n) this.alpha(c, 1 - (wall - once.t) / 500, () => this.frame(c, once.name, i, 0, 0));
  }

  // ---------- レーン ----------

  private drawLane(c: CanvasRenderingContext2D, F: TndeFrame, gogo: boolean) {
    const { wall } = F;
    this.put(c, 'lane/Background_Main', LANE_X, FIELD_Y);
    if (gogo) {
      // ゴーゴーのレーンは縦にひらいて出てくる（18 ms ごと）
      const v = step(wall, this.gogoAt, 18);
      const [ky, dy] = v <= 4 ? [0.2, 54] : v <= 5 ? [0.4, 40] : v <= 6 ? [0.6, 26] : v <= 8 ? [0.8, 13] : [1, 0];
      this.put(c, 'lane/Background_GoGo', LANE_X, FIELD_Y + P(dy), 0, 0, undefined, undefined, S, S * ky);
    }
    this.put(c, 'lane/Background_Sub', LANE_X, P(326));
    // 叩いた色（ドン 赤・カッ 青）と、音符を叩けたとき（黄）。0.1 秒そのまま、次の 0.1 秒で半分まで薄くなって消える
    const flash = (name: string, t: number) => {
      const ms = wall - t;
      if (ms < 0 || ms >= 200) return;
      const a = Math.min(255, ((150 - ms / 2) * 255) / 100) / 255;
      this.alpha(c, a, () => this.put(c, name, LANE_X, FIELD_Y));
    };
    // 色ごとに 1 つ（TJAPlayer3 と同じく、叩くたびに最初から光り直す）
    let don = -1e9, ka = -1e9, hit = -1e9;
    for (const f of F.fx.flashes) if (f.kind === 'don') don = Math.max(don, f.t); else ka = Math.max(ka, f.t);
    for (const b of F.fx.bursts) if (b.judge !== 'bad') hit = Math.max(hit, b.t);
    flash('lane/Red', don);
    flash('lane/Blue', ka);
    flash('lane/Yellow', hit);
    if (!F.laneOnly) this.put(c, 'taiko/frame3', P(329), P(136));
    else {
      // 動画用の画面: ゲージの下地（黒）は出さず、レーンの縁だけ
      c.save();
      c.beginPath();
      c.rect(0, 276, TW, TH);
      c.clip();
      this.put(c, 'taiko/frame3', P(329), P(136));
      c.restore();
    }
  }

  // ---------- ゲージ ----------

  private drawGauge(c: CanvasRenderingContext2D, gauge: number, wall: number) {
    const gx = P(492);
    const gy = P(144);
    // クリアが 80% の形（おに）。このアプリはどの難易度もクリアは 80%
    this.put(c, 'gauge/base3', gx, gy, 0, 0, 700, 44);
    const w = Math.floor(gauge / 2) * 14;
    if (w > 0) this.put(c, 'gauge/fill3', gx, gy, 0, 0, w, 44);
    if (gauge >= 100) {
      // 虹: 50 ms ごとに次の絵へ、次の絵を重ねながら移る
      const n = this.count('gauge/rainbow3');
      const ms = wall % (n * 50);
      const i = Math.floor(ms / 50);
      this.frame(c, 'gauge/rainbow3', i, gx, gy);
      this.alpha(c, (ms % 50) / 50, () => this.frame(c, 'gauge/rainbow3', (i + 1) % n, gx, gy));
    } else this.put(c, 'gauge/1P_Line', gx, gy);
    this.put(c, 'gauge/fill3', P(1038), gy, gauge >= CLEAR_LINE ? 0 : 58, 44, 58, 24);
    if (gauge >= 100) {
      const n = Math.floor(this.imgW('gauge/Fire') / 230);
      this.put(c, 'gauge/Fire', P(1112), P(52), 230 * (step(wall, 0, 50) % n), 0, 230, 230);
    }
    this.put(c, 'gauge/Soul', P(1184), P(125), 0, gauge >= CLEAR_LINE ? 0 : 80, 80, 80);
  }

  private imgW(name: string) {
    return this.img(name)?.width ?? 1;
  }

  // ---------- 判定枠・ゴーゴーの炎・判定の光 ----------

  private drawJudgeFrame(c: CanvasRenderingContext2D, F: TndeFrame, gogo: boolean, jx: number) {
    const { wall } = F;
    if (gogo) {
      const n = step(wall, 0, 50) % 7;
      const v = step(wall, this.gogoAt, 18);
      const k = v < FIRE_SCALE.length ? FIRE_SCALE[v] : 1;
      // 参考動画では炎は足し算で重ねていない。判定枠は炎の上に見えている
      this.putC(c, 'fx/Fire', jx, JUDGE_Y, 360 * n, 0, 360, 370, k);
    }
    this.add(c, 1, () => this.put(c, 'notes', jx - HALF, FIELD_Y, 0, 0, 130, 130));
    // 判定枠が光る（良・可、大音符は大きい光）。20 ms ごとに 15 枚
    for (const b of F.fx.bursts) {
      if (b.judge === 'bad') continue;
      const i = step(wall, b.t, 20);
      if (i < 0 || i >= 15) continue;
      const name = b.judge === 'good' ? (b.big ? 'fx/Great_Big' : 'fx/Great') : b.big ? 'fx/Good_Big' : 'fx/Good';
      this.frame(c, name, i, jx - P(130), JUDGE_Y - P(130));
    }
  }

  // ---------- 小節線・音符 ----------

  /** 音符の顔の段（TJAPlayer3 と同じ: コンボ 50 から半拍ごと、150 から 1/4 拍ごと、300 から別の顔） */
  private faceRow(combo: number, beat: number, wall: number) {
    const v = Math.floor((((beat % 1) + 1) % 1) * 4);
    const lagDone = wall - this.faceLagAt >= 664;
    if (combo >= 300) return v === 1 || v === 3 ? (lagDone ? 2 : 1) : 0;
    if (combo >= 150) return v === 1 || v === 3 ? 1 : 0;
    if (combo >= 50 && lagDone) return v <= 1 ? 1 : 0;
    return 0;
  }

  private drawNotes(c: CanvasRenderingContext2D, F: TndeFrame, beat: number, jx: number) {
    const { game, now, wall } = F;
    const X = (t: number, b: number | undefined, n: { bpm: number; scroll: number }) => jx + F.adv(t, b, n) * (T_MEASURE / 4);
    const Y = (t: number, b: number | undefined, n: { bpm: number; scrollY?: number }) => (n.scrollY ? F.advY(t, b, n) * (T_MEASURE / 4) : 0);
    c.save();
    c.beginPath();
    c.rect(LANE_X, 0, TW - LANE_X, TH);
    c.clip();
    for (const b of F.course.bars) {
      const x = X(b.time, b.beat, b);
      if (x < LANE_X || x > TW) continue;
      this.put(c, 'bar', x - 1.5, FIELD_Y + Y(b.time, b.beat, b), 0, 0, 3, 130);
    }
    const row = this.faceRow(game.stats.combo, beat, wall) * 130;
    const states = game.states;
    for (let i = states.length - 1; i >= 0; i--) {
      const s = states[i];
      const n = s.note;
      if (s.skip || (n.sec !== undefined && !game.active(n))) continue;
      const long = n.type === 'roll' || n.type === 'bigRoll' || n.type === 'balloon';
      if (s.done && !s.missed && !long) continue;
      let x = X(n.time, n.beat, n);
      const endX = n.endTime !== undefined ? X(n.endTime, n.endBeat, n) : x;
      if (Math.max(x, endX) < LANE_X - 300 || x > TW + 200) continue;
      const y = FIELD_Y + Y(n.time, n.beat, n);
      const left = x - HALF;
      if (n.type === 'balloon') {
        if (s.done && s.count >= (n.hits ?? 5)) continue;
        const end = n.endTime ?? n.time;
        if (now >= end) continue;
        if (now >= n.time) x = jx;
        this.put(c, 'notes', x - HALF, y, 1430, row, 260, 130);
        this.se(c, 'ふうせん', x - HALF - P(2), y);
      } else if (n.type === 'roll' || n.type === 'bigRoll') {
        const big = n.type === 'bigRoll';
        const col = NOTE_COL[n.type] * 130;
        // 胴は頭の真ん中から、終わりの真ん中 +10 まで。終わりの絵はそこから右へ
        const tail = endX + P(10);
        const bodyW = tail - (left + P(64));
        // 叩いている連打は赤くなっていく（頭・胴・終わりとも）
        const lv = now >= n.time && now <= (n.endTime ?? n.time) ? this.rollLevel(wall) : 0;
        const g = 1 - (0.95 / 100) * lv;
        if (bodyW > 0) this.tint(c, g, left + P(64), y, col + 131, 0, 128, 130, bodyW, NOTE);
        this.tint(c, g, tail, y, col + 260, row, 130, 130, NOTE, NOTE);
        this.tint(c, g, left, y, col, row, 130, 130, NOTE, NOTE);
        // 連打の文字: 「連打」と、伸ばす線と、終わりの「っ!!」
        const sy = y + P(131);
        const lx = left + P(big ? 116 : 90);
        const lw = endX - HALF + P(10) - left - P(big ? 70 : 44);
        if (lw > 0) this.put(c, 'senotes', lx, sy, 60, 240, 1, 30, lw, S);
        this.put(c, 'senotes', left + P(big ? 56 : 30), sy, 0, 240, 60, 30);
        this.put(c, 'senotes', endX - HALF + P(56), sy, 58, 270, 78, 30);
        this.put(c, 'senotes', left - (big ? P(2) : 0), sy, 0, 30 * SE_ROW[big ? '連打(大)' : '連打'], 136, 30);
      } else {
        this.put(c, 'notes', left, y, NOTE_COL[n.type] * 130, row, 130, 130);
        const label = this.label(game, n, F.labels);
        if (label) {
          const big = n.type === 'bigDon' || n.type === 'bigKa';
          this.se(c, big ? (n.type === 'bigDon' ? 'ドン(大)' : 'カッ(大)') : label, left - P(2), y);
        }
      }
    }
    c.restore();
  }

  /** 赤くした連打の絵（赤みを 20 段に分けて、使う段だけ作る） */
  private tinted = new Map<string, HTMLCanvasElement>();
  /** 音符の絵を、緑と青を g 倍にして（赤っぽくして）貼る */
  private tint(c: CanvasRenderingContext2D, g: number, x: number, y: number, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
    const im = this.img('notes');
    if (!im) return;
    const lv = Math.round((1 - g) * 20);
    if (lv <= 0) {
      c.drawImage(im, sx, sy, sw, sh, x, y, dw, dh);
      return;
    }
    const key = `${sx},${sy},${sw},${sh},${lv}`;
    let cv = this.tinted.get(key);
    if (!cv) {
      // 色を変えた絵は 48 枚まで（古いものから手放す）
      if (this.tinted.size >= 48) {
        const [k0, old] = this.tinted.entries().next().value!;
        old.width = old.height = 0;
        this.tinted.delete(k0);
      }
      cv = document.createElement('canvas');
      cv.width = sw;
      cv.height = sh;
      const t = cv.getContext('2d');
      if (!t) { c.drawImage(im, sx, sy, sw, sh, x, y, dw, dh); return; }
      const gg = Math.round(255 * (1 - lv / 20));
      t.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
      t.globalCompositeOperation = 'multiply';
      t.fillStyle = `rgb(255,${gg},${gg})`;
      t.fillRect(0, 0, sw, sh);
      t.globalCompositeOperation = 'destination-in';
      t.drawImage(im, sx, sy, sw, sh, 0, 0, sw, sh);
      if (this.tinted.size > 200) this.tinted.clear();
      this.tinted.set(key, cv);
    }
    c.drawImage(cv, 0, 0, sw, sh, x, y, dw, dh);
  }

  /** TNDE の「コ」: ド・コ・ドン と続くときだけ（それ以外の 16 分の続きはみな「ド」） */
  private koCache = new WeakMap<Game, Map<Note, boolean>>();
  private label(game: Game, n: Note, base: (n: Note) => string | undefined) {
    const l = base(n);
    if (l !== 'コ') return l;
    let m = this.koCache.get(game);
    if (!m) {
      m = new Map();
      const notes = game.states.map((s) => s.note);
      for (let i = 0; i < notes.length; i++) {
        const nx = notes[i + 1];
        const nn = notes[i + 2];
        m.set(notes[i], !!nx && (nx.type === 'don' || nx.type === 'bigDon') && (!nn || nn.time - nx.time >= 60 / nx.bpm / 2 - 1e-3));
      }
      this.koCache.set(game, m);
    }
    return m.get(n) ? 'コ' : 'ド';
  }

  /** 音符の下の文字（x = 文字の絵の左、y = 音符の上の端） */
  private se(c: CanvasRenderingContext2D, label: string, x: number, y: number) {
    const r = SE_ROW[label];
    if (r !== undefined) this.put(c, 'senotes', x, y + P(131), 0, r * 30, 136, 30);
  }

  // ---------- 左のパネル ----------

  private drawPanel(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const tx = P(207);
    const ty = P(205);
    // 動かない所（パネルの地・太鼓）は 1 枚にまとめておく
    this.cached(c, 'panel', '', 0, 276, 500, 264, (g) => {
      this.put(g, 'taiko/1P_Background', 0, P(184));
      this.put(g, 'taiko/Base', tx, ty);
    });
    // 叩いた面が光る（明るさ 8 から 20 ms ごとに 1 ずつ下がる。濃さは 明るさ × 73 / 255）
    // 面ごとに 1 つ（叩くたびに最初から光り直す）
    const last = new Map<string, (typeof F.fx.flashes)[number]>();
    for (const f of F.fx.flashes) {
      const k = f.kind + f.side;
      if ((last.get(k)?.t ?? -1e9) <= f.t) last.set(k, f);
    }
    for (const f of last.values()) {
      const lv = 8 - step(wall, f.t, 20);
      if (lv <= 0) continue;
      const im = this.img(f.kind === 'don' ? 'taiko/Don' : 'taiko/Ka');
      if (!im) continue;
      const half = im.width / 2;
      const sx = f.side === 'L' ? 0 : half;
      this.alpha(c, Math.min(255, lv * 73) / 255, () => c.drawImage(im, sx, 0, half, im.height, tx + sx * S, ty, half * S, im.height * S));
    }
    // 難易度・ネームプレート（中身が変わったときだけ描き直す）
    const course = COURSE_IMG[F.info.course] ?? 'course/Oni';
    this.cached(c, 'plate', `${course}|${F.title}|${F.name}|${JSON.stringify(F.profile ?? null)}`, -10, 340, 350, 190, (g) => {
      this.put(g, course, P(28), P(232));
      this.drawNameplate(g, F);
    });
  }

  /**
   * ネームプレート。NamePlate.png の 54px ごとの段（1P の丸・白い台・称号の帯）を同じ位置に重ねて 1.5 倍で貼る
   * （参考動画で測った: 段の左上が (-6, 443.5)）。字は勘亭流。段位は無いので出さない
   */
  private drawNameplate(c: CanvasRenderingContext2D, F: TndeFrame) {
    const im = this.img('nameplate');
    if (!im) return;
    const pf = F.profile ?? DEFAULT_PROFILE;
    // NamePlate.png の 54px ごとの段: 0 1P の丸、3 白い台、4 木・5 金・6 紫の称号の帯、7 段位の下地、8 銀・9 金・10 虹の枠、11 金の字の色
    const at = (src: CanvasImageSource, r: number) => c.drawImage(src, 0, r * 54, 220, 54, -6, 443.5, 330, 81);
    const row = (r: number) => at(im, r);
    row(3);
    const base = pf.titleStyle === 'wood' ? 4 : pf.titleStyle === 'gold' || pf.titleStyle === 'goldc' ? 5 : 6;
    const rc = (pf.titleStyle === 'goldc' || pf.titleStyle === 'purplec') && /^#[0-9a-f]{6}$/i.test(pf.titleColor) ? this.recolored(im, base, pf.titleColor) : null;
    if (rc) c.drawImage(rc, 0, 0, 220, 54, -6, 443.5, 330, 81);
    else row(base);
    const dan = pf.danOn && pf.dan.trim() ? [...pf.dan.trim()].slice(0, 3).join('') : '';
    if (dan) {
      row(7);
      const fr = pf.danFrame === 'gold' ? 1 : pf.danFrame === 'rainbow' ? 2 : 0;
      // 枠は 4 倍にした絵から（無ければ元の絵）
      const hd = this.img('nameplate_frames');
      if (hd) c.drawImage(hd, 0, fr * 216, 880, 216, -6, 443.5, 330, 81);
      else row(8 + fr);
    }
    row(0);
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    // 称号: 帯に収まるいちばん大きい字（21px まで。それより小さくなるときは 13px で横に縮める）
    c.font = `20px 'TNDE Kantei', 'TNDE Seurat', sans-serif`;
    const tw = c.measureText(F.title).width || 1;
    const ts = Math.max(13, Math.min(21, (20 * 228) / tw));
    c.font = `${ts}px 'TNDE Kantei', 'TNDE Seurat', sans-serif`;
    c.fillStyle = titleInk(pf);
    // 帯の 1P の丸より右の真ん中（字の真ん中が帯の所の真ん中に来る高さ）
    fitText(c, F.title, 192, 468, 228);
    c.font = `21px 'TNDE Kantei', 'TNDE Seurat', sans-serif`;
    c.lineJoin = 'round';
    c.lineWidth = 6;
    c.strokeStyle = '#000';
    c.fillStyle = '#fff';
    // 白い所の真ん中（段位があるときは段位より右の白い所の真ん中。参考動画で測った）
    if (dan) fitText(c, F.name, 215, 500, 168, true);
    else fitText(c, F.name, 191, 500, 220, true);
    c.restore();
    if (dan) this.drawDanText(c, im, dan, pf.danPass === 'gold');
  }

  /**
   * 段位の字。参考動画で測った: 1 文字 21.7px、字の中心の間 29px、2 文字の真ん中が (98, 500)。
   * 3 文字のときは字の間を詰める（字は縮めない）。赤合格は白い字、金合格は金の字（NamePlate.png の 11 段目の色）
   */
  private drawDanText(c: CanvasRenderingContext2D, im: CanvasImageSource, dan: string, gold: boolean) {
    const chars = [...dan];
    const n = chars.length;
    const size = 21.7;
    // 3 文字は字の間を詰める（字の形は変えない）。丸に重ならないよう少し右へ
    const sx = n >= 3 ? 0.9 : 1;
    const adv = n >= 3 ? size * 0.92 * sx : 29;
    const cx = n >= 3 ? 99 : 98;
    const k = Math.hypot(c.getTransform().a, c.getTransform().b) || 1;
    const W = 120;
    const H = 40;
    // 段位の字の下書き（1 枚を使い回す）
    const cv = (this.danCv ??= document.createElement('canvas'));
    cv.width = Math.ceil(W * k);
    cv.height = Math.ceil(H * k);
    const g = cv.getContext('2d');
    if (!g) return;
    g.scale(k, k);
    g.font = `${size}px 'TNDE Kantei', 'TNDE Seurat', sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    const xs = chars.map((_, i) => W / 2 + (i - (n - 1) / 2) * adv);
    // 字の色（白か金）を先に描き、そのあと縁を後ろに描く
    const put = (f: (ch: string, x: number) => void) => chars.forEach((ch, i) => { g.save(); g.translate(xs[i], H / 2); g.scale(sx, 1); f(ch, 0); g.restore(); });
    put((ch, x) => g.fillText(ch, x, 0));
    if (gold) {
      g.globalCompositeOperation = 'source-in';
      // 金の字の色は 11 段目の帯の、色のある所（縦に金のしま）を字の高さに合わせて引きのばす
      g.drawImage(im, 51, 11 * 54 + 30, 35, 15, 0, H / 2 - size / 2, W, size);
    }
    g.globalCompositeOperation = 'destination-over';
    g.lineJoin = 'round';
    g.lineWidth = 5;
    g.strokeStyle = '#140a0a';
    put((ch, x) => g.strokeText(ch, x, 0));
    c.drawImage(cv, cx - W / 2, 500 - H / 2, W, H);
  }

  private danCv: HTMLCanvasElement | null = null;

  /** 色を指定した称号の帯（明るさ・光沢はそのままで色だけ変える）。色ごとに 1 枚作っておく */
  private recolorCache = new Map<string, HTMLCanvasElement>();
  private recolored(im: CanvasImageSource, r: number, hex: string) {
    const key = `${r}|${hex}`;
    let cv = this.recolorCache.get(key);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = 220;
    cv.height = 54;
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(im, 0, r * 54, 220, 54, 0, 0, 220, 54);
    const d = g.getImageData(0, 0, 220, 54);
    const px = d.data;
    const n = parseInt(hex.slice(1), 16);
    const [th, ts, tv] = rgbToHsv((n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    let sum = 0, cnt = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 128) { sum += Math.max(px[i], px[i + 1], px[i + 2]) / 255; cnt++; }
    const mv = cnt ? sum / cnt : 1;
    for (let i = 0; i < px.length; i += 4) {
      if (!px[i + 3]) continue;
      const [, s0, v0] = rgbToHsv(px[i] / 255, px[i + 1] / 255, px[i + 2] / 255);
      const [rr, gg, bb] = hsvToRgb(th, Math.min(1, s0 * ts * 1.05), Math.min(1, ((v0 * tv) / Math.max(mv, 1e-3)) * 0.95));
      px[i] = rr * 255;
      px[i + 1] = gg * 255;
      px[i + 2] = bb * 255;
    }
    g.putImageData(d, 0, 0);
    if (this.recolorCache.size > 8) { for (const x of this.recolorCache.values()) x.width = x.height = 0; this.recolorCache.clear(); }
    this.recolorCache.set(key, cv);
    return cv;
  }


  // ---------- ゴーゴーの始まりの光 ----------

  private drawSplash(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('fx/GoGoSplash');
    if (!im) return;
    const n = Math.floor(im.width / 230);
    const i = step(wall, this.gogoAt, 30);
    if (i < 0 || i >= n) return;
    this.add(c, 1, () => {
      for (const [x, y, rot] of SPLASH) {
        c.save();
        c.translate(P(x), P(y) - P(230));
        c.rotate(rot);
        c.drawImage(im, i * 230, 0, 230, 460, -P(115), -P(230), P(230), P(460));
        c.restore();
      }
    });
  }

  // ---------- コンボ・点数 ----------

  private drawCombo(c: CanvasRenderingContext2D, combo: number, wall: number) {
    if (combo < 10) return;
    const digits = String(combo);
    const n = digits.length;
    const v = Math.min(12, step(wall, this.comboAt, 12));
    // 「コンボ」の字（このスキンは下の段だけ）。下の真ん中を (266, 298) に
    this.put(c, 'taiko/Combo_Text', P(266) - P(50), P(298) - P(50), 0, 50, 100, 50);
    let name = 'taiko/Combo';
    let right = P(267);
    let pad = P(35);
    let bottom = P(273);
    let k = 1;
    let ky = COMBO_SCALE[v];
    if (n === 2) {
      right = P(267 + 35 / 2);
      if (combo >= 50) name = 'taiko/Combo_Midium';
    } else if (n === 3) {
      name = 'taiko/Combo_Big';
      right = P(266 + 35);
      ky = COMBO_SCALE_EX[v];
    } else if (n >= 4) {
      // 4 桁から: 横だけ 0.83 倍、間隔 29.3、真ん中を 266.7 に（参考動画で測った。縦は 3 桁と同じ大きさ）
      name = 'taiko/Combo_Big';
      k = 0.83;
      pad = P(29.3);
      right = P(266.7) + (pad * (n - 1)) / 2;
      ky = COMBO_SCALE_EX[v];
    }
    const im = this.img(name);
    if (!im) return;
    for (let i = 0; i < n; i++) {
      const d = +digits[n - 1 - i];
      const w = P(40) * k;
      const h = P(48) * (1 + ky);
      c.drawImage(im, d * 40, 0, 40, 48, right - pad * i - w / 2, bottom - h, w, h);
    }
    // 3 桁から: 数字のまわりのきらきら（20 ms ごと、30 コマでひと回り）
    if (n >= 3) {
      const r = step(wall, 0, 20) % 30;
      const ey = bottom - P(48 / 4) * k;
      for (let i = 0; i < n; i++) {
        const x = right - pad * i;
        // 下の真ん中を基準に置く
        const sp = (dx: number, a: number) => this.add(c, a / 255, () => this.putC(c, 'taiko/Combo_Effect', x + dx, ey - P(1.05 * r) - P(12.5), 0, 0, 25, 25));
        if (r < 14) sp(-P(10) * k, r < 7 ? 255 : Math.max(0, 204 - 24 * r));
        if (r > 4 && r < 24) sp(P(10) * k, r < 11 ? 255 : Math.max(0, 204 - 12 * r));
        if (r > 14) sp(0, r < 22 ? 255 : Math.max(0, 204 - 6 * r));
      }
    }
  }

  private drawScore(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('taiko/Score');
    if (!im) return;
    const cw = im.width / 10;
    const ch = im.height / 3;
    const s = String(Math.max(0, Math.floor(this.shownScore))).padStart(7, ' ');
    const v = Math.min(11, step(wall, this.scoreAt, 12));
    const k = SCORE_SCALE[v];
    // 参考動画で測った位置: 1 文字目の左 52.5、間隔 29.5、下の端 336.5（下を基準に縦に伸びる）
    for (let i = 0; i < 7; i++) {
      if (s[i] === ' ') continue;
      const d = +s[i];
      c.drawImage(im, d * cw, 0, cw, ch, 52.5 + 29.5 * i, 336.5 - ch * S * k, cw * S, ch * S * k);
    }
  }

  // ---------- 叩いた音符が魂へ飛ぶ ----------

  private fireworks: { x: number; y: number; t: number }[] = [];

  private flyPos(theta: number, jx: number) {
    const sx = jx / S;
    const r = (theta * Math.PI) / 180;
    return { x: P(sx + 499 - Math.cos(r) * 499 - 85), y: P(260 - Math.sin(r) * 559 + 329 - (96 / 180) * theta) };
  }

  private flyLane(n: Note) {
    return n.type === 'ka' ? 2 : n.type === 'bigDon' ? 3 : n.type === 'bigKa' ? 4 : 1;
  }

  private drawFlyers(c: CanvasRenderingContext2D, F: TndeFrame, jx: number) {
    const { wall } = F;
    for (const f of F.fx.flyers) {
      // 36° から 140° まで、4 ms に 1°
      const theta = 36 + (wall - f.t) / 4;
      if (theta < 36 || theta > 140) continue;
      const lane = this.flyLane(f.note);
      const p = this.flyPos(theta, jx);
      // 大音符は通った所に花火（8° ごと）
      if (lane >= 3) {
        const last = (f as { fw?: number }).fw ?? 36;
        for (let th = Math.ceil(last / 8) * 8; th <= theta; th += 8) {
          if (th > 36) {
            const q = this.flyPos(th, jx);
            this.fireworks.push({ x: q.x, y: q.y, t: f.t + (th - 36) * 4 });
          }
        }
        (f as { fw?: number }).fw = theta + 0.001;
      }
      this.putC(c, 'notes', p.x, p.y, lane * 130, 0, 130, 130);
    }
  }

  private drawFireworks(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('fx/FireWorks');
    if (!im) return;
    const n = Math.floor(im.width / 192);
    this.fireworks = this.fireworks.filter((f) => wall - f.t < n * 10);
    this.add(c, 1, () => {
      for (const f of this.fireworks) {
        const i = step(wall, f.t, 10);
        if (i >= 0 && i < n) this.putC(c, 'fx/FireWorks', f.x, f.y, i * 192, 0, 192, 192);
      }
    });
  }

  /** 魂に着いた音符: 弾ける光（25 ms ごと）と、その間そこに残る音符 */
  private drawSoulFx(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const im = this.img('gauge/1P_Explosion');
    const n = im ? Math.floor(im.width / 180) : 0;
    const x = P(1222);
    const y = P(164);
    for (const f of F.fx.flyers) {
      const t0 = f.t + 104 * 4;
      const i = step(wall, t0, 25);
      if (i < 0 || i >= n) continue;
      this.putC(c, 'gauge/1P_Explosion', x, y, i * 180, 0, 180, 180);
      this.putC(c, 'notes', x, y, this.flyLane(f.note) * 130, 0, 130, 130);
    }
  }

  /** 判定枠の上の火花の輪（足し算・25 ms ごと 7 コマ）と、大音符の光の輪（0.5 倍から広がる） */
  private drawExplosion(c: CanvasRenderingContext2D, F: TndeFrame, jx: number) {
    const { wall } = F;
    // 足し算で重ねるものは、まとめて 1 回で切り替える
    const live = F.fx.bursts.filter((b) => b.judge !== 'bad' && wall - b.t >= 0 && wall - b.t < 175);
    if (!live.length) return;
    this.add(c, 1, () => {
      for (const b of live) {
        const i = step(wall, b.t, 25);
        if (i >= 0 && i < 7) {
          const row = (b.judge === 'good' ? 0 : 260) + (b.big ? 520 : 0);
          this.put(c, 'fx/Explosion', jx - P(130), JUDGE_Y - P(130), i * 260, row, 260, 260);
        }
        // 大音符の光の輪は 10 ms ごとに広がる（参考動画で測った）
        const j = step(wall, b.t, 10);
        if (b.big && b.judge === 'good' && j >= 0 && j < 10) this.putC(c, 'fx/Explosion_Big', jx, JUDGE_Y, 0, 0, 260, 260, 0.5 + j * 0.05);
      }
    });
  }

  /** 風船が割れたときの虹（8 ms ごと。左から現れて、左から消える） */
  private drawRainbow(c: CanvasRenderingContext2D, F: TndeFrame) {
    const t0 = F.fx.rainbow;
    if (t0 === null) return;
    const v = step(F.wall, t0, 8);
    if (v < 0 || v > 164) return;
    const im = this.img('fx/Rainbow');
    if (!im) return;
    const W = im.width;
    if (v < 82) {
      const w = (v * W) / 85;
      if (w > 0) c.drawImage(im, 0, 0, w, im.height, P(360), P(-100), w * S, im.height * S);
    } else {
      const x = Math.min(W, ((v - 82) * W) / 85);
      if (W - x > 0) c.drawImage(im, x, 0, W - x, im.height, P(360) + x * S, P(-100), (W - x) * S, im.height * S);
    }
  }

  // ---------- 曲名 ----------

  private titleCache: { key: string; c: HTMLCanvasElement } | null = null;
  /** ジャンルと曲目を入れ替える時計の始まり */
  private stageAt = -1;

  private drawTitle(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const f = F.info.folder;
    // エディタから遊んだときも入れ替える（曲えらびから遊んでいなければ 1 曲目）
    const stage = Math.max(1, F.info.stage ?? 0);
    if (this.stageAt < 0) this.stageAt = wall;
    // ジャンル（曲のフォルダ）と「○曲目 / ∞曲」を約 4 秒で入れ替える（TJAPlayer3 と同じ数え方。間隔は参考動画で測った）
    const n = ((((wall - this.stageAt) % 3960) + 3960) % 3960) / 1.98;
    const songsA = stage <= 0 ? 0 : n < 745 ? 0 : n < 1000 ? (n - 745) / 255 : n < 1745 ? 1 : Math.max(0, 1 - (n - 1745) / 255);
    const showGenre = !!f && (stage <= 0 || n < 1000 || n >= 1745);
    // 帯は 1.45 倍で (1518.4, 94.3) に貼る（参考動画で測った）
    const GX = 1518.4;
    const GY = 94.3;
    const GK = 1.45;
    if (showGenre && f) {
      this.cached(c, 'genre', `${f.name}|${f.color}|${f.custom}`, GX, GY, 295 * GK, 33 * GK, (g) => {
        const gk = f.custom ? undefined : GENRES.find(([re]) => re.test(f.name))?.[1];
        let col = f.color;
        if (gk && this.img(`genre/b${gk}`)) {
          this.put(g, `genre/b${gk}`, GX, GY, 0, 0, undefined, undefined, GK);
          col = GENRE_COL[gk];
        } else {
          // 帯の形（字の無い帯と同じ: 左右が丸い 202×22）をフォルダの色で塗る
          g.fillStyle = col;
          const x0 = GX + 47 * GK, y0 = GY + 6 * GK, w = 202 * GK, h = 22 * GK, r = h / 2;
          g.beginPath();
          g.arc(x0 + r, y0 + r, r, Math.PI / 2, (Math.PI * 3) / 2);
          g.arc(x0 + w - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
          g.closePath();
          g.fill();
        }
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = `21.5px 'TNDE Seurat', sans-serif`;
        g.lineJoin = 'round';
        g.lineWidth = 5;
        g.strokeStyle = shade(col, 0.18);
        g.fillStyle = '#fff';
        fitText(g, f.name, GX + 147.5 * GK, GY + 17 * GK, 190 * GK, true);
      });
    }
    if (songsA > 0) {
      this.alpha(c, songsA, () => this.cached(c, 'songs', `${stage}`, GX, GY, 295 * GK, 33 * GK, (g) => {
        this.put(g, 'genre/Songs', GX, GY, 0, 0, undefined, undefined, GK);
        g.textAlign = 'right';
        g.textBaseline = 'middle';
        g.font = `24px 'TNDE Seurat', sans-serif`;
        g.lineJoin = 'round';
        g.lineWidth = 4.5;
        g.strokeStyle = '#000';
        g.fillStyle = '#fff';
        g.strokeText(String(stage), 1655, 121.5);
        g.fillText(String(stage), 1655, 121.5);
        g.strokeText('∞', 1807, 121.5);
        g.fillText('∞', 1807, 121.5);
      }));
    }
    const key = F.info.title;
    if (this.titleCache?.key !== key) {
      const cv = this.titleCache?.c ?? document.createElement('canvas');
      const t = cv.getContext('2d');
      if (!t) return;
      const font = `48px 'TNDE Kantei', 'TNDE Seurat', sans-serif`;
      t.font = font;
      const w = Math.ceil(t.measureText(key).width) + 24;
      cv.width = w;
      cv.height = 90;
      t.font = font;
      t.textAlign = 'center';
      t.textBaseline = 'middle';
      t.lineJoin = 'round';
      t.lineWidth = 13;
      t.strokeStyle = '#000';
      t.strokeText(key, w / 2, 47);
      t.fillStyle = '#fff';
      t.fillText(key, w / 2, 47);
      this.titleCache = { key, c: cv };
    }
    const cv = this.titleCache.c;
    // 長い曲名は横に縮める（TJAPlayer3 と同じく 990px まで）
    const tw = Math.min(cv.width, 1014);
    // 字の真ん中が y 67.5 に来る高さ（参考動画で測った）
    c.drawImage(cv, Math.min(1732 - tw / 2, 1880 - tw), 65 - 47, tw, cv.height);
  }

  // ---------- コンボの巻物・連打・風船 ----------

  /** 50・100・200… コンボの巻物（70 ms ごとに 42 コマ。最初と最後の 3 コマは薄い） */
  private drawComboBanner(c: CanvasRenderingContext2D, wall: number) {
    const b = this.bannerFx;
    if (!b) return;
    const v = 1 + step(wall, b.t, 70);
    if (v > 42) { this.bannerFx = null; return; }
    const cell = v <= 2 ? 0 : v === 3 || v === 40 ? 1 : v >= 41 ? 0 : 2;
    const a = v === 1 || v === 42 ? 64 : v === 2 || v === 41 ? 128 : 255;
    const na = v <= 2 || v >= 41 ? 0 : v === 3 || v === 40 ? 128 : 255;
    this.alpha(c, a / 255, () => this.put(c, 'balloon/Combo_1P', P(253), P(-11), cell * 360, 0, 360, 192));
    const big = b.n >= 1000;
    this.alpha(c, na / 255, () => {
      const im = this.img('balloon/Number_Combo');
      if (!im) return;
      const s = String(b.n).padStart(4, ' ');
      const kx = big ? 0.8 : 1;
      let x = P(big ? 297 : 257);
      for (const ch of s) {
        if (ch !== ' ') c.drawImage(im, +ch * 53, 0, 53, 61, x, P(54), 53 * S * kx, 61 * S);
        x += P(45 * kx);
      }
      this.put(c, 'balloon/Number_Combo', P((big ? 444 : 442) + 6 - cell * 3), P(85), 0, 124, 100, 30);
    });
  }

  private drawRoll(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const r = F.fx.rollFx;
    // 連打の扇（40 ms ごと。0〜3 でひらき、4 のまま、最後に閉じる）。動画用の画面では上の曲の情報に重なるので出さない
    const v = step(wall, this.rollAt, 40);
    if (r && !F.laneOnly && !r.balloon && v >= 0 && v <= 66 && wall - r.t < 2700) {
      const cell = v <= 3 ? v : v >= 57 && v <= 60 ? 60 - v : 4;
      const fade = v > 60 ? 1 - (v - 60) / 6 : 1;
      this.alpha(c, fade, () => {
        this.put(c, 'balloon/Roll', P(218), P(-3), cell * 334, 0, 334, 204);
        this.rollNum(c, r.count, P(380), P(122), 1, ROLL_SCALE[Math.min(9, step(wall, this.rollNumAt, 20))]);
      });
    }
    // 風船: ふくらんでいく風船と、残りの数
    if (r && r.balloon && wall - r.t < 300 && r.count < r.hits) {
      const hits = r.hits;
      const left = [4, 3, 2, 1, 0].map((k) => (hits < 5 ? k : Math.floor(hits / 5) * k));
      let j = 4;
      for (let k = 0; k < 5; k++) if (left[k] < r.count) { j = k; break; }
      const jig = step(wall, 0, 100) % 2 ? P(3) : 0;
      this.put(c, `balloon/Breaking_${j}`, P(382) + jig, P(115));
      this.put(c, 'balloon/Balloon', P(382), P(80));
      this.rollNum(c, hits - r.count, P(486), P(187), 0.879, ROLL_SCALE[Math.min(9, step(wall, this.balloonNumAt, 20))]);
    }
  }

  /** 連打・風船の数（真ん中寄せ。y は下の端で、そこを基準に縦に伸びる） */
  private rollNum(c: CanvasRenderingContext2D, v: number, x: number, y: number, k: number, ky: number) {
    const im = this.img('balloon/Number_Roll');
    if (!im) return;
    const s = String(Math.max(0, Math.floor(v)));
    const gw = im.width / 10;
    let px = x - P((57 * s.length) / 2);
    for (const ch of s) {
      const w = gw * S * k;
      const h = im.height * S * (k + ky);
      c.drawImage(im, +ch * gw, 0, gw, im.height, px, y - h, w, h);
      px += P(55) * k;
    }
  }

  /** 判定の字（良・可・不可）: 上から 19px 下りて止まり、0.3 秒で消える（参考動画で測った） */
  private drawJudgeText(c: CanvasRenderingContext2D, F: TndeFrame, jx: number) {
    const j = F.fx.judgeFx;
    if (!j) return;
    const ms = F.wall - j.t;
    if (ms < 0 || ms >= 300) return;
    const row = j.judge === 'good' ? 0 : j.judge === 'ok' ? 1 : 2;
    const y = 207 + 19 * Math.min(1, ms / 83);
    this.put(c, 'judge', jx - 69, y, 0, row * 60, 90, 60);
  }
}

/** 幅が max を超えるときは横に縮めて書く（stroke = 先に縁を描く） */
function fitText(c: CanvasRenderingContext2D, t: string, x: number, y: number, max: number, stroke = false) {
  const w = c.measureText(t).width;
  c.save();
  c.translate(x, y);
  if (w > max) c.scale(max / w, 1);
  if (stroke) c.strokeText(t, 0, 0);
  c.fillText(t, 0, 0);
  c.restore();
}


/** 色を暗くする（k = 残す明るさ） */
function shade(hex: string, k: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#1a1a1a';
  const n = parseInt(m[1], 16);
  const f = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
}

/** 絵を ImageBitmap にして読み込む（返事が来ないときは 12 秒で 1 回やり直す。2 回とも駄目なら img にする） */
async function loadBitmap(url: string): Promise<ImageBitmap | HTMLImageElement | null> {
  const wait = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));
  for (let i = 0; i < 2; i++) {
    try {
      const bm = await Promise.race([
        fetch(url).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status))))).then((b) => createImageBitmap(b)),
        wait(12000),
      ]);
      if (bm) return bm;
    } catch { /* もう 1 回 */ }
  }
  return new Promise((res) => {
    const im = new Image();
    const t = setTimeout(() => res(null), 12000);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); res(null); };
    im.src = url;
  });
}

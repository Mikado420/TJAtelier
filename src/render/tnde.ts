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

export interface TndeFrame {
  game: Game;
  course: Course;
  now: number;
  wall: number;
  info: { title: string; course: string; level: number; genre?: string };
  /** 判定枠からの距離（4 分音符の数 × ハイスピード） */
  adv: (time: number, beat: number | undefined, n: { bpm: number; scroll: number }) => number;
  advY: (time: number, beat: number | undefined, n: { bpm: number; scrollY?: number }) => number;
  jpos: number;
  labels: (n: Note) => string | undefined;
  fx: TndeFx;
  name: string;
  title: string;
}

/** SENotes.png の行 */
const SE_ROW: Record<string, number> = { ドン: 0, ド: 1, コ: 2, カッ: 3, カ: 4, 'ドン(大)': 5, 'カッ(大)': 6, 連打: 7, '連打(大)': 10, ふうせん: 11 };
/** Notes.png の列（130px ごと） */
const NOTE_COL: Record<string, number> = { don: 1, ka: 2, bigDon: 3, bigKa: 4, roll: 5, bigRoll: 8, balloon: 11 };
const COURSE_IMG: Record<string, string> = { Easy: 'course/Easy', Normal: 'course/Normal', Hard: 'course/Hard', Oni: 'course/Oni', Edit: 'course/Edit' };
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
  private imgs = new Map<string, HTMLImageElement>();
  private loading = new Map<string, Promise<HTMLImageElement | null>>();
  private man!: Manifest;
  ready = false;
  private beatTab: { course: Course; cum: number[] } | null = null;
  /** 曲ごとに決める背景（上・下）と踊り子 */
  private pick = { up: 2, down: 5, dancer: 1, key: '' };

  constructor(private readonly base: string) {}

  static async load(base: string) {
    const s = new TndeSkin(base);
    const r = await fetch(`${base}skin.json`);
    if (!r.ok) throw new Error('skin.json');
    s.man = await r.json();
    try {
      const ff = new FontFace('TNDE Seurat', `url(${base}FOT-Seurat_Pro_B.otf)`);
      document.fonts.add(await ff.load());
    } catch { /* 字が無くても描ける */ }
    await Promise.all([...Object.keys(s.man.img), ...Object.keys(s.man.anim)].map((k) => s.fetchImg(k)));
    s.ready = true;
    return s;
  }

  private fetchImg(name: string) {
    let p = this.loading.get(name);
    if (p) return p;
    const info = this.man.img[name] ?? this.man.anim[name];
    if (!info) return Promise.resolve(null);
    p = new Promise<HTMLImageElement | null>((res) => {
      const im = new Image();
      im.decoding = 'async';
      im.onload = () => { this.imgs.set(name, im); res(im); };
      im.onerror = () => res(null);
      im.src = this.base + info.f;
    });
    this.loading.set(name, p);
    return p;
  }

  private img(name: string) {
    const im = this.imgs.get(name);
    if (!im) void this.fetchImg(name);
    return im ?? null;
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
      this.charaOnce = { name: 'chara/Balloon_Broke', t: wall, ms: n * 16 };
      this.balloonUntil = wall + n * 16;
    } else if (this.charaOnce?.name === 'chara/Balloon_Breaking' && (!r || !r.balloon || wall - r.t > 300)) {
      // 割らずに終わった
      const n = this.count('chara/Balloon_Miss');
      this.charaOnce = { name: 'chara/Balloon_Miss', t: wall, ms: n * 16 };
      this.balloonUntil = wall + n * 16;
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
    this.choose(F.title);
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
    // TJAPlayer3 と同じ重ね順
    this.drawUp(c, wall, beat, clear);
    this.drawDown(c, wall, beat, clear, now);
    this.drawFooter(c);
    this.drawChara(c, beat, gogo, F);
    this.drawMob(c, beat, wall);
    this.drawLane(c, F, gogo);
    this.drawGauge(c, st.gauge, wall);
    this.drawJudgeFrame(c, F, gogo, jx);
    this.drawNotes(c, F, beat, jx);
    this.drawPanel(c, F);
    this.drawSplash(c, wall);
    this.drawCombo(c, st.combo, wall);
    this.drawScore(c, wall);
    this.drawRainbow(c, F);
    this.drawFireworks(c, wall);
    this.drawSoulFx(c, F);
    this.drawFlyers(c, F, jx);
    this.drawExplosion(c, F, jx);
    this.drawTitle(c, F);
    this.drawComboBanner(c, wall);
    this.drawRoll(c, F);
    this.drawJudgeText(c, F, jx);
    this.drawBalloonChara(c, F);
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

  private drawUp(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean) {
    const u = this.pick.up;
    // 上の背景は 1 秒に 92.4px ずつ左へ流れる（参考動画で測った）
    const sc = (wall / 1000) * 92.4 - this.bgPhase;
    if (u === 2) {
      const tw = 326 * S;
      const o = -(sc % tw);
      const k = clear ? '_Clear' : '';
      const fade = clear ? Math.min(1, (wall - this.clearAt) / 200) : 0;
      const layer = (kk: string) => {
        for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/Main${kk}`, x, 0);
        for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/MT${kk}`, x, 102);
        for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/Surf${kk}`, x + 172, 44);
      };
      if (fade < 1) layer('');
      this.alpha(c, fade, () => layer('_Clear'));
      // 鯛とイカが 1 拍ずつ代わりばんこに、下の波の後ろから出てくる（参考動画を見て合わせた）
      const ph = (((beat + 0.9) % 2) + 2) % 2;
      const p = ph % 1;
      for (let x = o - tw; x < TW + tw; x += tw) {
        if (ph < 1) {
          // 鯛: 弧を描いて跳ねる。上がるときは頭が上、下りるときは頭が下
          const im = this.img('bg/Bg_up/2/Fish');
          const y = 250 - Math.sin(p * Math.PI) * 200;
          if (im) {
            c.save();
            c.translate(x + 330 - p * 180, y);
            c.rotate((p - 0.35) * 1.8);
            c.drawImage(im, (-im.width * S) / 2, (-im.height * S) / 2, im.width * S, im.height * S);
            c.restore();
          }
        } else {
          // イカ: くるっと回りながら上がって止まり、また回りながら下りる
          const up = p < 0.25 ? p / 0.25 : p > 0.75 ? (1 - p) / 0.25 : 1;
          const e = 1 - (1 - up) * (1 - up);
          const cell = up < 1 ? Math.min(8, Math.floor((1 - up) * 9)) : 0;
          const y = 260 - e * 170 + (up >= 1 ? Math.sin(p * Math.PI * 4) * 4 : 0);
          this.put(c, 'bg/Bg_up/2/Ika', x - 96, y, cell * (1230 / 9), 0, 1230 / 9, 136);
        }
      }
      // 下のうろこの帯
      const hc = clear ? 234 / 4 : 176 / 3;
      const hw = hc * S;
      for (let x = (o % hw) - hw; x < TW; x += hw) this.put(c, `bg/Bg_up/2/Hair${k}`, x, 195, 0, 0, hc, 54);
    } else {
      const tw = 335 * S;
      const o = -(sc % tw);
      const bob = Math.abs(Math.sin(beat * Math.PI)) * 14;
      // 3 段（桃・青・橙）のうち、ふだんは桃、クリアからは橙（0.2 秒で変わる）
      const fade = clear ? Math.min(1, (wall - this.clearAt) / 200) : 0;
      const layer = (v: number) => {
        for (let x = o - tw; x < TW; x += tw) this.put(c, 'bg/Bg_up/3/Base', x, 0, v * 335, 0, 335, 188);
        for (let x = o - tw, i = 0; x < TW + tw; x += tw, i++) this.put(c, 'bg/Bg_up/3/Chara', x + 60, 30 - bob, (i % 2) * 328, v * 233, 328, 233);
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

  // ---------- 下の背景・踊り子・帯 ----------

  private static readonly GLOW: Record<number, number[]> = { 1: [1], 2: [1], 3: [2, 5], 4: [1], 5: [1, 2, 3] };
  private static readonly LAYERS: Record<number, number> = { 1: 2, 2: 2, 3: 8, 4: 3, 5: 6 };

  private drawDown(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean, now: number) {
    const d = this.pick.down;
    const n = TndeSkin.LAYERS[d] ?? 1;
    const glow = TndeSkin.GLOW[d] ?? [];
    const pulse = 0.8 + 0.2 * Math.cos((((beat % 1) + 1) % 1) * Math.PI * 2);
    for (let i = 0; i < n; i++) {
      if (d === 4 && i === 3) continue;
      this.alpha(c, glow.includes(i) ? pulse : 1, () => this.put(c, `bg/Bg_down/${d}/${i}`, 0, 540));
    }
    if (d === 4) {
      for (let i = 0; i < 24; i++) {
        const q = (wall / 5000 + ((i * 0.37) % 1)) % 1;
        this.put(c, 'bg/Bg_down/4/3', ((i * 211) % TW) - q * 240 + Math.sin(wall / 700 + i) * 20, 560 + q * 470);
      }
    }
    if (clear) this.drawClearDown(c, wall, now);
    this.drawRollCharas(c, wall);
    this.drawDancers(c, beat, wall);
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
    const wrap = (x: number, w: number, f: (x: number) => void) => {
      const p = ((x % TW) + TW) % TW;
      f(p);
      if (p + w > TW) f(p - TW);
    };
    this.alpha(c, fade, () => {
      const piece = (name: string, x: number, y: number) => this.put(c, `bg/clear/${name}`, x, y);
      // 市松（動かない）と、上のふちの金の雲
      this.put(c, 'bg/clear/0_0', 0, 540, 0, 0, 1280, 392);
      // 大きな金の雲（1 秒に 57px 左へ）
      wrap(975 - 57 * t, 475 * S, (x) => piece('43_1575', x, 475));
      wrap(958 - 57 * t, 483 * S, (x) => piece('664_1760', x, 521));
      this.put(c, 'bg/clear/0_0', -24, 540, 0, 380, 1280, 77);
      this.put(c, 'bg/clear/0_0', -24 + TW, 540, 0, 380, 1280, 77);
      // 松と梅（1 秒に 90px 左へ。1920px でひと回り）
      for (const [name, x, y, w] of CLEAR_DECO) wrap(x - 90 * t, w * S, (xx) => piece(name, xx, y));
      // こま（動かない）
      piece('228_2176', 340, 582);
      piece('23_2660', 36, 765);
      piece('856_2853', 1284, 516);
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
    if (once && once.name.startsWith('chara/Balloon')) return; // 風船のどんちゃんは手前に描く
    if (wall < this.balloonUntil) return;
    if (once) {
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
    // ふだん・ゴーゴーは 4 拍、クリアは 2 拍でひと回り
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
    if (once.name === 'chara/Balloon_Breaking') {
      this.frame(c, once.name, step(wall, once.t, 32) % n, 0, 0);
      return;
    }
    const i = step(wall, once.t, 16);
    if (i < n) this.frame(c, once.name, i, 0, 0);
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
    for (const f of F.fx.flashes) flash(f.kind === 'don' ? 'lane/Red' : 'lane/Blue', f.t);
    for (const b of F.fx.bursts) if (b.judge !== 'bad') flash('lane/Yellow', b.t);
    this.put(c, 'taiko/frame3', P(329), P(136));
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
    this.add(c, 1, () => this.put(c, 'notes', jx - HALF, FIELD_Y, 0, 0, 130, 130));
    if (gogo) {
      const n = step(wall, 0, 50) % 7;
      const v = step(wall, this.gogoAt, 18);
      const k = v < FIRE_SCALE.length ? FIRE_SCALE[v] : 1;
      this.add(c, 1, () => this.putC(c, 'fx/Fire', jx, JUDGE_Y, 360 * n, 0, 360, 370, k));
    }
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

  private tintCv: HTMLCanvasElement | null = null;
  /** 音符の絵を、緑と青を g 倍にして（赤っぽくして）貼る */
  private tint(c: CanvasRenderingContext2D, g: number, x: number, y: number, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
    const im = this.img('notes');
    if (!im) return;
    if (g >= 0.999) {
      c.drawImage(im, sx, sy, sw, sh, x, y, dw, dh);
      return;
    }
    const cv = (this.tintCv ??= document.createElement('canvas'));
    const w = Math.max(1, Math.ceil(dw));
    const h = Math.max(1, Math.ceil(dh));
    if (cv.width < w) cv.width = w;
    if (cv.height < h) cv.height = h;
    const t = cv.getContext('2d')!;
    t.globalCompositeOperation = 'copy';
    t.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
    t.globalCompositeOperation = 'multiply';
    t.fillStyle = `rgb(255,${Math.round(255 * g)},${Math.round(255 * g)})`;
    t.fillRect(0, 0, w, h);
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(im, sx, sy, sw, sh, 0, 0, dw, dh);
    t.globalCompositeOperation = 'source-over';
    c.drawImage(cv, 0, 0, w, h, x, y, w, h);
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
    this.put(c, 'taiko/1P_Background', 0, P(184));
    const tx = P(207);
    const ty = P(205);
    this.put(c, 'taiko/Base', tx, ty);
    // 叩いた面が光る（明るさ 8 から 20 ms ごとに 1 ずつ下がる。濃さは 明るさ × 73 / 255）
    for (const f of F.fx.flashes) {
      const lv = 8 - step(wall, f.t, 20);
      if (lv <= 0) continue;
      const im = this.img(f.kind === 'don' ? 'taiko/Don' : 'taiko/Ka');
      if (!im) continue;
      const half = im.width / 2;
      const sx = f.side === 'L' ? 0 : half;
      this.alpha(c, Math.min(255, lv * 73) / 255, () => c.drawImage(im, sx, 0, half, im.height, tx + sx * S, ty, half * S, im.height * S));
    }
    this.put(c, COURSE_IMG[F.info.course] ?? 'course/Oni', P(28), P(232));
    this.drawNameplate(c, F);
  }

  /** ネームプレート（参考動画で測った位置。段位の欄は無いので、名前の欄を左まで伸ばす） */
  private drawNameplate(c: CanvasRenderingContext2D, F: TndeFrame) {
    const im = this.img('nameplate');
    if (!im) return;
    c.drawImage(im, 0, 164, 220, 52, 2, 447, 330, 78);
    c.fillStyle = '#000';
    rr(c, 50, 452, 268, 68, 30);
    c.fill();
    c.drawImage(im, 0, 330, 216, 28, 54, 452, 262, 32);
    c.fillStyle = '#fff';
    c.fillRect(66, 485, 249, 31);
    c.drawImage(im, 0, 0, 56, 56, -5, 441, 84, 84);
    c.save();
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `20px 'TNDE Seurat', sans-serif`;
    c.fillStyle = '#2a0748';
    fitText(c, F.title, 186, 468, 250);
    c.font = `28px 'TNDE Seurat', sans-serif`;
    c.lineJoin = 'round';
    c.lineWidth = 6;
    c.strokeStyle = '#fff';
    c.strokeText(F.name, 190, 501, 240);
    c.fillStyle = '#000';
    c.fillText(F.name, 190, 501, 240);
    c.restore();
  }

  // ---------- ゴーゴーの始まりの光 ----------

  private drawSplash(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('fx/GoGoSplash');
    if (!im) return;
    const n = Math.floor(im.width / 230);
    const i = step(wall, this.gogoAt, 15);
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
      name = 'taiko/Combo_Big';
      k = 0.8;
      pad = P(24);
      bottom = P(270);
      right = P(268 + 12 + 24 * (n === 4 ? 1 : Math.floor((n - 1) / 2)));
      ky = COMBO_SCALE_EX[v];
    }
    const im = this.img(name);
    if (!im) return;
    for (let i = 0; i < n; i++) {
      const d = +digits[n - 1 - i];
      const w = P(40) * k;
      const h = P(48) * (k + ky);
      c.drawImage(im, d * 40, 0, 40, 48, right - pad * i - w / 2, bottom - h, w, h);
    }
    // 3 桁から: 数字のまわりのきらきら（20 ms ごと、30 コマでひと回り）
    if (n >= 3) {
      const r = step(wall, 0, 20) % 30;
      const ey = (n === 3 ? bottom : P(270)) - P(48 / 4) * k;
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
    for (const b of F.fx.bursts) {
      if (b.judge === 'bad') continue;
      const i = step(wall, b.t, 25);
      if (i >= 0 && i < 7) {
        const row = (b.judge === 'good' ? 0 : 260) + (b.big ? 520 : 0);
        this.add(c, 1, () => this.put(c, 'fx/Explosion', jx - P(130), JUDGE_Y - P(130), i * 260, row, 260, 260));
      }
      const j = step(wall, b.t, 20);
      if (b.big && b.judge === 'good' && j >= 0 && j < 10) {
        this.add(c, 1, () => this.putC(c, 'fx/Explosion_Big', jx, JUDGE_Y, 0, 0, 260, 260, 0.5 + j * 0.05));
      }
    }
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

  private drawTitle(c: CanvasRenderingContext2D, F: TndeFrame) {
    const g = F.info.genre ?? '';
    const gk = GENRES.find(([re]) => re.test(g))?.[1];
    if (gk) this.put(c, `genre/${gk}`, 1518.4, 94.3, 0, 0, undefined, undefined, 1.45);
    const key = F.info.title;
    if (this.titleCache?.key !== key) {
      const cv = document.createElement('canvas');
      const t = cv.getContext('2d')!;
      const font = `52px 'TNDE Seurat', sans-serif`;
      t.font = font;
      const w = Math.ceil(t.measureText(key).width) + 24;
      cv.width = w;
      cv.height = 90;
      t.font = font;
      t.textAlign = 'center';
      t.textBaseline = 'middle';
      t.lineJoin = 'round';
      t.lineWidth = 16;
      t.strokeStyle = '#000';
      t.strokeText(key, w / 2, 47);
      t.fillStyle = '#fff';
      t.fillText(key, w / 2, 47);
      this.titleCache = { key, c: cv };
    }
    const cv = this.titleCache.c;
    c.drawImage(cv, Math.min(1732 - cv.width / 2, 1880 - cv.width), 72 - 47);
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
    // 連打の扇（40 ms ごと。0〜3 でひらき、4 のまま、最後に閉じる）
    const v = step(wall, this.rollAt, 40);
    if (r && !r.balloon && v >= 0 && v <= 66 && wall - r.t < 2700) {
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

function fitText(c: CanvasRenderingContext2D, t: string, x: number, y: number, max: number) {
  const w = c.measureText(t).width;
  if (w <= max) c.fillText(t, x, y);
  else {
    c.save();
    c.translate(x, y);
    c.scale(max / w, 1);
    c.fillText(t, 0, 0);
    c.restore();
  }
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

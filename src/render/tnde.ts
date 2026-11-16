import type { Course, Note } from '../chart/types';
import { CLEAR_LINE, type Game, type HitKind, type Judge } from '../engine/game';

/**
 * TNDE スキン（TaikoNijiiroDondaEX Ver4.1 用スキン）のプレイ画面。
 * 座標は 1920×1080 の画面の px（参考動画で測った値）。スキンの絵は 1280×720 用なので 1.5 倍で貼る
 */
export const TW = 1920;
export const TH = 1080;
const S = 1.5;
/** 判定枠の中心 */
export const TJX = 617;
export const TJY = 386;
/** ハイスピード 1.0・4/4 で 1 小節が流れる距離 */
export const T_MEASURE = 1424;
const LANE = { x: 499.5, y: 288, w: 1420.5, h: 195 };
const SUB_Y = 489;
const NOTE = 195;
const GAUGE = { x: 738, y: 217 };
const SOUL = { x: 1776, y: 188 };

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
  /** 音符の x（判定枠からの距離に掛ける前の「進み」: 4 分音符の数 × ハイスピード） */
  adv: (time: number, beat: number | undefined, n: { bpm: number; scroll: number }) => number;
  advY: (time: number, beat: number | undefined, n: { bpm: number; scrollY?: number }) => number;
  jpos: number;
  labels: (n: Note) => string | undefined;
  fx: TndeFx;
  name: string;
  title: string;
}

const SE_ROW: Record<string, number> = { ドン: 0, ド: 1, コ: 2, カッ: 3, カ: 4, 'ドン(大)': 5, 'カッ(大)': 6, 連打: 7, 'ー': 8, 'ーっ!!': 9, '連打(大)': 10, ふうせん: 11 };
const NOTE_COL: Record<string, number> = { don: 1, ka: 2, bigDon: 3, bigKa: 4, roll: 5, bigRoll: 8, balloon: 11 };
const COURSE_IMG: Record<string, string> = { Easy: 'course/Easy', Normal: 'course/Normal', Hard: 'course/Hard', Oni: 'course/Oni', Edit: 'course/Edit' };
const GENRES: [RegExp, string][] = [
  [/ポップ|pop/i, '1'], [/アニメ|anime/i, '2'], [/ゲーム|game/i, '3'], [/ボーカロイド|ボカロ|vocaloid/i, '8'], [/キッズ|どうよう|kids/i, '7'],
  [/バラエティ|variety/i, '4'], [/クラシック|classic/i, '6'], [/ナムコ|オリジナル|original/i, '5'],
];

/** 踊り子 1（3 人で 1 枚）の動き: [絵の番号, 長さ（16 分の数）]。16 拍で 1 回り（参考動画で数えた） */
const DANCE_A: [number, number][] = [[0, 2], [1, 2], [2, 2], [1, 2], [0, 2], [1, 2], [2, 1], [2, 1], [4, 1], [5, 1], [6, 2], [7, 2], [8, 2], [7, 2], [6, 2], [7, 2], [8, 2], [5, 2]];
const DANCE_B = [10, 11, 3, 11, 10, 11, 3, 11, 10, 13, 14, 15, 14, 13, 14, 15, 14, 13];

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

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
    const first = Object.keys(s.man.img);
    first.push(...Object.keys(s.man.anim));
    await Promise.all(first.map((k) => s.fetchImg(k)));
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

  /** 絵を 1.5 倍で貼る（sx..sh は絵の中の範囲、x, y は画面の位置） */
  private put(c: CanvasRenderingContext2D, name: string, x: number, y: number, sx = 0, sy = 0, sw?: number, sh?: number, k = S) {
    const im = this.img(name);
    if (!im) return;
    const w = sw ?? im.width - sx;
    const h = sh ?? im.height - sy;
    if (w <= 0 || h <= 0) return;
    c.drawImage(im, sx, sy, w, h, x, y, w * k, h * k);
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
    let lo = 0;
    let hi = bars.length - 1;
    if (now < bars[0].time) return ((now - bars[0].time) * bars[0].bpm) / 60;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (bars[m].time <= now) lo = m;
      else hi = m - 1;
    }
    return cum[lo] + ((now - bars[lo].time) * bars[lo].bpm) / 60;
  }

  /** 背景・踊り子を決める（指定しなければ曲名で決まる） */
  force: { up: number; down: number; dancer: number } | null = null;

  private choose(title: string) {
    if (this.force) { this.pick = { ...this.force, key: '' }; return; }
    if (this.pick.key === title) return;
    const h = hash(title);
    this.pick = { key: title, up: [2, 3][h % 2], down: [1, 2, 4, 5][(h >>> 3) % 4], dancer: (h >>> 7) % 2 ? 1 : 2 };
  }

  // ---------- 1 フレーム ----------

  draw(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { game, course, now, wall } = F;
    this.choose(F.title);
    const beat = this.beatOf(course, now);
    // 踊り子の振りは曲の音の始まり（0 秒）から数える
    const b0 = course.bars[0];
    this.dancePhase = b0 ? (b0.time * b0.bpm) / 60 + 0.55 : 0;
    const st = game.stats;
    const gogo = course.gogo.some(([a, b]) => now >= a && now < b);
    const clear = st.gauge >= CLEAR_LINE;
    c.imageSmoothingEnabled = true;
    this.watch(F, gogo);
    this.drawUp(c, wall, beat, clear);
    this.drawDown(c, wall, beat, clear);
    this.drawChara(c, beat, gogo, F);
    this.drawLane(c, F, beat, gogo);
    this.drawGauge(c, st.gauge, wall);
    this.drawPanel(c, F);
    this.drawJudgeFx(c, F, gogo);
    this.drawFlyers(c, F);
    this.drawRainbow(c, F);
    this.drawBubbles(c, F);
    this.drawTitle(c, F);
  }

  // ---------- 上の背景 ----------

  private drawUp(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean) {
    const u = this.pick.up;
    // 上の背景は 1 秒に 92.4px ずつ左へ流れる（参考動画で測った）
    const sc = (wall / 1000) * 92.4;
    if (u === 2) {
      const tw = 326 * S;
      const o = -(sc % tw);
      const k = clear ? '_Clear' : '';
      for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/Main${k}`, x, 0);
      for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/MT${k}`, x, 102);
      for (let x = o - tw; x < TW; x += tw) this.put(c, `bg/Bg_up/2/Surf${clear ? '_Clear' : ''}`, x + 172, 44);
      // 鯛とイカが、3 拍ずつ代わりばんこに下から出てくる
      const ph = (((beat / 3) % 2) + 2) % 2;
      const p = ph % 1;
      const rise = Math.sin(Math.min(1, p * 1.25) * Math.PI);
      for (let x = o - tw; x < TW + tw; x += tw) {
        if (ph < 1) {
          // 鯛: 波の上で右上から左下へ跳ねる
          const ang = (p - 0.5) * 1.4;
          const im = this.img('bg/Bg_up/2/Fish');
          if (im && rise > 0) {
            c.save();
            c.translate(x + 300 - p * 160, 250 - rise * 170);
            c.rotate(ang);
            c.drawImage(im, -im.width * S / 2, -im.height * S / 2, im.width * S, im.height * S);
            c.restore();
          }
        } else if (rise > 0) {
          const n = Math.floor(p * 18) % 9;
          this.put(c, 'bg/Bg_up/2/Ika', x - 96, 250 - rise * 200, n * (1230 / 9), 0, 1230 / 9, 136);
        }
      }
      const hw = (176 / 3) * S;
      for (let x = (o % hw) - hw; x < TW; x += hw) this.put(c, `bg/Bg_up/2/Hair${clear ? '_Clear' : ''}`, x, 195, 0, 0, clear ? 234 / 4 : 176 / 3, 54);
    } else {
      const tw = 335 * S;
      const o = -(sc % tw);
      for (let x = o - tw; x < TW; x += tw) this.put(c, 'bg/Bg_up/3/Base', x, 0, 0, 0, 335, 188);
      // ちくわと鳥の飾り: 1 拍ごとに弾む
      const bob = Math.abs(Math.sin(beat * Math.PI)) * 14;
      for (let x = o - tw, i = 0; x < TW + tw; x += tw, i++) {
        this.put(c, 'bg/Bg_up/3/Chara', x + 60, 30 - bob, (i % 2) * 328, 0, 328, 233);
      }
      // 花びら
      const im = this.img('bg/Bg_up/3/Flower');
      if (im) {
        for (let i = 0; i < 14; i++) {
          const q = ((wall / 6000 + i / 14) % 1);
          const px = ((i * 397) % TW) - q * 300 + 150;
          const py = q * 320 - 30;
          const cell = (i % 3) * 184;
          c.drawImage(im, 0, cell, 641, 184, px - 60, py - 20, 641 * 0.25, 184 * 0.25);
        }
      }
    }
  }

  // ---------- 下の背景・踊り子・帯 ----------

  /** 下の背景の重ね方: 光る絵（拍に合わせて明るさが変わる）の番号 */
  private static readonly GLOW: Record<number, number[]> = { 1: [1], 2: [1], 3: [2, 5], 4: [1], 5: [1, 2, 3] };
  private static readonly LAYERS: Record<number, number> = { 1: 2, 2: 2, 3: 8, 4: 3, 5: 6 };

  private drawDown(c: CanvasRenderingContext2D, wall: number, beat: number, clear: boolean) {
    const d = this.pick.down;
    const n = TndeSkin.LAYERS[d] ?? 1;
    const glow = TndeSkin.GLOW[d] ?? [];
    const pulse = 0.8 + 0.2 * Math.cos(((beat % 1) + 1) % 1 * Math.PI * 2);
    for (let i = 0; i < n; i++) {
      if (d === 4 && i === 3) continue;
      if (glow.includes(i)) {
        c.save();
        c.globalAlpha = pulse;
        this.put(c, `bg/Bg_down/${d}/${i}`, 0, 540);
        c.restore();
      } else this.put(c, `bg/Bg_down/${d}/${i}`, 0, 540);
    }
    if (d === 4) {
      // 舞う花びら
      for (let i = 0; i < 24; i++) {
        const q = ((wall / 5000 + (i * 0.37) % 1) % 1);
        const x = ((i * 211) % TW) - q * 240 + Math.sin(wall / 700 + i) * 20;
        const y = 560 + q * 470;
        this.put(c, 'bg/Bg_down/4/3', x, y);
      }
    }
    void clear;
    this.drawDancers(c, beat, wall);
    // ゴーゴーの始まり: 下から噴き上がる光
    const sp = Math.floor(((wall - this.splash) / 1000) * 30);
    if (sp >= 0 && sp < 15) for (let x = 40; x < TW; x += 380) this.put(c, 'fx/GoGoSplash', x, 1080 - 460 * S + 60, sp * 460, 0, 460, 460);
    // 帯（動かない。参考動画では絵を右へ 648px ずらした位置）
    this.put(c, 'footer1', 648, 1014);
    this.put(c, 'footer1', 648 - 1280 * S, 1014);
  }

  /** 踊り子（16 拍で 1 回りの振り付け）。1 匹ずつの組は、ゲージが増えると 4 匹目・5 匹目が出てくる */
  private drawDancers(c: CanvasRenderingContext2D, beat: number, wall: number) {
    const b16 = (((beat + this.dancePhase) * 4) % 64 + 64) % 64;
    let fr = 0;
    if (b16 < 32) {
      let t = b16;
      for (const [f, len] of DANCE_A) {
        if (t < len) { fr = f; break; }
        t -= len;
      }
    } else fr = DANCE_B[Math.floor(((b16 - 32) / 32) * 36) % 18];
    if (this.pick.dancer === 1) {
      this.frame(c, 'dancer/Normal1', fr, 427, 553);
      return;
    }
    const g = this.last.gauge;
    const xs: [number, number][] = [[502, 0], [822, 0], [1142, 0], [182, 50], [1462, CLEAR_LINE]];
    xs.forEach(([x, need], i) => {
      if (g < need) { this.inAt[i] = -1; return; }
      if (this.inAt[i] < 0) this.inAt[i] = need ? wall : -1e9;
      const name = `${2 + (i % 2)}`;
      const k = ((wall - this.inAt[i]) / 1000) * 30;
      if (k < this.count(`dancer/In${name}`)) this.frame(c, `dancer/In${name}`, k, x, 553);
      else this.frame(c, `dancer/Normal${name}`, fr, x, 553);
    });
  }
  private inAt = [-1, -1, -1, -1, -1];
  private dancePhase = 0;

  // ---------- どんちゃん ----------

  /** どんちゃんの 1 回だけの動き（10 コンボ・ゴーゴーの始まり・クリア・風船） */
  private charaOnce: { name: string; t: number } | null = null;
  private last = { combo: 0, gauge: 0, gogo: false, balloon: 0 };

  /** 状態の変わり目で、1 回だけの動き・演出を始める */
  private watch(F: TndeFrame, gogo: boolean) {
    const st = F.game.stats;
    const { wall } = F;
    const L = this.last;
    const max = st.gauge >= 100;
    if (st.combo < L.combo) this.reset();
    if (gogo && !L.gogo) {
      this.charaOnce = { name: max ? 'chara/GoGoStart_Max' : 'chara/GoGoStart', t: wall };
      this.splash = wall;
    } else if (st.gauge >= 100 && L.gauge < 100) this.charaOnce = { name: 'chara/Soulin', t: wall };
    else if (st.gauge >= CLEAR_LINE && L.gauge < CLEAR_LINE) this.charaOnce = { name: 'chara/Clearin', t: wall };
    else if (st.combo > L.combo && st.combo % 10 === 0 && (st.combo < 100 || st.combo % 100 === 0) && !gogo) {
      this.charaOnce = { name: max ? 'chara/10combo_Max' : 'chara/10combo', t: wall };
    }
    if (st.combo > L.combo && (st.combo === 50 || (st.combo >= 100 && st.combo % 100 === 0))) this.banner = { n: st.combo, t: wall };
    const r = F.fx.rollFx;
    if (r?.balloon && r.t !== L.balloon) {
      L.balloon = r.t;
      if (this.charaOnce?.name !== 'chara/Balloon_Breaking' || wall - this.charaOnce.t > 200) this.charaOnce = { name: 'chara/Balloon_Breaking', t: wall };
    }
    if (F.fx.rainbow !== null && F.fx.rainbow !== this.poppedAt) {
      this.poppedAt = F.fx.rainbow;
      this.charaOnce = { name: 'chara/Balloon_Broke', t: wall };
    }
    L.combo = st.combo;
    L.gauge = st.gauge;
    L.gogo = gogo;
  }
  private poppedAt: number | null = null;
  /** ゴーゴーの始まり（下の噴水） */
  private splash = -1e9;
  /** 50・100・200… コンボの巻物 */
  private banner: { n: number; t: number } | null = null;

  reset() {
    this.charaOnce = null;
    this.banner = null;
    this.splash = -1e9;
    this.last = { combo: 0, gauge: 0, gogo: false, balloon: 0 };
  }

  private drawChara(c: CanvasRenderingContext2D, beat: number, gogo: boolean, F: TndeFrame) {
    const st = F.game.stats;
    const { wall } = F;
    const once = this.charaOnce;
    if (once) {
      const n = this.count(once.name);
      // 絵は 1 秒に 30 枚（元の 60 枚を 1 枚おきにしてある）
      const i = ((wall - once.t) / 1000) * 30;
      const big = once.name.startsWith('chara/Balloon');
      if (i < n) {
        this.frame(c, once.name, i, big ? 0 : 0, big ? -60 : 0);
        return;
      }
      this.charaOnce = null;
    }
    const max = st.gauge >= 100;
    const clear = st.gauge >= CLEAR_LINE;
    const name = gogo ? (max ? 'chara/GoGo_Max' : 'chara/GoGo') : max ? 'chara/Clear_Max' : clear ? 'chara/Clear' : 'chara/Normal';
    const n = this.count(name);
    const ph = (((beat / (name === 'chara/Normal' || gogo ? 4 : 2)) % 1) + 1) % 1;
    this.frame(c, name, ph * n, 0, 0);
  }

  /** 連打の数（扇）・風船の数（吹き出し）・コンボの巻物 */
  private drawBubbles(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const r = F.fx.rollFx;
    if (r && wall - r.t < 600) {
      if (r.balloon) {
        // 風船: ふくらむ風船と、残りの数の吹き出し
        const left = Math.max(0, r.hits - r.count);
        const k = Math.min(5, Math.floor((r.count / Math.max(1, r.hits)) * 6));
        this.put(c, `balloon/Breaking_${k}`, 600, 170);
        this.put(c, 'balloon/Balloon', 560, 20);
        this.num(c, 'balloon/Number_Roll', left, 710, 80, 630 / 10, 75, 1);
      } else {
        // 連打: 扇がひらいて、数
        const p = Math.min(4, Math.floor((wall - r.t + 200) / 40));
        this.put(c, 'balloon/Roll', 470, 30, p * 334, 0, 334, 204, 1.1);
        this.num(c, 'balloon/Number_Roll', r.count, 655, 78, 630 / 10, 75, 1);
      }
    }
    const b = this.banner;
    if (b) {
      const ms = wall - b.t;
      if (ms > 2200) this.banner = null;
      else {
        const cell = ms < 80 ? 0 : ms < 160 ? 1 : 2;
        c.save();
        if (ms > 1900) c.globalAlpha = 1 - (ms - 1900) / 300;
        this.put(c, 'balloon/Combo_1P', 360, 18, cell * 360, 0, 360, 192, 1.2);
        if (cell === 2) {
          this.num(c, 'balloon/Number_Combo', b.n, 560, 80, 53, 61, 1.2, 0);
          this.put(c, 'balloon/Number_Combo', 610, 104, 0, 125, 80, 29, 1.2);
        }
        c.restore();
      }
    }
  }

  /** 数字（真ん中寄せ）。w, h = 1 文字の大きさ、row = 何段目 */
  private num(c: CanvasRenderingContext2D, name: string, v: number, cx: number, y: number, w: number, h: number, k: number, row = 0) {
    const im = this.img(name);
    if (!im) return;
    const s = String(Math.max(0, Math.floor(v)));
    const step = w * k * 0.92;
    const x0 = cx - (step * s.length) / 2;
    for (let i = 0; i < s.length; i++) c.drawImage(im, +s[i] * w, row * h, w, h, x0 + i * step, y, w * k, h * k);
  }

  // ---------- レーン ----------

  private drawLane(c: CanvasRenderingContext2D, F: TndeFrame, beat: number, gogo: boolean) {
    const { game, now, wall } = F;
    this.put(c, 'lane/Background_Main', LANE.x, LANE.y);
    if (gogo) this.put(c, 'lane/Background_GoGo', LANE.x, LANE.y);
    for (const f of F.fx.flashes) {
      const a = 1 - (wall - f.t) / 300;
      if (a <= 0) continue;
      c.save();
      c.globalAlpha = a;
      this.put(c, f.kind === 'don' ? 'lane/Red' : 'lane/Blue', LANE.x, LANE.y, 0, 0, 947, 130);
      c.restore();
    }
    this.put(c, 'lane/Background_Sub', LANE.x, SUB_Y);
    // 枠（レーンの縁・ゲージの台）
    this.put(c, 'taiko/frame3', 493.5, 205);

    const jx = TJX + F.jpos * S;
    // 判定枠
    this.put(c, 'notes', jx - NOTE / 2, TJY - NOTE / 2, 0, 0, 130, 130);
    c.save();
    c.globalAlpha = 0.5;
    this.put(c, 'chip', jx - NOTE / 2, TJY - NOTE / 2, 0, 0, 130, 130);
    c.restore();

    // ゴーゴー: 判定枠の後ろに炎
    if (gogo) {
      const n = Math.floor(wall / 50) % 7;
      c.save();
      c.globalAlpha = 0.75;
      this.put(c, 'fx/Fire', jx - 180, TJY - 250, n * 360, 0, 360, 370, 1);
      c.restore();
    }
    const X = (t: number, b: number | undefined, n: { bpm: number; scroll: number }) => jx + F.adv(t, b, n) * (T_MEASURE / 4);
    // 小節線
    c.save();
    c.beginPath();
    c.rect(LANE.x, 0, LANE.w, TH);
    c.clip();
    for (const b of F.course.bars) {
      const x = X(b.time, b.beat, b);
      if (x < LANE.x || x > TW) continue;
      this.put(c, 'bar', x - 1.5, LANE.y, 0, 0, 3, 130);
    }
    // 音符（後ろから）
    // 音符の顔: クリアまではにっこり、クリアからは半拍ごとに口を開けた顔とつり目の顔
    const row = game.stats.gauge >= CLEAR_LINE ? 1 + (Math.floor(beat * 2) & 1) : 0;
    const states = game.states;
    for (let i = states.length - 1; i >= 0; i--) {
      const s = states[i];
      const n = s.note;
      if (s.skip || (n.sec !== undefined && !game.active(n))) continue;
      const long = n.type === 'roll' || n.type === 'bigRoll' || n.type === 'balloon';
      if (s.done && !s.missed && !long) continue;
      let x = X(n.time, n.beat, n);
      const endX = n.endTime !== undefined ? X(n.endTime, n.endBeat, n) : x;
      if (Math.max(x, endX) < LANE.x - 200 || x > TW + 200) continue;
      const dy = n.scrollY ? F.advY(n.time, n.beat, n) * (T_MEASURE / 4) : 0;
      const y = TJY - NOTE / 2 + dy;
      if (n.type === 'balloon') {
        if (s.done && s.count >= (n.hits ?? 5)) continue;
        if (now > (n.endTime ?? n.time)) continue;
        if (now >= n.time) x = jx;
        this.put(c, 'notes', x - NOTE / 2 + NOTE, y, 12 * 130, row * 130, 130, 130);
        this.put(c, 'notes', x - NOTE / 2, y, 11 * 130, row * 130, 130, 130);
      } else if (n.type === 'roll' || n.type === 'bigRoll') {
        const col = NOTE_COL[n.type];
        const bx = Math.max(x, LANE.x - 100);
        if (endX > bx) {
          const im = this.img('notes');
          if (im) c.drawImage(im, (col + 1) * 130, row * 130, 130, 130, bx, y, endX - bx, NOTE);
        }
        this.put(c, 'notes', endX, y, (col + 2) * 130, row * 130, 130, 130);
        this.put(c, 'notes', x - NOTE / 2, y, col * 130, row * 130, 130, 130);
        // 連打の文字（連打 ーーー っ!!）
        const ty = SUB_Y + 2;
        const big = n.type === 'bigRoll';
        this.se(c, big ? '連打(大)' : '連打', x, ty);
        for (let sx = x + 60; sx < endX - 30; sx += 30) this.se(c, 'ー', sx, ty);
        this.se(c, 'ーっ!!', endX, ty);
        continue;
      } else {
        const col = NOTE_COL[n.type];
        this.put(c, 'notes', x - NOTE / 2, y, col * 130, row * 130, 130, 130);
      }
      const label = this.label(game, n, F.labels);
      if (label && x > LANE.x - 40) {
        const big = n.type === 'bigDon' || n.type === 'bigKa';
        this.se(c, big ? (n.type === 'bigDon' ? 'ドン(大)' : 'カッ(大)') : label, x, SUB_Y + 2 + dy);
      }
    }
    c.restore();
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
        const ok = !!nx && (nx.type === 'don' || nx.type === 'bigDon') && (!nn || nn.time - nx.time >= 60 / nx.bpm / 2 - 1e-3);
        m.set(notes[i], ok);
      }
      this.koCache.set(game, m);
    }
    return m.get(n) ? 'コ' : 'ド';
  }

  /** 音符の下の文字（SENotes の 1 行、中心 x） */
  private se(c: CanvasRenderingContext2D, label: string, x: number, y: number) {
    const r = SE_ROW[label];
    if (r === undefined) return;
    this.put(c, 'senotes', x - 68 * S, y, 0, r * 30, 136, 30);
  }

  // ---------- ゲージ ----------

  private drawGauge(c: CanvasRenderingContext2D, gauge: number, wall: number) {
    // ゲージはクリアが 80% の形（おに）。このアプリはどの難易度もクリアは 80%
    this.put(c, 'gauge/base3', GAUGE.x, GAUGE.y, 0, 0, 700, 46);
    const w = Math.floor(gauge / 2) * 14;
    if (gauge >= 100) {
      const n = this.count('gauge/rainbow0');
      this.frame(c, 'gauge/rainbow0', Math.floor(wall / 50) % n, GAUGE.x, GAUGE.y + 1);
    } else if (w > 0) this.put(c, 'gauge/fill3', GAUGE.x, GAUGE.y, 0, 0, w, 46);
    // クリアの字（届いたら明るい字）
    this.put(c, gauge >= CLEAR_LINE ? 'gauge/fill3' : 'gauge/base3', GAUGE.x + 546 * S, GAUGE.y + 2, 0, 46, 58, 20);
    if (gauge >= 100) {
      const n = Math.floor(wall / 40) % 8;
      this.put(c, 'gauge/Fire', SOUL.x + 60 - 115 * S, SOUL.y + 60 - 130 * S, n * 230, 0, 230, 230);
    }
    this.put(c, 'gauge/Soul', SOUL.x, SOUL.y, 0, gauge >= CLEAR_LINE ? 80 : 0, 80, 80);
  }

  // ---------- 左のパネル ----------

  private drawPanel(c: CanvasRenderingContext2D, F: TndeFrame) {
    const st = F.game.stats;
    const { wall } = F;
    this.put(c, 'taiko/1P_Background', 0, 276);
    this.put(c, COURSE_IMG[F.info.course] ?? 'course/Oni', 42, 348);
    // 点数（右寄せ）
    this.digits(c, 'taiko/Score', st.score, 231, 294.7, 293 / 10, 94 / 3, 0, 28.1, 1.32);
    // 太鼓
    this.put(c, 'taiko/Base', 310, 308);
    for (const f of F.fx.flashes) {
      const a = 1 - (wall - f.t) / 120;
      if (a <= 0) continue;
      c.save();
      c.globalAlpha = a;
      const im = this.img(f.kind === 'don' ? 'taiko/Don' : 'taiko/Ka');
      if (im) {
        const half = im.width / 2;
        const sx = f.side === 'L' ? 0 : half;
        c.drawImage(im, sx, 0, half, im.height, 310 + sx * S, 308, half * S, im.height * S);
      }
      c.restore();
    }
    // コンボ（3 桁で文字の間隔 47px・高さ 67px。「コンボ」の字は太鼓の面の下の方）
    if (st.combo >= 10) {
      const pop = Math.max(0, 1 - (wall - F.fx.comboPop) / 120);
      const name = st.combo >= 100 ? 'taiko/Combo_Big' : 'taiko/Combo';
      const digits = String(st.combo);
      const k = 1.4;
      const step = digits.length >= 4 ? 36 : digits.length === 3 ? 47 : 50;
      const cx = 403.5;
      const bottom = 407;
      const im = this.img(name);
      if (im) {
        const total = step * (digits.length - 1) + 40 * k;
        for (let i = 0; i < digits.length; i++) {
          const d = +digits[i];
          const h = 48 * k * (1 + pop * 0.12);
          c.drawImage(im, d * 40, 0, 40, 48, cx - total / 2 + i * step, bottom - h, 40 * k, h);
        }
      }
      this.put(c, 'taiko/Combo_Text', 327.6, 305, 0, 0, 100, 100, 1.4);
    }
    this.drawNameplate(c, F);
  }

  /** 数字（右寄せ）。cw, ch = 絵の 1 文字の大きさ。row = 何段目 */
  /** 数字（右寄せ）。last = 一の位の 1 文字の絵の左端、cw, ch = 絵の 1 文字の大きさ、row = 何段目、step = 文字の間隔 */
  private digits(c: CanvasRenderingContext2D, name: string, v: number, last: number, y: number, cw: number, ch: number, row: number, step: number, k = S) {
    const im = this.img(name);
    if (!im) return;
    const s = String(Math.max(0, Math.floor(v)));
    for (let i = 0; i < s.length; i++) {
      const d = +s[s.length - 1 - i];
      c.drawImage(im, d * cw, row * ch, cw, ch, last - i * step, y, cw * k, ch * k);
    }
  }

  /** ネームプレート（参考動画で測った位置。段位の欄は無いので、名前の欄を左まで伸ばす） */
  private drawNameplate(c: CanvasRenderingContext2D, F: TndeFrame) {
    const im = this.img('nameplate');
    if (!im) return;
    // 白い台（黒い縁つき）
    c.drawImage(im, 0, 164, 220, 52, 2, 447, 330, 78);
    // 中の黒
    c.fillStyle = '#000';
    rr(c, 50, 452, 268, 68, 30);
    c.fill();
    // 称号の帯（紫）
    c.drawImage(im, 0, 330, 216, 28, 54, 452, 262, 32);
    // 名前の欄
    c.fillStyle = '#fff';
    c.fillRect(66, 485, 249, 31);
    // 1P の丸
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

  // ---------- 判定の演出 ----------

  private drawJudgeFx(c: CanvasRenderingContext2D, F: TndeFrame, gogo: boolean) {
    const { wall } = F;
    const jx = TJX + F.jpos * S;
    for (const b of F.fx.bursts) {
      const ms = wall - b.t;
      const name = b.judge === 'good' ? (b.big ? 'fx/Great_Big' : 'fx/Great') : b.big ? 'fx/Good_Big' : 'fx/Good';
      const n = this.count(name);
      const i = Math.floor(ms / 25);
      if (i >= n) continue;
      this.frame(c, name, i, jx - 130 * S, TJY - 130 * S);
    }
    const j = F.fx.judgeFx;
    if (j) {
      const ms = wall - j.t;
      if (ms < 360) {
        const row = j.judge === 'good' ? 0 : j.judge === 'ok' ? 1 : 2;
        const up = ms < 60 ? (1 - ms / 60) * 12 : 0;
        c.save();
        if (ms > 260) c.globalAlpha = 1 - (ms - 260) / 100;
        this.put(c, 'judge', jx - 45 * S, 247 - up, 0, row * 60, 90, 60);
        c.restore();
      }
    }
  }

  private drawFlyers(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { wall } = F;
    const jx = TJX + F.jpos * S;
    const tx = SOUL.x + 60;
    const ty = SOUL.y + 60;
    for (const f of F.fx.flyers) {
      const p = (wall - f.t) / 420;
      if (p >= 1) {
        if (p < 1 + 18 * 25 / 420) {
          const k = Math.floor(((p - 1) * 420) / 25);
          this.put(c, 'gauge/1P_Explosion', tx - 90 * S, ty - 90 * S, k * 180, 0, 180, 180);
        }
        continue;
      }
      if (p < 0) continue;
      const x = jx + (tx - jx) * p;
      const y = TJY + (ty - TJY) * p - Math.sin(p * Math.PI) * 300;
      const col = NOTE_COL[f.note.type] ?? 1;
      this.put(c, 'notes', x - NOTE / 2, y - NOTE / 2, col * 130, 130, 130, 130);
    }
  }

  /** 風船が割れたときの虹（判定枠から魂ゲージへ） */
  private drawRainbow(c: CanvasRenderingContext2D, F: TndeFrame) {
    const t0 = F.fx.rainbow;
    if (t0 === null) return;
    const ms = F.wall - t0;
    if (ms < 0 || ms > 1600) return;
    const im = this.img('fx/Rainbow');
    if (!im) return;
    const w = 1260;
    const h = (im.height / im.width) * w;
    c.save();
    c.beginPath();
    c.rect(TJX - 60, 0, Math.min(1, ms / 400) * w, TH);
    c.clip();
    if (ms > 1200) c.globalAlpha = 1 - (ms - 1200) / 400;
    c.drawImage(im, TJX - 60, 60, w, h);
    c.restore();
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
    // 曲名はジャンルの帯の真ん中の上。長いときは右の端（1880）にそろえる
    const x = Math.min(1732 - cv.width / 2, 1880 - cv.width);
    c.drawImage(cv, x, 72 - 47);
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

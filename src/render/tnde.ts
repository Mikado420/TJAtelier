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
/** 下の帯の 赤・黄・緑 ひと組の幅（参考動画の px） */
const FOOT_SET = 384;
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

/** k: 絵が元の大きさ（w × h）の何倍の細かさで入っているか */
interface ImgInfo { f: string; w: number; h: number; k?: number }
/** pages: 大きな連番は何枚かに分けてある（1 枚に per コマずつ） */
interface AnimInfo { f: string; w: number; h: number; n: number; cols: number; step: number; k?: number; pages?: string[]; per?: number }
interface Manifest { img: Record<string, ImgInfo>; anim: Record<string, AnimInfo>; v?: string }

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
  /** 自己ベスト（超えたら「ベストスコア更新」を出す。無ければ出さない） */
  best?: number | null;
  /** 演奏オプションのドロン: 音符を描かない（下の文字は出す） */
  doron?: boolean;
  /** 演奏オプション（印を出す） */
  mods?: PlayMods | null;
  /** 動画用の画面: レーンと左のパネルだけ描く（背景・ゲージ・キャラ・曲名は描かない） */
  laneOnly?: boolean;
  /** エディタの見本（レーンだけ）。遊んだあとは、読み込んである絵をそのまま使う（手放したり読み直したりしない） */
  preview?: boolean;
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
  /** 曲の終わりの演出（t = 始まった時刻 ms） */
  end?: { kind: string; t: number } | null;
  /** 譜面分岐（分岐のある譜面だけ）: 今の分岐・前の分岐・切り替わりの進み（0〜1） */
  branch?: { cur: number; from: number; p: number } | null;
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
/**
 * のぼりの上の背景（Bg_up/0）の、鈴を持ったキャラの動き（参考動画「Glitch hoppin'」で 1 コマずつ測った）。
 * 1.8337 秒（ほぼ 110 コマ）で 1 回り: 大きく跳ねて速く左へ → 小さく 2 回はずんでゆっくり左へ。1 回りでちょうど 1 人ぶん（492px）左へ進む。
 * BELL_X は 1 回りの始めからの横のずれ、BELL_Y はコマの左上の y（どちらも 1920 の画面の px）
 */
const BELL_X = [0.0, -7.3, -14.5, -22.0, -29.5, -37.3, -45.0, -52.5, -60.0, -67.7, -75.5, -82.9, -90.3, -98.0, -106.2, -113.7, -121.4, -129.1, -136.9, -144.3, -151.8, -159.3, -166.8, -173.8, -181.0, -188.0, -195.0, -201.7, -208.5, -215.0, -222.0, -228.0, -234.0, -239.7, -241.3, -243.3, -245.3, -248.0, -250.3, -252.3, -254.3, -257.0, -259.3, -261.3, -262.1, -265.1, -268.3, -270.3, -272.3, -275.0, -277.0, -279.3, -281.3, -283.7, -286.0, -288.3, -290.3, -292.7, -294.9, -297.3, -299.3, -301.4, -304.0, -306.3, -308.4, -310.3, -313.0, -315.3, -317.3, -319.3, -322.1, -324.3, -326.3, -328.4, -331.0, -333.0, -335.3, -337.7, -340.0, -342.0, -344.7, -346.6, -349.0, -351.3, -353.6, -355.6, -357.9, -360.3, -362.6, -364.9, -366.9, -369.2, -371.3, -377.4, -383.3, -389.3, -396.0, -402.0, -408.3, -415.0, -421.3, -428.0, -435.0, -442.0, -448.7, -455.7, -463.0, -470.0, -477.0, -484.3];
const BELL_Y = [-50.0, -52.1, -53.5, -55.0, -57.1, -58.1, -59.1, -60.1, -61.1, -61.6, -62.1, -62.1, -62.1, -62.1, -62.1, -61.6, -61.2, -60.3, -59.3, -57.8, -56.3, -54.2, -52.2, -50.3, -48.2, -45.2, -42.7, -39.7, -36.2, -33.1, -29.1, -25.1, -21.1, -17.1, -17.1, -15.1, -12.1, -10.1, -8.1, -6.1, -4.1, -3.1, -1.1, -0.1, 1.8, 2.9, 3.9, 4.9, 4.9, 5.9, 5.9, 6.9, 6.9, 6.9, 6.0, 4.9, 2.9, 2.0, 1.0, 0.1, -1.1, -3.1, -4.1, -5.1, -6.0, -7.1, -9.1, -10.1, -11.0, -12.1, -13.0, -15.1, -16.1, -17.1, -15.2, -12.4, -10.4, -8.4, -6.5, -4.4, -3.4, -1.5, -0.4, 1.2, 2.2, 3.3, 4.3, 4.6, 5.2, 5.6, 6.2, 6.2, 6.2, 2.3, -1.8, -5.8, -9.4, -13.4, -16.4, -20.4, -23.4, -26.4, -29.4, -32.4, -35.4, -38.4, -41.1, -43.4, -45.4, -47.9];
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

/** 大きな動きの絵（選曲画面にいる間・リザルトの間は持たない）: どんちゃんのふだん以外の動き・踊り子の出てくる動き・ゴーゴーの光 */
const HEAVY = /^(chara\/(?!Normal$)|dancer\/In|fx\/GoGoSplash$)/;
/** 読む順（小さいほど先） */
function prio(n: string) {
  if (/^(bg\/|lane\/|notes$|senotes$|taiko\/|gauge\/|course\/|nameplate|chara\/Normal$|dancer\/Normal|judge|chip$|game|footer|load\/|res\/)/.test(n)) return 0;
  if (HEAVY.test(n)) return 2;
  return 1;
}

/** 風船・ゴーゴーの動きの絵を、何秒前から持つか・何秒先まで無ければ手放すか */
const EV_AHEAD = 25;
const EV_KEEP = 40;

/** 譜面に風船・ゴーゴーがあるか（balloonAt・gogoAt: 遊び始めてから最初の風船・ゴーゴーまでの秒数） */
export interface SkinNeed { balloon: boolean; gogo: boolean; balloonAt?: number; gogoAt?: number }

/** 演奏オプション */
export interface PlayMods { speed: number; doron: boolean; mirror: boolean; random: 'off' | 'kimagure' | 'detarame'; auto: boolean }
/** はやさの印がある値（mode/speed の並び。1.0 は印なし） */
const MOD_SPEEDS = [0.5, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.3, 2.4, 2.5, 3, 3.5, 4];

/** 譜面分岐の始まりの小節線の色 */
const BRANCH_BAR = '#ffd400';

export class TndeSkin {
  /** 読み込んだ絵（ImageBitmap にして、描くたびに読み直されないようにする。作れなかったときだけ img） */
  private imgs = new Map<string, ImageBitmap | HTMLImageElement>();
  private loading = new Map<string, Promise<ImageBitmap | HTMLImageElement | null>>();
  private man!: Manifest;
  ready = false;
  private beatTab: { course: Course; cum: number[] } | null = null;
  /** 曲ごとに決める背景（上・下）と踊り子 */
  private pick = { up: 2, down: 5, dancer: 1, clr: 0, key: '' };
  /** 読み込んである絵の組（背景・踊り子） */
  private loadedSet = '';

  constructor(private readonly base: string) {}

  static async load(base: string, title?: string) {
    const s = new TndeSkin(base);
    // 絵を差し替えたとき、古い skin.json が残らないように
    const r = await fetch(`${base}skin.json`, { cache: 'no-cache' });
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
    // 曲が決まるまでは、どの曲でも使う絵だけを裏で読む（大きな動き・曲ごとの背景は曲を始めるときに）。
    // 待つのはネームプレートだけ（選曲画面をすぐに出す）
    if (title !== undefined) { s.choose(title); await s.sync(); }
    else {
      s.dormant = true;
      void s.sync();
      await Promise.all(['nameplate', 'nameplate_frames'].map((n) => s.fetchImg(n)));
    }
    s.ready = true;
    return s;
  }

  /**
   * プレイ画面を離れるとき（選曲画面などへ戻るとき）: 曲ごとの絵（背景・踊り子・モブ）・終わりの演出・
   * 満タンのどんちゃん・読み込み画面・リザルト画面の絵を手放す（iPhone でメモリが足りずに落ちないように）
   */
  release(keepScreens = false) {
    if (this.force) return;
    // 選曲画面で使う絵（ネームプレート・称号のキラキラ）と、読み込み画面の絵だけ残す
    this.dormant = true;
    this.pick = { ...this.pick, key: '' };
    this.maxWant = false;
    this.inWant = false;
    this.clearWant = false;
    this.endWant.clear();
    // （どの曲でも使う絵は持ったまま。次の曲がすぐ始まるように）
    if (!keepScreens) {
      this.dropScreen('load');
      this.dropScreen('res');
    }
    void this.sync();
  }

  /** プレイ画面を離れている（どの曲でも使う絵だけ持っておく。大きな動き・曲ごとの背景は手放す） */
  private dormant = false;

  /** 曲を始める前に、その曲で使う絵を読み込んでおく */
  async prepare(title: string, need?: SkinNeed) {
    this.dormant = false;
    // 曲の始めから少しの間に風船・ゴーゴーが無ければ、その動きの絵はあとで読む
    this.inWant = false;
    this.evBalloon = (need?.balloonAt ?? 0) < EV_AHEAD;
    this.evGogo = (need?.gogoAt ?? 0) < EV_AHEAD;
    // エディタのプレビュー（レーンだけ）で決めた「背景は要らない」をプレイ用に戻す（読み込み画面の間に背景・踊り子も読む）
    this.played = true;
    if (this.view === 'lane') this.view = '';
    this.clearWant = false;
    this.maxWant = false;
    if (need) this.need = need;
    this.choose(title);
    await this.sync();
    // 大きな動きの絵（どんちゃんの 10 コンボ・すぐ来るゴーゴーや風船など）も、読み込み画面の間に読み終えておく
    // （スマホでは後から読むと、使うときに間に合わず出なかったり遅れたりする。長くても 8 秒まで待つ）
    const heavy = [...Object.keys(this.man.img), ...Object.keys(this.man.anim)].filter((n) => prio(n) === 2 && this.wants(n)).map((n) => this.fetchImg(n));
    await Promise.race([Promise.all(heavy), new Promise((r) => setTimeout(r, 8000))]);
  }

  /** 今の曲で使う絵か（背景・踊り子・ゲージは曲や難易度ごとに 1 組だけ使う） */
  private wants(name: string) {
    const p = this.pick;
    if (this.dormant && HEAVY.test(name)) return false;
    const v = this.view;
    if ((v === 'full' || v === 'lane') && /^bg\/Bg_up\//.test(name)) return false;
    if (v && /^(bg\/(Bg_down|clear)\/|dancer\/|mob$|footer)/.test(name)) return false;
    if (v === 'lane' && /^(chara\/|fx\/GoGoSplash$)/.test(name)) return false;
    // 曲が決まるまでは、曲ごとに変わる絵（背景・踊り子・モブ）は読み込まない
    if (!p.key && !this.force && /^(bg\/Bg_(up|down)\/|dancer\/Normal1$|mob$)/.test(name)) return false;
    let m = /^bg\/Bg_up\/([^/]+)\//.exec(name);
    if (m) return m[1] === String(p.up);
    // クリアの下の背景: 曲ごとに 2 つのうち 1 つ（c/0 は切り分けた bg/clear/ を使う）。魂ゲージが半分を超えてから読む
    if (name.startsWith('bg/Bg_down/c/')) return name.startsWith('bg/Bg_down/c/1/') && p.clr === 1 && this.clearWant;
    if (name.startsWith('bg/clear/')) return p.clr === 0;
    m = /^bg\/Bg_down\/([^/]+)\//.exec(name);
    if (m) return m[1] === String(p.down);
    if (/^gauge\/(base|fill|rainbow)\d$/.test(name)) return name.endsWith('3');
    if (/^footer\d$/.test(name)) return name === 'footer1';
    if (name === 'dancer/In1') return false;
    if (name.startsWith('dancer/In')) return this.inWant;
    if (name === 'dancer/Normal1') return p.dancer === 1;
    if (name === 'mob') return p.down !== 5;
    if (name.startsWith('end/')) return this.endWant.has(endGroup(name));
    if (/^(load|res)\//.test(name)) return this.screenWant.has(name.slice(0, name.indexOf('/')));
    // 譜面に無い動き（風船・ゴーゴー）の絵は読まない。クリアの動きは魂ゲージが半分を超えてから
    if (/^chara\/Balloon_/.test(name)) return this.need.balloon && this.evBalloon;
    if (/^(chara\/GoGo|fx\/GoGoSplash$)/.test(name) && !(this.need.gogo && this.evGogo)) return false;
    if (/^chara\/(Clear|Clearin|Soulin)$/.test(name)) return this.clearWant;
    if (name.startsWith('chara/') && name.endsWith('_Max')) return this.maxWant;
    return true;
  }

  /** 読む絵の組の名前（変わったら読み直す） */
  private setKey() {
    return `${this.dormant ? 'z' : ''}${this.pick.key ? '' : '-'}${this.pick.up}|${this.pick.down}|${this.pick.dancer}|${this.pick.clr}|${+(this.need.balloon && this.evBalloon)}${+(this.need.gogo && this.evGogo)}${+this.clearWant}${+this.maxWant}${+this.inWant}|${this.view}`;
  }
  /** 隠れていて描かない所（full: 上下の背景・踊り子、bottom: 下の背景・踊り子、lane: レーンと左のパネルだけ） */
  private view: '' | 'full' | 'bottom' | 'lane' = '';
  /** 一度でもプレイ画面で描いたか */
  private played = false;

  /** 譜面に風船・ゴーゴーがあるか（無ければその動きの絵を読まない） */
  private need: SkinNeed = { balloon: true, gogo: true };
  /**
   * 風船・ゴーゴーの大きな動きの絵（どんちゃん・ゴーゴーの光）を持つか。
   * その少し前（EV_AHEAD 秒）から持ち、しばらく（EV_KEEP 秒先まで）無ければ手放す（iPhone でメモリが足りずに落ちないように）
   */
  /** 踊り子の出てくる動き（魂ゲージが 15% を超えてから読む。出てくるのは 4 割から） */
  private inWant = false;
  private evBalloon = true;
  private evGogo = true;
  private evTimes = new WeakMap<Course, { balloon: [number, number][]; gogo: [number, number][] }>();
  private eventWants(course: Course, now: number, wall: number) {
    let t = this.evTimes.get(course);
    if (!t) {
      t = { balloon: course.notes.filter((n) => n.type === 'balloon').map((n) => [n.time, n.endTime ?? n.time] as [number, number]), gogo: course.gogo };
      this.evTimes.set(course, t);
    }
    const near = (list: [number, number][], ahead: number) => list.some(([a, b]) => a - ahead <= now && now <= b + 3);
    // 風船のどんちゃんが動いている間は手放さない
    const busy = this.charaOnce?.name.startsWith('chara/Balloon') || wall < this.balloonUntil;
    this.evBalloon = busy || near(t.balloon, this.evBalloon ? EV_KEEP : EV_AHEAD);
    this.evGogo = near(t.gogo, this.evGogo ? EV_KEEP : EV_AHEAD);
  }
  /** クリアの動きの絵（魂ゲージが半分を超えてから読み込む） */
  private clearWant = false;
  private wantClear() {
    if (this.clearWant) return;
    this.clearWant = true;
    for (const n of ['chara/Clear', 'chara/Clearin', 'chara/Soulin']) void this.fetchImg(n);
  }

  /** 魂ゲージが満タンのどんちゃんの絵（大きいので、ゲージが 8 割を超えてから読み込む） */
  private maxWant = false;
  private wantMax() {
    if (this.maxWant) return;
    this.maxWant = true;
    for (const n of Object.keys(this.man.anim)) if (n.startsWith('chara/') && n.endsWith('_Max') && this.wants(n)) void this.fetchImg(n);
  }

  /** 曲の終わりの演出の絵は、要りそうになってから読み込む（clear・fc・dfc） */
  private endWant = new Set<string>();
  needEnd(kinds: string[]) {
    let add = false;
    for (const k of kinds) if (!this.endWant.has(k)) { this.endWant.add(k); add = true; }
    if (!add) return;
    for (const n of Object.keys(this.man.img)) if (n.startsWith('end/') && this.endWant.has(endGroup(n))) void this.fetchImg(n);
  }

  // ---------- 曲の読み込み画面・リザルト画面（tndescreens.ts から使う） ----------

  private screenWant = new Set<string>();
  /** 読み込み画面（load）・リザルト画面（res）の絵を読み込む（全部そろうまで待つ） */
  needScreen(kind: 'load' | 'res'): Promise<void> {
    this.screenWant.add(kind);
    const names = [...Object.keys(this.man.img), ...Object.keys(this.man.anim)].filter((n) => n.startsWith(`${kind}/`));
    return Promise.all(names.map((n) => this.fetchImg(n))).then(() => {});
  }
  /** 使い終わった画面の絵を手放す（メモリを空ける） */
  dropScreen(kind: 'load' | 'res') {
    if (!this.screenWant.delete(kind)) return;
    for (const n of [...Object.keys(this.man.img), ...Object.keys(this.man.anim)]) {
      if (!n.startsWith(`${kind}/`)) continue;
      for (const key of this.keysOf(n)) {
        const im = this.imgs.get(key);
        if (im && 'close' in im) im.close();
        this.imgs.delete(key);
        this.loading.delete(key);
      }
    }
  }
  /** 絵（読み込めていなければ null） */
  pic(name: string) {
    return this.img(name);
  }
  /** 絵の情報（切り出した絵は、元の絵での位置 x, y と元の大きさ ow, oh） */
  meta(name: string): { w: number; h: number; x?: number; y?: number; ow?: number; oh?: number; n?: number; cols?: number } | null {
    return (this.man.img[name] ?? this.man.anim[name] ?? null) as never;
  }
  /** 読み込み画面のヒントの数 */
  get hintCount() {
    return (this.man as unknown as { loadHints?: number }).loadHints ?? 0;
  }
  /** 元の大きさの単位で描く（細かくしてある絵も同じ座標で） */
  blit(c: CanvasRenderingContext2D, im: CanvasImageSource, a0: number, a1: number, a2?: number, a3?: number, a4?: number, a5?: number, a6?: number, a7?: number) {
    this.di(c, im, a0, a1, a2, a3, a4, a5, a6, a7);
  }
  /** 連番の n コマ目を (x, y) に k 倍で */
  anim(c: CanvasRenderingContext2D, name: string, n: number, x: number, y: number, k = S) {
    this.frame(c, name, n, x, y, k);
  }
  /** 不透明度をかけて描く */
  fade(c: CanvasRenderingContext2D, a: number, f: () => void) {
    this.alpha(c, a, f);
  }
  /** ネームプレート（称号のキラキラも）を、プレイ画面の位置から (dx, dy) ずらして描く */
  plate(c: CanvasRenderingContext2D, F: Pick<TndeFrame, 'name' | 'title' | 'profile' | 'wall'>, dx: number, dy: number) {
    const G = F as TndeFrame;
    c.save();
    c.translate(dx, dy);
    this.drawNameplate(c, G, false);
    if ((F.profile ?? DEFAULT_PROFILE).titleStyle !== 'wood') this.drawTitleShine(c, F.wall);
    this.drawNameplate(c, G, true);
    c.restore();
  }

  /** 使う絵を読み込み、使わない絵を手放す */
  private sync() {
    const set = this.setKey();
    const names = [...Object.keys(this.man.img), ...Object.keys(this.man.anim)];
    if (set !== this.loadedSet) {
      this.loadedSet = set;
      let freed = false;
      for (const n of names) {
        if (this.wants(n)) continue;
        for (const key of this.keysOf(n)) {
          const im = this.imgs.get(key);
          if (im) freed = true;
          if (im && 'close' in im) im.close();
          this.imgs.delete(key);
          this.loading.delete(key);
        }
      }
      // 絵を手放したときだけ、まとめた絵を作り直す（足すだけのときは今のままで同じ見た目。全部を一度に作り直すとカクつく）
      if (freed) this.dropCaches();
    }
    // 読む順: 背景・レーン・音符などの画面の土台 → 演出 → 大きな動き（どんちゃんの GoGo など）
    const want = names.filter((n) => this.wants(n)).sort((a, b) => prio(a) - prio(b));
    const all = want.map((n) => [n, this.fetchImg(n)] as const);
    // 待つのは大きな動き以外（大きな動きは裏で読み続ける。始まってすぐには使わない）
    return Promise.all(all.filter(([n]) => prio(n) < 2).map(([, p]) => p)).then(() => {});
  }

  /** 絵を置いておく名前（分けてある連番は、2 枚目から name#1, name#2, …） */
  private keysOf(name: string) {
    const pages = this.man.anim[name]?.pages;
    return pages && pages.length > 1 ? pages.map((_, i) => (i ? `${name}#${i}` : name)) : [name];
  }

  private retries = new Map<string, number>();
  private fetchImg(name: string) {
    const info = this.man.img[name] ?? this.man.anim[name];
    if (!info) return Promise.resolve(null);
    const files = (info as AnimInfo).pages ?? [info.f];
    const keys = this.keysOf(name);
    return Promise.all(keys.map((key, i) => this.fetchOne(key, files[i], info.k))).then((r) => r[0]);
  }

  private fetchOne(key: string, file: string, k?: number) {
    let p = this.loading.get(key);
    if (p) return p;
    const url = this.base + file + (this.man.v ? `?v=${this.man.v}` : '');
    p = this.queue(() => loadBitmap(url)).then((v) => {
      if (!v) {
        // 読み込めなかった絵は、少し待って読み直す（混んでいて時間切れになったときに、背景などが消えたままにならないように）
        if (this.loading.get(key) === p) {
          this.loading.delete(key);
          const name = key.replace(/#\d+$/, '');
          const tries = (this.retries.get(key) ?? 0) + 1;
          this.retries.set(key, tries);
          if (tries <= 5) setTimeout(() => { if (this.wants(name)) void this.fetchOne(key, file, k); }, 1000 * tries);
        }
        return null;
      }
      this.retries.delete(key);
      if (this.loading.get(key) !== p) { if ('close' in v) v.close(); return null; }
      if (k && k !== 1) this.hq.set(v, k);
      this.imgs.set(key, v);
      this.warm.push(v);
      return v;
    });
    this.loading.set(key, p);
    return p;
  }

  /** 連番の絵がすべて読み込めているか */
  private animReady(name: string) {
    return this.keysOf(name).every((key) => this.imgs.has(key));
  }

  private img(name: string) {
    return this.imgs.get(name) ?? null;
  }

  /** 細かくしてある絵（元の大きさの何倍の細かさで入っているか） */
  private hq = new WeakMap<object, number>();
  private qOf(im: CanvasImageSource) {
    return this.hq.get(im as object) ?? 1;
  }
  /** 絵の元の大きさ（細かくしてあっても、元の絵の px で） */
  private lw(im: CanvasImageSource) {
    return (im as { width: number }).width / this.qOf(im);
  }
  private lh(im: CanvasImageSource) {
    return (im as { height: number }).height / this.qOf(im);
  }
  /** 絵を貼る。絵の中の範囲は元の絵の px で書き、細かくしてある絵はその倍率で読む */
  private di(c: CanvasRenderingContext2D, im: CanvasImageSource, a0: number, a1: number, a2?: number, a3?: number, a4?: number, a5?: number, a6?: number, a7?: number) {
    // 毎フレーム何百回も呼ぶので、配列を作らない（作るとごみが増えて、iPhone でときどき止まる）
    if (a7 !== undefined) {
      const q = this.qOf(im);
      // 1.5 倍の絵は端が 1 px 足りないことがある。はみ出して切り出すと iPhone では何も描かれないので、絵の中に収める
      let sx = a0 * q, sy = a1 * q, sw = a2! * q, sh = a3! * q;
      let dw = a6!, dh = a7;
      const W = (im as { width: number }).width;
      const H = (im as { height: number }).height;
      if (sx + sw > W) { const w = W - sx; dw *= w / sw; sw = w; }
      if (sy + sh > H) { const h = H - sy; dh *= h / sh; sh = h; }
      if (sw <= 0 || sh <= 0) return;
      c.drawImage(im, sx, sy, sw, sh, a4!, a5!, dw, dh);
    }
    else if (a3 !== undefined) c.drawImage(im, a0, a1, a2!, a3);
    else c.drawImage(im, a0, a1, this.lw(im), this.lh(im));
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
    const w = sw ?? this.lw(im) - sx;
    const h = sh ?? this.lh(im) - sy;
    if (w <= 0 || h <= 0) return;
    this.di(c, im, sx, sy, w, h, x, y, w * kx, h * ky);
  }

  /** レーンの絵を貼る。絵は 1 px ほど右端に届かないので、横は画面の右端までちょうどに伸ばす（ky = 縦の倍率） */
  private putLane(c: CanvasRenderingContext2D, name: string, y: number, ky = 1) {
    const im = this.img(name);
    if (!im) return;
    this.put(c, name, LANE_X, y, 0, 0, undefined, undefined, (TW - LANE_X) / this.lw(im), S * ky);
  }

  /** 絵の範囲を、(cx, cy) を中心に k 倍（1.5 倍の上にさらに）で貼る */
  private putC(c: CanvasRenderingContext2D, name: string, cx: number, cy: number, sx: number, sy: number, sw: number, sh: number, k = 1) {
    const w = sw * S * k;
    const h = sh * S * k;
    this.put(c, name, cx - w / 2, cy - h / 2, sx, sy, sw, sh, S * k);
  }

  /** 連番の絵の n 番目 */
  private frame(c: CanvasRenderingContext2D, name: string, n: number, x: number, y: number, k = S) {
    // 魂ゲージが満タンのどんちゃんの絵は、満タンが近づいてから読み込む（読み込み中はふだんの絵で）
    if (!this.animReady(name) && name.startsWith('chara/') && name.endsWith('_Max')) name = name.slice(0, -4);
    // どんちゃんのふだん以外の動きがまだ読めていないときは、ふだんの動きで（消えないように）
    if (name.startsWith('chara/') && name !== 'chara/Normal' && !this.animReady(name) && this.animReady('chara/Normal')) {
      const nm = this.man.anim['chara/Normal'];
      if (nm) n = ((Math.floor(n) % nm.n) + nm.n) % nm.n;
      name = 'chara/Normal';
    }
    const a = this.man.anim[name];
    if (!a) return;
    const i = Math.max(0, Math.min(a.n - 1, Math.floor(n)));
    // 分けてある連番は、何枚目の何コマ目か
    const per = a.pages && a.pages.length > 1 ? a.per ?? a.n : a.n;
    const pg = Math.floor(i / per);
    const j = i - pg * per;
    const im = this.imgs.get(pg ? `${name}#${pg}` : name);
    if (!im) return;
    this.di(c, im, (j % a.cols) * a.w, Math.floor(j / a.cols) * a.h, a.w, a.h, x, y, a.w * k, a.h * k);
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
    for (const cv of this.tinted.values()) cv.width = cv.height = 0;
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
  force: { up: number; down: number; dancer: number; clr?: number } | null = null;

  private choose(title: string) {
    if (this.force) { this.pick = { clr: 0, ...this.force, key: '' }; return; }
    if (this.pick.key === title) return;
    const h = hash(title);
    this.pick = { key: title, up: [0, 1, 2, 3][h % 4], down: [1, 2, 4, 5][(h >>> 3) % 4], dancer: (h >>> 7) % 2 ? 1 : 2, clr: (h >>> 11) % 2 };
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
    this.addPops = [];
    this.rankPops = [];
    this.bestAt = -1;
  }

  /** スコアの加算の数字（出た時刻） */
  private addPops: { v: number; t: number }[] = [];
  /** スコアランクの絵（何番目・出た時刻） */
  private rankPops: { i: number; t: number }[] = [];
  /** 自己ベストを超えた時刻（-1 = まだ） */
  private bestAt = -1;

  /** 加算の数字: 右から入ってきて止まり、少し上がってから下へ消える（TJAPlayer3 系と同じ動き。1 目盛り 2ms） */
  private drawAddPops(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('taiko/Score');
    if (!im) return;
    this.addPops = this.addPops.filter((p) => wall - p.t < 930);
    const cw = this.lw(im) / 10;
    const ch = this.lh(im) / 3;
    for (const p of this.addPops) {
      const v = (wall - p.t) / 2;
      const xAdd = v < 10 ? 25 : v < 20 ? 10 : v < 30 ? -5 : v < 40 ? -9 : v < 50 ? -10 : v < 60 ? -9 : v < 70 ? -5 : v < 80 ? -3 : 0;
      let a = v < 10 ? 150 : v < 20 ? 200 : v < 30 ? 250 : 256;
      let yAdd = 0;
      if (v > 120) yAdd = -1;
      if (v > 130) yAdd = -5;
      if (v > 140) yAdd = -7;
      if (v > 150) yAdd = -8;
      if (v > 170) yAdd = -6;
      if (v > 180) yAdd = 0;
      if (v > 190) { yAdd = 5; a = 200; }
      if (v > 200) { yAdd = 12; a = 150; }
      if (v > 210) { yAdd = 20; a = 0; }
      if (a <= 0) continue;
      const s = String(p.v).padStart(7, ' ');
      this.alpha(c, Math.min(1, a / 256), () => {
        for (let i = 0; i < 7; i++) {
          if (s[i] === ' ') continue;
          // スコアの 40（1280×720）上に、同じ桁の位置で
          this.di(c, im, +s[i] * cw, ch, cw, ch, 52.5 + 29.5 * i + P(xAdd), 336.5 - 60 + P(yAdd) - ch * S, cw * S, ch * S);
        }
      });
    }
  }

  /** スコアランク: 下から 0.25 秒で出て、少し大きくなって戻り、3 秒で上へ消える */
  private drawRankPops(c: CanvasRenderingContext2D, wall: number) {
    const im = this.img('game/ScoreRank');
    if (!im) return;
    this.rankPops = this.rankPops.filter((p) => wall - p.t < 3000);
    for (const p of this.rankPops) {
      const v = wall - p.t;
      let a = 1;
      let k = 1;
      let y = 0;
      if (v <= 255) { a = v / 255; y = (v / 255 - 1) * -20; }
      else if (v <= 435) k = 1 + Math.sin(((v - 255) * Math.PI) / 180) * 0.2;
      else if (v >= 2745) { a = Math.max(0, 255 - (v - 2745)) / 255; y = ((v - 2745) / 255) * -20; }
      this.alpha(c, a, () => this.di(c, im, 0, p.i * 120, 140, 120, P(87 - 70 * k), P(98 + y - 60 * k), P(140 * k), P(120 * k)));
    }
  }

  /**
   * 自己ベストを超えたら、スコアの下に「ベストスコア更新」を 5 秒（参考動画で測った）。
   * 横に少し広く薄い所から 0.17 秒で出て、0.16 秒黄色く光る。絵は 1.45 倍で (0, 278) に置く
   */
  private drawBest(c: CanvasRenderingContext2D, wall: number) {
    if (this.bestAt < 0) return;
    const v = wall - this.bestAt;
    if (v > 5200) return;
    const im = this.img('game/BestScore');
    if (!im) return;
    const K = 1.45;
    const a = v < 170 ? v / 170 : v > 5000 ? 1 - (v - 5000) / 200 : 1;
    const kx = v < 170 ? 1.08 - (v / 170) * 0.08 : 1;
    // 帯の絵（332×176 の y 44〜100）
    const sx = 0, sy = 44, sw = 332, sh = 56;
    const cx = (sw * K) / 2;
    const dx = cx - (sw * K * kx) / 2;
    const y = 278.2 + sy * K;
    this.alpha(c, a, () => this.di(c, im, sx, sy, sw, sh, dx, y, sw * K * kx, sh * K));
    const fl = v >= 170 && v < 330 ? 1 - (v - 170) / 160 : 0;
    if (fl > 0) {
      const tc = this.tintPart(im, '#ffe600', sx, sy, sw, sh);
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.globalAlpha *= fl * 0.8;
      c.drawImage(tc, 0, y, sw * K, sh * K);
      c.restore();
    }
  }

  /** ベストスコアを更新している間の、スコアの後ろの光（足し算で重ねる） */
  private drawBestGlow(c: CanvasRenderingContext2D, wall: number) {
    if (this.bestAt < 0) return;
    const v = wall - this.bestAt;
    if (v > 5200) return;
    const fx = this.img('game/BestScoreFx');
    const m = this.man.img['game/BestScoreFx'] as ImgInfo & { x?: number; y?: number };
    if (!fx || !m) return;
    const a = v < 170 ? v / 170 : v > 5000 ? 1 - (v - 5000) / 200 : 0.85 + Math.sin(v / 160) * 0.15;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha *= a;
    // 絵の不透明度がとても低い（最大 16%）ので、本家の明るさになるよう 5 回重ねる
    for (let i = 0; i < 3; i++) this.di(c, fx, P(m.x ?? 0), P(m.y ?? 0), P(m.w), P(m.h));
    // 本家は金色に近いので、黄色にした光も重ねる
    const y = this.tintPart(fx, '#ffd23a', 0, 0, m.w, m.h);
    for (let i = 0; i < 3; i++) c.drawImage(y, P(m.x ?? 0), P(m.y ?? 0), P(m.w), P(m.h));
    c.restore();
  }

  private tintPartCv: HTMLCanvasElement | null = null;
  /** 絵の一部を 1 色に塗った絵（光らせるとき用） */
  private tintPart(im: CanvasImageSource, col: string, sx: number, sy: number, sw: number, sh: number) {
    const cv = (this.tintPartCv ??= document.createElement('canvas'));
    cv.width = Math.ceil(sw * 1.5);
    cv.height = Math.ceil(sh * 1.5);
    const g = cv.getContext('2d')!;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, cv.width, cv.height);
    this.di(g, im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = col;
    g.fillRect(0, 0, cv.width, cv.height);
    return cv;
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
    if (st.score > L.score) {
      this.scoreAt = wall;
      // 加算の数字（叩くたびに、スコアの上にオレンジの数字）。途中から始めたときなど、一度に大きく増えたときは出さない
      if (L.score > 0 || st.score - L.score < 100000) this.addPops.push({ v: st.score - L.score, t: wall });
      if (this.addPops.length > 10) this.addPops.shift();
      // スコアランク（粋・雅・極）: 超えたときに 3 秒出す
      const RANKS = [500000, 600000, 700000, 800000, 900000, 950000, 1000000];
      RANKS.forEach((r, i) => { if (L.score < r && st.score >= r) this.rankPops.push({ i, t: wall }); });
      // 自己ベストを超えた
      if (F.best && L.score <= F.best && st.score > F.best && this.bestAt < 0) this.bestAt = wall;
    }
    const r = F.fx.rollFx;
    if (r && r.t !== L.roll) {
      L.roll = r.t;
      // 時刻は叩いた時（描いた時ではなく）。録画で区間の途中から描き始めても同じになるように
      const at = r.t;
      if (r.balloon) {
        this.balloonNumAt = at;
        this.balloonHitAt = at;
        if (!this.charaOnce || this.charaOnce.name !== 'chara/Balloon_Breaking') this.charaOnce = { name: 'chara/Balloon_Breaking', t: at, ms: 1e9 };
        this.balloonUntil = at + 1e9;
      } else {
        // 連打の音符の色: 1 打ごとに赤みが 10 増える（100 まで）
        const T = this.rollTint;
        if (r.count < T.count) T.level = 0;
        T.level = Math.min(100, this.rollLevel(at) + 10 * Math.max(1, r.count - T.count));
        T.count = r.count;
        T.at = at;
        // 下から斜めに上がっていく連打のキャラ
        this.rollCharas.push({ t: at, x: P(ROLL_X[this.rnd() % ROLL_X.length]), type: this.rnd() % 6 });
        if (this.rollCharas.length > 64) this.rollCharas.shift();
        // 連打の枠: 出ていなければ開くところから、出ていれば開いたまま延ばす
        if (at - this.rollAt > 2400) this.rollAt = at;
        else this.rollAt = at - 5 * 40;
        this.rollNumAt = at;
      }
    }
    if (F.fx.rainbow !== null && F.fx.rainbow !== L.popped) {
      L.popped = F.fx.rainbow;
      const n = this.count('chara/Balloon_Broke');
      this.charaOnce = { name: 'chara/Balloon_Broke', t: F.fx.rainbow, ms: n * 32 };
      this.balloonUntil = F.fx.rainbow + 500;
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

  /** 読み込んだばかりで、まだ一度も描いていない絵 */
  private warm: (ImageBitmap | HTMLImageElement)[] = [];
  /**
   * 読み込んだ絵を、使う前に 1 枚ずつ（1 フレームに 1 枚）レーンの下に 1 px で描いておく。
   * 初めて描く絵は端末が GPU に移すのに時間がかかるので、ゴーゴー・クリアなどで初めて出るときにカクつかないように
   */
  private warmUp(c: CanvasRenderingContext2D) {
    let im = this.warm.shift();
    // 手放した絵（大きさが 0）はとばす
    while (im && im.width === 0) im = this.warm.shift();
    if (!im) return;
    c.save();
    c.globalAlpha = 1 / 255;
    c.imageSmoothingEnabled = false;
    c.drawImage(im, LANE_X + 10, FIELD_Y + 10, 1, 1);
    c.restore();
  }

  draw(c: CanvasRenderingContext2D, F: TndeFrame) {
    const { game, course, now, wall } = F;
    if (!F.preview) {
      this.choose(F.info.title);
      this.played = true;
    }
    // 動画を全面・下に出すとき、動画用の画面のときは、隠れる背景・踊り子・どんちゃんの絵を読まない（手放す）
    const view = F.preview ? (this.played ? this.view : 'lane') : F.laneOnly ? 'lane' : F.bgMode === 'full' ? 'full' : F.bgMode ? 'bottom' : '';
    if (view !== this.view) this.view = view;
    if (!F.preview) this.eventWants(course, now, wall);
    if (this.setKey() !== this.loadedSet) void this.sync();
    // 曲の半分を過ぎたら、終わりの演出の絵を読み込み始める（フルコンボの連番はフルコンボできそうなときだけ）
    if (!F.preview) {
      const half = this.lastNote(course) * 0.5;
      const st = game.stats;
      if (now > half || F.end) {
        const k = ['clear'];
        if (st.bad === 0) k.push(st.ok === 0 ? 'dfc' : 'fc');
        if (F.end) k.push(END_GROUP[F.end.kind] ?? 'clear');
        this.needEnd(k);
      }
    }
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
    this.warmUp(c);
    this.drawLane(c, F, gogo);
    if (all) this.drawGauge(c, st.gauge, wall);
    this.drawJudgeFrame(c, F, gogo, jx);
    this.drawNotes(c, F, beat, jx);
    this.drawPanel(c, F);
    if (all) this.drawSplash(c, wall);
    this.drawCombo(c, st.combo, wall);
    if (all) this.drawBestGlow(c, wall);
    this.drawScore(c, wall);
    if (all) {
      this.drawAddPops(c, wall);
      this.drawBest(c, wall);
      this.drawRankPops(c, wall);
      this.drawRainbow(c, F);
      this.drawFireworks(c, wall);
      this.drawSoulFx(c, F);
      this.drawFlyers(c, F, jx);
    }
    this.drawExplosion(c, F, jx);
    this.drawEndFx(c, F);
    if (all) {
      this.drawTitle(c, F);
      this.drawComboBanner(c, wall);
    }
    // 風船を割っているどんちゃんは、風船より後ろ（風船・連打数は手前）
    if (all) this.drawBalloonChara(c, F);
    this.drawRoll(c, F);
    this.drawJudgeText(c, F, jx);
    // 演出の 7 秒後から 1.8 秒で暗くして、結果の画面へ
    if (all && F.end && END_KINDS.has(F.end.kind)) {
      const a = (wall - F.end.t - END_FADE_AT) / END_FADE;
      if (a > 0) {
        c.save();
        c.globalAlpha = Math.min(1, a);
        c.fillStyle = '#000';
        c.fillRect(0, 0, TW, TH);
        c.restore();
      }
    }
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
    if (u === 0) { this.drawUp0(c, wall, clear); return; }
    if (u === 1) { this.drawUp1(c, wall, clear); return; }
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
            this.di(c, im, (-this.lw(im) * S) / 2, (-this.lh(im) * S) / 2, this.lw(im) * S, this.lh(im) * S);
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
            this.di(c, im, 0, v * 184, 641, 184, px - 60, py - 20, 641 * 0.25, 184 * 0.25);
          }
        }
      };
      if (fade < 1) layer(0);
      this.alpha(c, fade, () => layer(2));
    }
  }

  /** クリアの色に変わる時間（上の背景 0・1。参考動画で測った） */
  private static readonly UP_FADE = 150;

  /**
   * のぼりの上の背景（Bg_up/0）。参考動画「Glitch hoppin'」で測った:
   * - のぼり: Base.png の 2 段（濃い・薄いのぼりが 1 本おきに並ぶ）を重ねた 328×154 を 1.5 倍にして、縦横に並べる。
   *   上の端は y = -79、1 秒に 92.2px 左へ流れる。ふだんは赤（左の組）、クリアは黄と白（右の組）
   * - 鈴を持ったキャラ: 492px おきに並び（持ち物は 鞠・風車・でんでん太鼓・団子 の順）、BELL_X・BELL_Y の動きで跳ねながら左へ進む。
   *   ふだんは桃（1 段目）、クリアは橙（3 段目）
   */
  /**
   * 六角と梅の上の背景（Bg_up/1）。参考動画「ベースラインやってる?笑」で 1 コマずつ測った:
   * - 下地（UPScroll_0）: 329×184 を 1.5 倍で横に並べ、y = 0。1 秒に 92.53px 左へ
   * - そのほか（梅・キャラ・六角）: 984px（1.5 倍で 1476px）の組で、1 秒に 92.2px 左へ
   * - 六角（UPScroll_1・Normal_0〜2）とキャラ: 2 秒で 1 往復、まっすぐ上下する（y = -5〜-15）
   * - 白い梅の固まり: 2 秒で 1 往復、なめらかに上下（y = -2〜-18）。小さい梅: 上の端を止めて 0.9 倍まで縮む
   * - 4 秒ごとに、Normal_0〜2 の六角が左の端を軸に 0.1 秒で裏返って消え、後ろからキャラが上がってくる。
   *   2.6 秒ほどでキャラが下がり、六角がまた 0.1 秒で表に返る
   */
  private static readonly UP1_HEX: [number, number, number, number][] = [[48, 14, 94, 110], [284, 14, 94, 110], [750, 93, 94, 111]];
  private static readonly UP1_MOF: [number, number, number, number, number][] = [
    // [x, y, w, h, 種類（0: 小さい梅・縮む、1: 白い梅の固まり・上下）]
    [160, 0, 79, 71, 0], [488, 0, 79, 71, 0], [816, 0, 79, 71, 0],
    [55, 151, 78, 74, 0], [383, 151, 78, 74, 0], [711, 151, 78, 74, 0],
    [166, 45, 215, 171, 1], [494, 45, 215, 171, 1], [822, 45, 162, 171, 1], [0, 110, 53, 106, 1],
  ];
  private drawUp1(c: CanvasRenderingContext2D, wall: number, clear: boolean) {
    const fade = clear ? Math.min(1, (wall - this.clearAt) / TndeSkin.UP_FADE) : 0;
    const t = wall / 1000;
    const W1 = 984 * S;
    const lx = -((((t * 92.2 + 1263.9) % W1) + W1) % W1);
    const BW = 329 * S;
    const bx = -((((t * 92.53 + 215.15) % BW) + BW) % BW);
    // 2 秒の上下（u = 0 で上、1 で下）
    const u = (((t - 20.167) % 2) + 2) % 2;
    const tri = u < 1 ? u : 2 - u;
    const hexDy = -5 - 10 * tri;
    const cos = 0.5 - 0.5 * Math.cos(Math.PI * tri);
    // 4 秒の六角とキャラの入れ替わり（ph = 0 で六角が裏返り始める）
    const ph = (((t - 20.217) % 4) + 4) % 4;
    const hexK = ph < 0.1 ? 1 - ph / 0.1 : ph < 2.833 ? 0 : ph < 2.933 ? (ph - 2.833) / 0.1 : 1;
    const charaOn = ph >= 0.1 && ph < 2.963;
    const lift = ph < 0.45 ? 110 * (1 - (ph - 0.1) / 0.35) : ph > 2.633 ? (110 * (ph - 2.633)) / 0.33 : 0;
    const one = (kk: '' | 'Clear') => {
      const N = (n: string) => `bg/Bg_up/1/${kk ? 'Clear' : 'Normal'}${n}`;
      // 下地
      c.save();
      c.translate(bx, 0);
      this.cached(c, `up1b${kk}`, '', 0, 0, TW + BW, 276, (g) => {
        for (let x = 0; x < TW + BW; x += BW) this.put(g, `bg/Bg_up/1/UPScroll${kk ? '_Clear' : ''}_0`, x, 0, 0, 0, 329, 184);
      });
      c.restore();
      for (let ox = lx; ox < TW; ox += W1) {
        // 梅
        for (const [x, y, w, h, kind] of TndeSkin.UP1_MOF) {
          if (kind === 1) { this.put(c, N('_Mof'), ox + x * S, y * S - 2 - 16 * cos, x, y, w, h); continue; }
          const k = S * (1 - 0.1 * cos);
          this.put(c, N('_Mof'), ox + (x + w / 2) * S - (w * k) / 2, y * S, x, y, w, h, k);
        }
        // キャラ（下からせり上がる。ゲージの下には出さない）
        if (charaOn) {
          c.save();
          c.beginPath();
          c.rect(ox, 0, W1, 237);
          c.clip();
          this.put(c, 'bg/Bg_up/1/Chara', ox, hexDy + lift, 0, 0, 984, 266);
          c.restore();
        }
        // 六角
        this.put(c, `bg/Bg_up/1/UPScroll${kk ? '_Clear' : ''}_1`, ox, hexDy, 0, 0, 984, 266);
        if (hexK > 0) {
          TndeSkin.UP1_HEX.forEach(([x, y, w, h], i) => this.put(c, N(`_${i}`), ox + x * S, hexDy + y * S, x, y, w, h, S * hexK, S));
        }
      }
    };
    if (fade < 1) one('');
    if (fade > 0) this.alpha(c, fade, () => one('Clear'));
  }

  private drawUp0(c: CanvasRenderingContext2D, wall: number, clear: boolean) {
    const fade = clear ? Math.min(1, (wall - this.clearAt) / TndeSkin.UP_FADE) : 0;
    const t = wall / 1000;
    const TW0 = 328 * S;
    // 位置の基準は参考動画の時刻に合わせてある（動画の 20 秒 = wall 20000 で同じ絵になる）
    const ox = -((((t * 92.2 + 227.5) % TW0) + TW0) % TW0);
    const banners = (set: number) => {
      c.save();
      c.translate(ox, 0);
      this.cached(c, `up0b${set}`, '', -TW0, -79, TW + TW0 * 3, 320, (g) => {
        for (let x = -TW0; x < TW + TW0 * 2; x += TW0) {
          for (const y of [-79, -79 + 231]) {
            this.put(g, 'bg/Bg_up/0/Base', x, y, set * 328, 0, 328, 154);
            this.put(g, 'bg/Bg_up/0/Base', x, y, set * 328, 154, 328, 154);
          }
        }
      });
      c.restore();
    };
    // 鈴のキャラ: f = 1 回りの中の何コマ目か、n = 何回り目か
    // 1 回りは 1.8337 秒（動画の 20〜100 秒の 44 回りで測った）
    const fr = (t - 20) * (110 / 1.83371);
    const n = Math.floor(fr / 110);
    const f = fr - n * 110;
    const i0 = Math.floor(f);
    const k = f - i0;
    const xa = BELL_X[i0];
    const xb = i0 + 1 < 110 ? BELL_X[i0 + 1] : -492;
    const ya = BELL_Y[i0];
    const yb = BELL_Y[(i0 + 1) % 110];
    const dx = xa + (xb - xa) * k;
    const y = ya + (yb - ya) * k;
    const bells = (row: number) => {
      // いちばん左のキャラの番号（持ち物は番号 % 4）
      const base = 104.7 + dx - 492 * n;
      const first = Math.floor((-500 - base) / 492);
      for (let j = first; base + 492 * j < TW; j++) {
        const v = ((j % 4) + 4) % 4;
        this.put(c, 'bg/Bg_up/0/Bells', base + 492 * j, y, v * 328, row * 233, 328, 233);
      }
    };
    if (fade < 1) { banners(0); bells(0); }
    if (fade > 0) this.alpha(c, fade, () => { banners(2); bells(2); });
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

  private lastNoteOf: { c: Course; t: number } | null = null;
  private lastNote(course: Course) {
    if (this.lastNoteOf?.c !== course) {
      let t = 0;
      for (const n of course.notes) if (!n.dummy) t = Math.max(t, n.endTime ?? n.time);
      this.lastNoteOf = { c: course, t };
    }
    return this.lastNoteOf.t;
  }

  // ---------- 曲の終わりの演出（参考動画で 1 コマずつ測った） ----------

  private drawEndFx(c: CanvasRenderingContext2D, F: TndeFrame) {
    const e = F.end;
    if (!e) return;
    const t = F.wall - e.t;
    if (t < 0) return;
    if (e.kind === 'clear') this.drawClearFx(c, t);
    else if (e.kind === 'fc') this.drawFcFx(c, t);
    else if (e.kind === 'allgood') this.drawDfcFx(c, t);
  }

  /** クリアの「クリア成功」の字（1 文字ずつ、ふくらみながら出る） */
  private clearLetters(c: CanvasRenderingContext2D, t: number, start: number, gap: number) {
    for (let j = 0; j < 5; j++) {
      const lt = t - start - j * gap;
      if (lt < 0) continue;
      const i = Math.floor(lt / FRAME);
      const ky = i < LETTER_K.length ? LETTER_K[i] : 1;
      const a = i < LETTER_A.length ? LETTER_A[i] : 1;
      const h = 90 * S * ky;
      this.alpha(c, a, () => this.put(c, 'end/clearText', LETTER_X[j], 450 - h, j * 90, 0, 90, 90, S, S * ky));
    }
  }

  /** 字の白い光（白い字を重ねる） */
  private clearLettersWhite(c: CanvasRenderingContext2D, a: number) {
    if (a <= 0) return;
    this.alpha(c, a, () => {
      for (let j = 0; j < 5; j++) this.put(c, 'end/clearText', LETTER_X[j], 447 - 90 * S, j * 90, 90, 90, 90);
    });
  }

  /** 星のきらめき（7 つが順に、ふくらんでから消える。くり返す） */
  private stars(c: CanvasRenderingContext2D, t: number, start: number) {
    if (t < start) return;
    const ct = (t - start) % STAR_PERIOD;
    for (const [x, y, k, at] of STARS) {
      const st = ct - at;
      const grow = k * 10 * FRAME;
      if (st < 0 || st > grow + 75) continue;
      const s = st < grow ? (st / grow) * k : k;
      const a = st < grow ? 1 : 1 - (st - grow) / 75;
      const w = 61 * s;
      this.alpha(c, a, () => this.put(c, 'end/star', x - w / 2, y - w / 2, 0, 0, 61, 61, s));
    }
  }

  /** バチを持った 2 人（クリア）。cell: 絵の列、L・R の位置 */
  private clearChara(c: CanvasRenderingContext2D, cell: number, l: number[], r: number[], a = 1) {
    this.alpha(c, a, () => {
      this.put(c, 'end/clearChara', l[0], l[1], cell * 180, 0, 180, 180);
      this.put(c, 'end/clearChara', r[0], r[1], cell * 180, 180, 180, 180);
    });
  }

  private drawClearFx(c: CanvasRenderingContext2D, t: number) {
    // 2 人: 真ん中に現れて、左右に分かれ、バチを掲げる
    if (t < 142) this.clearChara(c, 1, [1030, 267], [1092, 266], t / 142);
    else if (t < 717) {
      const p = Math.min(1, (t - 142) / 441);
      const q = 1 - (1 - p) * (1 - p);
      this.clearChara(c, 0, [1025 - 328 * q, 266], [1105 + 325 * q, 267]);
    } else {
      const [cell, l, r] = CLEAR_POSE.find(([at]) => t >= at)!.slice(1) as [number, number[], number[]];
      this.clearChara(c, cell, l, r);
    }
    this.clearLetters(c, t, 317, 50);
    // 字が白く光る
    this.clearLettersWhite(c, t < 1000 ? 0 : t < 1183 ? (t - 1000) / 183 : 1 - (t - 1183) / 192);
    this.stars(c, t, 1758);
  }

  private drawFcFx(c: CanvasRenderingContext2D, t: number) {
    // フルコンボは連番の絵（33 ms ごと）。終わったら最後の絵と、光る字（50 ms ごと）
    const meta = this.man.img['end/fc0'] as unknown as { frames: number[][] } | undefined;
    if (!meta) return;
    const n = meta.frames.length;
    const k = Math.min(n - 1, Math.floor(t / 33));
    if (t > 2300) this.confetti(c, t - 2300);
    // 細かくした絵では、コマの位置と大きさ（px, py, sw, sh）を元の大きさの単位で持っている
    const [x0, y0, w, h, px, py, pg, sw, sh] = meta.frames[k];
    const im = this.img(`end/fc${pg}`);
    if (im && w) this.di(c, im, px, py, sw ?? w, sh ?? h, 495 + x0 * S, 75 + y0 * S, w * S, h * S);
    if (t >= n * 33) {
      const j = Math.floor((t - n * 33) / 50) % 2 ? 2 : 0;
      this.put(c, 'end/fcLoop', 495, 294, 0, j * 155, 950, 155);
    }
  }

  /**
   * 紙ふぶき（フルコンボ・ドンだフルコンボ）。レーンの横いっぱいに、ゲージの上からゆっくり舞い落ちる小さな紙（青・紫が多い）。
   * 落ちる速さ・数・大きさは参考動画で測った（1 秒に 150 px ほど、いつも 25 枚ほど）
   */
  private confetti(c: CanvasRenderingContext2D, t: number) {
    const N = 30;
    for (let i = 0; i < N; i++) {
      const speed = 0.13 + (hash(`v${i}`) % 60) / 1000;
      const life = 320 / speed;
      const born = (hash(`b${i}`) % 1600);
      const lt = t - born;
      if (lt < 0) continue;
      const cyc = Math.floor(lt / life);
      const u = (lt % life) / life;
      const h = hash(`p${i}_${cyc}`);
      const x = 520 + (h % 1380) + Math.sin(u * 6 + i) * 14;
      const y = 195 + u * 320;
      const a = u < 0.06 ? u / 0.06 : u > 0.85 ? (1 - u) / 0.15 : 1;
      const col = CONFETTI[h % CONFETTI.length];
      const s = 0.8 + ((h >> 4) % 40) / 100;
      c.save();
      c.globalAlpha = a;
      c.translate(x, y);
      c.rotate(u * 8 + i);
      c.scale(1, Math.max(0.15, Math.abs(Math.cos(u * 10 + i))));
      c.fillStyle = col;
      c.fillRect(-6 * s, -5 * s, 12 * s, 10 * s);
      c.restore();
    }
  }

  /** ドンだフルコンボのバチお（Bachi.png: 151×168、上の段が左、下の段が右）。右は左と真ん中で対称（x の和が 2190） */
  private dfcChara(c: CanvasRenderingContext2D, name: string, cell: number, lx: number, y: number, a = 1, ry = y) {
    this.alpha(c, a, () => {
      this.put(c, name, lx, y, cell * 151, 0, 151, 168);
      this.put(c, name, 2190 - lx, ry, cell * 151, 168, 151, 168);
    });
  }

  private drawDfcFx(c: CanvasRenderingContext2D, t: number) {
    const B = 'end/dfc/Bachi';
    const lerp = (a: number, b: number, p: number) => a + (b - a) * Math.max(0, Math.min(1, p));
    // 金の背景（1158〜1342 ms で出る）
    const gold = this.man.img['end/dfc/gold'] as unknown as { x: number; y: number } | undefined;
    if (gold && t > 1158) this.alpha(c, Math.min(1, (t - 1158) / 184), () => this.put(c, 'end/dfc/gold', gold.x * S, gold.y * S));
    if (t > 2300) this.confetti(c, t - 2300);
    // 扇（棒が出てから、ひらく）
    if (t > 1192) {
      const fa = Math.min(1, (t - 1192) / 66);
      const cell = t < 1325 ? 0 : t < 1358 ? 1 : t < 1375 ? 2 : t < 1392 ? 3 : 4;
      const dy = t < 1258 ? (1 - fa) * -15 : 0;
      this.alpha(c, fa, () => {
        this.put(c, 'end/dfc/fanL', 570, 298 + dy, cell * 221, 0, 221, 143);
        this.put(c, 'end/dfc/fanR', 1513, 297 + dy, cell * 221, 0, 221, 143);
      });
    }
    // バチお
    if (t < 192) this.dfcChara(c, B, 0, 1050, 278, t / 192);
    else if (t < 792) {
      const p = Math.min(1, (t - 192) / 450);
      this.dfcChara(c, B, 1, 1065 - 329 * (1 - (1 - p) * (1 - p)), 276);
    } else if (t < 1042) {
      const [cell, x, y] = DFC_POSE.find(([at]) => t >= at)!.slice(1);
      this.dfcChara(c, B, cell, x, y);
    } else if (t < 1342) {
      // しゃがんで白く光る
      const y = lerp(280, 292, (t - 1042) / 100);
      const w = 0.55 * Math.min(1, (t - 1042) / 200);
      this.dfcChara(c, B, 5, 734, y);
      this.alpha(c, w, () => {
        this.put(c, 'end/dfc/Bachi_Flush', 734 + 75 * S / 2 - 75 * S / 2, y, 0, 0, 151, 168);
        this.put(c, 'end/dfc/Bachi_Flush', 2190 - 734, y, 0, 168, 151, 168);
      });
    } else if (t < 1742) {
      // 上へ跳んで、白く光って消える
      const p = Math.min(1, (t - 1342) / 316);
      const x = 734 - 169 * p;
      const y = 65 + 158 * (1 - p) * (1 - p);
      const w = t < 1658 ? 0 : Math.min(1, (t - 1658) / 50);
      const a = t < 1675 ? 1 : 1 - (t - 1675) / 67;
      this.alpha(c, a, () => {
        this.dfcChara(c, B, 5, x, y);
        this.alpha(c, w, () => {
          this.put(c, 'end/dfc/Bachi_Flush', x, y, 0, 0, 151, 168);
          this.put(c, 'end/dfc/Bachi_Flush', 2190 - x, y, 0, 168, 151, 168);
        });
      });
    }
    // 神さまのバチお: 白く光って現れ、落ちてきて着地、そのあと 1.65 秒ごとに跳ぶ
    if (t >= 1700) {
      let x = 435;
      let y = 278;
      if (t < 2008) {
        const p = Math.max(0, (t - 1742) / 266);
        x = 515 - 80 * p;
        y = 80 + 199 * p * p;
      } else if (t < 2108) y = t < 2075 ? 291 : 278;
      else if (t > 3875) y = godJump(((t - 3875) % 1650) / FRAME);
      const a = Math.min(1, (t - 1700) / 140);
      const w = t < 1792 ? 1 : Math.max(0, 1 - (t - 1792) / 92);
      this.alpha(c, a, () => {
        this.put(c, 'end/dfc/Bachi_God', x, y, 0, 0, 151, 168);
        this.put(c, 'end/dfc/Bachi_God', 2190 - x, y, 0, 168, 151, 168);
        this.alpha(c, w, () => {
          this.put(c, 'end/dfc/Bachi_God_Flush', x, y, 0, 0, 151, 168);
          this.put(c, 'end/dfc/Bachi_God_Flush', 2190 - x, y, 0, 168, 151, 168);
        });
      });
    }
    // 「クリア成功」→ 白く光る →「ドンだフルコンボ!!」
    if (t < 1300) this.clearLetters(c, t, 400, 46);
    if (t < 1325) this.clearLettersWhite(c, t < 1108 ? 0 : Math.min(1, (t - 1108) / 134));
    const DX = 713;
    const DY = 277;
    if (t >= 1258) {
      const white = t < 1300 ? (t - 1258) / 42 : t < 1600 ? 1 : Math.max(0, 1 - (t - 1600) / 110);
      const col = t < 1600 ? 0 : Math.min(1, (t - 1600) / 110);
      // 虹のふち（字の後ろ）。出たときは字の上にも重ねて、すぐに引く
      if (col > 0) this.alpha(c, col, () => this.put(c, 'end/dfc/Donda_Text_Rainbow_Effect', DX, DY));
      this.alpha(c, col, () => this.put(c, 'end/dfc/Donda_Text', DX, DY));
      const over = t < 1708 ? 0 : t < 1842 ? 0.6 * (1 - (t - 1708) / 134) : 0;
      if (over > 0) this.alpha(c, over, () => this.put(c, 'end/dfc/Donda_Text_Rainbow_Effect', DX, DY));
      this.alpha(c, white, () => this.put(c, 'end/dfc/Donda_Text_Effect', DX, DY));
    }
    this.stars(c, t, 1400);
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
    5: [[0, 0, 1280, 131], [269, 169, 990, 231], [38, 231, 1240, 310]],
  };
  /**
   * 下の背景 5 の灯籠（層 3 = 後ろの赤い光、層 4 = 灯籠）。参考動画「魔宵月」「Glitch hoppin'」で測ると、
   * スキンの絵より 18px 上で、左の 4 本は 6px 左・右の 4 本は 3px 右にある。光は足して重ねる（灯籠の周りが明るい橙になる）
   */
  private static readonly LAMP_DX = [-6, 3];
  private static readonly LAMP_DY = -18;

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
        if (d === 5 && (i === 3 || i === 4)) {
          if (i === 3) g.globalCompositeOperation = 'lighter';
          TndeSkin.LAMP_DX.forEach((dx, k) => this.put(g, `bg/Bg_down/5/${i}`, k * 640 * S + dx, 540 + TndeSkin.LAMP_DY, k * 640, 0, 640, 360));
          g.globalCompositeOperation = 'source-over';
          continue;
        }
        this.put(g, `bg/Bg_down/${d}/${i}`, 0, 540);
      }
      g.globalAlpha = 1;
    };
    // クリアの背景が出きったら、その下は見えないので描かない
    if (!clear || wall - this.clearAt < (this.pick.clr === 1 ? 150 : 200)) {
      this.cached(c, 'down0', `${d}`, 0, 540, TW, 540, bake(0.8));
      // 光る絵のある所だけ重ねる（重ならない四角に分けてある。1280×360 の絵の中の位置）
      const parts = (TndeSkin.GLOW_AT[d] ?? []).map(([x0, y0, x1, y1]) => [x0 * S, 540 + y0 * S, (x1 - x0) * S, (y1 - y0) * S]);
      if (parts.length) this.alpha(c, (pulse - 0.8) / 0.2, () => this.cached(c, 'down1', `${d}`, 0, 540, TW, 540, bake(1), parts));
    }
    if (d === 4) this.drawPetals(c, wall);
    if (clear) {
      if (this.pick.clr === 1) this.drawClearDown1(c, wall);
      else this.drawClearDown(c, wall, now);
    }
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
      this.di(c, im, (-this.lw(im) * S) / 2, (-this.lh(im) * S) / 2, this.lw(im) * S, this.lh(im) * S);
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
      // 赤と黒の犬（Normal3）は、絵の中の位置が白い犬（Normal2）より 5px 右・9px 上にあるので、白い犬にそろえる
      const [dx, dy] = name === 'dancer/Normal3' ? [-5, 9] : [0, 0];
      this.frame(c, name, name.includes('/In') ? k : fr, P(x + dx) - (a.w * S) / 2, 842.5 + P(dy) - (a.h * S) / 2);
    });
  }
  private inAt = [-1, -1, -1, -1, -1];
  private dancePhase = 0;

  /**
   * クリアの下の背景 c/1（波の模様の地に、縁起物の 4 枚の帯）。参考動画「Glitch hoppin'」で 1 コマずつ測った:
   * - 0.15 秒で前の背景から変わる。地（DownClear）は動かない
   * - 帯 1・3 は y = 540、帯 2・4 は y = 420 から 1 秒ごとに上下する（C1_BOB）
   * - 画面にある部品は、クリアから 0.2〜0.37 秒の間に 1 つずつ入ってくる: 帯 1 は下から、帯 2 は上から（C1_IN）。
   *   行き過ぎて戻る。0.467 秒から、4 枚とも 1 秒に 60px 左へ流れる（3843px でひと回り）
   */
  /** 帯の重なり順（奥から） */
  private static readonly C1_ORDER = [1, 2, 3, 4];
  private static readonly C1_BOB = [-1, -2, 0, 2, 4, 6, 8, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 30, 32, 34, 36, 38, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 27, 26, 25, 24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 7, 6, 5, 4, 3, 2, 1, 0];
  /** 入ってくる部品: [帯, 絵の中の x, y, w, h, 止まる時刻（クリアからの秒）, 落ちてくるときの傾き（度。招き猫だけ傾いて落ちてくる）] */
  private static readonly C1_IN: [number, number, number, number, number, number, number?][] = [
    [1, 1194, 220, 108, 125, 0.2], [1, 656, 12, 429, 211, 0.233], [1, 699, 237, 147, 123, 0.233], [1, 515, 259, 98, 92, 0.26],
    [1, 258, 0, 323, 252, 0.3], [1, 282, 279, 139, 81, 0.32], [1, 242, 325, 34, 35, 0.33], [1, 0, 180, 145, 180, 0.367],
    [2, 863, 29, 823, 413, 0.2], [2, 383, 100, 331, 350, 0.267], [2, 69, 48, 270, 379, 0.35, -5],
  ];
  private drawClearDown1(c: CanvasRenderingContext2D, wall: number) {
    const t = (wall - this.clearAt) / 1000;
    const W = 2562 * S;
    const x0 = t < 0.467 ? 0 : -(((60 * (t - 0.467)) % W) + W) % W;
    const fb = Math.floor((t - 0.95) * 60);
    const bob = TndeSkin.C1_BOB[((fb % 60) + 60) % 60];
    const entering = t < 0.6;
    this.alpha(c, Math.min(1, t / 0.15), () => {
      this.cached(c, 'c1bg', '', 0, 540, TW, 540, (g) => this.put(g, 'bg/Bg_down/c/1/DownClear', 0, 540));
      for (const n of TndeSkin.C1_ORDER) {
        const name = `bg/Bg_down/c/1/DownClear${n}`;
        const y = n % 2 ? 540 : 420 + bob;
        if (entering && n <= 2) {
          for (const [L, sx, sy, sw, sh, at, tilt] of TndeSkin.C1_IN) {
            if (L !== n) continue;
            const k = (t - at) * 60;
            let d: number;
            // 帯 1: 下から 1 コマに 48.5px で上がり、40px 行き過ぎて戻る。帯 2: 上から 1 コマに 51px で落ち、44px 行き過ぎて戻る
            if (n === 1) d = k < 0 ? -48.5 * k : k < 4 ? -10 * k : k < 7 ? (-40 * (7 - k)) / 3 : 0;
            else d = k < 0 ? 51 * k : k < 4 ? 11 * k : k < 8 ? 11 * (8 - k) : 0;
            const x = x0 + sx * S;
            const yy = y + sy * S + d;
            const a = tilt && k < -3 ? Math.max(-30, tilt * (-3 - k)) : 0;
            if (!a) { this.put(c, name, x, yy, sx, sy, sw, sh); continue; }
            c.save();
            c.translate(x + (sw * S) / 2, yy + (sh * S) / 2);
            c.rotate((a * Math.PI) / 180);
            this.put(c, name, (-sw * S) / 2, (-sh * S) / 2, sx, sy, sw, sh);
            c.restore();
          }
          continue;
        }
        this.put(c, name, x0, y);
        if (x0 + W < TW) this.put(c, name, x0 + W, y);
      }
    });
  }

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

  /**
   * 下の帯。参考動画では 赤・黄・緑 が 128px ずつ（x=-64 から 384px ごと）に継ぎ目なく並び、上の黒い縁は 6px。
   * スキンの絵は 1 色が 127px ほどで 1280px に割り切れないので、赤から緑までのひと組（絵の x=42.5〜296.75）を切り出して並べる
   */
  private drawFooter(c: CanvasRenderingContext2D) {
    const y = TH - 44 * S;
    const edge = 6;
    this.put(c, 'footer1', 0, y, 0, 0, 1280, 2, S, edge / 2);
    const sx = 42.5, sw = 254.25, sy = 3, sh = 44 - sy;
    const kx = FOOT_SET / sw, ky = (TH - y - edge) / sh;
    for (let x = -FOOT_SET / 6; x < TW; x += FOOT_SET) this.put(c, 'footer1', x, y + edge, sx, sy, sw, sh, kx, ky);
  }

  // ---------- どんちゃん ----------

  private drawChara(c: CanvasRenderingContext2D, beat: number, gogo: boolean, F: TndeFrame) {
    const st = F.game.stats;
    const { wall } = F;
    if (st.gauge >= 80) this.wantMax();
    if (st.gauge >= 50) this.wantClear();
    if (st.gauge >= 15) this.inWant = true;
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

  /** 風船を割っているどんちゃん（風船のすぐ後ろ） */
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

  /** 背景に動画・画像があるときの、音符が流れる所（レーンの地・分岐の色・ゴーゴー）の不透明度 */
  private static readonly LANE_ALPHA = 0.75;
  /** 透かすレーンを一度まとめて描く canvas（重ねた絵どうしが透けないように、まとめてから薄く貼る） */
  private laneLayer: HTMLCanvasElement | null = null;

  private drawLane(c: CanvasRenderingContext2D, F: TndeFrame, gogo: boolean) {
    const { wall } = F;
    const body = (g: CanvasRenderingContext2D) => {
      this.putLane(g, 'lane/Background_Main', FIELD_Y);
      // 譜面分岐のある譜面: 分岐ごとのレーンの色（切り替わるときは、前の色の上に新しい色を重ねていく）
      const br = F.branch;
      const BASE = ['lane/Base_Normal', 'lane/Base_Expert', 'lane/Base_Master'];
      if (br) {
        if (br.p < 1) this.putLane(g, BASE[br.from], FIELD_Y);
        if (br.p > 0) this.alpha(g, br.p, () => this.putLane(g, BASE[br.cur], FIELD_Y));
      }
      if (gogo) {
        // ゴーゴーのレーンは縦にひらいて出てくる（18 ms ごと）
        const v = step(wall, this.gogoAt, 18);
        const [ky, dy] = v <= 4 ? [0.2, 54] : v <= 5 ? [0.4, 40] : v <= 6 ? [0.6, 26] : v <= 8 ? [0.8, 13] : [1, 0];
        this.putLane(g, 'lane/Background_GoGo', FIELD_Y + P(dy), ky);
      }
    };
    const m = c.getTransform();
    const lw = Math.ceil((TW - LANE_X) * m.a);
    const lh = Math.ceil(P(130) * m.d);
    if (F.bgMode === 'full' && lw > 0 && lh > 0) {
      // 後ろの動画・画像が少し見えるように、音符が流れる所だけ薄く貼る（下の音符の文字の帯は今のまま）
      const L = (this.laneLayer ??= document.createElement('canvas'));
      if (L.width !== lw || L.height !== lh) { L.width = lw; L.height = lh; }
      const g = L.getContext('2d');
      if (g) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, lw, lh);
        g.setTransform(m.a, 0, 0, m.d, -LANE_X * m.a, -FIELD_Y * m.d);
        body(g);
        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha *= TndeSkin.LANE_ALPHA;
        c.drawImage(L, m.e + LANE_X * m.a, m.f + FIELD_Y * m.d);
        c.restore();
      }
    } else {
      if (this.laneLayer) { this.laneLayer.width = this.laneLayer.height = 0; this.laneLayer = null; }
      body(c);
    }
    const br = F.branch;
    this.putLane(c, 'lane/Background_Sub', P(326));
    // 分岐の名前（普通譜面・玄人譜面・達人譜面）: 前の名前は上へ抜けて消え、新しい名前は下から入ってくる
    if (br) {
      const TEXT = ['lane/Text_Normal', 'lane/Text_Expert', 'lane/Text_Master'];
      if (br.p >= 1) this.putLane(c, TEXT[br.cur], FIELD_Y);
      else {
        const d = P(20);
        this.alpha(c, 1 - br.p, () => this.putLane(c, TEXT[br.from], FIELD_Y - d * br.p));
        this.alpha(c, br.p, () => this.putLane(c, TEXT[br.cur], FIELD_Y + d * (1 - br.p)));
      }
    }
    // 叩いた色（ドン 赤・カッ 青）と、音符を叩けたとき（黄）。0.1 秒そのまま、次の 0.1 秒で半分まで薄くなって消える
    const flash = (name: string, t: number) => {
      const ms = wall - t;
      if (ms < 0 || ms >= 200) return;
      const a = Math.min(255, ((150 - ms / 2) * 255) / 100) / 255;
      this.alpha(c, a, () => this.putLane(c, name, FIELD_Y));
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
    const im = this.img(name);
    return im ? this.lw(im) : 1;
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
      if (b.branch) {
        c.fillStyle = BRANCH_BAR;
        c.fillRect(x - 1.5, FIELD_Y + Y(b.time, b.beat, b), 3 * S, 130 * S);
      } else this.put(c, 'bar', x - 1.5, FIELD_Y + Y(b.time, b.beat, b), 0, 0, 3, 130);
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
        // 叩き始めたら、レーンの風船は消して、どんちゃんと風船のアニメーションだけにする
        if (now >= n.time && s.count > 0) continue;
        if (now >= n.time) x = jx;
        if (!F.doron) this.put(c, 'notes', x - HALF, y, 1430, row, 260, 130);
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
        if (!F.doron) {
          if (bodyW > 0) this.tint(c, g, left + P(64), y, col + 131, 0, 128, 130, bodyW, NOTE);
          this.tint(c, g, tail, y, col + 260, row, 130, 130, NOTE, NOTE);
          this.tint(c, g, left, y, col, row, 130, 130, NOTE, NOTE);
        }
        // 連打の文字: 「連打」と、伸ばす線と、終わりの「っ!!」
        const sy = y + P(131);
        const lx = left + P(big ? 116 : 90);
        const lw = endX - HALF + P(10) - left - P(big ? 70 : 44);
        if (lw > 0) this.put(c, 'senotes', lx, sy, 60, 240, 1, 30, lw, S);
        this.put(c, 'senotes', left + P(big ? 56 : 30), sy, 0, 240, 60, 30);
        this.put(c, 'senotes', endX - HALF + P(56), sy, 58, 270, 78, 30);
        this.put(c, 'senotes', left - (big ? P(2) : 0), sy, 0, 30 * SE_ROW[big ? '連打(大)' : '連打'], 136, 30);
      } else {
        if (!F.doron) this.put(c, 'notes', left, y, NOTE_COL[n.type] * 130, row, 130, 130);
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
      this.di(c, im, sx, sy, sw, sh, x, y, dw, dh);
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
      // 細かくしてある絵は、その細かさのまま色を変える
      const q = this.qOf(im);
      cv = document.createElement('canvas');
      cv.width = Math.round(sw * q);
      cv.height = Math.round(sh * q);
      const t = cv.getContext('2d');
      if (!t) { this.di(c, im, sx, sy, sw, sh, x, y, dw, dh); return; }
      const gg = Math.round(255 * (1 - lv / 20));
      this.di(t, im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      t.globalCompositeOperation = 'multiply';
      t.fillStyle = `rgb(255,${gg},${gg})`;
      t.fillRect(0, 0, cv.width, cv.height);
      t.globalCompositeOperation = 'destination-in';
      this.di(t, im, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
      if (this.tinted.size > 200) { for (const o of this.tinted.values()) o.width = o.height = 0; this.tinted.clear(); }
      this.tinted.set(key, cv);
    }
    c.drawImage(cv, 0, 0, cv.width, cv.height, x, y, dw, dh);
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
      const half = this.lw(im) / 2;
      const sx = f.side === 'L' ? 0 : half;
      this.alpha(c, Math.min(255, lv * 73) / 255, () => this.di(c, im, sx, 0, half, this.lh(im), tx + sx * S, ty, half * S, this.lh(im) * S));
    }
    // 難易度・ネームプレート（中身が変わったときだけ描き直す）
    const course = COURSE_IMG[F.info.course] ?? 'course/Oni';
    const key = `${course}|${F.title}|${F.name}|${JSON.stringify(F.profile ?? null)}`;
    this.cached(c, 'plate', key, -10, 340, 350, 190, (g) => {
      this.put(g, course, P(28), P(232));
      this.drawNameplate(g, F, false);
    });
    // 演奏オプションの印: むずかしさの印の右に、横 3 つずつ 2 段（点数の下・ネームプレートの上）
    this.drawMods(c, F.mods, 145, 352, 43, 3, 3);
    // 金・紫の称号のキラキラ（帯の上、字の下）
    const ts = (F.profile ?? DEFAULT_PROFILE).titleStyle;
    if (ts !== 'wood') this.drawTitleShine(c, F.wall);
    this.cached(c, 'plateTop', key, -10, 340, 350, 190, (g) => this.drawNameplate(g, F, true));
  }

  /**
   * 演奏オプションの印（スキンの ModeSymbol と Auto）。(x, y) から size の大きさで、per 個ずつ折り返して並べる。
   * 順は はやさ・ドロン・あべこべ・ランダム・オート（使っているものだけ）
   */
  drawMods(c: CanvasRenderingContext2D, m: PlayMods | null | undefined, x: number, y: number, size: number, gap: number, per: number) {
    if (!m) return;
    const list: [string, number][] = [];
    const si = MOD_SPEEDS.findIndex((v) => Math.abs(v - m.speed) < 0.001);
    if (si >= 0) list.push(['mode/speed', si]);
    if (m.doron) list.push(['mode/sym', 0]);
    if (m.mirror) list.push(['mode/sym', 1]);
    if (m.random === 'kimagure') list.push(['mode/sym', 2]);
    if (m.random === 'detarame') list.push(['mode/sym', 3]);
    if (m.auto) list.push(['mode/sym', 4]);
    list.forEach(([name, i], k) => {
      const im = this.img(name);
      if (im) this.di(c, im, i * 30, 0, 30, 30, x + (k % per) * (size + gap), y + Math.floor(k / per) * (size + gap), size, size);
    });
  }

  /**
   * 金・紫の称号のキラキラ（帯の上、字の下）。参考動画から取り出した光を、2 秒（120 コマ）でひと回り貼る。
   * 絵は横 10 コマずつ・1 コマ 330×106 で、1920×1080 の (30, 392) から
   */
  private drawTitleShine(c: CanvasRenderingContext2D, wall: number) {
    const sh = this.img('fx/TitleShine');
    if (!sh) return;
    const i = Math.floor((((wall * 0.06) % 120) + 120) % 120);
    this.di(c, sh, (i % 10) * 330, Math.floor(i / 10) * 106, 330, 106, 30, 392, 330, 106);
  }

  /**
   * ネームプレート。NamePlate.png の 54px ごとの段（1P の丸・白い台・称号の帯）を同じ位置に重ねて 1.5 倍で貼る
   * （参考動画で測った: 段の左上が (-6, 443.5)）。字は勘亭流。段位は無いので出さない
   */
  private drawNameplate(c: CanvasRenderingContext2D, F: TndeFrame, top: boolean) {
    const im = this.img('nameplate');
    if (!im) return;
    const pf = F.profile ?? DEFAULT_PROFILE;
    const dan = pf.danOn && pf.dan.trim() ? [...pf.dan.trim()].slice(0, 3).join('') : '';
    // NamePlate.png の 54px ごとの段: 0 1P の丸、3 白い台、4 木・5 金・6 紫の称号の帯、7 段位の下地、8 銀・9 金・10 虹の枠、11 金の字の色
    const at = (src: CanvasImageSource, r: number) => this.di(c, src, 0, r * 54, 220, 54, PLATE_X, PLATE_Y, 330, 81);
    const row = (r: number) => at(im, r);
    // 上の段（1P の丸・字）は、称号のキラキラより手前に別に描く
    if (top) {
      this.drawNameplateTop(c, F, im, pf, dan);
      return;
    }
    row(3);
    const base = pf.titleStyle === 'wood' ? 4 : pf.titleStyle === 'gold' || pf.titleStyle === 'goldc' ? 5 : 6;
    const rc = (pf.titleStyle === 'goldc' || pf.titleStyle === 'purplec') && /^#[0-9a-f]{6}$/i.test(pf.titleColor) ? this.recolored(im, base, pf.titleColor) : null;
    if (rc) this.di(c, rc, 0, 0, 220, 54, PLATE_X, PLATE_Y, 330, 81);
    else row(base);
    if (dan) {
      row(7);
      const fr = pf.danFrame === 'gold' ? 1 : pf.danFrame === 'rainbow' ? 2 : 0;
      // 枠は 4 倍にした絵から（無ければ元の絵）
      const hd = this.img('nameplate_frames');
      if (hd) c.drawImage(hd, 0, fr * 216, 880, 216, PLATE_X, PLATE_Y, 330, 81);
      else row(8 + fr);
    }
  }

  private drawNameplateTop(c: CanvasRenderingContext2D, F: TndeFrame, im: CanvasImageSource, pf: PlateStyle, dan: string) {
    this.di(c, im, 0, 0, 220, 54, PLATE_X, PLATE_Y, 330, 81);
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
      this.di(g, im, 51, 11 * 54 + 30, 35, 15, 0, H / 2 - size / 2, W, size);
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
    // 細かくしてある絵なら、その細かさのまま色を変える
    const q = this.qOf(im);
    cv = document.createElement('canvas');
    cv.width = Math.round(220 * q);
    cv.height = Math.round(54 * q);
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    this.di(g, im, 0, r * 54, 220, 54, 0, 0, cv.width, cv.height);
    this.hq.set(cv, q);
    const d = g.getImageData(0, 0, cv.width, cv.height);
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
    const n = Math.floor(this.lw(im) / 230);
    const i = step(wall, this.gogoAt, 30);
    if (i < 0 || i >= n) return;
    this.add(c, 1, () => {
      for (const [x, y, rot] of SPLASH) {
        c.save();
        c.translate(P(x), P(y) - P(230));
        c.rotate(rot);
        this.di(c, im, i * 230, 0, 230, 460, -P(115), -P(230), P(230), P(460));
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
      this.di(c, im, d * 40, 0, 40, 48, right - pad * i - w / 2, bottom - h, w, h);
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
    const cw = this.lw(im) / 10;
    const ch = this.lh(im) / 3;
    const s = String(Math.max(0, Math.floor(this.shownScore))).padStart(7, ' ');
    const v = Math.min(11, step(wall, this.scoreAt, 12));
    const k = SCORE_SCALE[v];
    // 参考動画で測った位置: 1 文字目の左 52.5、間隔 29.5、下の端 336.5（下を基準に縦に伸びる）
    for (let i = 0; i < 7; i++) {
      if (s[i] === ' ') continue;
      const d = +s[i];
      this.di(c, im, d * cw, 0, cw, ch, 52.5 + 29.5 * i, 336.5 - ch * S * k, cw * S, ch * S * k);
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
    const n = Math.floor(this.lw(im) / 192);
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
    const n = im ? Math.floor(this.lw(im) / 180) : 0;
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
    const W = this.lw(im);
    if (v < 82) {
      const w = (v * W) / 85;
      if (w > 0) this.di(c, im, 0, 0, w, this.lh(im), P(360), P(-100), w * S, this.lh(im) * S);
    } else {
      const x = Math.min(W, ((v - 82) * W) / 85);
      if (W - x > 0) this.di(c, im, x, 0, W - x, this.lh(im), P(360) + x * S, P(-100), (W - x) * S, this.lh(im) * S);
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
    // 帯は絵を拡大すると粗くなるので、同じ形（左右が丸い 202.5×22.7、縦の真ん中は 16.65）を図形で描く
    const bx = GX + 46.5 * GK, by = GY + 5.3 * GK, bw = 202.5 * GK, bh = 22.7 * GK;
    const cy = by + bh / 2;
    const pill = (g: CanvasRenderingContext2D) => {
      const r = bh / 2;
      g.beginPath();
      g.arc(bx + r, cy, r, Math.PI / 2, (Math.PI * 3) / 2);
      g.arc(bx + bw - r, cy, r, -Math.PI / 2, Math.PI / 2);
      g.closePath();
    };
    if (showGenre && f) {
      this.cached(c, 'genre', `${f.name}|${f.color}|${f.custom}`, GX, GY, 295 * GK, 33 * GK, (g) => {
        const gk = f.custom ? undefined : GENRES.find(([re]) => re.test(f.name))?.[1];
        const col = gk ? GENRE_COL[gk] : f.color;
        g.fillStyle = col;
        pill(g);
        g.fill();
        g.font = `21.5px 'TNDE Seurat', sans-serif`;
        g.lineJoin = 'round';
        g.lineWidth = 5;
        g.strokeStyle = shade(col, 0.18);
        g.fillStyle = '#fff';
        midText(g, f.name, GX + 147.5 * GK, cy, 'center', 190 * GK);
      });
    }
    if (songsA > 0) {
      this.alpha(c, songsA, () => this.cached(c, 'songs', `${stage}`, GX, GY, 295 * GK, 33 * GK, (g) => {
        g.save();
        pill(g);
        g.clip();
        g.fillStyle = '#fff';
        g.fillRect(bx, by, bw, bh);
        // 右の水色は斜めに切る（上 165.3 → 下 156.3）
        g.fillStyle = '#c7dff6';
        g.beginPath();
        g.moveTo(GX + 165.3 * GK, by);
        g.lineTo(bx + bw, by);
        g.lineTo(bx + bw, by + bh);
        g.lineTo(GX + 156.3 * GK, by + bh);
        g.closePath();
        g.fill();
        g.restore();
        stageNums(g, stage, 1655, 1807, cy, 24, 4.5);
        midText(g, '曲目', GX + 114.5 * GK, cy, 'center');
        midText(g, '曲', GX + 213.5 * GK, cy, 'center');
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
        if (ch !== ' ') this.di(c, im, +ch * 53, 0, 53, 61, x, P(54), 53 * S * kx, 61 * S);
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
    const gw = this.lw(im) / 10;
    let px = x - P((57 * s.length) / 2);
    for (const ch of s) {
      const w = gw * S * k;
      const h = this.lh(im) * S * (k + ky);
      this.di(c, im, +ch * gw, 0, gw, this.lh(im), px, y - h, w, h);
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
/** 字の見た目の上下の真ん中を y に合わせて書く（縁取りつき。max より長ければ横に縮める） */
/**
 * 「○曲目 / ∞曲」の数字（プレイ画面とリザルトで同じ字）。白い字に黒い縁の丸ゴシック。
 * 何曲目は右をそろえ、縦は字の真ん中を cy に。∞ は小さい字なので、下を数字の下にそろえる
 */
export function stageNums(c: CanvasRenderingContext2D, stage: number, xNum: number, xInf: number, cy: number, px: number, lw: number) {
  c.font = `${px}px 'TNDE Seurat', sans-serif`;
  c.lineJoin = 'round';
  c.lineWidth = lw;
  c.strokeStyle = '#000';
  c.fillStyle = '#fff';
  midText(c, String(Math.max(1, stage)), xNum, cy, 'right');
  c.textAlign = 'right';
  c.textBaseline = 'alphabetic';
  const d = c.measureText('0');
  const base = cy + (d.actualBoundingBoxAscent - d.actualBoundingBoxDescent) / 2;
  const m = c.measureText('∞');
  const by = base + d.actualBoundingBoxDescent - m.actualBoundingBoxDescent;
  c.strokeText('∞', xInf, by);
  c.fillText('∞', xInf, by);
}

/** 字の上下の真ん中を y にそろえて描く（縁→中の順） */
export function midText(c: CanvasRenderingContext2D, t: string, x: number, y: number, align: CanvasTextAlign, max = Infinity) {
  c.textAlign = align;
  c.textBaseline = 'alphabetic';
  const m = c.measureText(t);
  const by = y + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  c.save();
  c.translate(x, by);
  if (m.width > max) c.scale(max / m.width, 1);
  c.strokeText(t, 0, 0);
  c.fillText(t, 0, 0);
  c.restore();
}

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
        wait(25000),
      ]);
      if (bm) return bm;
    } catch { /* もう 1 回 */ }
  }
  // 録画の別スレッドには Image が無い
  if (typeof Image === 'undefined') return null;
  return new Promise((res) => {
    const im = new Image();
    const t = setTimeout(() => res(null), 12000);
    im.onload = () => { clearTimeout(t); res(im); };
    im.onerror = () => { clearTimeout(t); res(null); };
    im.src = url;
  });
}

/** 1 コマ（60 fps） */
const FRAME = 1000 / 60;
/** 演出が始まってから暗くし始めるまで・暗くなるまで（参考動画で測った） */
const END_FADE_AT = 7000;
const END_FADE = 1800;
const END_KINDS = new Set(['clear', 'fc', 'allgood']);
/** 演出の種類 → 読み込む絵の組 */
const END_GROUP: Record<string, string> = { clear: 'clear', fc: 'fc', allgood: 'dfc' };
function endGroup(name: string) {
  if (name.startsWith('end/dfc/')) return 'dfc';
  if (name.startsWith('end/fc')) return 'fc';
  return 'clear';
}
/** ネームプレートの段の左上（参考動画で測った） */
const PLATE_X = -6;
const PLATE_Y = 443.5;
/** 「クリア成功」の字の左の端（1 文字 135px。下の端は y 450） */
const LETTER_X = [949, 1035, 1124, 1224, 1331];
/** 字の縦のふくらみと濃さ（1 コマごと。TJAPlayer3 と同じ表） */
const LETTER_K = [1.04, 1.11, 1.15, 1.19, 1.23, 1.26, 1.3, 1.31, 1.32, 1.32, 1.32, 1.3, 1.3, 1.26, 1.25, 1.19, 1.15, 1.11, 1.05, 1.0];
const LETTER_A = [43, 85, 128, 170, 213, 255].map((v) => v / 255);
/** クリアの 2 人のポーズ（始まってからの ms・絵の列・左・右の位置） */
const CLEAR_POSE: [number, number, number[], number[]][] = [
  [950, 5, [725, 264], [1405, 263]],
  [883, 4, [727, 266], [1406, 266]],
  [833, 3, [701, 229], [1430, 227]],
  [783, 2, [703, 230], [1429, 227]],
  [717, 1, [693, 268], [1440, 266]],
];
/** ドンだフルコンボのバチおのポーズ（ms・絵の列・左の x・y） */
const DFC_POSE: number[][] = [
  [1025, 5, 734, 280],
  [958, 4, 733, 278],
  [892, 3, 744, 244],
  [858, 2, 746, 244],
  [792, 0, 702, 278],
  [0, 1, 736, 276],
];
/** 星（真ん中の x・y、いちばん大きいとき、くり返しの中で出る時刻 ms） */
const STARS: number[][] = [
  [1206, 311, 0.9, 0], [1388, 311, 0.92, 83], [1025, 312, 0.9, 167], [1088, 457, 1.0, 250],
  [1443, 442, 0.46, 383], [1310, 457, 1.0, 500], [966, 441, 0.25, 533],
];
const STAR_PERIOD = 1575;
const CONFETTI = ['#3b5cff', '#2f6bff', '#5a3cff', '#7a3cff', '#9b40ff', '#c43cf0', '#ff3b8a', '#3b5cff', '#5a3cff'];
/** 神さまのバチおの跳ね方（1 コマごとの y。参考動画で測った） */
const GOD_JUMP = [278, 281, 285, 288, 290, 291, 292, 292, 292, 292, 292, 292, 292, 290, 287, 285, 280, 275, 269, 265, 261, 257, 254, 251, 248, 246, 244, 242, 241, 240, 240, 240, 240, 241, 242, 244, 246, 249, 251, 254, 257, 260, 264, 268, 273, 277, 282, 286, 288, 289, 289, 285, 282, 280, 278];
function godJump(f: number) {
  const i = Math.floor(f);
  return i < GOD_JUMP.length ? GOD_JUMP[i] : 278;
}

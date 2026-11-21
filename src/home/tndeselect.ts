/**
 * TNDE スキンの選曲画面・難易度えらび（canvas で描く）。
 * 位置・大きさは本家の画面録画に素材を重ねて測った値（1920×1080）。動きの時間と式は TJAPlayer3（OpenTaiko の元）と同じ。
 */
import type { AudioEngine } from '../audio/audio';
import type { SongEntry } from '../io/library';
import type { PlateStyle, TndeSkin } from '../render/tnde';
import { songPill } from '../render/tndescreens';
import { nameColor } from './folderColor';

export type Crown = 'allgood' | 'fc' | 'clear' | 'fail';
type Best = Record<string, { score: number; crown: Crown }>;

/** オンライン対戦: 選曲担当が決めた曲の難易度えらび（全員がこの画面に移る。戻れるのは選曲担当だけ） */
export interface OnlineDiff {
  key: string;
  song: SongEntry;
  canBack(): boolean;
  /** 部屋のみんな（自分は mine） */
  players(): { name: string; mine: boolean; course: string; ok: boolean; ready: boolean }[];
  /** 自分の今の難易度 */
  course(): string;
  back(): void;
  /** 難易度を選んだ（ok = 決定した） */
  pick(course: string, ok: boolean): void;
}

export interface TselHost {
  audio: AudioEngine;
  songs(): SongEntry[];
  folders(): string[];
  /** フォルダの色（genre.ini の GenreColor） */
  colors(): Record<string, string>;
  best(): Best;
  /** ネームプレートを描くスキン */
  skin(): Promise<TndeSkin | null>;
  plate(): { name: string; title: string; profile?: PlateStyle };
  /** 試聴（null で止める） */
  preview(s: SongEntry | null): void;
  /** 選んだ難易度で始める */
  play(id: string, course: string): void;
  lastCourse(id: string): string | undefined;
  /** 演奏オプション（はやさ・ドロン・あべこべ・ランダム・オート） */
  opts(): PlayOpts;
  setOpt<K extends keyof PlayOpts>(k: K, v: PlayOpts[K]): void;
  /** 下のボタン: 読み込み・新規・対戦・設定 */
  action(a: 'import' | 'new' | 'online' | 'settings', at?: { x: number; y: number; w: number; h: number }): void;
  /** 難易度えらびのボタン: エディタ・譜面情報 */
  edit(id: string, course: string): void;
  info(id: string, course: string): void;
  /** ジャケットの絵の URL（無ければ undefined） */
  jacket(s: SongEntry): Promise<string | undefined>;
  /** 曲をフォルダに入れる・外す（入っていれば外す）・新しいフォルダを作って入れる・曲を消す（どれも済んだら一覧を読み直してある） */
  toggleFolder(id: string, folder: string): Promise<void>;
  newFolder(id: string): Promise<void>;
  deleteSong(id: string): Promise<void>;
}

export interface PlayOpts {
  speed: number;
  auto: boolean;
  doron: boolean;
  mirror: boolean;
  random: 'off' | 'kimagure' | 'detarame';
}

const BASE = 'skins/tnde/';
const KANTEI = `'TNDE Kantei', 'TNDE Seurat', sans-serif`;
const SEURAT = `'TNDE Seurat', sans-serif`;
const UNCAT = 'uncat';
const COURSES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
const RANKS = [500000, 600000, 700000, 800000, 900000, 950000, 1000000];
const rankOf = (score: number) => RANKS.filter((r) => score >= r).length;
const CROWN_TYPE: Record<string, number> = { clear: 0, fc: 1, allgood: 2 };
const CROWN_CELL: Record<string, number> = { clear: 1, fc: 2, allgood: 3 };
// SongSelect_Crown の並び: おに・裏・かんたん・むずかしい・ふつう（各 3 つ）
const CROWN_BLOCK = [2, 4, 3, 0, 1];
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------- ジャンル（本家の画面からスポイトで取った色） ----------
/** 帯の絵のもとの色（塗り替えるときの基準） */
const BAR_BASE: number[][] = [[124, 223, 136], [71, 194, 212], [254, 147, 209], [205, 141, 236], [42, 226, 62], [254, 116, 45], [204, 195, 4], [253, 194, 7], [206, 209, 223], [254, 231, 11], [99, 209, 187], [62, 81, 222]];
type Look = { bar: number; rim: number[]; edge: string; chara: number };
const GENRES: [RegExp, Look][] = [
  [/ポップス|J-?POP|pops/i, { bar: 1, rim: [58, 184, 205], edge: '#13363b', chara: 1 }],
  [/アニメ/, { bar: 2, rim: [254, 120, 190], edge: '#6a1848', chara: 2 }],
  [/ボーカロイド|ボカロ|VOCALOID/i, { bar: 3, rim: [190, 130, 230], edge: '#3e2266', chara: 3 }],
  [/バラエティ/, { bar: 4, rim: [42, 210, 62], edge: '#1d4a12', chara: 4 }],
  [/ナムコ|namco/i, { bar: 5, rim: [255, 100, 36], edge: '#7a1b09', chara: 5 }],
  [/クラシック/, { bar: 6, rim: [195, 183, 0], edge: '#513925', chara: 6 }],
  [/ゲーム/, { bar: 7, rim: [253, 194, 7], edge: '#5a3a05', chara: 7 }],
  [/キッズ|どうよう|童謡/, { bar: 8, rim: [206, 209, 223], edge: '#3a3d4a', chara: 8 }],
  [/お気に入り/, { bar: 9, rim: [255, 225, 1], edge: '#392d07', chara: 9 }],
  [/最近/, { bar: 10, rim: [83, 202, 178], edge: '#153b3b', chara: 10 }],
];
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = (c: number[]) => `#${c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`;
/** CSS の色（#abc・#aabbcc・rgb() など）を [r, g, b] に。読めなければ null */
let colorCtx: CanvasRenderingContext2D | null = null;
function parseColor(css: string): number[] | null {
  if (/^#[0-9a-f]{6}$/i.test(css)) return hex(css);
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return null;
  colorCtx.fillStyle = '#000001';
  colorCtx.fillStyle = css;
  const v = String(colorCtx.fillStyle);
  if (v === '#000001') return null;
  if (/^#[0-9a-f]{6}$/i.test(v)) return hex(v);
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
/**
 * フォルダの見た目。色を決めたフォルダはその色（名前が本家のジャンルなら箱のキャラはそのジャンルの）。
 * 決めていないフォルダは、名前が本家のジャンルならその色、ほかは いつもの一覧と同じ名前から決まる色
 */
function lookOf(name: string, color?: string, key = name): Look {
  const genre = GENRES.find(([re]) => re.test(name))?.[1];
  const c = color ? parseColor(color) : null;
  if (!c && genre) return genre;
  const cc = c ?? hex(key === UNCAT ? '#5a6670' : nameColor(key));
  // いちばん近い色の帯の絵を塗り替える
  let bi = 1, bd = 1e9;
  BAR_BASE.forEach((b, i) => { const d = (b[0] - cc[0]) ** 2 + (b[1] - cc[1]) ** 2 + (b[2] - cc[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
  return { bar: bi, rim: cc, edge: toHex(cc.map((v) => v * 0.3)), chara: genre?.chara ?? -1 };
}
const BACK_LOOK: Look = { bar: -1, rim: [0, 0, 0], edge: '#2e2e36', chara: -1 };

type Item =
  | { kind: 'folder'; key: string; name: string; look: Look; count: number }
  | { kind: 'back'; look: Look }
  | { kind: 'song'; s: SongEntry; look: Look };

type Img = { im: ImageBitmap | HTMLCanvasElement; k: number; x: number; y: number; w: number; h: number };
type Anim = { pages: ImageBitmap[]; k: number; x: number; y: number; w: number; h: number; n: number; cols: number; per: number };

// バーの左上（1 段ごとに 40 右・135 下）と、まんなかの帯（閉じたとき）
const BW = 632 * 1.5, BH = 92 * 1.5;
const slotPos = (p: number) => (p < 0 ? { x: 436 + 40 * (p + 1), y: 215.5 + 135 * (p + 1) } : p > 0 ? { x: 536 + 40 * (p - 1), y: 725.5 + 135 * (p - 1) } : { x: 486, y: 471 });
function posAt(p: number) {
  const a = Math.floor(p), t = p - a;
  const A = slotPos(a), B = slotPos(a + 1);
  return { x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t) };
}

// ---------- 下のボタン・難易度えらびのボタン・演奏オプション ----------
const BLUE = '#2f8fd8', RED = '#e8452c', GRN = '#39b54a', ORG = '#f39a1e', GRY = '#6c6f7d', PUR = '#8a4fd8';
type MenuAct = 'search' | 'sort' | 'import' | 'new' | 'online' | 'settings';
const MENU: { t: string; a: MenuAct; c: string }[] = [
  { t: '検索', a: 'search', c: BLUE }, { t: '並べ替え', a: 'sort', c: BLUE }, { t: '読み込み', a: 'import', c: GRN },
  { t: '新規', a: 'new', c: GRN }, { t: '対戦', a: 'online', c: ORG }, { t: '設定', a: 'settings', c: GRY },
];
/** 下のボタンの場所（右下に横一列。右の端 1900） */
function menuRect(i: number): [number, number, number, number] {
  let x = 1900;
  for (let k = MENU.length - 1; k >= i; k--) x -= (MENU[k].t.length <= 2 ? 172 : 232) + (k < MENU.length - 1 ? 12 : 0);
  return [x, 976, MENU[i].t.length <= 2 ? 172 : 232, 86];
}
/** 難易度えらびの左のボタン（0 もどる・1 設定・6 エディタ・7 譜面情報） */
const BTN_X: Record<number, number> = { 0: 382, 1: 514, 6: 382, 7: 514 };
const BTN_Y: Record<number, number> = { 0: 405, 1: 405, 6: 537, 7: 537 };
const OPT_ANIM = 220;
const SPEEDS = [0.5, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.5, 3, 3.5, 4];
type OptRow = { k: keyof PlayOpts; label: string; vals: (number | boolean | string)[]; names: string[]; def: number | boolean | string };
const OPT_ROWS: OptRow[] = [
  { k: 'speed', label: 'はやさ', vals: SPEEDS, names: SPEEDS.map((v) => v.toFixed(1)), def: 1 },
  { k: 'doron', label: 'ドロン', vals: [false, true], names: ['しない', 'する'], def: false },
  { k: 'mirror', label: 'あべこべ', vals: [false, true], names: ['しない', 'する'], def: false },
  { k: 'random', label: 'ランダム', vals: ['off', 'kimagure', 'detarame'], names: ['なし', 'きまぐれ', 'でたらめ'], def: 'off' },
  { k: 'auto', label: 'オート', vals: [false, true], names: ['しない', 'する'], def: false },
];
// 本家の板（1920×1080 の画面で測った）: 左 18・幅 394・見出しから 1 行目の真ん中まで 107・行の間 61.5
const OPT_X = 18, OPT_W = 394, OPT_H = 107 + 61.5 * (OPT_ROWS.length - 1) + 44, OPT_Y = 1058 - OPT_H;
const optRowY = (i: number) => OPT_Y + 107 + i * 61.5;
/** 値の何番目か（はやさは一番近い値） */
function optIndex(r: OptRow, v: unknown) {
  if (r.k !== 'speed') return Math.max(0, r.vals.indexOf(v as never));
  let bi = 0;
  r.vals.forEach((x, i) => { if (Math.abs((x as number) - (v as number)) < Math.abs((r.vals[bi] as number) - (v as number))) bi = i; });
  return bi;
}
const fmtLen = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const fmtBpm = (s: SongEntry) => (s.bpmMin && s.bpmMax && Math.round(s.bpmMin) !== Math.round(s.bpmMax) ? `${Math.round(s.bpmMin)}-${Math.round(s.bpmMax)}` : String(Math.round(s.bpm)));

export class TndeSelect {
  readonly el: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private imgs = new Map<string, Img>();
  private anims = new Map<string, Anim>();
  private loaded: Promise<void> | null = null;
  private sk: TndeSkin | null = null;
  private raf = 0;
  private on = false;
  private last = 0;
  /** 画面の時計（ms） */
  private wall = 0;

  // 一覧
  private path: string[] = [];
  private items: Item[] = [];
  private cur = 0;
  /** スクロールの残り（段。+ は下から来る） */
  private scroll = 0;
  /** 止まってからの時間（帯が開く） */
  private still = 0;
  /** フォルダを開く・閉じる動き（ms。-1 = していない） */
  private boxT = -1;
  private boxTo: string[] | null = null;
  /** フォルダを入れ替えたあと、ほかの帯が出てくる（ms） */
  private fadeIn = 1e9;
  // 難易度えらび
  private diffT = -1;
  /** オンライン対戦の難易度えらび（出している間だけ） */
  private online: OnlineDiff | null = null;
  private saved: { items: Item[]; cur: number } | null = null;
  private diffOut = -1;
  private dsel = 5;
  private ura = false;
  private cursorT = 1e9;
  private startT = -1;
  /** ほかの画面が上に重なっているか（見るのは 200ms ごと） */
  private covered = false;
  private coverAt = -1e9;
  private previewed: SongEntry | null = null;
  private best: Best = {};
  /** 難易度えらびで最後に選んでいたカード（エディタ・譜面情報で開く難易度） */
  private lastCard = 5;
  // 演奏オプションの板（open: 開いているか・t: 開け閉めの動き ms・row: 選んでいる行）
  private opt = { open: false, t: 1e9, row: 0 };
  // 検索・並べ替え
  private query = '';
  private sort: 'title' | 'updated' | 'bpm' = 'title';
  private readonly qEl: HTMLInputElement;
  private jackets = new Map<string, HTMLImageElement | null>();

  constructor(private readonly host: TselHost, parent: HTMLElement) {
    this.el = document.createElement('canvas');
    this.el.className = 'tsel hidden';
    parent.append(this.el);
    this.g = this.el.getContext('2d')!;
    this.qEl = document.createElement('input');
    this.qEl.className = 'tsel-q hidden';
    this.qEl.type = 'search';
    this.qEl.enterKeyHint = 'search';
    this.qEl.addEventListener('input', () => { this.query = this.qEl.value.trim(); this.rebuild(); this.still = 0; });
    this.qEl.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.closeSearch();
      else if (e.key === 'Enter') this.qEl.blur();
    });
    parent.append(this.qEl);
    try { const v = localStorage.getItem('tsel-sort'); if (v === 'title' || v === 'updated' || v === 'bpm') this.sort = v; } catch { /* 無くてよい */ }
    this.bindInput();
    window.addEventListener('resize', () => { if (this.on) this.resize(); });
  }

  get visible() { return this.on; }

  /** 出す（select の曲を選んだ状態で） */
  async show(select?: string | null) {
    this.on = true;
    this.el.classList.remove('hidden');
    this.resize();
    this.best = this.host.best();
    this.loaded ??= this.load();
    this.sk ??= await this.host.skin();
    await this.loaded;
    // 待っている間に隠された（プレイなどに移った）ら、出さない
    if (!this.on) return;
    this.diffT = -1; this.diffOut = -1; this.startT = -1; this.boxT = -1;
    this.opt.open = false; this.opt.t = 1e9;
    this.pop = null;
    this.qEl.classList.toggle('hidden', !this.query);
    const s = select ? this.host.songs().find((x) => x.id === select) : undefined;
    if (s) {
      const f = s.folders.find((x) => !x.includes('/')) ?? s.folders[0];
      this.path = this.topFolders().length ? [f ?? UNCAT] : [];
    }
    this.rebuild(s?.id);
    this.still = 0;
    // オンライン対戦の難易度えらびを出していたら、出し直す
    if (this.online) { const od = this.online; this.online = null; this.saved = null; this.openOnline(od); }
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); }
  }

  /** オンライン対戦の曲の難易度えらびを出す（一覧はしまっておく） */
  openOnline(od: OnlineDiff) {
    if (this.online?.key === od.key) { this.online = od; return; }
    if (!this.online) this.saved = { items: this.items, cur: this.cur };
    this.online = od;
    this.items = [{ kind: 'song', s: od.song, look: lookOf('') }];
    this.cur = 0;
    this.scroll = 0;
    this.pop = null;
    this.opt.open = false;
    const has = (c: string) => od.song.courses.some((x) => x.name === c);
    const want = has(od.course()) ? od.course() : ['Oni', 'Edit', 'Hard', 'Normal', 'Easy'].find(has) ?? 'Oni';
    this.ura = want === 'Edit';
    this.dsel = want === 'Edit' ? 5 : 2 + COURSES.indexOf(want);
    this.lastCard = this.dsel;
    this.cursorT = 1e9;
    this.diffT = 1000;
    this.diffOut = -1;
    this.startT = -1;
    this.boxT = -1;
    this.still = OPEN_AT + OPEN_MS;
    this.previewed = null;
    this.se('Diff');
  }

  /** オンライン対戦の難易度えらびを閉じて、一覧に戻す */
  closeOnline() {
    if (!this.online) return;
    this.online = null;
    if (this.saved?.items.length) { this.items = this.saved.items; this.cur = Math.min(this.saved.cur, this.items.length - 1); }
    this.saved = null;
    this.diffT = -1;
    this.diffOut = -1;
    this.startT = -1;
    this.still = 0;
  }

  hide() {
    this.on = false;
    this.el.classList.add('hidden');
    this.qEl.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.previewed = null;
    this.host.audio.bgmStop();
    // 画面の canvas のメモリを返す（出すときに resize で戻す）
    this.el.width = this.el.height = 0;
    // プレイ中は大きな絵（フォルダのキャラ・難易度えらびの背景・跳ぶどんちゃん）と描いた字を手放す。
    // ほかの絵（65MB ほど）は持ったまま（戻ったときにすぐ出せるように）
    this.releaseLazy();
  }

  private releaseLazy() {
    for (const [k, m] of [...this.imgs]) if (LAZY.test(k)) { freeImg(m.im); this.imgs.delete(k); }
    // どんちゃん（ふだんの動き。21MB）も手放す（戻ったときに読み直す）
    for (const [k, a] of [...this.anims]) if (LAZY.test(k) || k === 'donLoop') { for (const pg of a.pages) pg.close(); this.anims.delete(k); }
    for (const [k, m] of [...this.tints]) if (LAZY.test(k)) { freeImg(m.im); this.tints.delete(k); }
    for (const k of [...this.pending]) if (LAZY.test(k)) this.pending.delete(k);
    for (const c of this.btnCache.values()) freeImg(c);
    for (const t of this.texts.values()) freeImg(t.cv);
    this.btnCache.clear();
    this.texts.clear();
    this.jackets.clear();
  }

  // ---------- 絵 ----------

  private man: { img: Record<string, { f: string; k: number; x: number; y: number; w: number; h: number }>; anim: Record<string, Omit<Anim, 'pages'> & { pages: string[] }> } | null = null;
  /** 読み込み中の絵 */
  private pending = new Set<string>();
  /** 読み直しの世代（手放したあとに届いた絵は捨てる） */
  private gen = 0;
  /** 最後に使った時（後から読む絵を手放す順） */
  private used = new Map<string, number>();

  private async load() {
    const gen = this.gen;
    const r = await fetch(`${BASE}sel.json`, { cache: 'no-cache' });
    const man = (await r.json()) as NonNullable<TndeSelect['man']>;
    if (gen !== this.gen) return;
    this.man = man;
    // 大きな絵（フォルダのキャラ・難易度えらびの背景・どんちゃんの跳ぶ動き・帯の色）は、使うときに読む
    await Promise.all([...Object.keys(man.img), ...Object.keys(man.anim)].filter((n) => !LAZY.test(n)).map((n) => this.fetchImg(n)));
    for (const k of ['Ka', 'Don', 'Diff', 'Cancel', 'Ura', 'BgmIn', 'Bgm']) void this.host.audio.loadUi(`tsel:${k}`, `${BASE}se/sel${k}.ogg`);
    await Promise.all([document.fonts.load(`40px ${KANTEI}`, '選曲自己ベスト'), document.fonts.load(`36px ${SEURAT}`, '1曲目∞')]);
  }

  private se(n: string) { this.host.audio.playUi(`tsel:${n}`); }

  /** 絵（まだ読んでいなければ読み始めて undefined） */
  private im(name: string) {
    const m = this.imgs.get(name);
    if (m) { this.used.set(name, this.wall); return m; }
    void this.fetchImg(name);
    return undefined;
  }
  private an(name: string) {
    const a = this.anims.get(name);
    if (a) { this.used.set(name, this.wall); return a; }
    void this.fetchImg(name);
    return undefined;
  }
  private async fetchImg(name: string) {
    const man = this.man;
    if (!man || this.pending.has(name) || this.imgs.has(name) || this.anims.has(name)) return;
    const gen = this.gen;
    this.pending.add(name);
    const bmp = async (f: string) => createImageBitmap(await (await fetch(`${BASE}${f}`)).blob());
    try {
      const m = man.img[name];
      const a = man.anim[name];
      if (m) {
        const im = await bmp(m.f);
        if (gen !== this.gen || (!this.on && LAZY.test(name))) { im.close(); return; }
        this.imgs.set(name, { ...m, im });
      } else if (a) {
        const pages = await Promise.all(a.pages.map(bmp));
        if (gen !== this.gen || (!this.on && (LAZY.test(name) || name === 'donLoop'))) { for (const pg of pages) pg.close(); return; }
        this.anims.set(name, { ...a, pages });
      }
      this.used.set(name, this.wall);
      this.evict(name);
    } catch { /* 無くても描ける */ } finally {
      if (gen === this.gen) this.pending.delete(name);
    }
  }
  /** 後から読む大きな絵は、種類ごとに最近使った 2 つだけ残す */
  private evict(name: string) {
    const grp = /^(boxChara|diffBack)/.exec(name)?.[1];
    if (!grp) return;
    const keys = [...this.imgs.keys()].filter((k) => k.startsWith(grp)).sort((a, b) => (this.used.get(b) ?? 0) - (this.used.get(a) ?? 0));
    for (const k of keys.slice(2)) {
      freeImg(this.imgs.get(k)!.im);
      this.imgs.delete(k);
      for (const t of [...this.tints.keys()]) if (t.startsWith(`${k}|`)) { freeImg(this.tints.get(t)!.im); this.tints.delete(t); }
    }
  }

  /** 元の絵の座標 (sx, sy, sw, sh) を (dx, dy, dw, dh) に描く。切り出し・細かさを足し引きする */
  private blit(name: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
    const m = this.im(name);
    if (!m) return;
    this.g.drawImage(m.im, (sx - m.x) * m.k, (sy - m.y) * m.k, sw * m.k, sh * m.k, dx, dy, dw, dh);
  }
  /** 1280×720 いっぱいの絵を、1920×1080 の (ox, oy) ずらした所に */
  private full(name: string, ox = 0, oy = 0) {
    const m = this.im(name);
    if (m) this.g.drawImage(m.im, m.x * 1.5 + ox, m.y * 1.5 + oy, m.w * 1.5, m.h * 1.5);
  }
  private whole(name: string, dx: number, dy: number, k = 1.5) {
    const m = this.im(name);
    if (m) this.g.drawImage(m.im, dx, dy, m.w * k, m.h * k);
  }
  /** 9 分割で引きのばす（角はそのまま 1.5 倍） */
  private nine(im: Img, s: number[], d: number[], cx: number, cy: number) {
    const [sx, sy, sw, sh] = s, [dx, dy, dw, dh] = d;
    const xs = [sx, sx + cx, sx + sw - cx, sx + sw], ys = [sy, sy + cy, sy + sh - cy, sy + sh];
    const X = [dx, dx + cx * 1.5, dx + dw - cx * 1.5, dx + dw], Y = [dy, dy + cy * 1.5, dy + dh - cy * 1.5, dy + dh];
    if (X[2] < X[1]) { const m = (dx + dx + dw) / 2; X[1] = X[2] = m; }
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const w = xs[i + 1] - xs[i], h = ys[j + 1] - ys[j];
      if (w <= 0 || h <= 0 || X[i + 1] <= X[i] || Y[j + 1] <= Y[j]) continue;
      this.g.drawImage(im.im, (xs[i] - im.x) * im.k, (ys[j] - im.y) * im.k, w * im.k, h * im.k, X[i], Y[j], X[i + 1] - X[i], Y[j + 1] - Y[j]);
    }
  }

  private sils = new Map<string, Img>();
  /** 絵の形だけを黒くしたもの（縁を太くするのに使う） */
  private silhouette(name: string): Img | undefined {
    const have = this.sils.get(name);
    if (have) return have;
    const m = this.im(name);
    if (!m) return undefined;
    const o = document.createElement('canvas');
    o.width = m.im.width; o.height = m.im.height;
    const g = o.getContext('2d')!;
    g.drawImage(m.im, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#120c10';
    g.fillRect(0, 0, o.width, o.height);
    const r = { ...m, im: o };
    this.sils.set(name, r);
    return r;
  }
  private blitImg(m: Img | undefined, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
    if (m) this.g.drawImage(m.im, (sx - m.x) * m.k, (sy - m.y) * m.k, sw * m.k, sh * m.k, dx, dy, dw, dh);
  }

  private tints = new Map<string, Img>();
  /** 絵の色を塗り替える（もとの色 base からの明るさの比で。黒い縁はそのまま） */
  private tinted(name: string, base: number[], to: number[], skip?: (r: number, g: number, b: number) => boolean): Img | undefined {
    const key = `${name}|${to.join(',')}`;
    const have = this.tints.get(key);
    if (have) return have;
    const m = this.im(name);
    if (!m) return undefined;
    const o = document.createElement('canvas');
    o.width = m.im.width; o.height = m.im.height;
    const g = o.getContext('2d')!;
    g.drawImage(m.im, 0, 0);
    const px = g.getImageData(0, 0, o.width, o.height), p = px.data;
    const bs = base[0] + base[1] + base[2];
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] === 0) continue;
      const r = p[i], gg = p[i + 1], b = p[i + 2];
      if (r + gg + b < 90 || skip?.(r, gg, b)) continue;
      const k = Math.min((r + gg + b) / bs, 1.6);
      p[i] = Math.min(255, to[0] * k); p[i + 1] = Math.min(255, to[1] * k); p[i + 2] = Math.min(255, to[2] * k);
    }
    g.putImageData(px, 0, 0);
    const t = { ...m, im: o };
    this.tints.set(key, t);
    return t;
  }
  private barImg(l: Look) {
    if (l.bar < 0) return this.im('barBack');
    return this.tinted(`bar${l.bar}`, BAR_BASE[l.bar], l.rim);
  }

  // ---------- 字（勘亭流・白い字に色の縁。描いた字はとっておく） ----------

  private texts = new Map<string, { cv: HTMLCanvasElement; w: number; h: number; ax: number; ay: number }>();
  private textScale = 1;
  private text(t: string, px: number, lw: number, edge: string, opt: { font?: string; kx?: number; punct?: number; fill?: string } = {}) {
    const font = opt.font ?? KANTEI, kx = opt.kx ?? 1, punct = opt.punct ?? 1, fill = opt.fill ?? '#fff';
    const Z = this.textScale;
    const key = `${t}|${px}|${lw}|${edge}|${font}|${kx}|${punct}|${fill}|${Z}`;
    const have = this.texts.get(key);
    if (have) return have;
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d')!;
    g.font = `${px}px ${font}`;
    const chars = [...t];
    const adv = chars.map((ch) => g.measureText(ch).width * ('、。'.includes(ch) ? punct : 1));
    const w = adv.reduce((a, b) => a + b, 0) * kx;
    const m = g.measureText(t);
    const asc = m.actualBoundingBoxAscent, des = m.actualBoundingBoxDescent;
    const pad = lw;
    cv.width = Math.ceil((w + pad * 2) * Z) + 2;
    cv.height = Math.ceil((asc + des + pad * 2) * Z) + 2;
    g.scale(Z, Z);
    g.translate(pad, pad + asc);
    g.scale(kx, 1);
    g.font = `${px}px ${font}`;
    g.lineJoin = 'round';
    g.lineWidth = lw;
    g.strokeStyle = edge;
    g.fillStyle = fill;
    for (const pass of [0, 1]) {
      let x = 0;
      chars.forEach((ch, i) => { if (pass === 0) { if (lw > 0) g.strokeText(ch, x, 0); } else g.fillText(ch, x, 0); x += adv[i]; });
    }
    const r = { cv, w: w + pad * 2, h: asc + des + pad * 2, ax: (w + pad * 2) / 2, ay: (asc + des + pad * 2) / 2 };
    // 描いた字は 160 まで（古いものから手放す）
    while (this.texts.size >= 160) {
      const [k0, old] = this.texts.entries().next().value!;
      freeImg(old.cv);
      this.texts.delete(k0);
    }
    this.texts.set(key, r);
    return r;
  }
  /** 字を (cx, cy) を真ん中に。maxW を超えたら横を縮める */
  private put(t: ReturnType<TndeSelect['text']>, cx: number, cy: number, maxW = Infinity, align: 'center' | 'right' | 'left' = 'center') {
    const sx = t.w > maxW ? maxW / t.w : 1;
    const w = t.w * sx;
    const x = align === 'right' ? cx - w : align === 'left' ? cx : cx - w / 2;
    this.g.drawImage(t.cv, x, cy - t.ay, w, t.h);
  }

  // ---------- 一覧を作る ----------

  private topFolders() {
    const fs = this.host.folders().filter((f) => !f.includes('/')).sort((a, b) => a.localeCompare(b, 'ja'));
    const songs = this.host.songs();
    if (!fs.length) return [];
    return songs.some((s) => !s.folders.length) ? [...fs, UNCAT] : fs;
  }

  private rebuild(selectId?: string) {
    const songs = this.host.songs();
    const colors = this.host.colors();
    const folderItem = (key: string): Item => {
      const name = key === UNCAT ? '未分類' : key.split('/').pop()!;
      const count = key === UNCAT ? songs.filter((s) => !s.folders.length).length : songs.filter((s) => s.folders.some((f) => f === key || f.startsWith(`${key}/`))).length;
      return { kind: 'folder', key, name, look: lookOf(name, colors[key], key), count };
    };
    const byTitle = this.sort === 'updated' ? (a: SongEntry, b: SongEntry) => b.updatedAt - a.updatedAt
      : this.sort === 'bpm' ? (a: SongEntry, b: SongEntry) => a.bpm - b.bpm || a.title.localeCompare(b.title, 'ja')
        : (a: SongEntry, b: SongEntry) => a.title.localeCompare(b.title, 'ja');
    let items: Item[];
    const top = this.topFolders();
    if (this.query) {
      // 検索中: 合う曲だけを、フォルダに分けずに並べる
      const q = this.query.toLowerCase();
      items = songs.filter((s) => `${s.title} ${s.subtitle}`.toLowerCase().includes(q)).sort(byTitle)
        .map((s) => ({ kind: 'song' as const, s, look: lookOf(s.folders[0]?.split('/').pop() ?? '', colors[s.folders[0] ?? ''], s.folders[0] ?? UNCAT) }));
    } else if (!this.path.length) {
      items = top.length ? top.map(folderItem) : [...songs].sort(byTitle).map((s) => ({ kind: 'song' as const, s, look: lookOf('') }));
    } else {
      const key = this.path[this.path.length - 1];
      const look = folderItem(key).look;
      const subs = key === UNCAT ? [] : this.host.folders().filter((f) => f.startsWith(`${key}/`) && !f.slice(key.length + 1).includes('/')).sort((a, b) => a.localeCompare(b, 'ja'));
      const inside = songs.filter((s) => (key === UNCAT ? !s.folders.length : s.folders.includes(key))).sort(byTitle);
      items = [{ kind: 'back', look: BACK_LOOK }, ...subs.map(folderItem), ...inside.map((s) => ({ kind: 'song' as const, s, look }))];
    }
    if (!items.length) items = [{ kind: 'back', look: BACK_LOOK }];
    const keep = selectId ?? (this.items.length && this.center.kind === 'song' ? this.center.s.id : undefined);
    this.items = items;
    let i = keep ? items.findIndex((x) => x.kind === 'song' && x.s.id === keep) : -1;
    if (i < 0) i = items.findIndex((x) => x.kind !== 'back');
    this.cur = Math.max(0, i);
    this.scroll = 0;
  }

  private at(i: number) {
    const n = this.items.length;
    return this.items[((i % n) + n) % n];
  }
  private get center() { return this.at(this.cur); }

  // ---------- 操作 ----------

  private busy() { return this.boxT >= 0 || this.startT >= 0 || (this.diffT >= 0 && this.diffT < 1510) || this.diffOut >= 0 || this.opt.t < OPT_ANIM; }

  private move(d: number) {
    if (this.pop) { this.popMove(d); return; }
    if (this.busy()) return;
    if (this.opt.open) { this.optRow(d); return; }
    if (this.diffT >= 0) { this.moveCursor(d); return; }
    if (!this.items.length) return;
    this.cur = (((this.cur + d) % this.items.length) + this.items.length) % this.items.length;
    this.scroll = clamp(this.scroll + d, -3, 3);
    this.still = 0;
    this.se('Ka');
  }

  private decide() {
    if (this.pop) { void this.popAct(this.pop.sel); return; }
    if (this.busy()) return;
    if (this.opt.open) { this.optChange(1); return; }
    if (this.diffT >= 0) { this.decideDiff(); return; }
    if (this.scroll !== 0) return;
    // 開ききる前に決めたときは、開いた所から
    this.still = Math.max(this.still, OPEN_AT + OPEN_MS);
    const it = this.center;
    if (it.kind === 'song') {
      this.se('Don');
      this.se('Diff');
      this.diffT = 0;
      const last = this.host.lastCourse(it.s.id);
      const has = (c: string) => it.s.courses.some((x) => x.name === c);
      this.ura = (last === 'Edit' && has('Edit')) || (!has('Oni') && has('Edit'));
      const want = last && has(last) ? last : ['Oni', 'Edit', 'Hard', 'Normal', 'Easy'].find(has) ?? 'Oni';
      this.dsel = want === 'Edit' ? 5 : 2 + COURSES.indexOf(want);
      this.lastCard = this.dsel;
      this.cursorT = 1e9;
    } else {
      this.se('Don');
      this.boxT = 0;
      this.boxTo = it.kind === 'back' ? this.path.slice(0, -1) : [...this.path, it.key];
    }
  }

  private back() {
    if (this.pop) { this.closePop(); return; }
    if (this.busy()) return;
    if (this.opt.open) { this.optClose(); return; }
    if (this.diffT >= 0 && this.online) { if (this.online.canBack()) { this.se('Cancel'); this.online.back(); } return; }
    if (this.diffT >= 0) { this.se('Cancel'); this.diffOut = 0; return; }
    if (this.query || !this.qEl.classList.contains('hidden')) { this.se('Cancel'); this.closeSearch(); return; }
    if (this.path.length) { this.se('Cancel'); this.boxT = 0; this.boxTo = this.path.slice(0, -1); }
  }

  /** 難易度えらびの並び: 0 もどる・1 設定・2〜5 かんたん〜おに（5 は裏にもなる） */
  private courseAt(i: number) { return i < 2 || i > 5 ? null : i === 5 && this.ura ? 'Edit' : COURSES[i - 2]; }
  private hasCourse(i: number) {
    const it = this.center;
    const c = this.courseAt(i);
    return !c || (it.kind === 'song' && it.s.courses.some((x) => x.name === c));
  }
  private moveCursor(d: number) {
    const it = this.center;
    if (it.kind !== 'song') return;
    // おにで右: 裏おにがあれば入れ替える
    if (d > 0 && this.dsel === 5) {
      const other = this.ura ? 'Oni' : 'Edit';
      if (it.s.courses.some((x) => x.name === other)) { this.ura = !this.ura; this.se('Ura'); this.cursorT = 0; this.onlineCursor(); }
      return;
    }
    // 並び: もどる・設定・エディタ・譜面情報・かんたん〜おに
    const order = this.online ? [0, 1, 2, 3, 4, 5] : [0, 1, 6, 7, 2, 3, 4, 5];
    let j = order.indexOf(this.dsel);
    do j += d; while (j >= 0 && j < order.length && !this.hasCourse(order[j]));
    if (j < 0 || j >= order.length) return;
    this.dsel = order[j];
    if (this.dsel >= 2 && this.dsel <= 5) this.lastCard = this.dsel;
    this.cursorT = 0;
    this.se('Ka');
    this.onlineCursor();
  }
  /** オンライン: 難易度のカードに動いたら、その難易度を知らせる（決定は取り消し） */
  private onlineCursor() {
    const c = this.courseAt(this.dsel);
    if (this.online && c) this.online.pick(c, false);
  }
  private decideDiff() {
    const it = this.center;
    if (it.kind !== 'song') return;
    if (this.dsel === 0) { this.back(); return; }
    if (this.dsel === 1) { this.se('Don'); this.optOpen(); return; }
    if (this.online) {
      const c = this.courseAt(this.dsel);
      if (c) { this.se('Don'); this.online.pick(c, true); }
      return;
    }
    if (this.dsel === 6 || this.dsel === 7) {
      const c = this.courseAt(this.lastCard) ?? this.focusCourse();
      this.se('Don');
      if (this.dsel === 6) this.host.edit(it.s.id, c);
      else this.host.info(it.s.id, c);
      return;
    }
    this.se('Don');
    this.startT = 0;
  }

  private bindInput() {
    const toStage = (e: { clientX: number; clientY: number }) => {
      // 画面全体が拡大・縮小されていても合うよう、見えている大きさと canvas の px の比で
      const r = this.el.getBoundingClientRect();
      const kx = this.el.width / Math.max(1, r.width), ky = this.el.height / Math.max(1, r.height);
      return { x: ((e.clientX - r.left) * kx - this.ox) / this.s, y: ((e.clientY - r.top) * ky - this.oy) / this.s };
    };
    let down: { x: number; y: number; t: number; acc: number; accX: number; moved: boolean } | null = null;
    let press = 0;
    this.el.addEventListener('pointerdown', (e) => {
      const ctx = this.host.audio.ctx;
      if (ctx.state !== 'running') void ctx.resume();
      const p = toStage(e);
      down = { x: p.x, y: p.y, t: performance.now(), acc: 0, accX: 0, moved: false };
      this.el.setPointerCapture(e.pointerId);
      // 曲の帯を長押し: 曲のメニュー
      clearTimeout(press);
      const d0 = down;
      if (!this.pop && this.diffT < 0 && !this.opt.open && !this.busy()) {
        press = window.setTimeout(() => {
          if (down !== d0 || d0.moved) return;
          const it = this.songAt(p);
          if (!it) return;
          d0.moved = true;
          this.openPop('song', it);
        }, 550);
      }
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.pop || this.diffT >= 0 || this.opt.open || this.busy()) return;
      const it = this.songAt(toStage(e));
      if (it) this.openPop('song', it);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const p = toStage(e);
      const dy = p.y - down.y, dx = p.x - down.x;
      if (Math.abs(dy) > 24 || Math.abs(dx) > 24) down.moved = true;
      if (this.pop) {
        // フォルダの一覧: 指で動かす
        if (this.pop.kind === 'folder') { this.pop.scroll = this.clampScroll(this.pop.scroll - (dy - down.acc)); down.acc = dy; }
        return;
      }
      if (this.diffT >= 0) {
        // 難易度えらび: 横に払って動かす
        const steps = Math.trunc((dx - down.accX) / 150);
        if (steps) { down.accX += steps * 150; this.move(steps > 0 ? 1 : -1); }
        return;
      }
      const steps = Math.trunc((dy - down.acc) / 120);
      if (steps) { down.acc += steps * 120; this.move(steps > 0 ? -1 : 1); }
    });
    const up = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.moved) return;
      this.tap(toStage(e));
    };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', () => { down = null; });
    let wheelAcc = 0;
    this.el.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.pop?.kind === 'folder') { this.pop.scroll = this.clampScroll(this.pop.scroll + e.deltaY); return; }
      if (this.pop) return;
      wheelAcc += e.deltaY;
      while (Math.abs(wheelAcc) >= 60) { const d = Math.sign(wheelAcc); wheelAcc -= d * 60; this.move(d); }
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.on || e.isComposing) return;
      // 設定などの面が開いているときは動かさない
      if (document.getElementById('sheet')?.classList.contains('hidden') === false) return;
      const k = e.key;
      if (this.opt.open && !this.busy() && (k === 'ArrowLeft' || k === 'ArrowRight')) { this.optChange(k === 'ArrowLeft' ? -1 : 1); e.preventDefault(); return; }
      if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'd' || k === 'D') this.move(-1);
      else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'k' || k === 'K') this.move(1);
      else if (k === 'Enter' || k === ' ' || k === 'f' || k === 'F' || k === 'j' || k === 'J') this.decide();
      else if (k === 'Escape' || k === 'Backspace') this.back();
      else return;
      e.preventDefault();
    });
  }

  private tap(p: { x: number; y: number }) {
    if (this.pop) { this.popTap(p); return; }
    if (this.busy()) return;
    if (this.opt.open) { this.optTap(p); return; }
    if (this.diffT >= 0) {
      const hit = [[382, 405, 115, 114], [514, 405, 115, 114], ...[647, 861, 1077, 1292].map((x) => [x, 405, 196, 355]), [382, 537, 115, 114], [514, 537, 115, 114]];
      const i = hit.findIndex(([x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h);
      if (i < 0 || !this.hasCourse(i) || (this.online && i >= 6)) return;
      if (i === this.dsel) this.decideDiff();
      else { this.dsel = i; if (i >= 2 && i <= 5) this.lastCard = i; this.cursorT = 0; this.se('Ka'); this.onlineCursor(); }
      return;
    }
    // 下のボタン
    const b = MENU.findIndex((_, i) => { const r = menuRect(i); return p.x >= r[0] && p.x <= r[0] + r[2] && p.y >= r[1] && p.y <= r[1] + r[3]; });
    if (b >= 0) { this.menu(MENU[b].a); return; }
    // まんなかの帯: 決める。ほかの帯: そこまで動かす
    if (p.y >= 383 && p.y <= 697 && p.x >= 470 && p.x <= 1450) { this.decide(); return; }
    for (let k = 1; k <= 3; k++) {
      for (const sgn of [-1, 1]) {
        const q = slotPos(sgn * k);
        if (p.x >= q.x && p.x <= q.x + BW && p.y >= q.y && p.y <= q.y + BH) { for (let n = 0; n < k; n++) this.move(sgn); return; }
      }
    }
  }

  // ---------- 描く ----------

  private dpr = 1;
  private s = 1;
  private ox = 0;
  private oy = 0;
  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    // 見えている大きさ（画面全体が拡大・縮小されていてもそのまま）で、細かさを合わせる
    const rb = this.el.getBoundingClientRect();
    const w = Math.round(rb.width * this.dpr), h = Math.round(rb.height * this.dpr);
    if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    this.s = Math.min(w / 1920, h / 1080);
    this.ox = (w - 1920 * this.s) / 2;
    this.oy = (h - 1080 * this.s) / 2;
    const z = Math.max(1, Math.round(this.s * 2) / 2);
    if (z !== this.textScale) {
      this.textScale = z;
      for (const t of this.texts.values()) freeImg(t.cv);
      this.texts.clear();
      for (const c of this.btnCache.values()) freeImg(c);
      this.btnCache.clear();
    }
  }

  private frame(now: number) {
    this.raf = this.on ? requestAnimationFrame((t) => this.frame(t)) : 0;
    if (!this.on) return;
    const dt = Math.min(100, now - this.last);
    this.last = now;
    this.step(dt);
    try { this.draw(); } catch { /* 描けないコマは飛ばす */ }
  }

  private step(dt: number) {
    this.wall += dt;
    // スクロールは 1 段 100ms ほどで寄せる
    if (this.scroll !== 0) {
      const v = Math.max(0.01, Math.abs(this.scroll) * 0.25 + 0.06) * (dt / 16.7);
      this.scroll = Math.abs(this.scroll) <= v ? 0 : this.scroll - Math.sign(this.scroll) * v;
      this.still = 0;
    } else this.still += dt;
    this.fadeIn += dt;
    this.cursorT += dt;
    this.opt.t += dt;
    if (this.boxT >= 0) {
      this.boxT += dt;
      // ctBoxOpen: 200 から 1.3ms ごと。1940 で中を入れ替える
      if (this.boxT >= BOX_END && this.boxTo) {
        const from = this.path[this.path.length - 1];
        const up = this.boxTo.length < this.path.length;
        this.path = this.boxTo;
        this.boxTo = null;
        this.rebuild();
        // 閉じて戻ったときは、出てきたフォルダを選ぶ
        if (up) {
          const i = this.items.findIndex((x) => x.kind === 'folder' && x.key === from);
          if (i >= 0) this.cur = i;
        }
        this.boxT = -1;
        this.fadeIn = 0;
        this.still = 0;
      }
    }
    if (this.diffT >= 0) this.diffT += dt;
    if (this.diffOut >= 0) {
      this.diffOut += dt;
      if (this.diffOut >= 400) { this.diffOut = -1; this.diffT = -1; this.still = OPEN_AT + OPEN_MS; }
    }
    if (this.startT >= 0) {
      this.startT += dt;
      if (this.startT >= 700 && this.startT - dt < 700) {
        const it = this.center;
        const c = this.courseAt(this.dsel);
        if (it.kind === 'song' && c) this.host.play(it.s.id, c);
      }
    }
    // 後から読む絵は、まんなかに来たときに読み始めておく（開いたとき・決めたときに間に合うように）
    {
      const c = this.center;
      if (c.kind === 'folder' && c.look.chara >= -1) this.im(`boxChara${c.look.chara}`);
      else if (c.kind === 'song') { this.im(`diffBack${c.look.bar < 0 ? 0 : c.look.bar}`); if (this.still > 300) this.an('donStart'); }
    }
    // 試聴: まんなかの曲が開いたら流す（フォルダの上・フォルダを開く間は止める。流している間は前の曲のまま）
    const it = this.center;
    let want = this.previewed;
    if (this.online || this.boxT >= 0 || (it.kind !== 'song' && this.still > 0)) want = null;
    else if (it.kind === 'song' && this.still >= 450) want = it.s;
    if (want !== this.previewed) {
      this.previewed = want;
      this.host.preview(want);
    }
    // 選曲の BGM: 試聴が鳴っている間と、曲を決めたあとは消す
    // 設定・対戦ルーム・譜面情報など、ほかの画面が上に重なっている間も消す（画面のまんなかに見えているものが選曲画面かで見る）
    if (this.wall - this.coverAt >= 200) {
      this.coverAt = this.wall;
      const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      this.covered = !!top && top !== this.el && !this.el.parentElement?.contains(top);
    }
    const A = this.host.audio;
    if (A.bgmStart('tsel:BgmIn', 'tsel:Bgm')) A.bgmLevel(A.previewing || this.startT >= 0 || this.covered || this.online ? 0 : 1);
  }

  /** 帯が開いた量（0〜62。本家は止まって 400ms から 120ms で開くが、待たずに使えるよう 60ms から 140ms で開く） */
  private bac() {
    if (this.scroll !== 0 || this.boxT >= 0) return this.boxT >= 0 ? 62 : 0;
    const t = clamp((this.still - OPEN_AT) / OPEN_MS, 0, 1);
    return Math.sin(rad(t * 90)) * 62;
  }

  private draw() {
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.background();
    g.setTransform(this.s, 0, 0, this.s, this.ox, this.oy);
    const inDiff = this.diffT >= 0;
    // 難易度えらびへ: 1000〜1255ms で一覧が消え、1255〜1510ms で難易度えらびが出る
    const listA = !inDiff ? 1 : this.diffOut >= 0 ? clamp(this.diffOut / 300, 0, 1) : clamp(1 - (this.diffT - 1000) / 255, 0, 1);
    const diffA = !inDiff ? 0 : this.diffOut >= 0 ? clamp(1 - this.diffOut / 300, 0, 1) : clamp((this.diffT - 1255) / 255, 0, 1);
    const course = inDiff ? this.courseAt(this.dsel) ?? 'Oni' : this.focusCourse();
    const ci = Math.max(0, COURSES.indexOf(course));
    // 重なり順は本家と同じ: 印 → 一覧・難易度えらび → どんちゃん → 記録 → 右上 → 2人プレイの雲 → ネームプレート
    if (diffA > 0) this.mark(ci, diffA);
    if (listA > 0) {
      g.globalAlpha = listA;
      this.guideTop();
      this.list();
      this.menuBar();
      g.globalAlpha = 1;
    }
    if (diffA > 0) {
      g.globalAlpha = diffA;
      this.diffScreen();
      g.globalAlpha = 1;
    }
    this.don();
    this.side(ci);
    this.stageNums();
    this.timer();
    if (this.online) this.onlinePanel();
    else this.full('credit', 3.5, 3);
    if (this.sk) {
      const pl = this.host.plate();
      this.sk.plate(g, { name: pl.name, title: pl.title, profile: pl.profile, wall: this.wall } as never, 60, 476);
    }
    this.optPanel();
    this.drawPop();
  }

  private pat: CanvasPattern | null = null;
  private background() {
    const g = this.g, W = this.el.width, H = this.el.height;
    const y = (v: number) => (this.oy + v * this.s) / H;
    const gr = g.createLinearGradient(0, 0, 0, H);
    const stops: [number, string][] = [[0, '254,238,44'], [120, '254,211,45'], [360, '254,156,46'], [600, '253,105,47'], [720, '253,99,61'], [960, '252,94,110'], [1080, '249,97,128']];
    for (const [v, c] of stops) gr.addColorStop(clamp(y(v), 0, 1), `rgb(${c})`);
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    // 模様（白・不透明度つきの 1 枚を繰り返す）。本家の画面に重ねて測った: 720p の 1.5 倍で、左へ 1 秒に 93 px 流れる
    const m = this.im('pattern');
    if (m) {
      if (!this.pat) this.pat = g.createPattern(m.im, 'repeat');
      if (this.pat) {
        const k = 1.5 / m.k * this.s, tw = m.w * 1.5, th = m.h * 1.5;
        const x = (((769.5 - (performance.now() / 1000) * 93) % tw) + tw) % tw - tw, y = 173 - th;
        this.pat.setTransform(new DOMMatrix([k, 0, 0, k, this.ox + x * this.s, this.oy + y * this.s]));
        g.fillStyle = this.pat;
        g.fillRect(0, 0, W, H);
      }
    }
  }

  private focusCourse() {
    const it = this.center;
    if (it.kind !== 'song') return 'Oni';
    const last = this.host.lastCourse(it.s.id);
    if (last && it.s.courses.some((c) => c.name === last)) return last;
    return ['Oni', 'Edit', 'Hard', 'Normal', 'Easy'].find((c) => it.s.courses.some((x) => x.name === c)) ?? 'Oni';
  }

  /** どんちゃん（1 秒に 45 コマ。決めたときは跳ぶ） */
  private don() {
    const jump = this.startT >= 0 ? this.an('donStart') : undefined;
    const a = jump ?? this.an('donLoop');
    if (!a) return;
    const n = jump ? Math.min(a.n - 1, Math.floor(this.startT / (1000 / 45))) : Math.floor(this.wall / (1000 / 45)) % a.n;
    const pg = a.pages[Math.floor(n / a.per)];
    const j = n % a.per;
    const W = a.w * a.k, H = a.h * a.k;
    this.g.drawImage(pg, (j % a.cols) * W, Math.floor(j / a.cols) * H, W, H, a.x * 1.5, 495 + a.y * 1.5, a.w * 1.5, a.h * 1.5);
  }

  /** 左の記録の表（その難易度の王冠・ランクの数）と自己ベスト */
  private side(ci: number) {
    const songs = this.host.songs();
    const c = COURSES[ci];
    const cnt = { rank: [0, 0, 0, 0, 0, 0, 0, 0], crown: { clear: 0, fc: 0, allgood: 0 } as Record<string, number> };
    for (const s of songs) {
      const b = this.best[`${s.id}:${c}`];
      if (!b) continue;
      cnt.rank[rankOf(b.score)]++;
      if (b.crown !== 'fail') cnt.crown[b.crown]++;
    }
    this.full(`table${Math.min(ci, 4)}`, 1.5, -2.5);
    // 数は自己ベストと同じ数字の絵（灰色の字に白い縁）。右をそろえる
    const num = (v: number, x: number, y: number) => {
      const ds = String(v).split('');
      const W = 21, k = 0.83, adv = 16;
      const x0 = x - (adv * (ds.length - 1) + W * k);
      ds.forEach((d, i) => this.blit('levelNum', Number(d) * W, 0, W, 25, x0 + i * adv, y - (25 * k) / 2, W * k, 25 * k));
    };
    // 上の右: 極、1 段目: 雅（3 つ）、2 段目: 粋（3 つ）、3 段目: 王冠
    num(cnt.rank[7], 306, 354);
    const rows = [[4, 5, 6], [1, 2, 3]];
    rows.forEach((r, ri) => r.forEach((rk, k) => num(cnt.rank[rk], (42 + 62 * k + 38) * 1.5, (261 + 24 * ri) * 1.5)));
    (['clear', 'fc', 'allgood'] as const).forEach((cr, k) => num(cnt.crown[cr], (42 + 62 * k + 38) * 1.5, 309 * 1.5));
    this.full('point');
    // 自己ベスト: 本家と重ねて測った 1.6 倍・左上 (29, 581)
    const sc = this.im(`score${Math.min(ci, 4)}`);
    if (sc) this.g.drawImage(sc.im, 29, 581, sc.w * 1.6, sc.h * 1.6);
    this.put(this.text('自己ベスト', 19.5, 6.5, '#0c0806', { kx: 0.96 }), 186, 603);
    const it = this.center;
    const b = it.kind === 'song' ? this.best[`${it.s.id}:${c}`] : undefined;
    if (b) this.bestNum(b.score, 220, 632);
  }

  private bestNum(n: number, cx: number, cy: number) {
    const ds = String(n).split('');
    const W = 21, k = 1.15, adv = 20.5;
    const x0 = cx - (adv * (ds.length - 1) + W * k) / 2;
    ds.forEach((d, i) => this.blit('levelNum', Number(d) * W, 0, W, 25, x0 + i * adv, cy - (25 * k) / 2, W * k, 25 * k));
  }

  /** 時計の下の何曲目（リザルトと同じ帯。本家と重ねて測った: 少し左・230 下・6 広い） */
  private pill: ReturnType<typeof songPill> = null;
  private stageNums() {
    if (!this.pill) this.pill = songPill('1', { dx: -21, dy: 230, grow: 6 });
    if (this.pill) this.g.drawImage(this.pill.cv, this.pill.x, this.pill.y, this.pill.w, this.pill.h);
  }

  /** 右上の時間（TJAtelier は時間を区切らないので ∞。本家の数字と同じ灰色・太さの線で） */
  private timer() {
    const m = this.im('headerTimer');
    if (!m) return;
    const k = 1.49, x = 1687, y = 31;
    this.g.drawImage(m.im, x, y, m.w * k, m.h * k);
    const cx = x + (m.w * k) / 2, cy = y + (m.h * k) / 2;
    const g = this.g;
    g.save();
    g.strokeStyle = '#474747';
    g.lineWidth = 11.5;
    g.lineCap = 'round';
    g.beginPath();
    const a = 50, b = 52;
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      const d = 1 + Math.sin(t) ** 2;
      const px = cx + (a * Math.cos(t)) / d, py = cy + (b * Math.sin(t) * Math.cos(t)) / d;
      if (i) g.lineTo(px, py); else g.moveTo(px, py);
    }
    g.stroke();
    g.restore();
  }

  /** 左上の太鼓の案内（ばちで叩く・矢印が上下に） */
  private guideTop() {
    const t = this.wall % 1000;
    this.whole('taikoBase', 0, 0);
    this.whole('taikoTaiko', 0, 0);
    const f = t < 100 ? 1 : t < 200 ? 2 : 0;
    this.blit('taikoBachi', f * 207, 0, 207, 207, 0, 0, 207 * 1.5, 207 * 1.5);
    const bob = Math.sin(rad(t * 0.36)) * 6;
    const g = this.g;
    g.save();
    g.globalAlpha *= 0.5 + 0.5 * Math.abs(Math.sin(rad(t * 0.18)));
    this.whole('taikoArrowUp', 239, 34 - bob);
    this.whole('taikoArrowDown', 239, 150 + bob);
    g.restore();
  }

  // ---------- 一覧 ----------

  private list() {
    const g = this.g;
    const bac = this.bac();
    const p0 = this.scroll;
    const ga = g.globalAlpha;
    // フォルダを開くとき、ほかの帯は 1200〜1620 で消え、入れ替えたあと 300ms で出てくる
    const boxV = this.boxT >= 0 ? BOX_FROM + (this.boxT * BOX_K) / 1.3 : -1;
    const others = boxV >= 0 ? clamp(1 - (boxV - 1200) / 420, 0, 1) : clamp(this.fadeIn / 150, 0, 1);
    g.globalAlpha = ga * others;
    for (let k = 5; k >= 1; k--) {
      for (const sgn of [-1, 1]) {
        const p = sgn * k + p0;
        if (p > -5 && p < 5 && Math.abs(p) > 0.02) this.bar(this.at(this.cur + sgn * k), posAt(p));
      }
    }
    g.globalAlpha = ga;
    if (Math.abs(p0) > 0.02) {
      // スクロール中: まんなかの帯も閉じたまま流れる
      this.bar(this.center, posAt(p0));
      return;
    }
    this.openBox(this.center, bac, boxV);
  }

  /** 閉じた帯 */
  private bar(it: Item, p: { x: number; y: number }) {
    const im = this.barImg(it.look);
    const g = this.g;
    if (im) g.drawImage(im.im, p.x, p.y, BW, BH);
    this.whole('barOverlay', p.x, p.y);
    const cx = p.x + BW / 2 - 1.5;
    if (it.kind === 'song') {
      this.songIcons(it.s, p.x + 22, p.y + 20.5, 1.25, p.x + 20, p.y + 71.5, 1.2);
      this.put(this.text(it.s.title, 38, 12, it.look.edge, { kx: 0.97 }), cx, p.y + BH / 2 + 3.5, 760);
    } else {
      const name = it.kind === 'back' ? 'とじる' : it.name;
      this.put(this.text(name, 51, 16, it.look.edge, { kx: 0.96 }), cx, p.y + BH / 2 + 2, 820);
    }
  }

  /** 曲の王冠・スコアランク（いちばん難しい王冠のある難易度） */
  private songIcons(s: SongEntry, cx: number, cy: number, ck: number, rx: number, ry: number, rk: number) {
    let top: { ci: number; crown: Crown; score: number } | null = null;
    for (const [ci, c] of COURSES.entries()) {
      const b = this.best[`${s.id}:${c}`];
      if (b && s.courses.some((x) => x.name === c)) top = { ci, crown: b.crown, score: b.score };
    }
    if (!top) return;
    if (top.crown !== 'fail') this.blit('crown', (CROWN_BLOCK[top.ci] * 3 + CROWN_TYPE[top.crown]) * 43.2, 0, 43.2, 39, cx, cy, 43.2 * ck, 39 * ck);
    const r = rankOf(top.score);
    if (r > 0) this.blit('rank', top.ci * 48, (r - 1) * 41, 48, 41, rx, ry, 48 * rk, 41 * rk);
  }

  /** まんなかの帯（開いていく） */
  private openBox(it: Item, bac: number, boxV: number) {
    const g = this.g;
    const t = bac / 62;
    const kind = it.kind === 'song' ? 'song' : 'box';
    // 外の縁: 閉じた (486,471,948,138) → 開いた (491,378.5,941,324.5)
    let x = lerp(486, 491, t), y = lerp(471, 378.5, t), w = lerp(948, 941, t), h = lerp(138, 324.5, t);
    // フォルダを開くとき: 1300〜1940 で横に縮む
    let sx = 1;
    if (boxV >= 1300) sx = Math.max(0, 1 - Math.sin(rad(Math.min(640, boxV - 1300) * 0.28125)));
    if (sx < 1) { const c = x + w / 2; w *= sx; x = c - w / 2; }
    if (w < 2) return;
    // 光る枠（フォルダは黄色、曲はうすい黄色）。決めたときは点滅
    const sel = kind === 'song' ? this.tinted('barSelect', [255, 255, 0], [254, 252, 191]) : this.im('barSelect');
    let glowA = t;
    const flash = this.boxT >= 0 ? this.boxT * BOX_K : this.diffT >= 0 ? this.diffT : -1;
    if (flash >= 0 && flash < 800) { const v = flash % 200; glowA = v < 100 ? v / 100 : 1 - (v - 100) / 100; glowA = 0.5 + glowA * 0.5; }
    if (sel && glowA > 0) {
      g.save();
      g.globalAlpha *= glowA;
      this.nine(sel, [0, 0, 662, 251], [x - 21, y - 23, w + 42, h + 46], 40, 40);
      g.restore();
    }
    const bar = this.barImg(it.look);
    if (bar) this.nine(bar, [0, 0, 632, 92], [x, y, w, h], 21, 21);
    const ov = this.im('barOverlay');
    // 中の明るい所: 閉じた (562.5,498,796.5,84) → 開いた 曲 (563,392,794,283) / フォルダ (564,498,792,177)
    const iy = lerp(471 + 27, kind === 'song' ? 392 : 498, t);
    const ih = lerp(84, kind === 'song' ? 283 : 177, t);
    if (ov) this.nine(ov, [51, 18, 531, 56], [x + (562.5 - 486) * sx, iy, w - (562.5 - 486 + 1434 - 1359) * sx, ih], 10, 10);
    if (sx < 0.98) return;
    // 中身（開くと出る。フォルダを開くときは 1200〜1620 で消える）
    const ca = boxV >= 0 ? clamp(1 - (boxV - 1200) / 420, 0, 1) : 1;
    const ga = g.globalAlpha;
    g.globalAlpha = ga * ca;
    if (it.kind === 'song') {
      const s = it.s;
      this.put(this.text(s.title, 38, 14, it.look.edge, { kx: 1.02, punct: 0.4 }), 962.5, lerp(540, 473, t), 820);
      g.globalAlpha = ga * ca * t;
      if (s.subtitle) this.put(this.text(s.subtitle, 23, 6, it.look.edge, { kx: 1.02 }), 959, 515, 820);
      const k = 0.8 + bac / 620;
      this.songIcons(s, lerp(486 + 22, 501, t), lerp(491, 398, t), k * 1.65 / 0.9, lerp(486 + 20, 496, t), lerp(542, 464, t), k * 1.65 / 0.9);
      this.levels(s);
      this.songInfo(s, 1460, 395, 190, 1460, 600);
    } else {
      const name = it.kind === 'back' ? 'とじる' : it.name;
      this.put(this.text(name, 51, 16, it.look.edge, { kx: 0.96 }), 960, lerp(542, 436, t), 820);
      g.globalAlpha = ga * ca * t;
      if (it.kind === 'folder') this.put(this.text(`${it.count}曲`, 50, 12, it.look.edge, { font: SEURAT }), 960, 586);
      // 箱のキャラ（両側から寄ってくる）
      if (it.kind === 'folder') this.boxChara(it.look.chara, bac);
    }
    g.globalAlpha = ga;
  }

  private boxChara(i: number, bac: number) {
    const m = this.im(`boxChara${i}`);
    if (!m) return;
    // TJAPlayer3: 45 までは外へ、そのあと戻る
    const anime = (bac <= 45 ? bac * 3.333 : 150 - (bac - 45) * 2.1176) * 1.5;
    const hw = m.w / 2;
    this.blit(`boxChara${i}`, 0, 0, hw, m.h, 960 - hw * 1.5 + 171 - anime, 540 - m.h * 0.75, hw * 1.5, m.h * 1.5);
    this.blit(`boxChara${i}`, hw, 0, hw, m.h, 960 - 171 + anime, 540 - m.h * 0.75, hw * 1.5, m.h * 1.5);
  }

  /** 開いた曲の帯のむずかしさ（かんたん・ふつう・むずかしい・おに。おにが無ければ裏おに） */
  private levels(s: SongEntry) {
    const fx = [600, 782, 963, 1145];
    const cells = [4, 125, 246, 367, 489];
    for (let i = 0; i < 4; i++) {
      let c = s.courses.find((x) => x.name === COURSES[i]);
      let cell = cells[i];
      if (i === 3 && !c) { c = s.courses.find((x) => x.name === 'Edit'); cell = cells[4]; }
      if (!c) continue;
      this.blit('frameScore', cell, 155, 118, 58, fx[i], 572, 118 * 1.5, 58 * 1.5);
      this.levelNum(c.level, fx[i] + 148, 598);
    }
  }
  private levelNum(n: number, cx: number, y: number) {
    const ds = String(n).split('');
    const W = 21, adv = 22, k = 1.45;
    const x0 = cx - (adv * (ds.length - 1) + W * k) / 2;
    ds.forEach((d, i) => this.blit('levelNum', Number(d) * W, 0, W, 25, x0 + i * adv, y, W * k, 25 * k));
  }

  // ---------- 難易度えらび ----------

  /** 左の大きなむずかしさの印（うすく） */
  private mark(ci: number, a: number) {
    const m = this.im(`mark${ci}`);
    if (!m) return;
    const g = this.g;
    g.save();
    // 本家の画面に輪の縁を重ねて測った: 1.5 倍・真ん中 (201, 408)・不透明度 0.65
    g.globalAlpha = 0.65 * a;
    const k = 1.5;
    g.drawImage(m.im, 201 - (m.w * k) / 2, 408 - (m.h * k) / 2, m.w * k, m.h * k);
    g.restore();
  }

  /** オンライン: 右に部屋のみんな（ネームプレートと難易度。地が緑 = 準備OK・灰 = まだ） */
  private onlinePanel() {
    const od = this.online;
    if (!od) return;
    const g = this.g;
    const list = od.players();
    const X = 1556, W = 350, RH = 88, GAP = 10, Y = 300;
    const H = list.length * (RH + GAP) - GAP + 32;
    g.save();
    g.fillStyle = 'rgba(60,30,10,0.3)';
    rrect(g, X, Y + 5, W, H, 16); g.fill();
    g.fillStyle = '#fffaf0';
    rrect(g, X, Y, W, H, 16); g.fill();
    g.lineWidth = 5; g.strokeStyle = '#1a1410'; g.stroke();
    const pl = this.host.plate();
    const CN: Record<string, [string, string]> = { Easy: ['かんたん', '#e8603c'], Normal: ['ふつう', '#5a9f3c'], Hard: ['むずかしい', '#3a7ca5'], Oni: ['おに', '#e0307a'], Edit: ['うら', '#7b4bd0'] };
    list.forEach((p, i) => {
      const y = Y + 16 + i * (RH + GAP), x = X + 14, w = W - 28;
      g.fillStyle = p.ok ? '#3cc46a' : '#cfc8bd';
      rrect(g, x, y, w, RH, 12); g.fill();
      g.lineWidth = 4; g.strokeStyle = '#1a1410'; g.stroke();
      if (this.sk) {
        g.save();
        g.translate(x + 6, y + (RH - 81 * 0.66) / 2);
        g.scale(0.66, 0.66);
        g.translate(6, -443.5);
        this.sk.plate(g, (p.mine ? { name: pl.name, title: pl.title, profile: pl.profile, wall: this.wall } : { name: p.name, title: '', wall: this.wall }) as never, 0, 0);
        g.restore();
      }
      const [label, col] = CN[p.course] ?? [p.course, '#8a96a8'];
      g.font = `26px ${KANTEI}`;
      const tw = Math.min(96, g.measureText(label).width);
      const cw = tw + 26, cx = x + w - cw - 8, cy = y + RH / 2 - 21;
      g.fillStyle = col;
      rrect(g, cx, cy, cw, 42, 21); g.fill();
      g.lineWidth = 3; g.strokeStyle = '#1a1410'; g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#1a1410';
      g.strokeText(label, cx + cw / 2, cy + 22, 96);
      g.fillStyle = '#fff';
      g.fillText(label, cx + cw / 2, cy + 22, 96);
    });
    g.restore();
  }

  private diffScreen() {
    const it = this.center;
    if (it.kind !== 'song') return;
    const s = it.s;
    const g = this.g;
    const backName = `diffBack${it.look.bar < 0 ? 0 : it.look.bar}`;
    const bk = this.im(backName);
    if (bk) g.drawImage(bk.im, 960 - 858 * 0.75, 435 - 528 * 0.75, 858 * 1.5, 528 * 1.5);
    this.put(this.text(s.title, 52, 16, '#100b0b', { kx: 0.98, punct: 0.4 }), 961.5, 195, 1100);
    if (s.subtitle) this.put(this.text(s.subtitle, 30, 10, '#100b0b', { kx: 0.9 }), 962, 256.5, 1100);
    const sel = this.dsel;
    // ボタンを選んでいるときの黄色い光（ボタンの後ろ）
    if (sel < 2 || sel > 5) this.blit('diffCursor', 86, 410, 88, 85, BTN_X[sel] + 57.75 - 66, BTN_Y[sel] + 57 - 63.75, 88 * 1.5, 85 * 1.5);
    this.blit('diffBar', 0, 0, 77, 76, 382, 405, 77 * 1.5, 76 * 1.5);
    this.blit('diffBar', 88, 0, 77, 76, 514, 405, 77 * 1.5, 76 * 1.5);
    // もどる・設定の下に、同じ形のボタン（1 列 2 つ）
    if (this.online) {
      // 戻れない人（選曲担当でない人）は、もどるを暗くする
      if (!this.online.canBack()) { g.fillStyle = 'rgba(30,20,60,0.7)'; rrect(g, 382, 405, 115.5, 114, 18); g.fill(); }
    } else {
      this.sqBtn(382, 537, 'edit', [214, 140, 235], [150, 80, 200]);
      this.sqBtn(514, 537, 'info', [140, 200, 250], [60, 140, 220]);
      this.songInfo(s, 1700, 350, 180, 1650, 550);
    }
    const cx = [647, 861, 1077, 1292];
    const src = [176, 319, 463, this.ura ? 749 : 606];
    // 選んでいる所の枠（カードの後ろ）
    if (sel >= 2 && sel <= 5) this.blit('diffCursor', 56, 135, 147, 250, cx[sel - 2] + 98.25 - 110.25, 405 + 177.75 - 187.5, 147 * 1.5, 250 * 1.5);
    cx.forEach((x, i) => {
      const c = this.courseAt(i + 2)!;
      const cs = s.courses.find((q) => q.name === c);
      const ga = g.globalAlpha;
      if (!cs) g.globalAlpha = ga * 0.35;
      // 裏に入れ替えたとき: カードがくるっと回る
      let kx = 1;
      if (i === 3 && this.cursorT < 200 && sel === 5) kx = Math.abs(Math.cos(rad(this.cursorT * 0.9)));
      const w = 131 * 1.5 * kx;
      this.blit('diffBar', src[i], 0, 131, 237, x + (131 * 1.5 - w) / 2, 405, w, 237 * 1.5);
      g.globalAlpha = ga;
      if (!cs || kx < 0.99) return;
      this.diffNum(cs.level, x + 113.5, 652);
      for (let k = 0; k < Math.min(10, cs.level); k++) this.blit('diffStar', 0, 0, 14, 14, x + 20.5 + k * 15, 687.5, 20, 20);
      const b = this.best[`${s.id}:${c}`];
      const cr = b && b.crown !== 'fail' ? CROWN_CELL[b.crown] : 0;
      // 王冠・ランクは本家の画面に絵を重ねて測った位置・大きさ
      this.blit('diffCrown', cr * 24.5, 0, 24.5, 26, x + 21, 405 + 23, 24.5 * 1.47, 26 * 1.47);
      const r = b ? rankOf(b.score) : 0;
      if (r > 0) {
        // 本家はランクの黒い縁が少し太い: 黒い影を周りに少しずらして重ねてから描く
        // （影は上の 2 px を切る。1 つ上のランクの端が少しかかっているため）
        const sy = (r - 1) * 42.71, k = 0.89, R = 1.2;
        for (let a = 0; a < 16; a++) {
          const ox = Math.cos((a / 16) * Math.PI * 2) * R, oy = Math.sin((a / 16) * Math.PI * 2) * R;
          this.blitImg(this.silhouette('diffRank'), 0, sy + 2, 50, 40.71, x + 56 + ox, 405 + 20 + 2 * k + oy, 50 * k, 40.71 * k);
        }
        this.blit('diffRank', 0, sy, 50, 42.71, x + 56, 405 + 20, 50 * k, 42.71 * k);
      }
    });
    // 1P の吹き出し（出てくるとき下りてくる。動かすと少し跳ねる）
    const inT = (this.diffT - 1255) / 4;
    const ba = inT >= 80 ? clamp((inT - 80) * 2.84 / 255, 0, 1) : 0;
    const drop = inT >= 80 ? Math.sin(rad(Math.min(90, inT - 80))) : 0;
    const bounce = this.cursorT < 180 ? Math.sin(rad(this.cursorT)) * 15 : 0;
    const bx = sel >= 2 && sel <= 5 ? cx[sel - 2] + 98.25 : BTN_X[sel] + 57.75;
    const ga = g.globalAlpha;
    g.globalAlpha = ga * ba;
    this.blit('diffCursor', 94, 34, 76, 77, bx - 57, 313 - 75 * (1 - drop) + (sel === 6 || sel === 7 ? 132 : 0) + bounce, 76 * 1.5, 77 * 1.5);
    g.globalAlpha = ga;
    // 下の案内
    this.full('guide', 4, 0);
    const k = 0.64;
    this.whole('drumL', 822 - 103 * k, 978 - 104 * k, k);
    this.whole('drumR', 997 - 103 * k, 976 - 104 * k, k);
  }

  private diffNum(n: number, cx: number, y: number) {
    const ds = String(n).split('');
    const adv = 19.5;
    const x0 = cx - (adv * (ds.length - 1)) / 2 - 13.5;
    ds.forEach((d, i) => this.blit('diffNum', Number(d) * 18, 0, 18, 23, x0 + i * adv, y, 27, 34.5));
  }
  // ---------- 下のボタン・検索・並べ替え ----------

  private menu(a: MenuAct) {
    this.se('Don');
    if (a === 'search') {
      if (!this.qEl.classList.contains('hidden')) { this.closeSearch(); return; }
      this.qEl.classList.remove('hidden');
      this.qEl.focus();
    } else if (a === 'sort') {
      const order: typeof this.sort[] = ['title', 'updated', 'bpm'];
      this.sort = order[(order.indexOf(this.sort) + 1) % order.length];
      try { localStorage.setItem('tsel-sort', this.sort); } catch { /* 無くてよい */ }
      this.rebuild();
      this.still = 0;
    } else {
      // ボタンの画面の位置（読み込みは、iPhone の選ぶメニューをそこから出す）
      const [x, y, w, h] = menuRect(MENU.findIndex((m) => m.a === a));
      const r = this.el.getBoundingClientRect();
      const q = r.width / Math.max(1, this.el.width);
      const k = this.s * q;
      this.host.action(a, { x: r.left + this.ox * q + x * k, y: r.top + this.oy * q + y * k, w: w * k, h: h * k });
    }
  }

  private closeSearch() {
    this.qEl.value = '';
    this.qEl.classList.add('hidden');
    this.qEl.blur();
    if (this.query) { this.query = ''; this.rebuild(); this.still = 0; }
  }

  private menuBar() {
    MENU.forEach((m, i) => {
      const [x, y, w, h] = menuRect(i);
      const on = m.a === 'search' && !this.qEl.classList.contains('hidden');
      this.tag(x, y, w, h, on ? '#f6c90e' : m.c, m.t, 40);
    });
  }

  /** 角の丸い札（本家の札のように黒い縁・上半分のつや・白い字に黒い縁） */
  private tag(x: number, y: number, w: number, h: number, fill: string, label: string, px: number) {
    const g = this.g;
    const r = h / 2;
    g.save();
    g.shadowColor = 'rgba(60,30,10,0.35)';
    g.shadowBlur = 8 * this.s;
    g.shadowOffsetY = 6 * this.s;
    rrect(g, x, y, w, h, r);
    g.fillStyle = fill;
    g.fill();
    g.restore();
    rrect(g, x, y, w, h, r);
    g.lineWidth = 5;
    g.strokeStyle = '#1a1410';
    g.stroke();
    g.save();
    g.globalAlpha *= 0.27;
    rrect(g, x + 8, y + 7, w - 16, h / 2 - 9, Math.max(1, r - 8));
    g.fillStyle = '#fff';
    g.fill();
    g.restore();
    this.put(this.text(label, px, 8, '#000'), x + w / 2, y + h / 2 + 1, w - 24);
  }

  /** 左に名前・右に値の札（BPM・長さ） */
  private stat(x: number, y: number, w: number, h: number, label: string, val: string, col: string) {
    const g = this.g;
    g.save();
    g.shadowColor = 'rgba(60,30,10,0.3)';
    g.shadowBlur = 6 * this.s;
    g.shadowOffsetY = 5 * this.s;
    rrect(g, x, y, w, h, 18);
    g.fillStyle = '#fffaf0';
    g.fill();
    g.restore();
    rrect(g, x, y, w, h, 18);
    g.lineWidth = 5;
    g.strokeStyle = '#1a1410';
    g.stroke();
    const lw = w * 0.42;
    rrect(g, x + 5, y + 5, lw - 5, h - 10, 14);
    g.fillStyle = col;
    g.fill();
    this.put(this.text(label, 28, 6, '#000'), x + 5 + (lw - 5) / 2, y + h / 2, lw - 14);
    this.put(this.text(val, 32, 0, '#000', { font: SEURAT, fill: '#222' }), x + lw + (w - lw) / 2, y + h / 2 + 1, w - lw - 16);
  }

  /** ジャケット（あれば）と BPM・長さ */
  private songInfo(s: SongEntry, jx: number, jy: number, js: number, sx: number, sy: number) {
    const g = this.g;
    const im = this.jacketImg(s);
    if (im) {
      g.save();
      g.shadowColor = 'rgba(60,30,10,0.35)';
      g.shadowBlur = 8 * this.s;
      g.shadowOffsetY = 6 * this.s;
      g.fillStyle = '#000';
      g.fillRect(jx, jy, js, js);
      g.restore();
      const k = Math.max(js / im.naturalWidth, js / im.naturalHeight);
      const w = js / k, h = js / k;
      g.drawImage(im, (im.naturalWidth - w) / 2, (im.naturalHeight - h) / 2, w, h, jx, jy, js, js);
      rrect(g, jx, jy, js, js, 6);
      g.lineWidth = 6;
      g.strokeStyle = '#1a1410';
      g.stroke();
    }
    this.stat(sx, sy, 240, 50, 'BPM', fmtBpm(s), PUR);
    if (s.length > 0) this.stat(sx, sy + 60, 240, 50, '長さ', fmtLen(s.length), PUR);
  }

  private jacketImg(s: SongEntry) {
    if (!s.jacket) return null;
    const key = `${s.id}:${s.jacket}`;
    if (this.jackets.has(key)) return this.jackets.get(key) ?? null;
    // ジャケットは最近の 6 枚だけ持つ（大きな絵を次々に読むとメモリが足りなくなる）
    while (this.jackets.size >= 6) this.jackets.delete(this.jackets.keys().next().value!);
    this.jackets.set(key, null);
    void this.host.jacket(s).then((url) => {
      if (!url) return;
      const im = new Image();
      im.onload = () => { if (this.jackets.has(key)) this.jackets.set(key, im); };
      im.src = url;
    });
    return null;
  }

  /** もどる・設定と同じ形のボタン（黒い縁・白い縁・上から下へ色の変わる面・つや） */
  private btnCache = new Map<string, HTMLCanvasElement>();
  private sqBtn(x: number, y: number, label: 'edit' | 'info', top: number[], bot: number[]) {
    const W = 115.5, H = 114;
    const Z = this.textScale * 2;
    const key = `${label}|${Z}`;
    let cv = this.btnCache.get(key);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.width = Math.ceil(W * Z);
      cv.height = Math.ceil(H * Z);
      const g = cv.getContext('2d')!;
      g.scale(Z, Z);
      rrect(g, 0, 0, W, H, 30);
      g.fillStyle = '#111';
      g.fill();
      rrect(g, 7, 7, W - 14, H - 14, 24);
      g.fillStyle = '#fff';
      g.fill();
      const gr = g.createLinearGradient(0, 11, 0, H - 11);
      gr.addColorStop(0, `rgb(${top.join(',')})`);
      gr.addColorStop(1, `rgb(${bot.join(',')})`);
      rrect(g, 11, 11, W - 22, H - 22, 20);
      g.fillStyle = gr;
      g.fill();
      g.save();
      g.filter = 'blur(6px)';
      g.globalAlpha = 0.35;
      g.beginPath();
      g.ellipse(W / 2, H / 2 - 4, W / 2 - 18, H / 2 - 22, 0, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.fill();
      g.restore();
      if (label === 'edit') drawPencil(g, W / 2, H / 2);
      else drawBars(g, W / 2, H / 2 - 5);
      this.btnCache.set(key, cv);
    }
    this.g.drawImage(cv, x, y, W, H);
  }

  // ---------- 演奏オプション（本家の左下の板） ----------

  private optOpen() {
    this.opt.open = true;
    this.opt.t = 0;
    this.opt.row = 0;
  }
  private optClose() {
    this.se('Cancel');
    this.opt.open = false;
    this.opt.t = 0;
  }
  private optRow(d: number) {
    const r = this.opt.row + d;
    // 最後の行からさらに下へ: 閉じる（本家と同じ）
    if (r >= OPT_ROWS.length) { this.optClose(); return; }
    if (r < 0) return;
    this.opt.row = r;
    this.se('Ka');
  }
  private optChange(d: number) {
    const row = OPT_ROWS[this.opt.row];
    const o = this.host.opts();
    const n = row.vals.length;
    const i = (optIndex(row, o[row.k]) + d + n) % n;
    this.host.setOpt(row.k, row.vals[i] as never);
    this.se('Don');
  }
  private optTap(p: { x: number; y: number }) {
    if (p.x < OPT_X || p.x > OPT_X + OPT_W || p.y < OPT_Y || p.y > OPT_Y + OPT_H) { this.optClose(); return; }
    const i = OPT_ROWS.findIndex((_, k) => Math.abs(p.y - optRowY(k)) <= 28);
    if (i < 0) return;
    if (i !== this.opt.row) { this.opt.row = i; this.se('Ka'); return; }
    this.optChange(p.x < 262 ? -1 : 1);
  }

  private optPanel() {
    const t = this.opt.t;
    if (!this.opt.open && t >= OPT_ANIM) return;
    const g = this.g;
    // 下からせり上がる（閉じるときは下へ）
    const e = clamp(t / OPT_ANIM, 0, 1);
    const k = this.opt.open ? 1 - (1 - e) ** 3 : 1 - e * e;
    const dy = (1 - k) * (OPT_H + 40);
    g.save();
    g.translate(0, dy);
    const x = OPT_X, y = OPT_Y, w = OPT_W, h = OPT_H;
    rrect(g, x, y, w, h, 26);
    g.fillStyle = '#0a0a10';
    g.fill();
    rrect(g, x + 7, y + 7, w - 14, h - 14, 20);
    g.fillStyle = 'rgb(177,224,61)';
    g.fill();
    g.save();
    rrect(g, x + 7, y + 7, w - 14, h - 14, 20);
    g.clip();
    g.lineWidth = 6;
    g.strokeStyle = 'rgba(214,236,180,0.9)';
    rrect(g, x + 7, y + 7, w - 14, h - 14, 20);
    g.stroke();
    g.restore();
    // 見出し: 赤い玉の「1P」と「演奏オプション」
    const by = y + 42;
    g.beginPath();
    g.arc(64, by, 27, 0, Math.PI * 2);
    g.fillStyle = '#1a0e0a';
    g.fill();
    const rg = g.createLinearGradient(0, by - 23, 0, by + 23);
    rg.addColorStop(0, '#f2684e');
    rg.addColorStop(1, '#c8261a');
    g.beginPath();
    g.arc(64, by, 22.5, 0, Math.PI * 2);
    g.fillStyle = rg;
    g.fill();
    this.put(this.text('1P', 25, 6, '#000', { font: SEURAT }), 64, by + 1);
    this.put(this.text('演奏オプション', 37, 9, '#000'), 105, by + 1, 290, 'left');
    const o = this.host.opts();
    OPT_ROWS.forEach((r, i) => {
      const cy = optRowY(i);
      const sel = i === this.opt.row;
      rrect(g, 36, cy - 24, 358, 48, 8);
      g.fillStyle = sel ? 'rgb(247,251,36)' : 'rgba(236,240,224,0.82)';
      g.fill();
      this.put(this.text(r.label, 32, 8, '#000'), 44, cy + 1, 160, 'left');
      const vi = optIndex(r, o[r.k]);
      const changed = r.vals[vi] !== r.def;
      rrect(g, 212, cy - 20, 176, 40, 20);
      g.fillStyle = changed && !sel ? 'rgb(255,236,0)' : '#fff';
      g.fill();
      this.put(this.text(r.names[vi], 30, 8, '#000'), 300, cy + 1, 100);
      if (sel) {
        for (const sgn of [-1, 1]) {
          const ax = 300 + sgn * 67;
          g.beginPath();
          g.moveTo(ax + sgn * 11, cy);
          g.lineTo(ax - sgn * 9, cy - 13);
          g.lineTo(ax - sgn * 9, cy + 13);
          g.closePath();
          const ag = g.createLinearGradient(0, cy - 13, 0, cy + 13);
          ag.addColorStop(0, '#6fd3f7');
          ag.addColorStop(1, '#1d77c4');
          g.fillStyle = ag;
          g.fill();
          g.lineJoin = 'round';
          g.lineWidth = 3.5;
          g.strokeStyle = '#0b1a2a';
          g.stroke();
        }
      }
    });
    g.restore();
  }
  // ---------- 曲の長押しのメニュー・フォルダに入れる・消す ----------

  private pop: { kind: 'song' | 'folder' | 'del'; id: string; sel: number; scroll: number } | null = null;

  /** その場所の曲の帯（曲でなければ null） */
  private songAt(p: { x: number; y: number }): SongEntry | null {
    const hitBar = (it: Item, q: { x: number; y: number }) => p.x >= q.x && p.x <= q.x + BW && p.y >= q.y && p.y <= q.y + BH && it.kind === 'song' ? it.s : null;
    const c = this.center;
    if (c.kind === 'song' && p.y >= 383 && p.y <= 697 && p.x >= 470 && p.x <= 1450) return c.s;
    for (let k = 1; k <= 4; k++) {
      for (const sgn of [-1, 1]) {
        const s = hitBar(this.at(this.cur + sgn * k), slotPos(sgn * k));
        if (s) return s;
      }
    }
    return null;
  }

  private openPop(kind: 'song' | 'folder' | 'del', s: SongEntry | string) {
    const id = typeof s === 'string' ? s : s.id;
    this.pop = { kind, id, sel: kind === 'del' ? 1 : 0, scroll: 0 };
    this.se(kind === 'song' ? 'Don' : 'Ka');
  }
  private closePop() {
    this.se('Cancel');
    this.pop = null;
  }

  private popSong() { return this.host.songs().find((x) => x.id === this.pop?.id) ?? null; }
  /** 今いるフォルダ（入っていれば「〜から外す」を出す） */
  private hereFolder() {
    const k = this.path[this.path.length - 1];
    return k && k !== UNCAT && !this.query ? k : null;
  }

  /** メニューの項目（[名前, 色, する事]） */
  private popItems(): [string, string, string][] {
    const p = this.pop;
    if (!p) return [];
    if (p.kind === 'song') {
      const s = this.popSong();
      const here = this.hereFolder();
      return [
        ['フォルダに入れる', BLUE, 'folder'],
        ...(here && s?.folders.includes(here) ? [[`「${here.split('/').pop()}」から外す`, BLUE, 'remove'] as [string, string, string]] : []),
        ['この曲を消す', RED, 'del'],
        ['もどる', GRY, 'close'],
      ];
    }
    if (p.kind === 'del') return [['消す', RED, 'delete'], ['やめる', GRY, 'close']];
    const colors = this.host.colors();
    const rows: [string, string, string][] = this.folderTree().map((f) => [f, toHex(lookOf(f.split('/').pop()!, colors[f], f).rim), `f:${f}`]);
    return [...rows, ['新しいフォルダ', '#9aa0a8', 'new'], ['もどる', GRY, 'close']];
  }
  /** フォルダを、親の次にその下の階層が来る順に */
  private folderTree() {
    const fs = [...this.host.folders()];
    const parents = new Set<string>();
    for (const f of fs) { const a = f.split('/'); for (let i = 1; i < a.length; i++) parents.add(a.slice(0, i).join('/')); }
    for (const p of parents) if (!fs.includes(p)) fs.push(p);
    return fs.sort((a, b) => {
      const A = a.split('/'), B = b.split('/');
      for (let i = 0; i < Math.min(A.length, B.length); i++) { const c = A[i].localeCompare(B[i], 'ja'); if (c) return c; }
      return A.length - B.length;
    });
  }

  private popMove(d: number) {
    const p = this.pop!;
    const n = this.popItems().length;
    p.sel = (p.sel + d + n) % n;
    if (p.kind === 'folder') this.keepVisible();
    this.se('Ka');
  }

  private async popAct(i: number) {
    const p = this.pop;
    if (!p) return;
    const it = this.popItems()[i];
    if (!it) return;
    const a = it[2];
    if (a === 'close') { if (p.kind === 'folder') { this.se('Cancel'); this.pop = { ...p, kind: 'song', sel: 0 }; } else this.closePop(); return; }
    if (a === 'folder') { this.openPop('folder', p.id); return; }
    if (a === 'del') { this.openPop('del', p.id); return; }
    this.se('Don');
    if (a === 'remove') {
      const here = this.hereFolder();
      if (here) await this.host.toggleFolder(p.id, here);
      this.pop = null;
      this.rebuild();
    } else if (a === 'delete') {
      this.pop = null;
      await this.host.deleteSong(p.id);
      this.rebuild();
    } else if (a === 'new') {
      await this.host.newFolder(p.id);
      this.rebuild(this.center.kind === 'song' ? this.center.s.id : undefined);
    } else if (a.startsWith('f:')) {
      await this.host.toggleFolder(p.id, a.slice(2));
      this.rebuild(this.center.kind === 'song' ? this.center.s.id : undefined);
    }
  }

  // 場所（1920×1080）
  /** 長押しのメニュー・消すの確かめ: 開いた曲の帯の右の板 */
  private sideBox(n: number, title: boolean) {
    const h = (title ? 74 : 0) + n * 100 + 40;
    const y = clamp(540 - h / 2, 20, 1060 - h);
    return { x: 1462, y, w: 438, h };
  }
  /** フォルダの板 */
  private static readonly FB = { x: 360, y: 40, w: 1200, h: 1010 };
  private static readonly ROW = 94;
  private listTop() { return TndeSelect.FB.y + 128; }
  private listH() { return TndeSelect.FB.h - 128 - 116; }
  private clampScroll(v: number) {
    const n = this.popItems().length - 2;
    return clamp(v, 0, Math.max(0, n * TndeSelect.ROW - this.listH()));
  }
  private keepVisible() {
    const p = this.pop!;
    const n = this.popItems().length - 2;
    if (p.sel >= n) return;
    const top = p.sel * TndeSelect.ROW, bot = top + TndeSelect.ROW;
    if (top < p.scroll) p.scroll = top;
    if (bot > p.scroll + this.listH()) p.scroll = bot - this.listH();
    p.scroll = this.clampScroll(p.scroll);
  }

  /** 押せる所の [x, y, w, h, 項目の番号] */
  private popRects(): [number, number, number, number, number][] {
    const p = this.pop;
    if (!p) return [];
    const items = this.popItems();
    if (p.kind !== 'folder') {
      const title = p.kind === 'del';
      const b = this.sideBox(items.length, title);
      return items.map((_, i) => [b.x + 28, b.y + 30 + (title ? 74 : 0) + i * 100, b.w - 56, 86, i]);
    }
    const B = TndeSelect.FB, n = items.length - 2;
    const out: [number, number, number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const dep = items[i][0].split('/').length - 1;
      const y = this.listTop() + i * TndeSelect.ROW - p.scroll;
      if (y + TndeSelect.ROW < this.listTop() || y > this.listTop() + this.listH()) continue;
      out.push([B.x + 40 + dep * 70, y, B.w - 80 - dep * 70, TndeSelect.ROW - 12, i]);
    }
    out.push([B.x + 40, B.y + B.h - 96, 400, 72, n]);
    out.push([B.x + B.w - 260, B.y + B.h - 96, 220, 72, n + 1]);
    return out;
  }

  private popTap(q: { x: number; y: number }) {
    const p = this.pop!;
    const hit = this.popRects().find(([x, y, w, h]) => q.x >= x && q.x <= x + w && q.y >= y && q.y <= y + h);
    if (p.kind === 'folder' && hit && hit[4] < this.popItems().length - 2 && (q.y < this.listTop() || q.y > this.listTop() + this.listH())) return;
    if (!hit) {
      // 板の外: 閉じる
      const B = p.kind === 'folder' ? TndeSelect.FB : this.sideBox(this.popItems().length, p.kind === 'del');
      if (q.x < B.x || q.x > B.x + B.w || q.y < B.y || q.y > B.y + B.h) this.closePop();
      return;
    }
    p.sel = hit[4];
    void this.popAct(hit[4]);
  }

  /** 白い板（黒い縁・影） */
  private boardAt(x: number, y: number, w: number, h: number, r: number, fill: string) {
    const g = this.g;
    g.save();
    g.shadowColor = 'rgba(60,30,10,0.45)';
    g.shadowBlur = 10 * this.s;
    g.shadowOffsetY = 8 * this.s;
    rrect(g, x, y, w, h, r);
    g.fillStyle = fill;
    g.fill();
    g.restore();
    rrect(g, x, y, w, h, r);
    g.lineWidth = 7;
    g.strokeStyle = '#1a1410';
    g.stroke();
  }
  /** 選んでいる所の黄色い枠 */
  private selRing(x: number, y: number, w: number, h: number, r: number) {
    const g = this.g;
    rrect(g, x - 7, y - 7, w + 14, h + 14, r + 7);
    g.lineWidth = 10;
    g.strokeStyle = '#1a1410';
    g.stroke();
    g.lineWidth = 6;
    g.strokeStyle = '#ffe600';
    g.stroke();
  }
  private check(cx: number, cy: number, on: boolean) {
    const g = this.g;
    g.beginPath();
    g.arc(cx, cy, 22, 0, Math.PI * 2);
    g.fillStyle = on ? '#ffe600' : '#fff';
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#1a1410';
    g.stroke();
    if (on) {
      g.beginPath();
      g.moveTo(cx - 11, cy);
      g.lineTo(cx - 3, cy + 10);
      g.lineTo(cx + 12, cy - 10);
      g.lineWidth = 7;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.stroke();
    }
  }

  private drawPop() {
    const p = this.pop;
    if (!p) return;
    const g = this.g;
    const items = this.popItems();
    const rects = this.popRects();
    if (p.kind !== 'folder') {
      const title = p.kind === 'del';
      const b = this.sideBox(items.length, title);
      this.boardAt(b.x, b.y, b.w, b.h, 30, '#fff6e0');
      if (p.kind === 'song') {
        // 開いた曲の帯につながる三角
        g.beginPath();
        g.moveTo(1440, 540);
        g.lineTo(b.x + 4, 512);
        g.lineTo(b.x + 4, 568);
        g.closePath();
        g.fillStyle = '#fff6e0';
        g.fill();
        g.lineWidth = 5;
        g.strokeStyle = '#1a1410';
        g.beginPath();
        g.moveTo(b.x + 1, 512);
        g.lineTo(1440, 540);
        g.lineTo(b.x + 1, 568);
        g.stroke();
      } else this.put(this.text('この曲を消す？', 38, 9, '#000'), b.x + b.w / 2, b.y + 64, b.w - 40);
      for (const [x, y, w, h, i] of rects) {
        if (i === p.sel) this.selRing(x, y, w, h, h / 2);
        this.tag(x, y, w, h, items[i][1], items[i][0], items[i][0].length > 7 ? 32 : 36);
      }
      return;
    }
    // フォルダに入れる: 画面を暗くして大きな板
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(-2000, -2000, 6000, 6000);
    const B = TndeSelect.FB;
    this.boardAt(B.x, B.y, B.w, B.h, 36, '#fffaf0');
    rrect(g, B.x + 20, B.y + 20, B.w - 40, 88, 24);
    g.fillStyle = BLUE;
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#1a1410';
    g.stroke();
    this.put(this.text('フォルダに入れる', 48, 11, '#000'), B.x + B.w / 2, B.y + 64, B.w - 80);
    const s = this.popSong();
    const n = items.length - 2;
    g.save();
    g.beginPath();
    g.rect(B.x + 10, this.listTop() - 10, B.w - 20, this.listH() + 20);
    g.clip();
    for (const [x, y, w, h, i] of rects) {
      if (i >= n) continue;
      const [f, col] = items[i];
      const dep = f.split('/').length - 1;
      // 親とつなぐ線
      if (dep) {
        const px = x - 70 + 34;
        g.beginPath();
        g.moveTo(px, y - 14);
        g.lineTo(px, y + h / 2);
        g.lineTo(x, y + h / 2);
        g.lineWidth = 7;
        g.strokeStyle = '#1a1410';
        g.stroke();
      }
      if (i === p.sel) this.selRing(x, y, w, h, 22);
      g.save();
      g.shadowColor = 'rgba(60,30,10,0.35)';
      g.shadowBlur = 6 * this.s;
      g.shadowOffsetY = 5 * this.s;
      rrect(g, x, y, w, h, 22);
      g.fillStyle = col;
      g.fill();
      g.restore();
      rrect(g, x, y, w, h, 22);
      g.lineWidth = 7;
      g.strokeStyle = '#1a1410';
      g.stroke();
      rrect(g, x + 44, y + 13, w - 140, h - 26, 12);
      g.fillStyle = 'rgba(255,255,255,0.47)';
      g.fill();
      this.put(this.text(f.split('/').pop()!, dep ? 38 : 42, 12, col), x + 44 + (w - 140) / 2, y + h / 2 + 1, w - 170);
      this.check(x + w - 52, y + h / 2, !!s?.folders.includes(f));
    }
    g.restore();
    for (const [x, y, w, h, i] of rects) {
      if (i < n) continue;
      if (i === p.sel) this.selRing(x, y, w, h, h / 2);
      this.tag(x, y, w, h, items[i][1], items[i][0], 34);
    }
  }
}

/**
 * フォルダを開け閉めする速さ（本家の ctBoxOpen の何倍か。本家は 2.3 秒かかって待たされるので、点滅を短くして 2.6 倍で約 0.5 秒に）と、
 * 止まってから曲の帯が開き始めるまで・開く時間（ms）
 */
const BOX_K = 2.6, BOX_FROM = 950, BOX_END = ((1940 - BOX_FROM) * 1.3) / BOX_K, OPEN_AT = 60, OPEN_MS = 140;
/** 後から読む絵 */
const LAZY = /^(boxChara|diffBack|donStart|donSelect)/;
/** 絵を手放す（canvas は大きさを 0 に） */
function freeImg(im: ImageBitmap | HTMLCanvasElement) {
  if ('close' in im) im.close();
  else { im.width = 0; im.height = 0; }
}

/** 角の丸い四角の道 */
function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.roundRect(x, y, w, h, q);
}

// ---------- 難易度えらびのボタンの絵（もどる・設定の絵と同じくらいの黒い縁） ----------
const EDGE = '#1a1410';
/** 縁の太さ（外へ見える幅は半分） */
const EDGE_W = 6.5;
const vgrad = (g: CanvasRenderingContext2D, y0: number, y1: number, a: string, b: string) => {
  const q = g.createLinearGradient(0, y0, 0, y1);
  q.addColorStop(0, a);
  q.addColorStop(1, b);
  return q;
};
/** エディタ: 黄色い鉛筆（ピンクの消しゴム） */
function drawPencil(g: CanvasRenderingContext2D, cx: number, cy: number) {
  g.save();
  g.translate(cx, cy);
  g.rotate(-Math.PI / 4);
  const L = 26, Hh = 11;
  const body = new Path2D();
  body.roundRect(-L, -Hh, 2 * L - 8, 2 * Hh, 3);
  const tip = new Path2D();
  tip.moveTo(L - 8, -Hh);
  tip.lineTo(L + 14, 0);
  tip.lineTo(L - 8, Hh);
  tip.closePath();
  const er = new Path2D();
  er.roundRect(-L - 12, -Hh, 14, 2 * Hh, 6);
  const all = new Path2D();
  all.addPath(body);
  all.addPath(tip);
  all.addPath(er);
  g.lineJoin = 'round';
  g.lineWidth = EDGE_W;
  g.strokeStyle = EDGE;
  g.stroke(all);
  g.fillStyle = vgrad(g, -Hh, Hh, '#ffe86a', '#f2a51a');
  g.fill(body);
  g.fillStyle = '#f6d3a6';
  g.fill(tip);
  g.fillStyle = EDGE;
  g.beginPath();
  g.moveTo(L + 5, -4);
  g.lineTo(L + 14, 0);
  g.lineTo(L + 5, 4);
  g.fill();
  g.fillStyle = vgrad(g, -Hh, Hh, '#ff9fc0', '#e2507e');
  g.fill(er);
  g.lineWidth = 2;
  g.stroke(body);
  g.stroke(tip);
  g.stroke(er);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.fillRect(-L + 3, -Hh + 3, 2 * L - 16, 4);
  g.restore();
}
/** 譜面情報: 赤・黄・緑の棒グラフ */
function drawBars(g: CanvasRenderingContext2D, cx: number, cy: number) {
  g.save();
  g.translate(cx, cy);
  const hs = [22, 40, 30];
  const cols = [['#ff8a7a', '#e8452c'], ['#ffe36a', '#f2b21a'], ['#8ef07a', '#2fb54a']];
  const W = 14, gap = 6, base = 24;
  const bl = new Path2D();
  bl.roundRect(-34, base - 3, 68, 8, 4);
  const ps = hs.map((h, i) => {
    const p = new Path2D();
    p.roundRect(-W * 1.5 - gap + i * (W + gap), base - h, W, h, 3);
    return p;
  });
  const all = new Path2D();
  ps.forEach((p) => all.addPath(p));
  all.addPath(bl);
  g.lineJoin = 'round';
  g.lineWidth = EDGE_W;
  g.strokeStyle = EDGE;
  g.stroke(all);
  ps.forEach((p, i) => {
    g.fillStyle = vgrad(g, base - hs[i], base, cols[i][0], cols[i][1]);
    g.fill(p);
  });
  g.fillStyle = '#f4f0e6';
  g.fill(bl);
  g.lineWidth = 2;
  ps.forEach((p) => g.stroke(p));
  g.stroke(bl);
  g.fillStyle = 'rgba(255,255,255,0.55)';
  ps.forEach((_, i) => g.fillRect(-W * 1.5 - gap + i * (W + gap) + 3, base - hs[i] + 3, 4, hs[i] - 8));
  g.restore();
}

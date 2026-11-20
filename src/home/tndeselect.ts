/**
 * TNDE スキンの選曲画面・難易度えらび（canvas で描く）。
 * 位置・大きさは本家の画面録画に素材を重ねて測った値（1920×1080）。動きの時間と式は TJAPlayer3（OpenTaiko の元）と同じ。
 */
import type { AudioEngine } from '../audio/audio';
import type { SongEntry } from '../io/library';
import type { PlateStyle, TndeSkin } from '../render/tnde';

export type Crown = 'allgood' | 'fc' | 'clear' | 'fail';
type Best = Record<string, { score: number; crown: Crown }>;

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
  /** いつもの一覧へ */
  toList(): void;
  settings(): void;
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
/** フォルダの見た目: 名前が本家のジャンルならその色、ほかはフォルダの色 */
function lookOf(name: string, color?: string): Look {
  for (const [re, l] of GENRES) if (re.test(name)) return l;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) {
    const c = hex(color);
    // いちばん近い色の帯の絵を塗り替える
    let bi = 1, bd = 1e9;
    BAR_BASE.forEach((b, i) => { const d = (b[0] - c[0]) ** 2 + (b[1] - c[1]) ** 2 + (b[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
    return { bar: bi, rim: c, edge: toHex(c.map((v) => v * 0.3)), chara: -1 };
  }
  return { bar: 1, rim: [58, 184, 205], edge: '#13363b', chara: -1 };
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
  private diffOut = -1;
  private dsel = 5;
  private ura = false;
  private cursorT = 1e9;
  private startT = -1;
  private previewed: SongEntry | null = null;
  private best: Best = {};

  constructor(private readonly host: TselHost, parent: HTMLElement) {
    this.el = document.createElement('canvas');
    this.el.className = 'tsel hidden';
    parent.append(this.el);
    this.g = this.el.getContext('2d')!;
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
    this.diffT = -1; this.diffOut = -1; this.startT = -1; this.boxT = -1;
    const s = select ? this.host.songs().find((x) => x.id === select) : undefined;
    if (s) {
      const f = s.folders.find((x) => !x.includes('/')) ?? s.folders[0];
      this.path = this.topFolders().length ? [f ?? UNCAT] : [];
    }
    this.rebuild(s?.id);
    this.still = 0;
    if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.frame(t)); }
  }

  hide() {
    this.on = false;
    this.el.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.previewed = null;
  }

  // ---------- 絵 ----------

  private async load() {
    const r = await fetch(`${BASE}sel.json`, { cache: 'no-cache' });
    const man = (await r.json()) as { img: Record<string, { f: string; k: number; x: number; y: number; w: number; h: number }>; anim: Record<string, Omit<Anim, 'pages'> & { pages: string[] }> };
    const bmp = async (f: string) => createImageBitmap(await (await fetch(`${BASE}${f}`)).blob());
    await Promise.all([
      ...Object.entries(man.img).map(async ([n, m]) => { try { this.imgs.set(n, { ...m, im: await bmp(m.f) }); } catch { /* 無くても描ける */ } }),
      ...Object.entries(man.anim).map(async ([n, m]) => { try { this.anims.set(n, { ...m, pages: await Promise.all(m.pages.map(bmp)) }); } catch { /* 無くても描ける */ } }),
    ]);
    for (const k of ['Ka', 'Don', 'Diff', 'Cancel', 'Ura']) void this.host.audio.loadUi(`tsel:${k}`, `${BASE}se/sel${k}.ogg`);
    await document.fonts.load(`40px ${KANTEI}`, '選曲');
  }

  private se(n: string) { this.host.audio.playUi(`tsel:${n}`); }

  /** 元の絵の座標 (sx, sy, sw, sh) を (dx, dy, dw, dh) に描く。切り出し・細かさを足し引きする */
  private blit(name: string, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
    const m = this.imgs.get(name);
    if (!m) return;
    this.g.drawImage(m.im, (sx - m.x) * m.k, (sy - m.y) * m.k, sw * m.k, sh * m.k, dx, dy, dw, dh);
  }
  /** 1280×720 いっぱいの絵を、1920×1080 の (ox, oy) ずらした所に */
  private full(name: string, ox = 0, oy = 0) {
    const m = this.imgs.get(name);
    if (m) this.g.drawImage(m.im, m.x * 1.5 + ox, m.y * 1.5 + oy, m.w * 1.5, m.h * 1.5);
  }
  private whole(name: string, dx: number, dy: number, k = 1.5) {
    const m = this.imgs.get(name);
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

  private tints = new Map<string, Img>();
  /** 絵の色を塗り替える（もとの色 base からの明るさの比で。黒い縁はそのまま） */
  private tinted(name: string, base: number[], to: number[], skip?: (r: number, g: number, b: number) => boolean): Img | undefined {
    const key = `${name}|${to.join(',')}`;
    const have = this.tints.get(key);
    if (have) return have;
    const m = this.imgs.get(name);
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
    if (l.bar < 0) return this.imgs.get('barBack');
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
    if (this.texts.size > 400) this.texts.clear();
    this.texts.set(key, r);
    return r;
  }
  /** 字を (cx, cy) を真ん中に。maxW を超えたら横を縮める */
  private put(t: ReturnType<TndeSelect['text']>, cx: number, cy: number, maxW = Infinity, align: 'center' | 'right' = 'center') {
    const sx = t.w > maxW ? maxW / t.w : 1;
    const w = t.w * sx;
    const x = align === 'right' ? cx - w : cx - w / 2;
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
      return { kind: 'folder', key, name, look: lookOf(name, colors[key]), count };
    };
    const byTitle = (a: SongEntry, b: SongEntry) => a.title.localeCompare(b.title, 'ja');
    let items: Item[];
    const top = this.topFolders();
    if (!this.path.length) {
      items = top.length ? top.map(folderItem) : [...songs].sort(byTitle).map((s) => ({ kind: 'song' as const, s, look: lookOf('') }));
    } else {
      const key = this.path[this.path.length - 1];
      const look = folderItem(key).look;
      const subs = key === UNCAT ? [] : this.host.folders().filter((f) => f.startsWith(`${key}/`) && !f.slice(key.length + 1).includes('/')).sort((a, b) => a.localeCompare(b, 'ja'));
      const inside = songs.filter((s) => (key === UNCAT ? !s.folders.length : s.folders.includes(key))).sort(byTitle);
      items = [{ kind: 'back', look: BACK_LOOK }, ...subs.map(folderItem), ...inside.map((s) => ({ kind: 'song' as const, s, look }))];
    }
    if (!items.length) items = [{ kind: 'back', look: BACK_LOOK }];
    this.items = items;
    let i = selectId ? items.findIndex((x) => x.kind === 'song' && x.s.id === selectId) : -1;
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

  private busy() { return this.boxT >= 0 || this.startT >= 0 || (this.diffT >= 0 && this.diffT < 1510) || this.diffOut >= 0; }

  private move(d: number) {
    if (this.busy()) return;
    if (this.diffT >= 0) { this.moveCursor(d); return; }
    if (!this.items.length) return;
    this.cur = (((this.cur + d) % this.items.length) + this.items.length) % this.items.length;
    this.scroll = clamp(this.scroll + d, -3, 3);
    this.still = 0;
    this.se('Ka');
  }

  private decide() {
    if (this.busy()) return;
    if (this.diffT >= 0) { this.decideDiff(); return; }
    if (this.scroll !== 0 || this.still < 520) return;
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
      this.cursorT = 1e9;
    } else {
      this.se('Don');
      this.boxT = 0;
      this.boxTo = it.kind === 'back' ? this.path.slice(0, -1) : [...this.path, it.key];
    }
  }

  private back() {
    if (this.busy()) return;
    if (this.diffT >= 0) { this.se('Cancel'); this.diffOut = 0; return; }
    if (this.path.length) { this.se('Cancel'); this.boxT = 0; this.boxTo = this.path.slice(0, -1); return; }
    this.host.toList();
  }

  /** 難易度えらびの並び: 0 もどる・1 設定・2〜5 かんたん〜おに（5 は裏にもなる） */
  private courseAt(i: number) { return i < 2 ? null : i === 5 && this.ura ? 'Edit' : COURSES[i - 2]; }
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
      if (it.s.courses.some((x) => x.name === other)) { this.ura = !this.ura; this.se('Ura'); this.cursorT = 0; }
      return;
    }
    let j = this.dsel;
    do j += d; while (j >= 0 && j <= 5 && !this.hasCourse(j));
    if (j < 0 || j > 5) return;
    this.dsel = j;
    this.cursorT = 0;
    this.se('Ka');
  }
  private decideDiff() {
    const it = this.center;
    if (it.kind !== 'song') return;
    if (this.dsel === 0) { this.se('Cancel'); this.diffOut = 0; return; }
    if (this.dsel === 1) { this.se('Don'); this.host.settings(); return; }
    this.se('Don');
    this.startT = 0;
  }

  private bindInput() {
    const toStage = (e: { clientX: number; clientY: number }) => {
      const r = this.el.getBoundingClientRect();
      return { x: ((e.clientX - r.left) * this.dpr - this.ox) / this.s, y: ((e.clientY - r.top) * this.dpr - this.oy) / this.s };
    };
    let down: { x: number; y: number; t: number; acc: number; accX: number; moved: boolean } | null = null;
    this.el.addEventListener('pointerdown', (e) => {
      const ctx = this.host.audio.ctx;
      if (ctx.state !== 'running') void ctx.resume();
      const p = toStage(e);
      down = { x: p.x, y: p.y, t: performance.now(), acc: 0, accX: 0, moved: false };
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const p = toStage(e);
      const dy = p.y - down.y, dx = p.x - down.x;
      if (Math.abs(dy) > 24 || Math.abs(dx) > 24) down.moved = true;
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
      wheelAcc += e.deltaY;
      while (Math.abs(wheelAcc) >= 60) { const d = Math.sign(wheelAcc); wheelAcc -= d * 60; this.move(d); }
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (!this.on || e.isComposing) return;
      // 設定などの面が開いているときは動かさない
      if (document.getElementById('sheet')?.classList.contains('hidden') === false) return;
      const k = e.key;
      if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'd' || k === 'D') this.move(-1);
      else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'k' || k === 'K') this.move(1);
      else if (k === 'Enter' || k === ' ' || k === 'f' || k === 'F' || k === 'j' || k === 'J') this.decide();
      else if (k === 'Escape' || k === 'Backspace') this.back();
      else return;
      e.preventDefault();
    });
  }

  private tap(p: { x: number; y: number }) {
    if (this.busy()) return;
    if (this.diffT >= 0) {
      const hit = [[382, 405, 115, 114], [514, 405, 115, 114], ...[647, 861, 1077, 1292].map((x) => [x, 405, 196, 355])];
      const i = hit.findIndex(([x, y, w, h]) => p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h);
      if (i < 0 || !this.hasCourse(i)) return;
      if (i === this.dsel) this.decideDiff();
      else { this.dsel = i; this.cursorT = 0; this.se('Ka'); }
      return;
    }
    // 左上の太鼓: いつもの一覧へ
    if (p.x < 300 && p.y < 270) { this.host.toList(); return; }
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
    const w = Math.round(this.el.clientWidth * this.dpr), h = Math.round(this.el.clientHeight * this.dpr);
    if (this.el.width !== w || this.el.height !== h) { this.el.width = w; this.el.height = h; }
    this.s = Math.min(w / 1920, h / 1080);
    this.ox = (w - 1920 * this.s) / 2;
    this.oy = (h - 1080 * this.s) / 2;
    const z = Math.max(1, Math.round(this.s * 2) / 2);
    if (z !== this.textScale) { this.textScale = z; this.texts.clear(); }
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
    if (this.boxT >= 0) {
      this.boxT += dt;
      // ctBoxOpen: 200 から 1.3ms ごと。1940 で中を入れ替える
      if (this.boxT >= (1940 - 200) * 1.3 && this.boxTo) {
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
      if (this.diffOut >= 400) { this.diffOut = -1; this.diffT = -1; this.still = 520; }
    }
    if (this.startT >= 0) {
      this.startT += dt;
      if (this.startT >= 700 && this.startT - dt < 700) {
        const it = this.center;
        const c = this.courseAt(this.dsel);
        if (it.kind === 'song' && c) this.host.play(it.s.id, c);
      }
    }
    // 試聴: まんなかの曲が開いたら流す（フォルダの上・フォルダを開く間は止める。流している間は前の曲のまま）
    const it = this.center;
    let want = this.previewed;
    if (this.boxT >= 0 || (it.kind !== 'song' && this.still > 0)) want = null;
    else if (it.kind === 'song' && this.still >= 520) want = it.s;
    if (want !== this.previewed) {
      this.previewed = want;
      this.host.preview(want);
    }
  }

  /** 帯が開いた量（TJAPlayer3 の BarAnimeCount: 止まって 400ms から、120ms で 0→62） */
  private bac() {
    if (this.scroll !== 0 || this.boxT >= 0) return this.boxT >= 0 ? 62 : 0;
    const v = this.still / 2;
    return v <= 200 ? 0 : v >= 260 ? 62 : Math.sin(rad((v - 200) * 1.5)) * 62;
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
      g.globalAlpha = 1;
    }
    if (diffA > 0) {
      g.globalAlpha = diffA;
      this.diffScreen();
      g.globalAlpha = 1;
    }
    this.don();
    this.side(ci);
    this.full('header', 0, 1.5);
    this.recolorHeader();
    this.stageNums();
    this.timer();
    this.full('credit', 3.5, 3);
    if (this.sk) {
      const pl = this.host.plate();
      this.sk.plate(g, { name: pl.name, title: pl.title, profile: pl.profile, wall: this.wall } as never, 60, 476);
    }
  }

  private headerFixed = false;
  /** 右上の曲目の帯の青を、本家の灰色がかった青に（一度だけ） */
  private recolorHeader() {
    if (this.headerFixed) return;
    this.headerFixed = true;
    const m = this.imgs.get('header');
    if (!m) return;
    const t = this.tinted('header', [160, 194, 216], [185, 203, 219], (r, _g, b) => b < r + 25);
    if (t) this.imgs.set('header', t);
  }

  private patCv: HTMLCanvasElement | null = null;
  private background() {
    const g = this.g, W = this.el.width, H = this.el.height;
    const y = (v: number) => (this.oy + v * this.s) / H;
    const gr = g.createLinearGradient(0, 0, 0, H);
    const stops: [number, string][] = [[0, '254,238,44'], [120, '254,211,45'], [360, '254,156,46'], [600, '253,105,47'], [720, '253,99,61'], [960, '252,94,110'], [1080, '249,97,128']];
    for (const [v, c] of stops) gr.addColorStop(clamp(y(v), 0, 1), `rgb(${c})`);
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    // 模様: 灰色の模様の明るい所だけを白く重ねる
    if (!this.patCv) {
      const m = this.imgs.get('bg');
      if (m) {
        const o = document.createElement('canvas'); o.width = m.im.width; o.height = m.im.height;
        const c = o.getContext('2d')!; c.drawImage(m.im, 0, 0);
        const px = c.getImageData(0, 0, o.width, o.height), p = px.data;
        // 本家の模様は、この絵の明るさを反転したもの（濃い所が白く、小さな白い点も白く）。
        // 絵は下ほど暗いので、周り 37px の平均からの差で見る（下まで同じ濃さに）
        const W = o.width, H = o.height;
        const L = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) L[i] = (p[i * 4] + p[i * 4 + 1] + p[i * 4 + 2]) / 3;
        const I = new Float64Array((W + 1) * (H + 1));
        for (let y = 0; y < H; y++) {
          let row = 0;
          for (let x = 0; x < W; x++) { row += L[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
        }
        const R = 18;
        for (let y = 0; y < H; y++) {
          const y0 = Math.max(0, y - R), y1 = Math.min(H, y + R + 1);
          for (let x = 0; x < W; x++) {
            const x0 = Math.max(0, x - R), x1 = Math.min(W, x + R + 1);
            const m = (I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
            const d = m - L[y * W + x];
            const i = (y * W + x) * 4;
            p[i] = p[i + 1] = p[i + 2] = 255;
            p[i + 3] = clamp(clamp(d * 0.05, 0, 1) * 0.5 + clamp((-d - 3.5) * 0.25, 0, 1) * 0.4, 0, 1) * 255;
          }
        }
        c.putImageData(px, 0, 0);
        this.patCv = o;
      }
    }
    if (this.patCv) {
      // 本家の画面に重ねて測った: 720p の絵の 1.86 倍・左上 (-868, -53) から並べる
      const k = 1.86 * this.s, w = 1280 * k, h = 720 * k;
      const x0 = this.ox - 868 * this.s, y0 = this.oy - 53 * this.s;
      for (let y = y0 - Math.ceil(y0 / h) * h; y < H; y += h) for (let x = x0 - Math.ceil(x0 / w) * w; x < W; x += w) g.drawImage(this.patCv, x, y, w, h);
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
    const jump = this.startT >= 0 ? this.anims.get('donStart') : undefined;
    const a = jump ?? this.anims.get('donLoop');
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
    const sc = this.imgs.get(`score${Math.min(ci, 4)}`);
    if (sc) this.g.drawImage(sc.im, 29, 581, sc.w * 1.6, sc.h * 1.6);
    this.put(this.text('自己ベスト', 18.5, 6, '#0c0806', { font: SEURAT }), 182, 605);
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

  private stageNums() {
    this.put(this.text('1', 32, 8, '#000', { font: SEURAT }), 1688, 273.5, Infinity, 'right');
    this.put(this.text('∞', 26, 6, '#000', { font: SEURAT }), 1812.5, 276);
  }

  /** 右上の時間（TJAtelier は時間を区切らないので ∞。本家の数字と同じ灰色・太さの線で） */
  private timer() {
    const m = this.imgs.get('headerTimer');
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
    const boxV = this.boxT >= 0 ? 200 + this.boxT / 1.3 : -1;
    const others = boxV >= 0 ? clamp(1 - (boxV - 1200) / 420, 0, 1) : clamp(this.fadeIn / 300, 0, 1);
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
    const sel = kind === 'song' ? this.tinted('barSelect', [255, 255, 0], [254, 252, 191]) : this.imgs.get('barSelect');
    let glowA = t;
    const flash = this.boxT >= 0 ? this.boxT : this.diffT >= 0 ? this.diffT : -1;
    if (flash >= 0 && flash < 800) { const v = flash % 200; glowA = v < 100 ? v / 100 : 1 - (v - 100) / 100; glowA = 0.5 + glowA * 0.5; }
    if (sel && glowA > 0) {
      g.save();
      g.globalAlpha *= glowA;
      this.nine(sel, [0, 0, 662, 251], [x - 21, y - 23, w + 42, h + 46], 40, 40);
      g.restore();
    }
    const bar = this.barImg(it.look);
    if (bar) this.nine(bar, [0, 0, 632, 92], [x, y, w, h], 21, 21);
    const ov = this.imgs.get('barOverlay');
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
    const m = this.imgs.get(`boxChara${i}`);
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
    const m = this.imgs.get(`mark${ci}`);
    if (!m) return;
    const g = this.g;
    g.save();
    // 本家の画面に輪の縁を重ねて測った: 1.5 倍・真ん中 (201, 408)・不透明度 0.65
    g.globalAlpha = 0.65 * a;
    const k = 1.5;
    g.drawImage(m.im, 201 - (m.w * k) / 2, 408 - (m.h * k) / 2, m.w * k, m.h * k);
    g.restore();
  }

  private diffScreen() {
    const it = this.center;
    if (it.kind !== 'song') return;
    const s = it.s;
    const g = this.g;
    const backName = `diffBack${it.look.bar < 0 ? 0 : it.look.bar}`;
    const bk = this.imgs.get(backName);
    if (bk) g.drawImage(bk.im, 960 - 858 * 0.75, 435 - 528 * 0.75, 858 * 1.5, 528 * 1.5);
    this.put(this.text(s.title, 52, 16, '#100b0b', { kx: 0.98, punct: 0.4 }), 961.5, 195, 1100);
    if (s.subtitle) this.put(this.text(s.subtitle, 30, 10, '#100b0b', { kx: 0.9 }), 962, 256.5, 1100);
    this.blit('diffBar', 0, 0, 77, 76, 382, 405, 77 * 1.5, 76 * 1.5);
    this.blit('diffBar', 88, 0, 77, 76, 514, 405, 77 * 1.5, 76 * 1.5);
    const cx = [647, 861, 1077, 1292];
    const src = [176, 319, 463, this.ura ? 749 : 606];
    // 選んでいる所の枠（カードの後ろ）
    const sel = this.dsel;
    if (sel >= 2) this.blit('diffCursor', 56, 135, 147, 250, cx[sel - 2] + 98.25 - 110.25, 405 + 177.75 - 187.5, 147 * 1.5, 250 * 1.5);
    else this.blit('diffCursor', 86, 410, 88, 85, [382, 514][sel] + 57.75 - 66, 462 - 63.75, 88 * 1.5, 85 * 1.5);
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
      this.blit('diffCrown', cr * 24.5, 0, 24.5, 26, x + 21, 405 + 22.5, 24.5 * 1.5, 26 * 1.5);
      const r = b ? rankOf(b.score) : 0;
      if (r > 0) this.blit('diffRank', 0, (r - 1) * 42.71, 50, 42.71, x + 57, 405 + 17, 50 * 0.85, 42.71 * 0.85);
    });
    // 1P の吹き出し（出てくるとき下りてくる。動かすと少し跳ねる）
    const inT = (this.diffT - 1255) / 4;
    const ba = inT >= 80 ? clamp((inT - 80) * 2.84 / 255, 0, 1) : 0;
    const drop = inT >= 80 ? Math.sin(rad(Math.min(90, inT - 80))) : 0;
    const bounce = this.cursorT < 180 ? Math.sin(rad(this.cursorT)) * 15 : 0;
    const bx = sel >= 2 ? cx[sel - 2] + 98.25 : [382, 514][sel] + 57.75;
    const ga = g.globalAlpha;
    g.globalAlpha = ga * ba;
    this.blit('diffCursor', 94, 34, 76, 77, bx - 57, 313 - 75 * (1 - drop) - (sel < 2 ? 0 : 0) + bounce, 76 * 1.5, 77 * 1.5);
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
}

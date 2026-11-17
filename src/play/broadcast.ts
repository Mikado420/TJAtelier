import { lyricAt, type Course } from '../chart/types';

/** プレイの画面に出す曲の情報（動画用の画面では、ジャケット・譜面作者なども使う） */
export interface PlayInfo {
  title: string;
  course: string;
  level: number;
  genre?: string;
  /** サブタイトル（アーティストなど） */
  sub?: string;
  /** 譜面作者 */
  maker?: string;
  /** ジャケットの画像（object URL） */
  jacket?: string;
  /** 曲のフォルダの名前と色（custom = genre.ini で決まった色） */
  folder?: { name: string; color: string; custom: boolean };
  /** 曲えらびから何曲目か（0 = 曲えらびから遊んでいない） */
  stage?: number;
}

const COURSE: Record<string, [string, string]> = {
  Easy: ['かんたん', '#e8603c'],
  Normal: ['ふつう', '#8cc63e'],
  Hard: ['むずかしい', '#1fa59a'],
  Oni: ['おに', '#c8337e'],
  Edit: ['おに', '#7b4bd0'],
};

/** 2000×1125 の枠の中の位置（レーンは renderer が BC_DY だけ下へずらして描く） */
const TL = { x: 50, y: 456, w: 1347, h: 92 };
const BARS = 300;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mmss = (t: number) => {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 上半分の背景にするジャケットの絵: 小さく縮めてぼかし・色の濃さ・暗さを一度だけ計算した canvas（2160×820 の 1/10）。
 * 表示のたびにぼかしを計算しないように
 */
const artCache = new Map<string, Promise<string | null>>();
function blurredArt(src: string): Promise<string | null> {
  const hit = artCache.get(src);
  if (hit) return hit;
  const p = new Promise<string | null>((resolve) => {
    const im = new Image();
    im.decoding = 'async';
    const run = (tries: number) => {
      try {
        const W = 216;
        const H = 82;
        const cv = document.createElement('canvas');
        cv.width = W;
        cv.height = H;
        const g = cv.getContext('2d', { willReadFrequently: true });
        if (!g || !im.naturalWidth) return resolve(null);
        // 枠いっぱいに（はみ出す所は切る）
        const k = Math.max(W / im.naturalWidth, H / im.naturalHeight);
        g.drawImage(im, (W - im.naturalWidth * k) / 2, (H - im.naturalHeight * k) / 2, im.naturalWidth * k, im.naturalHeight * k);
        const d = g.getImageData(0, 0, W, H);
        // 描けていない（透明のまま）ときは少し待ってやり直し、だめなら画面側でぼかす
        let seen = 0;
        for (let i = 3; i < d.data.length; i += 4) if (d.data[i] > 8) seen++;
        if (seen < (W * H) / 4) {
          if (tries > 0) return void setTimeout(() => run(tries - 1), 120);
          return resolve(null);
        }
        boxBlur(d.data, W, H, 5);
        boxBlur(d.data, W, H, 5);
        boxBlur(d.data, W, H, 4);
        // 色を濃く（1.35 倍）・暗く（0.62 倍）
        const a = d.data;
        for (let i = 0; i < a.length; i += 4) {
          const l = 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
          for (let c = 0; c < 3; c++) a[i + c] = Math.max(0, Math.min(255, (l + (a[i + c] - l) * 1.35) * 0.62));
          a[i + 3] = 255;
        }
        g.putImageData(d, 0, 0);
        resolve(cv.toDataURL('image/png'));
      } catch {
        resolve(null);
      }
    };
    im.onload = () => {
      if (im.decode) im.decode().then(() => run(3), () => run(3));
      else run(3);
    };
    im.onerror = () => resolve(null);
    im.src = src;
  });
  artCache.set(src, p);
  if (artCache.size > 8) artCache.delete(artCache.keys().next().value!);
  return p;
}
/** 横と縦の箱ぼかし（半径 r） */
function boxBlur(a: Uint8ClampedArray, W: number, H: number, r: number) {
  const tmp = new Float32Array(Math.max(W, H) * 4);
  const pass = (n: number, m: number, at: (i: number, j: number) => number) => {
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) tmp[i * 4 + c] = a[at(i, j) + c];
      for (let i = 0; i < n; i++) {
        let s0 = 0, s1 = 0, s2 = 0, s3 = 0, cnt = 0;
        for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) { s0 += tmp[k * 4]; s1 += tmp[k * 4 + 1]; s2 += tmp[k * 4 + 2]; s3 += tmp[k * 4 + 3]; cnt++; }
        const o = at(i, j);
        a[o] = s0 / cnt; a[o + 1] = s1 / cnt; a[o + 2] = s2 / cnt; a[o + 3] = s3 / cnt;
      }
    }
  };
  pass(W, H, (i, j) => (j * W + i) * 4);
  pass(H, W, (i, j) => (i * W + j) * 4);
}

/** 音源の波形の山（BARS 本。0〜1） */
const peakCache = new WeakMap<AudioBuffer, Float32Array>();
function peaksOf(buf: AudioBuffer | null, dur: number): Float32Array | null {
  if (!buf) return null;
  let p = peakCache.get(buf);
  if (p) return p;
  p = new Float32Array(BARS);
  const chs = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, i) => buf.getChannelData(i));
  const per = (buf.sampleRate * dur) / BARS;
  const stride = Math.max(1, Math.floor(per / 400));
  let max = 0;
  for (let i = 0; i < BARS; i++) {
    const a = Math.floor(i * per);
    const b = Math.min(chs[0].length, Math.floor((i + 1) * per));
    let sum = 0;
    let n = 0;
    for (let k = a; k < b; k += stride) {
      let v = 0;
      for (const c of chs) v += Math.abs(c[k]);
      sum += v * v;
      n++;
    }
    p[i] = n ? Math.sqrt(sum / n) : 0;
    if (p[i] > max) max = p[i];
  }
  if (max > 0) for (let i = 0; i < BARS; i++) p[i] /= max;
  peakCache.set(buf, p);
  return p;
}

/**
 * 動画用の画面の、レーン以外の部分（曲名・ジャケット・BPM などの数・曲の流れ・時間）。
 * 2000×1125 の枠で作り、画面の 16:9 の枠に合わせて縮める
 */
export class Broadcast {
  readonly el: HTMLElement;
  private readonly inner: HTMLElement;
  private course: Course | null = null;
  private dur = 1;
  private shown = '';
  private base: HTMLCanvasElement;
  private on: HTMLCanvasElement;
  private onWrap: HTMLElement;
  private seekOn: HTMLElement | null = null;
  private knob: HTMLElement | null = null;
  private peaks: Float32Array | null = null;
  private q = 1;

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'bc hidden';
    this.el.setAttribute('aria-hidden', 'true');
    this.inner = document.createElement('div');
    this.inner.className = 'bc-in';
    this.el.append(this.inner);
    // レーンの canvas より後ろ（背景の canvas より手前）。判定の文字などがパネルに隠れないように
    root.querySelector('canvas#game')?.before(this.el);
    this.base = document.createElement('canvas');
    this.on = document.createElement('canvas');
    this.onWrap = document.createElement('div');
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
    this.course = null;
  }

  /** backdrop = 背景の動画・画像を全面に出している（そのときはジャケットの背景を敷かず、後ろが透けて見える） */
  show(course: Course, info: PlayInfo, buf: AudioBuffer | null, musicDur: number, backdrop = false) {
    this.course = course;
    const last = Math.max(0, ...course.notes.map((n) => n.endTime ?? n.time));
    this.dur = Math.max(1, musicDur > 0 ? musicDur : last + 2);
    this.peaks = peaksOf(buf, this.dur);
    const [label, col] = COURSE[course.name] ?? [course.name, '#7b4bd0'];
    // 譜面分岐のある譜面は、達人の音符を数える
    const notes = course.notes.filter((n) => !n.dummy && (n.type === 'don' || n.type === 'ka' || n.type === 'bigDon' || n.type === 'bigKa') && (n.br === undefined || n.br === 2)).length;
    const sub = (info.sub ?? '').replace(/^(--|\+\+)/, '').trim();
    const genre = info.genre?.trim();
    this.el.style.setProperty('--cc', col);
    // 上半分の背景: ジャケットを大きくぼかして敷く（ジャケットが無ければ難易度の色）
    const art = backdrop ? '' : `<div class="bc-art${info.jacket ? '' : ' bc-art-none'}"></div><div class="bc-shade"></div>`;
    this.el.classList.toggle('bc-backdrop', backdrop);
    this.inner.innerHTML = `${art}
      <div class="bc-title bc-pnl"><i class="bc-bar"></i>
        <div class="bc-meta"><span class="bc-chip">${esc(label)}</span><b class="bc-lv">★${course.level}</b>${info.maker ? `<span class="bc-maker">${esc(info.maker)}</span>` : ''}</div>
        <div class="bc-name">${esc(info.title)}</div>
        ${sub ? `<div class="bc-sub">${esc(sub)}</div>` : ''}
      </div>
      <div class="bc-jk">${info.jacket ? `<img src="${info.jacket}" alt="">` : '<img class="bc-logo" src="logo.png" alt="">'}</div>
      <div class="bc-stats">
        <div class="bc-pnl bc-cell"><i>BPM</i><b data-k="bpm"></b></div>
        <div class="bc-pnl bc-cell"><i>SCROLL</i><b data-k="scroll"></b></div>
        <div class="bc-pnl bc-cell"><i>MEASURE</i><b data-k="meas"></b></div>
        <div class="bc-pnl bc-cell"><i>BAR</i><b><span data-k="bar"></span><small>/ ${course.measures?.length ?? course.bars.length}</small></b></div>
      </div>
      <div class="bc-tl"></div>
      <div class="bc-seek"><i class="bc-seek-on"><i></i></i><i class="bc-knob"></i></div>
      <div class="bc-foot bc-pnl">
        <div class="bc-cell"><i>NOTES</i><b>${notes.toLocaleString('en-US')}</b></div>
        ${genre ? `<div class="bc-cell bc-genre"><i>GENRE</i><b>${esc(genre)}</b></div>` : ''}
        <div class="bc-lyric" data-k="lyric"></div>
        <div class="bc-time"><b data-k="time"></b><small>/ ${mmss(this.dur)}</small></div>
      </div>`;
    const tl = this.inner.querySelector('.bc-tl')!;
    this.onWrap.className = 'bc-on';
    this.onWrap.replaceChildren(this.on);
    tl.replaceChildren(this.base, this.onWrap);
    this.seekOn = this.inner.querySelector('.bc-seek-on');
    const artEl = this.inner.querySelector<HTMLElement>('.bc-art');
    if (artEl && info.jacket) {
      const src = info.jacket;
      let done = false;
      const put = (url: string | null) => {
        if (done || !artEl.isConnected) return;
        done = true;
        // 計算できなかったとき・間に合わないときは、これまでどおり画面側でぼかす
        if (url) artEl.style.backgroundImage = `url("${url}")`;
        else {
          artEl.style.backgroundImage = `url("${src}")`;
          artEl.classList.add('bc-art-css');
        }
      };
      void blurredArt(src).then(put, () => put(null));
      setTimeout(() => put(null), 1200);
    }
    this.knob = this.inner.querySelector('.bc-knob');
    this.shown = '';
    this.el.classList.remove('hidden');
    this.paintTimeline();
    void document.fonts?.ready.then(() => { this.paintTimeline(); this.fitTitle(); });
    requestAnimationFrame(() => this.fitTitle());
  }

  /**
   * 曲名・サブタイトルが長いときは、板に収まるように文字を小さくする。
   * 2 行に分けられる大きさまで小さくなったら、2 行にする（それでも入らなければ、入るまでさらに小さく）
   */
  private fitTitle() {
    const name = this.inner.querySelector<HTMLElement>('.bc-name');
    const sub = this.inner.querySelector<HTMLElement>('.bc-sub');
    if (!name) return;
    const AREA = 154;
    const subH = sub ? this.fitBox(sub, 32, 58, 1.2) + 6 : 0;
    this.fitBox(name, 100, AREA - subH, 1.12);
  }

  /** el の文字を、幅と高さ（availH）に収まる大きさにする。使った高さを返す */
  private fitBox(el: HTMLElement, max: number, availH: number, lh: number) {
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = `${max}px`;
    const cw = el.clientWidth;
    const sw = el.scrollWidth;
    let size = Math.min(sw > cw && cw > 0 ? Math.floor((max * cw) / sw) : max, Math.floor(availH / lh));
    const two = Math.floor(availH / (2 * lh));
    if (size >= two) {
      el.style.fontSize = `${size}px`;
      return Math.ceil(size * lh);
    }
    el.style.whiteSpace = 'normal';
    size = two;
    for (;;) {
      el.style.fontSize = `${size}px`;
      if (el.scrollHeight <= availH + 1 || size <= 12) break;
      size--;
    }
    return el.scrollHeight;
  }

  /** 16:9 の枠（画面 px）に合わせて置く */
  place(frame: { x: number; y: number; s: number }) {
    this.el.style.transform = `translate(${frame.x}px, ${frame.y}px) scale(${frame.s})`;
    const q = Math.min(2, Math.max(0.5, frame.s * (window.devicePixelRatio || 1)));
    if (Math.abs(q - this.q) > 0.01) {
      this.q = q;
      if (this.course) this.paintTimeline();
    }
  }

  /** 曲の流れ（波形・ゴーゴーの区間）。進んだ所の色は上の canvas を幅で切って見せる */
  private paintTimeline() {
    const c = this.course;
    if (!c) return;
    const W = Math.round(TL.w * this.q);
    const H = Math.round(TL.h * this.q);
    const paint = (cv: HTMLCanvasElement, lit: boolean) => {
      cv.width = W;
      cv.height = H;
      const g = cv.getContext('2d')!;
      g.setTransform(this.q, 0, 0, this.q, 0, 0);
      g.clearRect(0, 0, TL.w, TL.h);
      const x = (t: number) => (Math.max(0, Math.min(this.dur, t)) / this.dur) * TL.w;
      g.fillStyle = lit ? 'rgba(200,51,126,0.34)' : 'rgba(200,51,126,0.2)';
      for (const [a, b] of c.gogo) g.fillRect(x(a), 0, Math.max(2, x(Number.isFinite(b) ? b : this.dur) - x(a)), TL.h);
      const bw = TL.w / BARS;
      g.fillStyle = lit ? '#93cde2' : 'rgba(255,255,255,0.2)';
      for (let i = 0; i < BARS; i++) {
        const v = this.peaks ? 0.12 + 0.88 * this.peaks[i] : 0.3;
        const h = v * TL.h;
        g.fillRect(i * bw + 0.5, TL.h - h, bw - 1.5, h);
      }
    };
    paint(this.base, false);
    paint(this.on, true);
    this.on.style.width = `${TL.w}px`;
    this.base.style.width = `${TL.w}px`;
  }

  /** 毎フレーム（変わった所だけ書き換える） */
  update(now: number) {
    const c = this.course;
    if (!c) return;
    const ps = c.params ?? [];
    let p = ps[0];
    for (const x of ps) {
      if (x.time > now) break;
      p = x;
    }
    const ms = c.measures ?? [];
    let mi = 0;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].time > now + 1e-4) break;
      mi = i;
    }
    const m = ms[mi];
    const bpm = p ? p.bpm : c.bars[0]?.bpm ?? 0;
    const scroll = p ? p.scroll : 1;
    const prog = Math.max(0, Math.min(1, now / this.dur));
    const px = Math.round(prog * TL.w * 2) / 2;
    const lyric = lyricAt(c.lyrics, now);
    const key = `${bpm}|${scroll}|${mi}|${Math.floor(Math.max(0, now))}|${px}|${lyric}`;
    if (key === this.shown) return;
    this.shown = key;
    const set = (k: string, v: string) => {
      const el = this.inner.querySelector<HTMLElement>(`[data-k="${k}"]`);
      if (el && el.textContent !== v) el.textContent = v;
    };
    set('bpm', bpm.toFixed(2));
    set('scroll', `×${scroll.toFixed(3)}`);
    set('meas', m ? `${m.num}/${m.den}` : '4/4');
    set('bar', String(now < (ms[0]?.time ?? 0) ? 0 : mi + 1));
    set('time', mmss(now));
    set('lyric', lyric);
    // 進んだ所は、幅を変えずに位置だけ動かして見せる（画面の配置の計算と描き直しを起こさない）
    const hide = TL.w - px;
    this.onWrap.style.transform = `translateX(${-hide}px)`;
    this.on.style.transform = `translateX(${hide}px)`;
    if (this.seekOn) {
      this.seekOn.style.transform = `translateX(${-hide}px)`;
      (this.seekOn.firstElementChild as HTMLElement | null)?.style.setProperty('transform', `translateX(${hide}px)`);
    }
    if (this.knob) this.knob.style.transform = `translateX(${px}px)`;
  }
}

const BC_FONT = "'Makinas 4 Flat', 'Hiragino Sans', 'Noto Sans JP', sans-serif";

/** 絵を読み込む（失敗したら null） */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    setTimeout(() => res(im.naturalWidth ? im : null), 5000);
    im.src = src;
  });
}

/**
 * 動画用の画面の、レーン以外の部分を canvas に描く（録画用。見た目は Broadcast の DOM と同じ）。
 * 動かない所は 1 枚の絵にしておき、毎コマは数・曲の流れ・時間だけ描く
 */
/** 録画の別スレッドへ渡す、動画用の画面の動かない部分 */
export interface BroadcastData {
  stat: ImageBitmap;
  lit: ImageBitmap | null;
  dur: number;
  total: string;
  lyricX: number;
}

export class BroadcastPainter {
  private stat: HTMLCanvasElement | ImageBitmap | null = null;
  private lit: HTMLCanvasElement | ImageBitmap | null = null;
  private course: Course | null = null;
  private dur = 1;
  private total = '';

  async prepare(course: Course, info: PlayInfo, buf: AudioBuffer | null, musicDur: number, backdrop: boolean, s: number) {
    await Promise.all(['600', '700', '800', '900'].map((w) => document.fonts?.load(`${w} 40px 'Makinas 4 Flat'`).catch(() => [])));
    this.course = course;
    const last = Math.max(0, ...course.notes.map((n) => n.endTime ?? n.time));
    this.dur = Math.max(1, musicDur > 0 ? musicDur : last + 2);
    const peaks = peaksOf(buf, this.dur);
    const [label, col] = COURSE[course.name] ?? [course.name, '#7b4bd0'];
    const notes = course.notes.filter((n) => !n.dummy && (n.type === 'don' || n.type === 'ka' || n.type === 'bigDon' || n.type === 'bigKa') && (n.br === undefined || n.br === 2)).length;
    const sub = (info.sub ?? '').replace(/^(--|\+\+)/, '').trim();
    const genre = info.genre?.trim();
    this.total = String(course.measures?.length ?? course.bars.length);
    const cv = document.createElement('canvas');
    cv.width = Math.round(2000 * s);
    cv.height = Math.round(1125 * s);
    const g = cv.getContext('2d')!;
    g.scale(s, s);
    // 上半分の背景
    if (!backdrop) {
      let art: HTMLImageElement | null = null;
      if (info.jacket) {
        const url = await blurredArt(info.jacket).catch(() => null);
        if (url) art = await loadImage(url);
      }
      if (art) g.drawImage(art, -80, -120, 2160, 793);
      else {
        g.save();
        g.translate(-80 + 0.3 * 2160, -120 + 0.2 * 793);
        g.scale(1, 634.4 / 1296);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1296);
        gr.addColorStop(0, mixColor(col, '#0d1014', 0.55));
        gr.addColorStop(0.75, '#0d1014');
        gr.addColorStop(1, '#0d1014');
        g.fillStyle = gr;
        g.fillRect(-2000, -2000, 6000, 6000 * (1296 / 634.4));
        g.restore();
      }
      const sh = g.createLinearGradient(0, 0, 0, 660);
      sh.addColorStop(0, 'rgba(0,0,0,0.1)');
      sh.addColorStop(0.92, 'rgba(0,0,0,0.55)');
      sh.addColorStop(1, '#0d1014');
      g.fillStyle = sh;
      g.fillRect(0, 0, 2000, 660);
    }
    const pnlBg = backdrop ? 'rgba(10,12,16,0.55)' : 'rgba(255,255,255,0.08)';
    const ring = (x: number, y: number, w: number, h: number) => {
      g.strokeStyle = 'rgba(255,255,255,0.16)';
      g.lineWidth = 1.5;
      g.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    };
    // 曲名の板
    const tg = g.createLinearGradient(50, 0, 1397, 0);
    tg.addColorStop(0, backdrop ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.28)');
    tg.addColorStop(1, backdrop ? 'rgba(10,12,16,0.4)' : 'rgba(255,255,255,0.05)');
    g.fillStyle = tg;
    g.fillRect(50, 50, 1347, 270);
    ring(50, 50, 1347, 270);
    g.fillStyle = col;
    g.fillRect(50, 50, 8, 270);
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    let x = 114;
    const my = 107;
    g.font = `800 30px ${BC_FONT}`;
    const cw = g.measureText(label).width + 44;
    g.fillStyle = col;
    g.fillRect(x, my - 23, cw, 46);
    g.fillStyle = '#fff';
    g.fillText(label, x + 22, my + 1);
    x += cw + 18;
    g.font = `800 40px ${BC_FONT}`;
    const lv = `★${course.level}`;
    g.fillText(lv, x, my + 1);
    x += g.measureText(lv).width + 26;
    if (info.maker) {
      g.font = `600 26px ${BC_FONT}`;
      g.globalAlpha = 0.75;
      g.fillText(ellipsis(g, info.maker, 1307 - x), x, my + 1);
      g.globalAlpha = 1;
    }
    // 曲名・サブタイトル（板に収まる大きさ。小さくなりすぎるときは 2 行に）
    const AREA = 154;
    const CW = 1193;
    let subLines: string[] = [];
    let subSize = 32;
    let subH = 0;
    if (sub) {
      [subSize, subLines] = fitText(g, sub, '600', 32, CW, 58, 1.2);
      subH = Math.min(58, subLines.length * subSize * 1.2) + 6;
    }
    const [nameSize, nameLines] = fitText(g, info.title, '900', 100, CW, AREA - subH, 1.12);
    let y = 146;
    g.textBaseline = 'middle';
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.45)';
    g.shadowBlur = 30;
    g.shadowOffsetY = 6;
    g.font = `900 ${nameSize}px ${BC_FONT}`;
    for (const ln of nameLines) {
      g.fillText(ln, 114, y + (nameSize * 1.12) / 2);
      y += nameSize * 1.12;
    }
    g.restore();
    if (subLines.length) {
      y += 6;
      g.font = `600 ${subSize}px ${BC_FONT}`;
      g.globalAlpha = 0.8;
      for (const ln of subLines) {
        g.fillText(ln, 114, y + (subSize * 1.2) / 2);
        y += subSize * 1.2;
      }
      g.globalAlpha = 1;
    }
    // ジャケット
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 70;
    g.shadowOffsetY = 30;
    g.fillStyle = 'rgba(16,18,21,0.9)';
    g.fillRect(1415, 50, 535, 535);
    g.restore();
    const jk = await loadImage(info.jacket ?? 'logo.png');
    if (jk && jk.naturalWidth) {
      if (info.jacket) {
        const k = Math.max(535 / jk.naturalWidth, 535 / jk.naturalHeight);
        const w = jk.naturalWidth * k;
        const h = jk.naturalHeight * k;
        g.save();
        g.beginPath();
        g.rect(1415, 50, 535, 535);
        g.clip();
        g.drawImage(jk, 1415 + (535 - w) / 2, 50 + (535 - h) / 2, w, h);
        g.restore();
      } else {
        const w = 535 * 0.78;
        const h = (w * jk.naturalHeight) / jk.naturalWidth;
        g.globalAlpha = 0.85;
        g.drawImage(jk, 1415 + (535 - w) / 2, 50 + (535 - h) / 2, w, h);
        g.globalAlpha = 1;
      }
    }
    g.strokeStyle = 'rgba(255,255,255,0.2)';
    g.lineWidth = 2;
    g.strokeRect(1414, 49, 537, 537);
    // BPM などの板
    const cellW = (1347 - 42) / 4;
    ['BPM', 'SCROLL', 'MEASURE', 'BAR'].forEach((t, i) => {
      const cx = 50 + i * (cellW + 14);
      g.fillStyle = pnlBg;
      g.fillRect(cx, 336, cellW, 104);
      ring(cx, 336, cellW, 104);
      label21(g, t, cx + 40, 336 + 14 + 14);
    });
    // 曲の流れ
    const tl = (lit: boolean) => {
      const c = document.createElement('canvas');
      c.width = Math.round(TL.w * s);
      c.height = Math.round(TL.h * s);
      const h = c.getContext('2d')!;
      h.scale(s, s);
      const px = (t: number) => (Math.max(0, Math.min(this.dur, t)) / this.dur) * TL.w;
      h.fillStyle = lit ? 'rgba(200,51,126,0.34)' : 'rgba(200,51,126,0.2)';
      for (const [a, b] of course.gogo) h.fillRect(px(a), 0, Math.max(2, px(Number.isFinite(b) ? b : this.dur) - px(a)), TL.h);
      const bw = TL.w / BARS;
      h.fillStyle = lit ? '#93cde2' : 'rgba(255,255,255,0.2)';
      for (let i = 0; i < BARS; i++) {
        const v = peaks ? 0.12 + 0.88 * peaks[i] : 0.3;
        h.fillRect(i * bw + 0.5, TL.h - v * TL.h, bw - 1.5, v * TL.h);
      }
      return c;
    };
    g.drawImage(tl(false), TL.x, TL.y, TL.w, TL.h);
    this.lit = tl(true);
    g.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(g, 50, 569, 1347, 8, 4);
    g.fill();
    // 下の帯
    g.fillStyle = 'rgba(10,12,16,0.78)';
    g.fillRect(0, 960, 2000, 141);
    g.fillStyle = 'rgba(255,255,255,0.14)';
    g.fillRect(0, 960, 2000, 1.5);
    x = 50;
    const notesTxt = notes.toLocaleString('en-US');
    g.font = `800 46px ${BC_FONT}`;
    const nw = Math.max(g.measureText(notesTxt).width, labelW(g, 'NOTES'));
    label21(g, 'NOTES', x, 1003.5);
    g.font = `800 46px ${BC_FONT}`;
    g.fillStyle = '#fff';
    g.fillText(notesTxt, x, 1045);
    x += nw + 70;
    if (genre) {
      const lw = labelW(g, 'GENRE');
      g.font = `700 38px ${BC_FONT}`;
      const gt = ellipsis(g, genre, 420);
      const gw = Math.max(g.measureText(gt).width, lw);
      g.fillStyle = '#fff';
      g.fillText(gt, x, 1045);
      label21(g, 'GENRE', x, 1003.5);
      x += gw + 70;
    }
    this.lyricX = x;
    this.stat = cv;
  }

  private lyricX = 0;

  /** 1 コマ。frame = 2000×1125 の枠を置く所（画面 px） */
  draw(g: CanvasRenderingContext2D, frame: { x: number; y: number; s: number }, now: number) {
    const c = this.course;
    if (!c || !this.stat) return;
    g.save();
    g.beginPath();
    g.rect(frame.x, frame.y, 2000 * frame.s, 1125 * frame.s);
    g.clip();
    g.drawImage(this.stat, frame.x, frame.y, 2000 * frame.s, 1125 * frame.s);
    g.translate(frame.x, frame.y);
    g.scale(frame.s, frame.s);
    const ps = c.params ?? [];
    let p = ps[0];
    for (const x of ps) {
      if (x.time > now) break;
      p = x;
    }
    const ms = c.measures ?? [];
    let mi = 0;
    for (let i = 0; i < ms.length; i++) {
      if (ms[i].time > now + 1e-4) break;
      mi = i;
    }
    const m = ms[mi];
    const bpm = p ? p.bpm : c.bars[0]?.bpm ?? 0;
    const scroll = p ? p.scroll : 1;
    const cellW = (1347 - 42) / 4;
    const vals = [bpm.toFixed(2), `×${scroll.toFixed(3)}`, m ? `${m.num}/${m.den}` : '4/4', String(now < (ms[0]?.time ?? 0) ? 0 : mi + 1)];
    g.textBaseline = 'middle';
    g.fillStyle = '#fff';
    vals.forEach((v, i) => {
      const x = 50 + i * (cellW + 14) + 40;
      g.font = `800 46px ${BC_FONT}`;
      g.fillText(v, x, 403);
      if (i === 3) {
        const w = g.measureText(v).width;
        g.font = `800 24px ${BC_FONT}`;
        g.globalAlpha = 0.55;
        g.textBaseline = 'alphabetic';
        g.fillText(`/ ${this.total}`, x + w + 6, 419);
        g.textBaseline = 'middle';
        g.globalAlpha = 1;
      }
    });
    // 曲の流れ・進んだ所
    const prog = Math.max(0, Math.min(1, now / this.dur));
    const px = Math.round(prog * TL.w * 2) / 2;
    if (this.lit && px > 0) g.drawImage(this.lit, 0, 0, (px / TL.w) * this.lit.width, this.lit.height, TL.x, TL.y, px, TL.h);
    if (px > 0) {
      g.save();
      g.beginPath();
      g.rect(50, 569, px, 8);
      g.clip();
      g.fillStyle = '#fff';
      roundRect(g, 50, 569, 1347, 8, 4);
      g.fill();
      g.restore();
    }
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 12;
    g.shadowOffsetY = 4;
    g.fillStyle = 'rgba(255,255,255,0.3)';
    g.beginPath();
    g.arc(50 + px, 573, 16, 0, Math.PI * 2);
    g.fill();
    g.restore();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(50 + px, 573, 11, 0, Math.PI * 2);
    g.fill();
    // 時間
    const tt = mmss(now);
    const tot = `/ ${mmss(this.dur)}`;
    g.font = `700 28px ${BC_FONT}`;
    const tw2 = g.measureText(tot).width;
    g.font = `800 56px ${BC_FONT}`;
    const tw1 = g.measureText(tt).width;
    const tx = 1950 - tw1 - 6 - tw2;
    g.textBaseline = 'alphabetic';
    g.fillText(tt, tx, 1050);
    g.font = `700 28px ${BC_FONT}`;
    g.globalAlpha = 0.55;
    g.fillText(tot, tx + tw1 + 6, 1050);
    g.globalAlpha = 1;
    // 歌詞
    const ly = lyricAt(c.lyrics, now);
    if (ly) {
      const room = tx - 70 - this.lyricX;
      g.font = `900 48px ${BC_FONT}`;
      const t = ellipsis(g, ly, room);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.lineWidth = 9;
      g.strokeStyle = '#0b0d12';
      const cx = this.lyricX + room / 2;
      g.strokeText(t, cx, 1030);
      g.fillStyle = '#fff';
      g.fillText(t, cx, 1030);
      g.textAlign = 'left';
    }
    g.restore();
  }

  /** 別スレッドへ渡す形にする */
  async export(): Promise<BroadcastData | null> {
    if (!this.stat) return null;
    return {
      stat: await createImageBitmap(this.stat),
      lit: this.lit ? await createImageBitmap(this.lit) : null,
      dur: this.dur,
      total: this.total,
      lyricX: this.lyricX,
    };
  }
  /** 渡されたものから作る（別スレッドで） */
  static from(course: Course, d: BroadcastData) {
    const p = new BroadcastPainter();
    p.course = course;
    p.stat = d.stat;
    p.lit = d.lit;
    p.dur = d.dur;
    p.total = d.total;
    p.lyricX = d.lyricX;
    return p;
  }

  dispose() {
    for (const c of [this.stat, this.lit]) {
      if (!c) continue;
      if ('close' in c) c.close();
      else c.width = c.height = 0;
    }
    this.stat = this.lit = null;
    this.course = null;
  }
}

function label21(g: CanvasRenderingContext2D, t: string, x: number, y: number) {
  g.font = `700 21px ${BC_FONT}`;
  g.fillStyle = 'rgba(255,255,255,0.7)';
  g.textBaseline = 'middle';
  let cx = x;
  for (const ch of t) {
    g.fillText(ch, cx, y);
    cx += g.measureText(ch).width + 21 * 0.14;
  }
  g.fillStyle = '#fff';
}
function labelW(g: CanvasRenderingContext2D, t: string) {
  g.font = `700 21px ${BC_FONT}`;
  let w = 0;
  for (const ch of t) w += g.measureText(ch).width + 21 * 0.14;
  return w;
}
function ellipsis(g: CanvasRenderingContext2D, t: string, w: number) {
  if (g.measureText(t).width <= w) return t;
  const chars = [...t];
  while (chars.length && g.measureText(`${chars.join('')}…`).width > w) chars.pop();
  return `${chars.join('')}…`;
}
function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
/** a と b を k : 1-k で混ぜた色 */
function mixColor(a: string, b: string, k: number) {
  const p = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return `rgb(${A.map((v, i) => Math.round(v * k + B[i] * (1 - k))).join(',')})`;
}
/** 幅 W・高さ H に収まる文字の大きさと行（Broadcast.fitBox と同じ決め方） */
function fitText(g: CanvasRenderingContext2D, t: string, weight: string, max: number, W: number, H: number, lh: number): [number, string[]] {
  g.font = `${weight} ${max}px ${BC_FONT}`;
  const sw = g.measureText(t).width;
  const size = Math.min(sw > W ? Math.floor((max * W) / sw) : max, Math.floor(H / lh));
  const two = Math.floor(H / (2 * lh));
  if (size >= two) return [size, [t]];
  for (let s = two; ; s--) {
    g.font = `${weight} ${s}px ${BC_FONT}`;
    const lines = wrap(g, t, W);
    if (lines.length * s * lh <= H + 1 || s <= 12) return [s, lines];
  }
}
function wrap(g: CanvasRenderingContext2D, t: string, W: number) {
  const out: string[] = [];
  let cur = '';
  for (const ch of t) {
    if (cur && g.measureText(cur + ch).width > W) {
      const sp = cur.lastIndexOf(' ');
      if (sp > 0 && ch !== ' ') {
        out.push(cur.slice(0, sp));
        cur = cur.slice(sp + 1) + ch;
      } else {
        out.push(cur);
        cur = ch === ' ' ? '' : ch;
      }
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

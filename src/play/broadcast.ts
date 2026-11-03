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
    im.onload = () => {
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
      setTimeout(() => put(null), 1500);
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
    set('scroll', `×${scroll.toFixed(2)}`);
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

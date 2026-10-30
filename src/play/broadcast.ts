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

  show(course: Course, info: PlayInfo, buf: AudioBuffer | null, musicDur: number) {
    this.course = course;
    const last = Math.max(0, ...course.notes.map((n) => n.endTime ?? n.time));
    this.dur = Math.max(1, musicDur > 0 ? musicDur : last + 2);
    this.peaks = peaksOf(buf, this.dur);
    const [label, col] = COURSE[course.name] ?? [course.name, '#7b4bd0'];
    // 譜面分岐のある譜面は、達人の音符を数える
    const notes = course.notes.filter((n) => (n.type === 'don' || n.type === 'ka' || n.type === 'bigDon' || n.type === 'bigKa') && (n.br === undefined || n.br === 2)).length;
    const sub = (info.sub ?? '').replace(/^(--|\+\+)/, '').trim();
    const genre = info.genre?.trim();
    this.el.style.setProperty('--cc', col);
    this.inner.innerHTML = `
      <div class="bc-title bc-pnl"><i class="bc-bar"></i>
        <div class="bc-meta"><span class="bc-chip">${esc(label)}</span><b class="bc-lv">★${course.level}</b>${info.maker ? `<span class="bc-maker">${esc(info.maker)}</span>` : ''}</div>
        <div class="bc-name"><span>${esc(info.title)}</span></div>
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
      <div class="bc-seek"><i class="bc-seek-on"></i><i class="bc-knob"></i></div>
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
    this.knob = this.inner.querySelector('.bc-knob');
    this.shown = '';
    this.el.classList.remove('hidden');
    this.paintTimeline();
    void document.fonts?.ready.then(() => this.paintTimeline());
    requestAnimationFrame(() => this.fitTitle());
  }

  /** 曲名が長いときは、帯に収まるように縮める */
  private fitTitle() {
    const n = this.inner.querySelector<HTMLElement>('.bc-name');
    const sp = n?.firstElementChild as HTMLElement | null;
    if (!n || !sp) return;
    sp.style.fontSize = '';
    const room = n.clientWidth;
    const w = sp.scrollWidth;
    if (w > room && room > 0) sp.style.fontSize = `${Math.max(48, Math.floor(100 * (room / w)))}px`;
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
    this.onWrap.style.width = `${px}px`;
    if (this.seekOn) this.seekOn.style.width = `${px}px`;
    if (this.knob) this.knob.style.transform = `translateX(${px}px)`;
  }
}

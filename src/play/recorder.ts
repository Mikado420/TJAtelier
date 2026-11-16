/**
 * 自動録画: プレイ画面（背景の動画・ゲームの絵・動画用の画面の絵）を 1 枚の canvas に重ねて描き、
 * 曲の音・打音と一緒に MediaRecorder で mp4 にする。
 * DOM の字（動画用の画面の曲名など）は canvas ではないので映らない。
 */

/** 使える入れ物（mp4 を優先。無ければ webm） */
export function recordMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const m of ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch { /* 次 */ }
  }
  return '';
}

export class Recorder {
  private cv = document.createElement('canvas');
  private g: CanvasRenderingContext2D | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private raf = 0;
  private mime = '';

  get active() {
    return !!this.rec;
  }

  /** 録り始める。root の中の video・canvas を重ねて描く */
  start(root: HTMLElement, audio: MediaStream | null): boolean {
    this.discard();
    this.mime = recordMime();
    if (!this.mime || typeof this.cv.captureStream !== 'function') return false;
    const r = root.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 横は 1920 まで（縦横は偶数）
    const k = Math.min(dpr, 1920 / Math.max(1, r.width));
    this.cv.width = Math.max(2, Math.round((r.width * k) / 2) * 2);
    this.cv.height = Math.max(2, Math.round((r.height * k) / 2) * 2);
    this.g = this.cv.getContext('2d');
    if (!this.g) return false;
    const stream = this.cv.captureStream(60);
    for (const t of audio?.getAudioTracks() ?? []) stream.addTrack(t);
    try {
      this.rec = new MediaRecorder(stream, { mimeType: this.mime, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000 });
    } catch {
      this.rec = null;
      return false;
    }
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    const loop = () => {
      this.paint(root);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return true;
  }

  /** 1 コマ: 黒 → 動画 → 動画を暗くする幕 → canvas（ゲーム・動画用の画面） */
  private paint(root: HTMLElement) {
    const g = this.g;
    if (!g) return;
    const R = root.getBoundingClientRect();
    const kx = this.cv.width / Math.max(1, R.width);
    const ky = this.cv.height / Math.max(1, R.height);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.cv.width, this.cv.height);
    const shown = (el: HTMLElement) => {
      if (el.classList.contains('hidden')) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0;
    };
    const rect = (el: Element) => {
      const b = el.getBoundingClientRect();
      return [(b.left - R.left) * kx, (b.top - R.top) * ky, b.width * kx, b.height * ky] as const;
    };
    for (const v of root.querySelectorAll('video')) {
      if (!shown(v) || v.readyState < 2) continue;
      const [x, y, w, h] = rect(v);
      try { g.drawImage(v, x, y, w, h); } catch { /* 描けないコマ */ }
    }
    for (const d of root.querySelectorAll<HTMLElement>('.play-vdim')) {
      if (!shown(d)) continue;
      const [x, y, w, h] = rect(d);
      g.globalAlpha = +getComputedStyle(d).opacity;
      g.fillStyle = '#000';
      g.fillRect(x, y, w, h);
      g.globalAlpha = 1;
    }
    for (const c of root.querySelectorAll('canvas')) {
      if (!shown(c) || !c.width || !c.height) continue;
      const [x, y, w, h] = rect(c);
      if (w <= 0 || h <= 0) continue;
      g.drawImage(c, x, y, w, h);
    }
  }

  /** 録り終えて、できたファイルを返す */
  stop(): Promise<{ blob: Blob; ext: string } | null> {
    const rec = this.rec;
    cancelAnimationFrame(this.raf);
    this.rec = null;
    if (!rec) return Promise.resolve(null);
    return new Promise((res) => {
      rec.onstop = () => {
        const type = this.mime.split(';')[0];
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this.cv.width = this.cv.height = 0;
        res(blob.size ? { blob, ext: type === 'video/mp4' ? 'mp4' : 'webm' } : null);
      };
      try { rec.stop(); } catch { res(null); }
      for (const t of rec.stream.getVideoTracks()) t.stop();
    });
  }

  /** 録ったものを捨てる（やりなおし・途中でやめたとき） */
  discard() {
    const rec = this.rec;
    cancelAnimationFrame(this.raf);
    this.rec = null;
    this.chunks = [];
    if (!rec) return;
    rec.ondataavailable = null;
    try { rec.stop(); } catch { /* 止まっている */ }
    for (const t of rec.stream.getVideoTracks()) t.stop();
    this.cv.width = this.cv.height = 0;
  }
}

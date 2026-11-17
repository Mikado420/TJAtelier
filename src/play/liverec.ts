/**
 * 遊びながらの録画: 毎コマ、プレイ画面を録画用の canvas（1920×1080 か 1280×720）に重ねて描き、その場で H.264 にする。
 * コマは曲の時刻で 1/60 秒（30fps なら 1/30 秒）ごとにちょうど 1 枚にそろえる（遅れて飛んだコマは前のコマで埋め、
 * 1 コマの間に何度も描いたときは間引く）。音は遊び終えてから、曲の音と叩いた打音を同じ時刻で混ぜて入れる
 */
import type { AudioEngine, HitSound } from '../audio/audio';
import { Mp4Writer } from './mp4';
import { encodeAudio, pickAudio, pickVideo, type AudioPick } from './recaudio';

const toU8 = (d: AllowSharedBufferSource) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();

/** エンコーダーの待ちがこれより増えたら、端末が追いついていない（メモリが増え続けるので録画をやめる） */
const QUEUE_MAX = 40;

export class LiveRecorder {
  /** この端末で録画できるか */
  static supported() {
    return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
  }

  /** 録画を用意する（作れる形式が無ければ null） */
  static async create(res: 1080 | 720, fps: 60 | 30, sampleRate: number): Promise<LiveRecorder | null> {
    if (!LiveRecorder.supported()) return null;
    const vcfg = await pickVideo(res, fps);
    if (!vcfg) return null;
    const apick = await pickAudio(sampleRate);
    const r = new LiveRecorder(vcfg, fps, apick);
    return r.g ? r : null;
  }

  readonly W: number;
  readonly H: number;
  readonly fps: number;
  private readonly cv = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D | null;
  private readonly enc: VideoEncoder;
  private readonly mux: Mp4Writer;
  private avcC: Uint8Array | null = null;
  private avcSent: Uint8Array | null = null;
  /** 録り始めた曲の時刻（秒） */
  private t0: number | null = null;
  /** 最後に録ったコマの番号 */
  private last = -1;
  private hits: { kind: HitSound; t: number }[] = [];
  private ui: { name: string; t: number }[] = [];
  /** 録れなくなった理由（null = 録れている） */
  failed: string | null = null;
  private closed = false;
  private readonly diag: Record<string, unknown>;

  private constructor(vcfg: VideoEncoderConfig, fps: number, private readonly apick: AudioPick) {
    this.W = vcfg.width;
    this.H = vcfg.height;
    this.fps = fps;
    this.cv.width = this.W;
    this.cv.height = this.H;
    this.g = this.cv.getContext('2d', { alpha: false });
    this.diag = { app: 'TJAtelier', mode: 'live', ua: navigator.userAgent, w: this.W, h: this.H, fps, codec: vcfg.codec, bitrate: vcfg.bitrate, audioPick: apick.kind };
    this.mux = new Mp4Writer(this.W, this.H, fps, { codec: { kind: 'pcm' }, rate: apick.rate, ch: 2 });
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc) this.avcC = toU8(desc);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // 映像の設定（avcC）は、最初と変わったときだけ付ける
        let avcC: Uint8Array | undefined;
        if (this.avcC && this.avcC !== this.avcSent) {
          avcC = this.avcC;
          this.avcSent = this.avcC;
        }
        this.mux.addVideo(data, chunk.type === 'key', avcC, chunk.timestamp);
      },
      error: (e) => { this.fail(`映像: ${(e as Error)?.message ?? e}`); },
    });
    try {
      this.enc.configure({ ...vcfg, latencyMode: 'quality' });
    } catch (e) {
      this.fail(String((e as Error)?.message ?? e));
    }
  }

  /** 録れなくなった（このあとのコマは録らない） */
  fail(msg: string) {
    if (this.failed) return;
    this.failed = msg;
    this.diag.fail = msg;
  }

  get active() {
    return !this.failed && !this.closed;
  }

  /**
   * 曲の時刻 now のコマ。録るコマの時刻になっていれば paint で録画用の canvas に描いて H.264 にする
   * （飛んだコマは同じ絵で埋める）
   */
  frame(now: number, paint: (g: CanvasRenderingContext2D, W: number, H: number) => void) {
    if (!this.active || !this.g) return;
    if (this.t0 === null) this.t0 = now;
    const slot = Math.floor((now - this.t0) * this.fps + 1e-6);
    if (slot <= this.last) return;
    if (this.enc.encodeQueueSize > QUEUE_MAX) {
      this.fail('端末の処理が追いつきません');
      return;
    }
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    paint(this.g, this.W, this.H);
    const dur = 1e6 / this.fps;
    const key = this.fps * 2;
    // 同じ絵で埋めるコマは、1 枚目の絵を使い回す（絵を写さないのでメモリが増えない）
    const src = new VideoFrame(this.cv, { timestamp: Math.round((this.last + 1) * dur), duration: Math.round(dur) });
    try {
      for (let i = this.last + 1; i <= slot; i++) {
        const vf = i === this.last + 1 ? src : new VideoFrame(src, { timestamp: Math.round(i * dur), duration: Math.round(dur) });
        try {
          this.enc.encode(vf, { keyFrame: i === 0 || i % key === 0 });
        } finally {
          if (vf !== src) vf.close();
        }
      }
    } finally {
      src.close();
    }
    if (slot - this.last > 1) this.diag.filled = ((this.diag.filled as number) ?? 0) + slot - this.last - 1;
    this.last = slot;
  }

  /** 鳴らした打音（曲の時刻） */
  hit(kind: HitSound, t: number) {
    if (this.active) this.hits.push({ kind, t });
  }

  /** 鳴らした画面の音（曲の時刻） */
  sound(name: string, t: number) {
    if (this.active) this.ui.push({ name, t });
  }

  /** 録り終えて、音を入れたファイルを作る */
  async end(audio: AudioEngine): Promise<{ blob: Blob; ext: string }> {
    if (this.closed) throw new Error('closed');
    this.closed = true;
    try {
      if (this.failed) throw new Error(this.failed);
      if (this.t0 === null || this.last < 0) throw new Error('コマがありません');
      await this.enc.flush();
      if (this.failed) throw new Error(this.failed);
      const length = (this.last + 1) / this.fps;
      const t0 = this.t0;
      this.diag.frames = this.last + 1;
      const tA = performance.now();
      const mix = await audio.renderMix({
        length: length + 0.5,
        rate: this.apick.rate,
        musicAt: -t0,
        hits: this.hits.map((h) => ({ kind: h.kind, at: h.t - t0 })).filter((h) => h.at >= 0),
        ui: this.ui.map((u) => ({ name: u.name, at: u.t - t0 })).filter((u) => u.at >= 0),
      });
      this.diag.hits = this.hits.length;
      const au = await encodeAudio(mix, this.apick, length, () => false, this.diag);
      this.diag.audioMs = Math.round(performance.now() - tA);
      this.mux.setAudio(au.codec, au.rate);
      for (const c of au.chunks) this.mux.addAudio(c.data, c.frames);
      this.mux.note(JSON.stringify(this.diag));
      const blob = this.mux.finish();
      return { blob, ext: blob.type === 'video/quicktime' ? 'mov' : 'mp4' };
    } finally {
      this.release();
    }
  }

  /** 録ったものを捨てる */
  discard() {
    this.closed = true;
    this.release();
  }

  private release() {
    if (this.enc.state !== 'closed') {
      try { this.enc.close(); } catch { /* 閉じている */ }
    }
    this.cv.width = this.cv.height = 0;
    this.hits = [];
    this.ui = [];
  }
}

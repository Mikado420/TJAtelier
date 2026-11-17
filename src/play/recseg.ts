/**
 * 録画の 1 区間を描いて H.264 にする係。画面のスレッドでも、別スレッド（Worker）でも同じものを使う。
 * 区間の頭の少し前（WARM）から描き始めて、演出の途中の状態をそろえてから録る。
 * 時計（performance.now）と乱数（Math.random）はコマの番号で決めるので、どの係が描いても同じ絵になる
 */
import type { Course } from '../chart/types';
import { Game } from '../engine/game';
import { Renderer } from '../render/renderer';
import { TndeSkin, type PlateStyle } from '../render/tnde';
import type { EndKind } from '../render/endfx';
import { buildAutoEvents, type AutoEvent } from './auto';
import { BroadcastPainter, type BroadcastData, type PlayInfo } from './broadcast';
import { needFor, warmFor, type Timeline } from './recneed';
import { VideoSource } from './vsource';

export interface RecPlan {
  course: Course;
  info: PlayInfo;
  view: {
    speed: number;
    donWidth: number;
    padVisible: boolean;
    broadcast: boolean;
    vmode: '' | 'full' | 'bottom';
    plate: { title: string; name: string; profile?: PlateStyle };
  };
  fixed?: number;
  W: number;
  H: number;
  FPS: number;
  /** 0 コマ目の曲の時刻・時計 */
  t0: number;
  W0: number;
  /** 全部のコマ数と、演出を出すコマ */
  N: number;
  iFx: number;
  endKind: EndKind;
  fade: boolean;
  dim: number;
  /** 背景の動画（blob = ファイルそのもの。別スレッドは写さずに使う） */
  video: { url: string; offset: number; blob?: Blob } | null;
  bgImage: ImageBitmap | null;
  bc: BroadcastData | null;
  vcfg: VideoEncoderConfig;
  /** TNDE スキンの場所（null = ふつうの見た目） */
  skinBase: string | null;
  /** 叩くたびのコンボとゲージ（区間で使う絵・前に描く長さを決める） */
  tl: Timeline;
}

export interface SegChunk {
  data: Uint8Array;
  key: boolean;
  avcC?: Uint8Array;
}

/** 区間の頭の前に描いておく長さの上限（秒）。ふつうの見た目のときはいつもこれだけ描く */
const WARM_MAX = 4;
/** 区間の頭の直前は、毎コマ描く（連打のキャラなど、描くたびに増えるものをそろえる） */
const WARM_EVERY = 90;

const toU8 = (d: AllowSharedBufferSource) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();

/** 時計と乱数をコマに合わせて描く */
function atFrame<T>(ms: number, seed: number, fn: () => T): T {
  const rnd = Math.random;
  let h = (seed * 2654435761 + 1) >>> 0;
  Math.random = () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Object.defineProperty(performance, 'now', { value: () => ms, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    delete (performance as unknown as { now?: unknown }).now;
    Math.random = rnd;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitQueue(enc: VideoEncoder, max: number) {
  return new Promise<void>((res) => {
    const check = () => {
      if (enc.encodeQueueSize > max && enc.state === 'configured') return;
      enc.removeEventListener('dequeue', check);
      clearInterval(t);
      res();
    };
    enc.addEventListener('dequeue', check);
    const t = setInterval(check, 4);
  });
}

function waitEvent(el: EventTarget, ev: string, ms: number) {
  return new Promise<void>((res) => {
    const done = () => {
      el.removeEventListener(ev, done);
      clearTimeout(t);
      res();
    };
    const t = setTimeout(done, ms);
    el.addEventListener(ev, done);
  });
}

export class SegRenderer {
  /** 画面のスレッドでは HTMLCanvasElement（いつものプレイと同じく GPU で描ける）、別スレッドでは OffscreenCanvas */
  private cv: OffscreenCanvas | HTMLCanvasElement;
  readonly R: Renderer;
  private enc: VideoEncoder;
  private avcC: Uint8Array | null = null;
  private emit: ((c: SegChunk) => void) | null = null;
  private first = true;
  private encErr: unknown = null;
  private auto: AutoEvent[];
  private vimg: VideoFrame | null = null;
  private under: OffscreenCanvas | HTMLCanvasElement | null = null;
  private nowCur = 0;

  private constructor(
    private readonly plan: RecPlan,
    private readonly tnde: TndeSkin | null,
    private readonly vsrc: VideoSource | null,
    private readonly velem: HTMLVideoElement | null,
    private readonly painter: BroadcastPainter | null,
  ) {
    const { W, H, view } = plan;
    if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
      this.cv = document.createElement('canvas');
      this.cv.width = W;
      this.cv.height = H;
    } else this.cv = new OffscreenCanvas(W, H);
    const R = new Renderer(this.cv as unknown as HTMLCanvasElement);
    this.R = R;
    R.fixedSize = { w: W, h: H };
    R.lean = true;
    R.dprCap = 1;
    R.spectate = false;
    R.setOpponents([]);
    R.restZone = false;
    R.touch = false;
    R.padVisible = view.padVisible;
    R.speed = view.speed;
    R.donWidth = view.donWidth;
    R.broadcast = view.broadcast;
    R.plate = view.plate;
    R.tnde = tnde;
    const vmode = plan.video ? view.vmode : '';
    R.movie = !!vmode;
    R.videoMode = vmode || (plan.bgImage ? 'full' : '');
    R.resize();
    if (tnde) tnde.fixedRnd = true;
    this.auto = buildAutoEvents(plan.course.notes);
    this.enc = new VideoEncoder({
      output: (chunk, meta) => {
        const desc = meta?.decoderConfig?.description;
        if (desc) this.avcC = toU8(desc);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // 区間の最初のコマには、映像の設定（avcC）を付ける
        this.emit?.({ data, key: chunk.type === 'key', avcC: this.first && this.avcC ? this.avcC : undefined });
        this.first = false;
      },
      error: (e) => { this.encErr = e; },
    });
    this.enc.configure({ ...plan.vcfg, latencyMode: 'quality' });
    R.underlay = (g) => this.paintUnder(g);
  }

  /**
   * 作る。画面のスレッドでは、読み込んであるスキン・動画用の画面の絵・背景の動画（video 要素）を渡す。
   * 別スレッドでは、ここで読み込む
   */
  static async create(plan: RecPlan, o: { tnde?: TndeSkin | null; painter?: BroadcastPainter | null; velem?: HTMLVideoElement | null; vsrc?: VideoSource | null } = {}) {
    let tnde = o.tnde ?? null;
    // 自分で読み込むスキン（別スレッド）は、区間で使う絵だけにする
    let own = false;
    if (o.tnde === undefined && plan.skinBase) {
      tnde = await TndeSkin.load(plan.skinBase, plan.info.title, () => false);
      own = true;
    }
    let vsrc = o.vsrc ?? null;
    if (o.vsrc === undefined && plan.video && plan.view.vmode) {
      vsrc = await VideoSource.open(plan.video.blob ?? plan.video.url);
      if (!vsrc && !o.velem) throw new Error('video');
    }
    const painter = o.painter !== undefined ? o.painter : plan.bc ? BroadcastPainter.from(plan.course, plan.bc) : null;
    const seg = new SegRenderer(plan, tnde, vsrc, o.velem ?? null, painter);
    seg.ownSkin = own;
    return seg;
  }
  /** 自分で読み込んだスキン（区間ごとに使う絵をしぼる） */
  private ownSkin = false;

  private vRect() {
    const { W, H } = this.plan;
    const t = this.plan.view.vmode === 'bottom' ? this.R.layout?.bottom : null;
    const r = t ? { x: t.x, y: t.y, w: t.w, h: t.h } : { x: 0, y: 0, w: W, h: H };
    let h = r.h;
    let w = (h * 16) / 9;
    if (w > r.w) {
      w = r.w;
      h = (w * 9) / 16;
    }
    return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
  }

  private cover(g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, r: { x: number; y: number; w: number; h: number }) {
    if (!sw || !sh) return;
    const k = Math.max(r.w / sw, r.h / sh);
    const w = sw * k;
    const h = sh * k;
    g.save();
    g.beginPath();
    g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    g.drawImage(src, r.x + (r.w - w) / 2, r.y + (r.h - h) / 2, w, h);
    g.restore();
  }

  /** 後ろの絵: 黒 → 背景の動画・画像と暗くする幕 → 背景 → 動画用の画面 */
  private paintUnder(g: CanvasRenderingContext2D) {
    const { W, H, bgImage } = this.plan;
    const dimA = 1 - Math.max(0.1, Math.min(1, this.plan.dim));
    const moving = !!this.vsrc || !!this.velem;
    if (!moving && !bgImage && this.tnde?.ready && !this.R.broadcast) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
    } else if (moving) {
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const r = this.vRect();
      if (this.vimg) this.cover(g, this.vimg, this.vimg.displayWidth, this.vimg.displayHeight, r);
      else if (this.velem && this.velem.readyState >= 2) this.cover(g, this.velem, this.velem.videoWidth, this.velem.videoHeight, r);
      g.fillStyle = `rgba(0,0,0,${dimA})`;
      g.fillRect(r.x, r.y, r.w, r.h);
      const bg = this.R.background;
      if (bg?.width) g.drawImage(bg, 0, 0, W, H);
    } else {
      if (!this.under) {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        const u = c.getContext('2d')!;
        u.fillStyle = '#000';
        u.fillRect(0, 0, W, H);
        if (bgImage) {
          this.cover(u, bgImage, bgImage.width, bgImage.height, { x: 0, y: 0, w: W, h: H });
          u.fillStyle = `rgba(0,0,0,${dimA})`;
          u.fillRect(0, 0, W, H);
        }
        const bg = this.R.background;
        if (bg?.width) u.drawImage(bg, 0, 0, W, H);
        this.under = c;
      }
      g.globalCompositeOperation = 'copy';
      g.drawImage(this.under, 0, 0);
      g.globalCompositeOperation = 'source-over';
    }
    this.painter?.draw(g, this.R.frame, this.nowCur);
  }

  /** 背景の動画を、video 要素で 1 コマずつ位置を合わせる（順に読めない形式のとき） */
  private async seekElem(t: number) {
    const v = this.velem!;
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    const at = Math.max(0, Math.min(t, dur - 0.001));
    if (Math.abs(v.currentTime - at) < 0.0005) return;
    const p = waitEvent(v, 'seeked', 3000);
    v.currentTime = at;
    await p;
  }

  /** a〜b-1 コマ目を描いて、できたものを emit に渡す。onFrames = 録ったコマ数を知らせる */
  async render(a: number, b: number, emit: (c: SegChunk) => void, cancelled: () => boolean, onFrames: (n: number) => void) {
    try {
      await this.renderSeg(a, b, emit, cancelled, onFrames);
    } catch (err) {
      // 途中でやめた: エンコーダーに残ったコマは捨てる（次の区間に混ざらないように）
      this.emit = null;
      if (this.enc.state === 'configured') await this.enc.flush().catch(() => {});
      throw err;
    }
  }

  private async renderSeg(a: number, b: number, emit: (c: SegChunk) => void, cancelled: () => boolean, onFrames: (n: number) => void) {
    const { plan, R, tnde } = this;
    const { course, FPS, t0, W0, iFx } = plan;
    const wallOf = (i: number) => W0 + (i * 1000) / FPS;
    const nowOf = (i: number) => t0 + i / FPS;
    // 区間の頭の前に描く長さ: TNDE スキンは、頭をまたいで続く演出の分だけ（演出のあとの区間・ふつうの見た目は長め）
    const warm = tnde && a < iFx ? warmFor(course, plan.tl, nowOf(a)) : WARM_MAX;
    const start = Math.max(0, a - Math.ceil(warm * FPS));
    // この区間で使う絵だけ読み込む（自分で読み込んだスキンのとき）。読み込み終えるまで描き始めない
    if (tnde && this.ownSkin) await tnde.setLimit(needFor(course, plan.tl, nowOf(start), nowOf(b)));
    // 終わりの演出の絵（演出がこの区間にかかるときだけ）
    if (tnde && b > iFx - FPS) await Promise.race([tnde.loadEnd(plan.endKind), sleep(15000)]);
    this.emit = emit;
    this.first = true;
    const game = new Game(course.notes, { ...course, fixed: plan.fixed });
    game.onBranch = (i, x, y) => R.pushBranch(x, y, course.branches?.[i]?.start ?? 0);
    game.onJudge = (e) => R.pushJudge(e);
    game.onRoll = (st) => R.pushRoll(st);
    atFrame(W0 - 1, -1, () => R.reset());
    if (tnde) tnde.stageAt = W0;
    let ai = 0;
    let side: 'L' | 'R' = 'L';
    const hitTo = (now: number) => {
      while (ai < this.auto.length && this.auto[ai].t <= now) {
        const e = this.auto[ai++];
        game.update(e.t);
        if (e.note && !game.active(e.note)) continue;
        side = side === 'L' ? 'R' : 'L';
        R.pushHit(e.kind, side);
        game.hit(e.kind, e.t);
      }
    };
    // 描き始めより前: 叩いた所だけ進める（そのコマの時計で）
    while (ai < this.auto.length) {
      const e = this.auto[ai];
      let i = Math.max(0, Math.ceil((e.t - t0) * FPS - 1e-6));
      while (nowOf(i) < e.t) i++;
      while (i > 0 && nowOf(i - 1) >= e.t) i--;
      if (i >= start) break;
      atFrame(wallOf(i), i, () => hitTo(nowOf(i)));
    }
    if (start > iFx) atFrame(wallOf(iFx), iFx, () => R.showEnd(plan.endKind, plan.fade));
    if (this.vsrc && plan.video) this.vsrc.seek(Math.max(0, nowOf(a) + plan.video.offset - 0.05));
    let yieldAt = performance.now();
    let sent = 0;
    for (let i = start; i < b; i++) {
      if (cancelled()) throw new Error('cancelled');
      if (this.encErr) throw this.encErr;
      const rec = i >= a;
      const now = nowOf(i);
      // 区間の前は 2 コマに 1 回だけ描く（状態をそろえるだけ。叩くのは毎コマ）。頭の直前は毎コマ
      if (!rec && a - i > WARM_EVERY && (a - i) % 2 === 1 && i !== iFx) {
        atFrame(wallOf(i), i, () => hitTo(now));
        continue;
      }
      if (rec && plan.video) {
        if (this.vsrc) this.vimg = await this.vsrc.frameAt(now + plan.video.offset);
        else if (this.velem) await this.seekElem(now + plan.video.offset);
      }
      this.nowCur = now;
      atFrame(wallOf(i), i, () => {
        hitTo(now);
        game.update(now);
        R.draw(game, course, now, plan.info);
        if (i === iFx) R.showEnd(plan.endKind, plan.fade);
      });
      if (!rec) {
        // 前に描く間も、ときどき手を空ける（止まっていないと知らせる）
        if (performance.now() - yieldAt > 200) {
          onFrames(0);
          await sleep(0);
          yieldAt = performance.now();
        }
        continue;
      }
      // 別スレッド: 描いた絵をそのまま渡して、次のコマは新しい絵に描く（描き終わるのを待たずに次へ進める）
      const bm = 'transferToImageBitmap' in this.cv ? this.cv.transferToImageBitmap() : null;
      const vf = new VideoFrame(bm ?? this.cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      this.enc.encode(vf, { keyFrame: i === a || i % (FPS * 2) === 0 });
      vf.close();
      bm?.close();
      sent++;
      // 待っているコマは 1 つで 8MB ほど使う。別スレッドは少なめにためる
      if (this.enc.encodeQueueSize > (bm ? 2 : 6)) await waitQueue(this.enc, bm ? 1 : 3);
      if (performance.now() - yieldAt > 40) {
        onFrames(sent);
        sent = 0;
        await sleep(0);
        yieldAt = performance.now();
      }
    }
    await this.enc.flush();
    if (this.encErr) throw this.encErr;
    onFrames(sent);
    this.emit = null;
  }

  close() {
    if (this.enc.state !== 'closed') this.enc.close();
    this.vsrc?.close();
    if (this.tnde) this.tnde.fixedRnd = false;
    this.R.dispose();
    this.under = null;
    this.cv.width = this.cv.height = 0;
  }
}

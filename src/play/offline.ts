/**
 * 譜面の録画: プレイ画面を見ずに、オートで遊んだときの画面と音を .mp4 にする。
 * 時計（performance.now）をコマごとの時刻に置き換えて 1 コマずつ描き、WebCodecs で H.264 にする。
 * 音は OfflineAudioContext で、プレイと同じ音量・リミッターで混ぜてから AAC（できなければ Opus・PCM）にする
 */
import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { CLEAR_LINE, Game } from '../engine/game';
import { Renderer } from '../render/renderer';
import type { PlateStyle, TndeSkin } from '../render/tnde';
import { buildAutoEvents } from './auto';
import { BroadcastPainter, type PlayInfo } from './broadcast';
import { Mp4Writer, aacConfig, type AudioCodec } from './mp4';
import { VideoSource } from './vsource';

export interface OfflineJob {
  course: Course;
  info: PlayInfo;
  audio: AudioEngine;
  view: {
    speed: number;
    donWidth: number;
    padVisible: boolean;
    broadcast: boolean;
    /** 背景の動画の出し方（'' = 出さない） */
    vmode: '' | 'full' | 'bottom';
    tnde: TndeSkin | null;
    plate: { title: string; name: string; profile?: PlateStyle };
  };
  /** 譜面分岐を固定（0 普通・1 玄人・2 達人） */
  fixed?: number;
  hitOn: boolean;
  /** クリアなどの演出を出す時刻（最後の音符の時刻から） */
  fxAt: (lastTime: number) => number;
  video: { url: string; offset: number } | null;
  bgImage: string | null;
  /** 背景の動画・画像の明るさ（0.1〜1） */
  dim: number;
  onProgress: (p: number) => void;
  cancelled: () => boolean;
}

export class RecordCancelled extends Error {}

const FPS = 60;

/** この端末で録画できるか（映像の H.264 を作れるか） */
export function canRecord() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
}

/** 映像の設定（1080p60 → だめなら 720p60） */
async function pickVideo(): Promise<VideoEncoderConfig | null> {
  const tries: [number, number, string[], number][] = [
    [1920, 1080, ['avc1.42002A', 'avc1.4D002A', 'avc1.64002A', 'avc1.640028'], 8_000_000],
    [1280, 720, ['avc1.420020', 'avc1.4D0020', 'avc1.640020'], 5_000_000],
  ];
  for (const [width, height, codecs, bitrate] of tries) {
    for (const codec of codecs) {
      const c: VideoEncoderConfig = { codec, width, height, bitrate, framerate: FPS, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
      } catch { /* 次 */ }
    }
  }
  return null;
}

/** 音の形式（AAC → Opus → PCM） */
async function pickAudio(rate: number): Promise<{ kind: AudioCodec['kind']; rate: number; config?: AudioEncoderConfig }> {
  if (typeof AudioEncoder !== 'undefined') {
    for (const r of [...new Set([rate, 48000, 44100])]) {
      const c: AudioEncoderConfig = { codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 2, bitrate: 192_000 };
      try {
        if ((await AudioEncoder.isConfigSupported(c)).supported) return { kind: 'aac', rate: r, config: c };
      } catch { /* 次 */ }
    }
    // iPhone・Mac は .mp4 の Opus を写真に保存できないことがあるので、AAC が無ければ PCM（.mov）に
    if (/iPhone|iPad|Macintosh/.test(navigator.userAgent)) return { kind: 'pcm', rate };
    const c: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };
    try {
      if ((await AudioEncoder.isConfigSupported(c)).supported) return { kind: 'opus', rate: 48000, config: c };
    } catch { /* 次 */ }
  }
  return { kind: 'pcm', rate };
}

const toU8 = (d: AllowSharedBufferSource) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();

/** 録画用の描き手（画面の外に置いた 1920×1080 の canvas）。使い回す */
let stage: { box: HTMLDivElement; cv: HTMLCanvasElement; R: Renderer } | null = null;
function getStage(W: number, H: number) {
  if (!stage) {
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', left: '-30000px', top: '0', overflow: 'hidden', pointerEvents: 'none', visibility: 'hidden' });
    box.setAttribute('aria-hidden', 'true');
    const cv = document.createElement('canvas');
    Object.assign(cv.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%' });
    box.append(cv);
    document.body.append(box);
    const R = new Renderer(cv);
    stage = { box, cv, R };
  }
  stage.box.style.width = `${W}px`;
  stage.box.style.height = `${H}px`;
  return stage;
}
/** 描き終えたら canvas のメモリを手放す */
function releaseStage() {
  if (!stage) return;
  // 枠の大きさは変えない（変えると描き直しが走って、また大きな canvas を作ってしまう）
  stage.R.tnde?.dropCaches();
  stage.R.tnde = null;
  for (const c of stage.box.querySelectorAll('canvas')) c.width = c.height = 0;
}

/** performance.now をコマの時刻にする（描く間だけ） */
function withClock<T>(ms: number, fn: () => T): T {
  Object.defineProperty(performance, 'now', { value: () => ms, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    delete (performance as unknown as { now?: unknown }).now;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** エンコーダーの待ちが max 以下になるまで待つ */
function drained(enc: VideoEncoder | AudioEncoder, max: number) {
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

/** 背景の動画を 1 コマずつ取り出す（位置を合わせて待つ） */
async function openVideo(url: string) {
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.preload = 'auto';
  v.src = url;
  await waitEvent(v, 'loadeddata', 10000);
  if (v.readyState < 2) {
    // iPhone は一度流さないとコマを読み込まないことがある
    await v.play().catch(() => {});
    v.pause();
    await waitEvent(v, 'loadeddata', 3000);
  }
  return v.readyState >= 2 ? v : null;
}
async function seekVideo(v: HTMLVideoElement, t: number) {
  const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
  const at = Math.max(0, Math.min(t, dur - 0.001));
  if (Math.abs(v.currentTime - at) < 0.0005) return;
  const p = waitEvent(v, 'seeked', 3000);
  v.currentTime = at;
  await p;
}

export async function renderChartVideo(job: OfflineJob): Promise<{ blob: Blob; ext: string; audio: AudioCodec['kind'] }> {
  const { course, info, audio } = job;
  const vcfg = await pickVideo();
  if (!vcfg) throw new Error('この端末では録画できません');
  const W = vcfg.width;
  const H = vcfg.height;
  const acfg = await pickAudio(audio.ctx.sampleRate);

  // オートで最後まで叩いたときの結果（演出の絵を前もって読み込むため）
  // 打音もここで決めておく（音は映像と並べて先に作る）
  const allAuto = buildAutoEvents(course.notes);
  const sim = new Game(course.notes, { ...course, fixed: job.fixed });
  const hitAt: { kind: 'don' | 'ka' | 'balloon'; t: number }[] = [];
  for (const e of allAuto) {
    sim.update(e.t);
    if (e.note && !sim.active(e.note)) continue;
    sim.hit(e.kind, e.t);
    if (job.hitOn) {
      hitAt.push({ kind: e.kind, t: e.t });
      if (e.pop) hitAt.push({ kind: 'balloon', t: e.t });
    }
  }
  sim.update(1e9);
  const kindOf = (g: Game) => {
    const st = g.stats;
    const fc = st.bad === 0 && g.totalHitNotes > 0;
    return fc && st.ok === 0 ? 'allgood' : fc ? 'fc' : st.gauge >= CLEAR_LINE ? 'clear' : 'fail';
  };
  const tnde = job.view.tnde;
  // 終わりの演出の絵は、描いている間に読み込む（演出の少し前に待つ）
  let endP: Promise<unknown> | null = null;
  if (tnde) {
    await tnde.prepare(info.title);
    endP = Promise.race([tnde.loadEnd(kindOf(sim)), sleep(15000)]);
  }

  const S = getStage(W, H);
  const R = S.R;
  let painter: BroadcastPainter | null = null;
  let video: HTMLVideoElement | null = null;
  let vsrc: VideoSource | null = null;
  let vimg: VideoFrame | null = null;
  let bgImg: HTMLImageElement | null = null;
  const ve = new VideoEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      const desc = meta?.decoderConfig?.description;
      mux.addVideo(d, chunk.type === 'key', desc ? toU8(desc) : undefined);
    },
    error: (e) => { encErr = e; },
  });
  let encErr: unknown = null;
  const codec: AudioCodec = acfg.kind === 'aac' ? { kind: 'aac', asc: aacConfig(acfg.rate, 2) } : acfg.kind === 'opus' ? { kind: 'opus', preSkip: 312 } : { kind: 'pcm' };
  let mux = new Mp4Writer(W, H, FPS, { codec, rate: acfg.rate, ch: 2 });
  try {
    ve.configure({ ...vcfg, latencyMode: 'quality' });
    // 描き方はプレイ画面と同じに
    R.dprCap = 1;
    R.spectate = false;
    R.setOpponents([]);
    R.restZone = false;
    R.touch = false;
    R.padVisible = job.view.padVisible;
    R.speed = job.view.speed;
    R.donWidth = job.view.donWidth;
    R.broadcast = job.view.broadcast;
    R.plate = job.view.plate;
    R.tnde = tnde;
    const vmode = job.video ? job.view.vmode : '';
    const img = !vmode && !!job.bgImage;
    R.movie = !!vmode;
    R.videoMode = vmode || (img ? 'full' : '');
    R.resize();
    // 背景の動画: 頭から順にデコードする（できない形式は video 要素で 1 コマずつ位置を合わせる）
    if (vmode && job.video) {
      vsrc = await VideoSource.open(job.video.url);
      if (!vsrc) video = await openVideo(job.video.url);
    }
    if (img && job.bgImage) {
      bgImg = new Image();
      bgImg.src = job.bgImage;
      await bgImg.decode().catch(() => {});
    }
    if (R.broadcast) {
      painter = new BroadcastPainter();
      await painter.prepare(course, info, audio.buffer, audio.musicDuration, !!vmode || img, R.frame.s);
    }


    // プレイと同じ時刻の決め方
    const first = (course.notes[0]?.time ?? 0) - 1;
    const from = Math.min(0, first);
    const t0 = from - 2;
    const real = course.notes.filter((n) => !n.dummy);
    const lastTime = Math.max(from, ...real.map((n) => n.endTime ?? n.time));
    const music = audio.musicDuration;
    const tailEnd = Math.max(0, ...course.notes.filter((n) => n.dummy).map((n) => n.endTime ?? n.time));
    const endAt = Math.max(music > 0 ? Math.max(music + 1, lastTime + 1.5) : lastTime + 2, tailEnd + 1.5);
    const fxAt = job.fxAt(lastTime);
    const guess = Math.max(endAt, fxAt + (tnde ? 8.9 : 3.1), tailEnd + 1) - t0;

    const game = new Game(course.notes, { ...course, fixed: job.fixed });
    game.onBranch = (i, a, b) => R.pushBranch(a, b, course.branches?.[i]?.start ?? 0);
    game.onJudge = (e) => R.pushJudge(e);
    game.onRoll = (st) => R.pushRoll(st);
    const W0 = 1_000_000;
    withClock(W0 - 1, () => R.reset());

    // 音: 映像を描いている間に、別の所で混ぜて AAC にしておく
    const hits = hitAt.map((h) => ({ kind: h.kind, at: h.t - t0 }));
    const ui: { name: string; at: number }[] = [];
    let iFx = 0;
    while (!(t0 + iFx / FPS > fxAt)) iFx++;
    const endKind = kindOf(sim);
    if (R.skinEnd(endKind)) ui.push({ name: `tnde:${endKind}`, at: iFx / FPS });
    const mixLen = guess + 2;
    const audP = audio.renderMix({ length: mixLen, rate: acfg.rate, musicAt: -t0, hits, ui }).then((mix) => encodeAudio(mix, acfg, mux, job));
    audP.catch(() => {});
    let ai = 0;
    let side: 'L' | 'R' = 'L';
    let endWall = 0;
    let endHold = 3000;
    const dimA = 1 - Math.max(0.1, Math.min(1, job.dim));
    // 背景の動画の置き場所（プレイ画面と同じく 16:9 の枠）
    const vRect = () => {
      const t = vmode === 'bottom' ? R.layout?.bottom : null;
      let r = t ? { x: t.x, y: t.y, w: t.w, h: t.h } : { x: 0, y: 0, w: W, h: H };
      let h = r.h;
      let w = (h * 16) / 9;
      if (w > r.w) {
        w = r.w;
        h = (w * 9) / 16;
      }
      r = { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
      return r;
    };
    const cover = (g: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, r: { x: number; y: number; w: number; h: number }) => {
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
    };
    // 後ろの絵（黒 → 背景の動画・画像と暗くする幕 → 背景 → 動画用の画面）は、ゲームの canvas に毎コマ先に描く。
    // 重ね直す canvas を作らずに、ゲームの canvas をそのまま動画のコマにする
    let nowCur = t0;
    const moving = !!video || !!vsrc;
    const black = !moving && !bgImg && !!tnde && !R.broadcast;
    let under: HTMLCanvasElement | null = null;
    const makeUnder = () => {
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d', { alpha: false })!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      if (bgImg?.naturalWidth) {
        cover(g, bgImg, bgImg.naturalWidth, bgImg.naturalHeight, { x: 0, y: 0, w: W, h: H });
        g.fillStyle = `rgba(0,0,0,${dimA})`;
        g.fillRect(0, 0, W, H);
      }
      const bg = R.background;
      if (bg?.width) g.drawImage(bg, 0, 0, W, H);
      return c;
    };
    R.underlay = (g) => {
      if (black) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
      } else if (moving) {
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        const r = vRect();
        if (vimg) cover(g, vimg, vimg.displayWidth, vimg.displayHeight, r);
        else if (video) cover(g, video, video.videoWidth, video.videoHeight, r);
        g.fillStyle = `rgba(0,0,0,${dimA})`;
        g.fillRect(r.x, r.y, r.w, r.h);
        const bg = R.background;
        if (bg?.width) g.drawImage(bg, 0, 0, W, H);
      } else {
        under ??= makeUnder();
        g.globalCompositeOperation = 'copy';
        g.drawImage(under, 0, 0);
        g.globalCompositeOperation = 'source-over';
      }
      painter?.draw(g, R.frame, nowCur);
    };
    let yieldAt = performance.now();

    for (let i = 0; ; i++) {
      if (job.cancelled()) throw new RecordCancelled();
      if (encErr) throw encErr;
      const now = t0 + i / FPS;
      const wall = W0 + (i * 1000) / FPS;
      // 背景の動画（位置を合わせてから）
      if (vsrc && job.video) vimg = await vsrc.frameAt(now + job.video.offset);
      else if (video && job.video) await seekVideo(video, now + job.video.offset);
      if (endP && i + FPS >= iFx) {
        await endP;
        endP = null;
      }
      nowCur = now;
      const done = withClock(wall, () => {
        // オート: 時刻になった打撃を判定に渡す
        while (ai < allAuto.length && allAuto[ai].t <= now) {
          const e = allAuto[ai++];
          game.update(e.t);
          if (e.note && !game.active(e.note)) continue;
          side = side === 'L' ? 'R' : 'L';
          R.pushHit(e.kind, side);
          game.hit(e.kind, e.t);
        }
        game.update(now);
        R.draw(game, course, now, info);
        if (!endWall && now > fxAt) {
          endWall = wall;
          const kind = kindOf(game);
          endHold = R.showEnd(kind, tailEnd > 0);
        }
        return endWall ? wall - endWall > endHold && now > tailEnd + 1 : now > endAt && now > fxAt;
      });
      const vf = new VideoFrame(S.cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      ve.encode(vf, { keyFrame: i % (FPS * 2) === 0 });
      vf.close();
      // エンコーダーが詰まったら少し待つ。進み具合の画面は 0.1 秒ごとに描き直す
      if (ve.encodeQueueSize > 8) await drained(ve, 4);
      if (performance.now() - yieldAt > 100) {
        job.onProgress(Math.min(0.98, i / FPS / guess));
        await sleep(0);
        yieldAt = performance.now();
      }
      if (done) break;
    }
    await ve.flush();
    if (encErr) throw encErr;
    const frames = mux.videoFrames;
    const length = frames / FPS;

    // 音（映像より長く作ったぶんは切る）
    await audP;
    mux.trimAudio(length);
    job.onProgress(1);
    const blob = mux.finish();
    mux = null as unknown as Mp4Writer;
    return { blob, ext: blob.type === 'video/quicktime' ? 'mov' : 'mp4', audio: acfg.kind };
  } finally {
    R.underlay = null;
    if (ve.state !== 'closed') ve.close();
    painter?.dispose();
    vsrc?.close();
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    releaseStage();
  }
}

/** 混ぜた音を形式に合わせて入れる */
async function encodeAudio(mix: AudioBuffer, a: { kind: AudioCodec['kind']; rate: number; config?: AudioEncoderConfig }, mux: Mp4Writer, job: OfflineJob) {
  const L = mix.getChannelData(0);
  const Rc = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
  const n = mix.length;
  if (a.kind === 'pcm') {
    const BLK = 4800;
    for (let o = 0; o < n; o += BLK) {
      const m = Math.min(BLK, n - o);
      const b = new DataView(new ArrayBuffer(m * 4));
      for (let k = 0; k < m; k++) {
        b.setInt16(k * 4, Math.max(-32768, Math.min(32767, Math.round(L[o + k] * 32767))), true);
        b.setInt16(k * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(Rc[o + k] * 32767))), true);
      }
      mux.addAudio(new Uint8Array(b.buffer), m);
    }
    return;
  }
  let err: unknown = null;
  const def = a.kind === 'aac' ? 1024 : 960;
  const ae = new AudioEncoder({
    output: (chunk, meta) => {
      const desc = meta?.decoderConfig?.description;
      if (desc) mux.setAudioDescription(toU8(desc));
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      const frames = chunk.duration ? Math.round((chunk.duration * a.rate) / 1e6) : def;
      mux.addAudio(d, frames || def);
    },
    error: (e) => { err = e; },
  });
  try {
    ae.configure(a.config!);
    const BLK = 4096;
    for (let o = 0; o < n; o += BLK) {
      if (err) throw err;
      if (job.cancelled()) throw new RecordCancelled();
      const m = Math.min(BLK, n - o);
      const data = new Float32Array(m * 2);
      data.set(L.subarray(o, o + m), 0);
      data.set(Rc.subarray(o, o + m), m);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: a.rate, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((o / a.rate) * 1e6), data });
      ae.encode(ad);
      ad.close();
      if (ae.encodeQueueSize > 16) await drained(ae, 8);
    }
    await ae.flush();
    if (err) throw err;
  } finally {
    if (ae.state !== 'closed') ae.close();
  }
}

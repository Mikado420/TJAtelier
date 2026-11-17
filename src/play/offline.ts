/**
 * 譜面の録画: プレイ画面を見ずに、オートで遊んだときの画面と音を .mp4 にする。
 * 時計（performance.now）をコマごとの時刻に置き換えて 1 コマずつ描き、WebCodecs で H.264 にする。
 * 曲をいくつかの区間に分け、画面のスレッドと別スレッド（Worker）で同時に描いて、順につなぐ。
 * 音は OfflineAudioContext で、プレイと同じ音量・リミッターで混ぜてから AAC（できなければ Opus・PCM）にする
 */
import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { CLEAR_LINE, Game } from '../engine/game';
import type { EndKind } from '../render/endfx';
import type { PlateStyle, TndeSkin } from '../render/tnde';
import { buildAutoEvents } from './auto';
import { BroadcastPainter, type PlayInfo } from './broadcast';
import { Mp4Writer, aacConfig, type AudioCodec } from './mp4';
import { SegRenderer, type RecPlan, type SegChunk } from './recseg';
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
    /** TNDE スキンの場所（別スレッドで読み込む） */
    skinBase: string;
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
  /** 別スレッドで読み込む字（名前・場所） */
  fonts: [string, string][];
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const toU8 = (d: AllowSharedBufferSource) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();

/** エンコーダーの待ちが max 以下になるまで待つ */
function drained(enc: AudioEncoder, max: number) {
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

/** 背景の動画を video 要素で開く（順に読めない形式のとき。1 コマずつ位置を合わせる） */
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

/** 別スレッドの数（iPhone はメモリが少ないので 2 つまで） */
function workerCount() {
  const forced = (globalThis as { __recWorkers?: number }).__recWorkers;
  if (forced !== undefined) return forced;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return 0;
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent))) return 2;
  return Math.max(0, Math.min(3, (navigator.hardwareConcurrency || 4) - 2));
}

/** 別スレッドの係 */
interface Helper {
  w: Worker;
  ready: Promise<boolean>;
  busy: boolean;
  dead: boolean;
  /** 描いている区間（-1 = なし） */
  cur: number;
  /** 区間を渡した時刻と、その区間で録り終えたコマ数（遅い係を見分ける） */
  since: number;
  got: number;
}

export async function renderChartVideo(job: OfflineJob): Promise<{ blob: Blob; ext: string; audio: AudioCodec['kind'] }> {
  const { course, info, audio } = job;
  const vcfg = await pickVideo();
  if (!vcfg) throw new Error('この端末では録画できません');
  const W = vcfg.width;
  const H = vcfg.height;
  const acfg = await pickAudio(audio.ctx.sampleRate);

  // オートで最後まで叩いたときの結果と打音（音は映像と並べて先に作る）
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
  const st = sim.stats;
  const fc = st.bad === 0 && sim.totalHitNotes > 0;
  const endKind: EndKind = fc && st.ok === 0 ? 'allgood' : fc ? 'fc' : st.gauge >= CLEAR_LINE ? 'clear' : 'fail';
  const tnde = job.view.tnde;
  if (tnde) await tnde.prepare(info.title);

  // プレイと同じ時刻の決め方
  const first = (course.notes[0]?.time ?? 0) - 1;
  const from = Math.min(0, first);
  const t0 = from - 2;
  const real = course.notes.filter((n) => !n.dummy);
  const lastTime = Math.max(from, ...real.map((n) => n.endTime ?? n.time));
  const tailEnd = Math.max(0, ...course.notes.filter((n) => n.dummy).map((n) => n.endTime ?? n.time));
  const fxAt = job.fxAt(lastTime);
  let iFx = 0;
  while (!(t0 + iFx / FPS > fxAt)) iFx++;

  const vmode = job.video ? job.view.vmode : '';
  const img = !vmode && !!job.bgImage;
  let velem: HTMLVideoElement | null = null;
  let vsrc: VideoSource | null = null;
  let painter: BroadcastPainter | null = null;
  let bgBitmap: ImageBitmap | null = null;
  const helpers: Helper[] = [];
  let main: SegRenderer | null = null;
  let cancel = false;
  try {
    if (vmode && job.video) {
      vsrc = await VideoSource.open(job.video.url);
      if (!vsrc) velem = await openVideo(job.video.url);
    }
    if (img && job.bgImage) {
      const im = new Image();
      im.src = job.bgImage;
      await im.decode().catch(() => {});
      if (im.naturalWidth) bgBitmap = await createImageBitmap(im);
    }
    if (job.view.broadcast) {
      painter = new BroadcastPainter();
      // 動画用の画面の枠の大きさ（1920×1080 のとき）
      const s = Math.min(W / 2000, H / 1125);
      await painter.prepare(course, info, audio.buffer, audio.musicDuration, !!vmode || img, s);
    }
    const plan: RecPlan = {
      course,
      info,
      view: { speed: job.view.speed, donWidth: job.view.donWidth, padVisible: job.view.padVisible, broadcast: job.view.broadcast, vmode, plate: job.view.plate },
      fixed: job.fixed,
      W,
      H,
      FPS,
      t0,
      W0: 1_000_000,
      N: 0,
      iFx,
      endKind,
      fade: tailEnd > 0,
      dim: job.dim,
      video: vmode && job.video ? job.video : null,
      bgImage: bgBitmap,
      bc: null,
      vcfg,
      skinBase: tnde ? job.view.skinBase : null,
    };
    main = await SegRenderer.create(plan, { tnde, painter, velem, vsrc: velem ? null : vsrc });
    vsrc = null; // main が持つ
    // 全部のコマ数: 演出を見せ終える所まで（プレイと同じ決め方）
    const hold = main.R.endHoldFor(endKind);
    let N = iFx;
    while (!((N - iFx) * 1000 / FPS > hold && t0 + N / FPS > tailEnd + 1)) N++;
    N += 1;
    plan.N = N;
    const length = N / FPS;

    // 音: 映像を描いている間に、別の所で混ぜて AAC にしておく
    const codec: AudioCodec = acfg.kind === 'aac' ? { kind: 'aac', asc: aacConfig(acfg.rate, 2) } : acfg.kind === 'opus' ? { kind: 'opus', preSkip: 312 } : { kind: 'pcm' };
    const mux = new Mp4Writer(W, H, FPS, { codec, rate: acfg.rate, ch: 2 });
    const hits = hitAt.map((h) => ({ kind: h.kind, at: h.t - t0 }));
    const ui = main.R.skinEnd(endKind) ? [{ name: `tnde:${endKind}`, at: iFx / FPS }] : [];
    const audP = audio.renderMix({ length: length + 0.5, rate: acfg.rate, musicAt: -t0, hits, ui }).then((mix) => encodeAudio(mix, acfg, mux, job));
    audP.catch(() => {});

    // 区間に分ける（係の数の 2〜3 倍。短すぎると前に描くぶんが無駄になる）
    const nw = velem ? 0 : workerCount();
    const segLen = (globalThis as { __recSegLen?: number }).__recSegLen ?? Math.max(900, Math.ceil(N / ((nw + 1) * 2.5)));
    const segs: [number, number][] = [];
    for (let a = 0; a < N; a += segLen) segs.push([a, Math.min(N, a + segLen)]);
    const queue = segs.map((_, k) => k);
    /** 区間ごと・描いた係ごとの結果（同じ区間を 2 つの係が描くことがある。先に終わったほうを使う） */
    const results = new Map<string, SegChunk[]>();
    const finals = new Map<number, SegChunk[]>();
    /** 区間を描いている係の数 */
    const running = new Map<number, number>();
    let committed = 0;
    const commit = () => {
      while (finals.has(committed)) {
        for (const c of finals.get(committed)!) mux.addVideo(c.data, c.key, c.avcC);
        finals.delete(committed);
        committed++;
      }
    };
    const begin = (k: number, who: string) => {
      results.set(`${k}:${who}`, []);
      running.set(k, (running.get(k) ?? 0) + 1);
    };
    const end = (k: number, who: string, ok: boolean) => {
      const r = results.get(`${k}:${who}`);
      results.delete(`${k}:${who}`);
      running.set(k, (running.get(k) ?? 1) - 1);
      if (ok && r && !finals.has(k) && k >= committed) {
        if ((globalThis as { __recDebug?: boolean }).__recDebug) console.warn(`rec seg ${k} by ${who}`);
        finals.set(k, r);
        commit();
        // 同じ区間を描いているほかの係はやめさせる
        for (const h of helpers) if (h.cur === k && !h.dead) h.w.postMessage({ type: 'skip', k });
      }
    };
    const isDone = (k: number) => k < committed || finals.has(k);
    let frames = 0;
    const progress = () => job.onProgress(Math.min(0.99, frames / N));
    let wakeMain: (() => void) | null = null;
    const kick = () => { wakeMain?.(); };
    /** 次に描く区間（終わっていないもの） */
    const take = () => {
      while (queue.length) {
        const k = queue.shift()!;
        if (!isDone(k) && !running.get(k)) return k;
      }
      return -1;
    };

    // 別スレッドの係を用意する（用意できるまでの間も、画面のスレッドは描き始める）
    if (nw > 0 && segs.length > 1) {
      const wplan: RecPlan = { ...plan, bc: painter ? await painter.export() : null };
      for (let n = 0; n < nw; n++) {
        let w: Worker;
        try {
          w = new Worker(new URL('./recworker.ts', import.meta.url), { type: 'module' });
        } catch {
          break;
        }
        const who = `w${n}`;
        const h: Helper = { w, ready: Promise.resolve(false), busy: false, dead: false, cur: -1, since: 0, got: 0 };
        const next = () => {
          if (h.dead || cancel) return;
          const k = take();
          if (k < 0) return;
          begin(k, who);
          h.busy = true;
          h.cur = k;
          h.since = performance.now();
          h.got = 0;
          w.postMessage({ type: 'seg', k, a: segs[k][0], b: segs[k][1] });
        };
        const drop = () => {
          h.dead = true;
          h.busy = false;
          if (h.cur >= 0) {
            const k = h.cur;
            h.cur = -1;
            end(k, who, false);
            if (!isDone(k)) queue.unshift(k);
          }
          w.terminate();
          kick();
        };
        h.ready = new Promise<boolean>((res) => {
          w.onmessage = (e) => {
            const m = e.data;
            if ((globalThis as { __recDebug?: boolean }).__recDebug && m.type !== 'chunk' && m.type !== 'frames') console.warn(`rec ${who}`, m.type, m.k ?? '', m.msg ?? '');
            if (m.type === 'ready') res(true);
            else if (m.type === 'fail') {
              res(false);
              drop();
            } else if (m.type === 'chunk') {
              results.get(`${m.k}:${who}`)?.push({ data: m.data, key: m.key, avcC: m.avcC });
            } else if (m.type === 'frames') {
              frames += m.n;
              h.got += m.n;
              progress();
            } else if (m.type === 'done' || m.type === 'skipped') {
              h.busy = false;
              h.cur = -1;
              end(m.k, who, m.type === 'done');
              next();
              kick();
            } else if (m.type === 'segfail') drop();
          };
          w.onerror = () => {
            res(false);
            drop();
          };
        });
        w.postMessage({ type: 'init', plan: wplan, fonts: job.fonts });
        void h.ready.then((ok) => { if (ok) next(); });
        helpers.push(h);
      }
    }

    // 画面のスレッドも区間を描く。全部そろうまで
    /** 画面のスレッドの速さ（1 ミリ秒に何コマ） */
    let mainRate = 0;
    const drawHere = async (k: number) => {
      begin(k, 'main');
      const [a, b] = segs[k];
      const t = performance.now();
      try {
        await main!.render(a, b, (c) => results.get(`${k}:main`)?.push(c), () => job.cancelled() || isDone(k), (n) => {
          frames += n;
          progress();
        });
        end(k, 'main', true);
        mainRate = (b - a) / Math.max(1, performance.now() - t);
      } catch (err) {
        end(k, 'main', false);
        if (job.cancelled()) throw new RecordCancelled();
        // 別の係が先に描き終えたので、やめた
        if (!isDone(k)) throw err;
      }
    };
    for (;;) {
      if (job.cancelled()) {
        cancel = true;
        throw new RecordCancelled();
      }
      if (committed >= segs.length) break;
      const k = take();
      if (k >= 0) {
        await drawHere(k);
        continue;
      }
      // 残りは別スレッドの係が描いている。係がいなくなった区間はここで描く
      const alive = helpers.some((h) => !h.dead && h.busy);
      if (!alive) {
        for (let j = committed; j < segs.length; j++) if (!isDone(j) && !running.get(j)) queue.push(j);
        if (!queue.length) await sleep(20);
        continue;
      }
      // 係がとても遅いときは、その区間をここでも描く（先に終わったほうを使う）。
      // ここで描き直したほうが、係の残りより十分早く終わりそうなときだけ
      let spec = -1;
      if (mainRate > 0) {
        const tNow = performance.now();
        for (const h of helpers) {
          if (h.dead || !h.busy || h.cur < 0 || isDone(h.cur) || (running.get(h.cur) ?? 0) > 1) continue;
          const len = segs[h.cur][1] - segs[h.cur][0];
          const mine = len / mainRate;
          const spent = tNow - h.since;
          const left = h.got > 0 ? ((len - h.got) * spent) / h.got : Infinity;
          if (left > mine * 1.5 && spent > mine * 0.5 && (spec < 0 || h.cur < spec)) spec = h.cur;
        }
      }
      if (spec >= 0) {
        await drawHere(spec);
        continue;
      }
      await new Promise<void>((r) => {
        wakeMain = r;
        setTimeout(r, 200);
      });
      wakeMain = null;
    }
    for (const h of helpers) {
      h.w.postMessage({ type: 'stop' });
      h.w.terminate();
    }
    helpers.length = 0;

    // 音（映像より長く作ったぶんは切る）
    await audP;
    mux.trimAudio(length);
    job.onProgress(1);
    const blob = mux.finish();
    return { blob, ext: blob.type === 'video/quicktime' ? 'mov' : 'mp4', audio: acfg.kind };
  } finally {
    cancel = true;
    for (const h of helpers) h.w.terminate();
    main?.close();
    vsrc?.close();
    painter?.dispose();
    bgBitmap?.close();
    if (velem) {
      velem.removeAttribute('src');
      velem.load();
    }
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

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
import { Renderer } from '../render/renderer';
import { BroadcastPainter, type PlayInfo } from './broadcast';
import { Mp4Writer, aacConfig, type AudioCodec } from './mp4';
import { buildTimeline } from './recneed';
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
  /** 画質（縦の大きさ）と 1 秒のコマ数 */
  res?: 1080 | 720;
  fps?: 60 | 30;
  onProgress: (p: number) => void;
  cancelled: () => boolean;
}

export class RecordCancelled extends Error {}


/** この端末で録画できるか（映像の H.264 を作れるか） */
export function canRecord() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof OfflineAudioContext !== 'undefined';
}

/**
 * 映像の設定。同じ見た目でファイルが小さくなる High プロファイルを先に試す（だめなら Main・Baseline。Baseline は少し多めに使う）。
 * 1080p が作れない端末は 720p にする
 */
async function pickVideo(res: 1080 | 720, fps: number): Promise<VideoEncoderConfig | null> {
  const sizes: [number, number][] = res === 1080 ? [[1920, 1080], [1280, 720]] : [[1280, 720]];
  for (const [width, height] of sizes) {
    const big = height === 1080;
    // 1 秒あたりのビット数（High・Main のとき）
    const rate = (big ? (fps > 30 ? 6_500_000 : 4_500_000) : fps > 30 ? 3_500_000 : 2_500_000);
    const lv = big ? (fps > 30 ? '2A' : '28') : fps > 30 ? '20' : '1F';
    const tries: [string, number][] = [[`avc1.6400${lv}`, rate], [`avc1.4D00${lv}`, rate], [`avc1.4200${lv}`, Math.round(rate * 1.25)]];
    for (const [codec, bitrate] of tries) {
      const c: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
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
      const c = { codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 2, bitrate: 192_000, aac: { format: 'aac' } } as AudioEncoderConfig;
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

/**
 * 別スレッドの数を、端末に合わせて決めるための記録（この端末の中だけ）。
 * - 無事に録り終えたら、次は 1 つ増やしてみる（上限まで）
 * - 別スレッドで描いている間にアプリごと落ちたら（次に起動したとき、描いている印が残っている）、1 つ減らして、それより増やさない
 * - 画面のスレッドと別スレッドの速さも残しておき、画面のスレッドに描かせるかを決める
 */
interface Tune {
  next: number;
  max: number;
  /** 描いている間の印（落ちたら残る） */
  running?: number;
  /** 前に落ちたか */
  crashed?: boolean;
  /** 1 秒に描けたコマ数（画面のスレッド・別スレッド 1 つ） */
  mainFps?: number;
  workerFps?: number;
}
const TUNE_KEY = 'tjatelier:recTune';
const isApple = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
/** 別スレッドの上限（iPhone・iPad は 3 つ、ほかは CPU の数から） */
const CAP = () => (isApple() ? 3 : Math.max(0, Math.min(3, (navigator.hardwareConcurrency || 4) - 2)));
function loadTune(): Tune {
  let t: Tune | null = null;
  try {
    t = JSON.parse(localStorage.getItem(TUNE_KEY) ?? 'null');
  } catch { /* 読めない */ }
  if (!t || typeof t.next !== 'number') t = { next: 1, max: CAP() };
  return t;
}
function saveTune(t: Tune) {
  try {
    localStorage.setItem(TUNE_KEY, JSON.stringify(t));
  } catch { /* 保存できない */ }
}
// 起動したとき: 描いている印が残っていたら、そのとき落ちた。1 つ減らして、それより増やさない
{
  const t = loadTune();
  if (t.running !== undefined) {
    t.max = Math.max(0, t.running - 1);
    t.next = t.max;
    t.crashed = true;
    delete t.running;
    saveTune(t);
  }
}

/** 今回使う別スレッドの数 */
function workerCount() {
  const forced = (globalThis as { __recWorkers?: number }).__recWorkers;
  if (forced !== undefined) return forced;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof VideoEncoder === 'undefined') return 0;
  const t = loadTune();
  return Math.max(0, Math.min(t.next, t.max, CAP()));
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
  /** 描いたコマ数と、描いていた時間（速さを測る） */
  frames: number;
  ms: number;
  /** 用意ができたか・次の区間を渡す・最後に知らせが来た時刻（止まった係を見分ける） */
  ok: boolean;
  next: () => void;
  drop: () => void;
  heard: number;
}

export async function renderChartVideo(job: OfflineJob): Promise<{ blob: Blob; ext: string; audio: AudioCodec['kind'] }> {
  const T_START = performance.now();
  const { course, info, audio } = job;
  const FPS = job.fps ?? 60;
  const vcfg = await pickVideo(job.res ?? 1080, FPS);
  if (!vcfg) throw new Error('この端末では録画できません');
  const W = vcfg.width;
  const H = vcfg.height;
  const acfg = await pickAudio(audio.ctx.sampleRate);
  /** 実機で何に時間がかかったかの記録（動画ファイルの中に入れる。画面には出さない） */
  const diag: Record<string, unknown> = { app: 'TJAtelier', ua: navigator.userAgent, w: W, h: H, fps: FPS, codec: vcfg.codec, bitrate: vcfg.bitrate, audioPick: acfg.kind, rate: acfg.rate };

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
  const tl = buildTimeline(course, job.fixed, allAuto);
  const tnde = job.view.tnde;
  if (tnde) await tnde.prepare(info.title);
  const skinMode: 'on' | 'lane' | null = tnde?.ready ? (job.view.broadcast ? 'lane' : 'on') : null;

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
  // 全部のコマ数: 演出を見せ終える所まで（プレイと同じ決め方）
  const hold = Renderer.endHoldOf(endKind, skinMode);
  let N = iFx;
  while (!((N - iFx) * 1000 / FPS > hold && t0 + N / FPS > tailEnd + 1)) N++;
  N += 1;
  const length = N / FPS;
  diag.frames = N;

  const vmode = job.video ? job.view.vmode : '';
  const img = !vmode && !!job.bgImage;
  let velem: HTMLVideoElement | null = null;
  let vsrc: VideoSource | null = null;
  let vblob: Blob | null = null;
  let painter: BroadcastPainter | null = null;
  let bgBitmap: ImageBitmap | null = null;
  const helpers: Helper[] = [];
  let main: SegRenderer | null = null;
  let cancel = false;
  let suspended = false;
  const tune = loadTune();
  let level = 0;
  try {
    if (vmode && job.video) {
      // 動画は 1 つのファイルを、画面のスレッドと別スレッドで共有する（写さない）
      vblob = await (await fetch(job.video.url)).blob().catch(() => null);
      vsrc = vblob ? await VideoSource.open(vblob) : null;
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
      N,
      iFx,
      endKind,
      fade: tailEnd > 0,
      dim: job.dim,
      video: vmode && job.video ? { ...job.video, blob: vblob ?? undefined } : null,
      bgImage: bgBitmap,
      bc: null,
      vcfg,
      skinBase: tnde ? job.view.skinBase : null,
      tl,
    };

    // 音: 映像を描いている間に、別の所で混ぜて AAC にしておく（できたものは確かめてから入れる）
    const hits = hitAt.map((h) => ({ kind: h.kind, at: h.t - t0 }));
    const ui = Renderer.skinEndOf(endKind, skinMode) ? [{ name: `tnde:${endKind}`, at: iFx / FPS }] : [];
    const tA = performance.now();
    const audP = audio
      .renderMix({ length: length + 0.5, rate: acfg.rate, musicAt: -t0, hits, ui })
      .then((mix) => {
        diag.mixMs = Math.round(performance.now() - tA);
        diag.hits = hits.length;
        diag.music = audio.musicDuration;
        return encodeAudio(mix, acfg, length, job, diag);
      })
      .then((r) => {
        diag.audioMs = Math.round(performance.now() - tA);
        return r;
      });
    audP.catch(() => {});

    // 別スレッドの数・画面のスレッドに描かせるか
    const nw = velem ? 0 : workerCount();
    // 画面のスレッドは、前に測った速さが別スレッドよりかなり遅いときだけ描かない（そのぶんメモリを空ける）
    let mainDraws = nw === 0 || !(tune.mainFps && tune.workerFps && tune.mainFps < tune.workerFps * 0.6);
    if ((globalThis as { __recMainOff?: boolean }).__recMainOff && nw > 0) mainDraws = false;
    diag.workers = nw;
    diag.mainDraws = mainDraws;
    diag.tune = { ...tune };
    if (mainDraws) main = await SegRenderer.create(plan, { tnde, painter, velem, vsrc: velem ? null : vsrc });
    vsrc = null; // main（か、別スレッドが自分で開く）
    const mux = new Mp4Writer(W, H, FPS, { codec: { kind: 'pcm' }, rate: acfg.rate, ch: 2 });

    // 区間に分ける（係の数の 2〜3 倍。短すぎると前に描くぶんが無駄になる）。係がいないときは分けない
    const segLen = (globalThis as { __recSegLen?: number }).__recSegLen ?? (nw ? Math.max(900, Math.ceil(N / ((nw + (mainDraws ? 1 : 0)) * 2.5))) : N);
    const segs: [number, number][] = [];
    for (let a = 0; a < N; a += segLen) segs.push([a, Math.min(N, a + segLen)]);
    diag.segs = segs.length;
    const queue = segs.map((_, k) => k);
    /** 区間ごと・描いた係ごとの結果（同じ区間を 2 つの係が描くことがある。先に終わったほうを使う） */
    const results = new Map<string, SegChunk[]>();
    const finals = new Map<number, SegChunk[]>();
    const owner: string[] = [];
    /** 区間を描いている係の数 */
    const running = new Map<number, number>();
    let committed = 0;
    const commit = () => {
      while (finals.has(committed)) {
        for (const c of finals.get(committed)!) mux.addVideo(c.data, c.key, c.avcC, c.ts);
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
        owner[k] = who;
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
      level = nw;
      // 描いている間の印（アプリごと落ちたら残り、次に起動したときに数を減らす）
      saveTune({ ...tune, running: nw });
      // 画面のスレッドが描かないときは、プレイ画面用に読み込んでいるスキンの絵を手放す（録画のあとで読み直す）
      if (!mainDraws && tnde) {
        tnde.suspend();
        suspended = true;
      }
      const wplan: RecPlan = { ...plan, bc: painter ? await painter.export() : null };
      for (let n = 0; n < nw; n++) {
        let w: Worker;
        try {
          w = new Worker(new URL('./recworker.ts', import.meta.url), { type: 'module' });
        } catch {
          break;
        }
        const who = `w${n}`;
        const h: Helper = { w, ready: Promise.resolve(false), busy: false, dead: false, cur: -1, since: 0, got: 0, frames: 0, ms: 0, ok: false, next: () => {}, drop: () => {}, heard: performance.now() };
        const next = () => {
          if (h.dead || cancel) return;
          const k = take();
          if (k < 0) return;
          begin(k, who);
          h.busy = true;
          h.cur = k;
          h.since = performance.now();
          h.heard = performance.now();
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
        h.next = next;
        h.drop = drop;
        h.ready = new Promise<boolean>((res) => {
          // 用意が 30 秒たってもできなければ、この係は使わない
          const tm = setTimeout(() => {
            if (!h.ok) {
              (diag.fail ??= [] as string[]) && (diag.fail as string[]).push('init timeout');
              res(false);
              drop();
            }
          }, 30000);
          w.onmessage = (e) => {
            const m = e.data;
            h.heard = performance.now();
            if ((globalThis as { __recDebug?: boolean }).__recDebug && m.type !== 'chunk' && m.type !== 'frames') console.warn(`rec ${who}`, m.type, m.k ?? '', m.msg ?? '');
            if (m.type === 'ready') {
              clearTimeout(tm);
              h.ok = true;
              res(true);
            }
            else if (m.type === 'fail') {
              (diag.fail ??= [] as string[]) && (diag.fail as string[]).push(String(m.msg));
              res(false);
              drop();
            } else if (m.type === 'chunk') {
              results.get(`${m.k}:${who}`)?.push({ data: m.data, key: m.key, avcC: m.avcC, ts: m.ts });
            } else if (m.type === 'frames') {
              frames += m.n;
              h.got += m.n;
              progress();
            } else if (m.type === 'done' || m.type === 'skipped') {
              if (m.type === 'done') {
                h.frames += segs[m.k][1] - segs[m.k][0];
                h.ms += performance.now() - h.since;
              }
              h.busy = false;
              h.cur = -1;
              end(m.k, who, m.type === 'done');
              next();
              kick();
            } else if (m.type === 'segfail') {
              (diag.fail ??= [] as string[]) && (diag.fail as string[]).push(String(m.msg));
              drop();
            }
          };
          w.onerror = (ev) => {
            (diag.fail ??= [] as string[]) && (diag.fail as string[]).push(String(ev.message ?? 'error'));
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
    let mainFrames = 0;
    let mainMs = 0;
    const drawHere = async (k: number) => {
      if (!main) {
        // 描かないつもりだったが、別スレッドが全部やめた: ここで描く
        if (suspended && tnde) {
          await tnde.prepare(info.title);
          suspended = false;
        }
        main = await SegRenderer.create(plan, { tnde, painter, velem, vsrc: null });
        mainDraws = true;
      }
      begin(k, 'main');
      const [a, b] = segs[k];
      const t = performance.now();
      try {
        await main.render(a, b, (c) => results.get(`${k}:main`)?.push(c), () => job.cancelled() || isDone(k), (n) => {
          frames += n;
          progress();
        });
        end(k, 'main', true);
        mainFrames += b - a;
        mainMs += performance.now() - t;
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
      // 止まった係（20 秒なにも知らせて来ない）はやめさせて、その区間はやり直す。空いている係には次の区間を渡す
      for (const h of helpers) {
        if (h.dead) continue;
        if (h.busy && performance.now() - h.heard > 20000) {
          (diag.fail ??= [] as string[]) && (diag.fail as string[]).push('stalled');
          h.drop();
        } else if (h.ok && !h.busy) h.next();
      }
      const alive = helpers.some((h) => !h.dead);
      // 画面のスレッドが描く（描かないときは、係がいなくなったときだけ）
      if (mainDraws || !alive) {
        const k = take();
        if (k >= 0) {
          await drawHere(k);
          continue;
        }
      }
      // 残りは別スレッドの係が描いている。係がいなくなった区間はここで描く
      if (!helpers.some((h) => !h.dead && h.busy) && !(alive && !mainDraws && helpers.some((h) => !h.dead && !h.busy))) {
        for (let j = committed; j < segs.length; j++) if (!isDone(j) && !running.get(j) && !queue.includes(j)) queue.push(j);
        if (!helpers.some((h) => !h.dead)) {
          if (!queue.length) await sleep(20);
          continue;
        }
      }
      // 係がとても遅いときは、その区間をここでも描く（先に終わったほうを使う）。
      // ここで描き直したほうが、係の残りより十分早く終わりそうなときだけ
      let spec = -1;
      const mainRate = mainMs > 0 ? mainFrames / mainMs : 0;
      if (mainDraws && mainRate > 0) {
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

    // 音（確かめてから入れる。映像より長く作ったぶんは入れない）
    job.onProgress(0.995);
    const tWait = performance.now();
    const au = await audP;
    diag.audioWaitMs = Math.round(performance.now() - tWait);
    mux.setAudio(au.codec, au.rate);
    for (const c of au.chunks) mux.addAudio(c.data, c.frames);
    job.onProgress(1);

    // 次の録画のための記録: 速さと、別スレッドの数（無事に終わったので 1 つ増やしてみる）
    const ws = helpers.filter((h) => h.frames > 0);
    const t2: Tune = { ...tune };
    delete t2.running;
    if (mainFrames > 0 && mainMs > 0) t2.mainFps = Math.round((mainFrames / mainMs) * 1000 * 10) / 10;
    if (ws.length) t2.workerFps = Math.round((ws.reduce((x, h) => x + h.frames / h.ms, 0) / ws.length) * 1000 * 10) / 10;
    if (level > 0) {
      if (ws.length) t2.next = Math.min(t2.max, CAP(), level + 1);
      else if (diag.fail) t2.max = t2.next = 0; // 別スレッドが使えない端末
    } else if (nw === 0 && !velem) t2.next = Math.min(t2.max, CAP(), Math.max(t2.next, 1));
    saveTune(t2);
    diag.result = { ms: Math.round(performance.now() - T_START), mainFrames, mainMs: Math.round(mainMs), owners: owner, workers: helpers.map((h) => ({ frames: h.frames, ms: Math.round(h.ms), dead: h.dead })) };
    diag.nextTune = t2;
    mux.note(JSON.stringify(diag));
    const blob = mux.finish();
    return { blob, ext: blob.type === 'video/quicktime' ? 'mov' : 'mp4', audio: au.codec.kind };
  } finally {
    // 描いている間の印を消す（ここまで来れば落ちていない）
    const t = loadTune();
    if (t.running !== undefined) {
      delete t.running;
      saveTune(t);
    }
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
    // 手放したスキンの絵は、裏で読み直しておく（次のプレイに間に合うように）
    if (suspended && tnde) void tnde.prepare(info.title).catch(() => {});
  }
}

interface AudioOut {
  codec: AudioCodec;
  rate: number;
  chunks: { data: Uint8Array; frames: number }[];
}

/** 音を PCM（.mov）にする */
function pcmOf(mix: AudioBuffer, frames: number): { data: Uint8Array; frames: number }[] {
  const L = mix.getChannelData(0);
  const Rc = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
  const n = Math.min(mix.length, frames);
  const out: { data: Uint8Array; frames: number }[] = [];
  const BLK = 4800;
  for (let o = 0; o < n; o += BLK) {
    const m = Math.min(BLK, n - o);
    const b = new DataView(new ArrayBuffer(m * 4));
    for (let k = 0; k < m; k++) {
      b.setInt16(k * 4, Math.max(-32768, Math.min(32767, Math.round(L[o + k] * 32767))), true);
      b.setInt16(k * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(Rc[o + k] * 32767))), true);
    }
    out.push({ data: new Uint8Array(b.buffer), frames: m });
  }
  return out;
}

/** 音の大きさ（全体の二乗平均の平方根。間引いて測る） */
function rmsOf(chs: Float32Array[]) {
  let s = 0;
  let n = 0;
  for (const c of chs) for (let i = 0; i < c.length; i += 7) { s += c[i] * c[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

/** ADTS の頭（AAC の 1 つずつに付くことがある）を外し、そこから AudioSpecificConfig を作る */
function stripAdts(d: Uint8Array): { body: Uint8Array; asc?: Uint8Array } {
  if (d.length < 7 || d[0] !== 0xff || (d[1] & 0xf0) !== 0xf0) return { body: d };
  const head = d[1] & 1 ? 7 : 9;
  const prof = ((d[2] >> 6) & 3) + 1;
  const fi = (d[2] >> 2) & 15;
  const ch = ((d[2] & 1) << 2) | (d[3] >> 6);
  return { body: d.subarray(head), asc: new Uint8Array([(prof << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]) };
}

/**
 * 混ぜた音を形式に合わせて作る（length 秒まで）。AAC・Opus は作ったものを一度読み戻して、音が入っているか確かめる。
 * 読み戻せない・音が消えているときは PCM（.mov）にする
 */
async function encodeAudio(mix: AudioBuffer, a: { kind: AudioCodec['kind']; rate: number; config?: AudioEncoderConfig }, length: number, job: OfflineJob, diag: Record<string, unknown>): Promise<AudioOut> {
  const total = Math.min(mix.length, Math.round(length * a.rate));
  const L = mix.getChannelData(0);
  const Rc = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
  const mixRms = rmsOf([L.subarray(0, total), Rc.subarray(0, total)]);
  const ad: Record<string, unknown> = { mixRms: Math.round(mixRms * 1e4) / 1e4, mixLen: mix.length };
  diag.audio = ad;
  const pcm = (): AudioOut => ({ codec: { kind: 'pcm' }, rate: a.rate, chunks: pcmOf(mix, total) });
  if (a.kind === 'pcm' || !a.config) {
    ad.final = 'pcm';
    return pcm();
  }
  try {
    let err: unknown = null;
    const per = a.kind === 'aac' ? 1024 : 960;
    let desc: Uint8Array | null = null;
    let adts = 0;
    const chunks: { data: Uint8Array; frames: number; ts: number }[] = [];
    const ae = new AudioEncoder({
      output: (chunk, meta) => {
        const dd = meta?.decoderConfig?.description;
        if (dd) desc = toU8(dd);
        let d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        if (a.kind === 'aac') {
          const x = stripAdts(d);
          if (x.asc) {
            adts++;
            desc ??= x.asc;
            d = x.body.slice();
          }
        }
        // 1 つの長さ: AAC はいつも 1024。Opus は届いた長さ（無ければ 960）
        const frames = a.kind === 'aac' ? 1024 : Math.round(((chunk.duration ?? 0) * a.rate) / 1e6) || per;
        chunks.push({ data: d, frames, ts: chunk.timestamp });
      },
      error: (e) => { err = e; },
    });
    try {
      ae.configure(a.config);
      const BLK = 4096;
      for (let o = 0; o < mix.length; o += BLK) {
        if (err) throw err;
        if (job.cancelled()) throw new RecordCancelled();
        const m = Math.min(BLK, mix.length - o);
        const data = new Float32Array(m * 2);
        data.set(L.subarray(o, o + m), 0);
        data.set(Rc.subarray(o, o + m), m);
        const x = new AudioData({ format: 'f32-planar', sampleRate: a.rate, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((o / a.rate) * 1e6), data });
        ae.encode(x);
        x.close();
        if (ae.encodeQueueSize > 16) await drained(ae, 8);
      }
      await ae.flush();
      if (err) throw err;
    } finally {
      if (ae.state !== 'closed') ae.close();
    }
    // length 秒までにする
    let acc = 0;
    let k = 0;
    while (k < chunks.length && acc < total) acc += chunks[k++].frames;
    const used = chunks.slice(0, k);
    // AAC の設定（AudioSpecificConfig）: iPhone はエンコーダーが別の形（ES 記述子など）で渡すことがあり、
    // そのまま .mp4 に入れると、写真などのアプリで音が鳴らない。AAC-LC・2ch と決めて作ったので、こちらで作った正しい形を使う
    const codec: AudioCodec =
      a.kind === 'aac'
        ? { kind: 'aac', asc: aacConfig(a.rate, 2) }
        : { kind: 'opus', preSkip: desc && (desc as Uint8Array).length >= 12 ? (desc as Uint8Array)[10] | ((desc as Uint8Array)[11] << 8) : 312 };
    ad.chunks = used.length;
    ad.adts = adts;
    ad.desc = desc ? Array.from((desc as Uint8Array).slice(0, 24)).map((x) => x.toString(16).padStart(2, '0')).join('') : '';
    // 読み戻して確かめる
    if (typeof AudioDecoder !== 'undefined' && mixRms > 1e-4) {
      const dec = await decodeRms(a, codec, used);
      ad.decRms = dec === null ? null : Math.round(dec * 1e4) / 1e4;
      if (dec === null || dec < mixRms * 0.3) {
        ad.final = 'pcm';
        return pcm();
      }
    }
    ad.final = a.kind;
    return { codec, rate: a.rate, chunks: used.map((c) => ({ data: c.data, frames: c.frames })) };
  } catch (e) {
    if (e instanceof RecordCancelled) throw e;
    ad.error = String((e as Error)?.message ?? e);
    ad.final = 'pcm';
    return pcm();
  }
}

/** 作った音を読み戻した大きさ（読めなければ null） */
async function decodeRms(a: { kind: AudioCodec['kind']; rate: number }, codec: AudioCodec, chunks: { data: Uint8Array; frames: number; ts: number }[]): Promise<number | null> {
  let s = 0;
  let n = 0;
  let err = false;
  const dec = new AudioDecoder({
    output: (x) => {
      try {
        for (let ch = 0; ch < x.numberOfChannels; ch++) {
          const buf = new Float32Array(x.numberOfFrames);
          x.copyTo(buf, { planeIndex: ch, format: 'f32-planar' });
          for (let i = 0; i < buf.length; i += 7) { s += buf[i] * buf[i]; n++; }
        }
      } catch {
        err = true;
      }
      x.close();
    },
    error: () => { err = true; },
  });
  try {
    const description = codec.kind === 'aac' ? codec.asc : undefined;
    dec.configure({ codec: a.kind === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: a.rate, numberOfChannels: 2, description });
    let t = 0;
    for (const c of chunks) {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((t / a.rate) * 1e6), data: c.data }));
      t += c.frames;
      if (dec.decodeQueueSize > 32) await new Promise((r) => setTimeout(r, 1));
    }
    await dec.flush();
  } catch {
    err = true;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  return err || !n ? null : Math.sqrt(s / n);
}

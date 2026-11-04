/**
 * 拍の AI（Beat This!、CPJKU・MIT ライセンス）で、拍と小節の頭（1 拍目）の時刻を求める。
 *
 * - モデル（軽い small0 を ONNX にしたもの、約 10MB）はサイトの ai/ に置いてある。実行環境（onnxruntime-web）は公開するときに ai/ へ入れる
 * - モデルは 1 度読んだら端末に取っておく（Cache Storage）
 * - 入力は 22050Hz の音の対数メルスペクトログラム（1 フレーム 20ms、128 段）。Beat This! の LogMelSpect と同じ作り方
 * - 長い曲は 1500 フレーム（30 秒）ずつに分けて、つなぎ目の 6 フレームは捨てて重ねる（元の実装と同じ）
 *
 * 描画や DOM に依存しないので、Web Worker の中で動く。
 */

export interface BeatAI {
  /** 拍の時刻（秒） */
  beats: number[];
  /** 小節の頭（1 拍目）の時刻（秒、どれかの拍と同じ時刻） */
  downbeats: number[];
}

const SR = 22050;
const NFFT = 1024;
const HOP = 441;
const MELS = 128;
const FPS = SR / HOP; // 50
const BINS = NFFT / 2 + 1;
// 10 秒ずつ（元は 30 秒）。AI の使うメモリはほぼ区切りの長さに比例し、30 秒では 1GB 近くになって
// iPhone のアプリが落ちる（10 秒で半分ほど）。小節の頭の決め方は、AI の印が続けてそろった所しか使わないので、結果は変わらない
const CHUNK = 500;
const BORDER = 6;

export const MODEL_FILE = 'beat-this-small0.onnx';
const CACHE = 'tjatelier-ai-v2';

// ---------- 音を 22050Hz にする ----------

/** 窓付き sinc で 22050Hz にする（高い音が折り返して混ざらないように、低域通過してから間引く） */
export function resample(x: Float32Array, sr: number): Float32Array {
  if (sr === SR) return x;
  const ratio = SR / sr;
  const cut = Math.min(1, ratio) * 0.97;
  const half = 16;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
  // 2:1（44.1kHz → 22.05kHz）はよくあるので、係数を先に作っておく
  if (sr === SR * 2) {
    const taps: number[] = [];
    for (let k = -half * 2; k <= half * 2; k++) {
      const t = k * 0.5 * cut;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const u = k / (half * 2 + 1);
      taps.push(s * (0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u)));
    }
    const sum = taps.reduce((p, v) => p + v, 0);
    for (let i = 0; i < taps.length; i++) taps[i] /= sum;
    for (let i = 0; i < n; i++) {
      const c = i * 2;
      let acc = 0;
      for (let k = 0; k < taps.length; k++) {
        const j = c + k - half * 2;
        if (j >= 0 && j < x.length) acc += taps[k] * x[j];
      }
      out[i] = acc;
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const pos = i / ratio;
    const c = Math.floor(pos);
    let acc = 0;
    let norm = 0;
    for (let j = c - half + 1; j <= c + half; j++) {
      if (j < 0 || j >= x.length) continue;
      const t = (j - pos) * cut;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const u = (j - pos) / half;
      const w = 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      acc += s * w * x[j];
      norm += s * w;
    }
    out[i] = norm ? acc / norm : 0;
  }
  return out;
}

// ---------- 対数メルスペクトログラム ----------

/** Slaney 型のメル尺度（torchaudio の mel_scale="slaney"） */
const hzToMel = (f: number) => (f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
const melToHz = (m: number) => (m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));

/** メルの三角フィルタ（周波数 513 段 × メル 128 段、周波数ごとに並べる。torchaudio の melscale_fbanks、norm なし） */
export function melFilters(fMin = 30, fMax = 11000): Float32Array {
  const fb = new Float32Array(BINS * MELS);
  const m0 = hzToMel(fMin);
  const m1 = hzToMel(fMax);
  const fp: number[] = [];
  for (let i = 0; i < MELS + 2; i++) fp.push(melToHz(m0 + ((m1 - m0) * i) / (MELS + 1)));
  for (let k = 0; k < BINS; k++) {
    const f = ((SR / 2) * k) / (BINS - 1);
    for (let m = 0; m < MELS; m++) {
      const down = (f - fp[m]) / (fp[m + 1] - fp[m]);
      const up = (fp[m + 2] - f) / (fp[m + 2] - fp[m + 1]);
      fb[k * MELS + m] = Math.max(0, Math.min(down, up));
    }
  }
  return fb;
}

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * 22050Hz の音から、モデルに入れる対数メルスペクトログラム（フレーム数 × 128、フレームごとに並べる）。
 * torchaudio の MelSpectrogram（中心合わせ・端は折り返し、周期ハン窓、振幅、normalized="frame_length" で √1024 で割る）
 * → log(1 + 1000 × メル)
 */
export function logMel(x: Float32Array, fb = melFilters()): { mel: Float32Array; frames: number } {
  const P = NFFT / 2;
  const len = x.length;
  const pad = new Float32Array(len + NFFT);
  pad.set(x, P);
  for (let k = 1; k <= P && k < len; k++) {
    pad[P - k] = x[k];
    pad[P + len - 1 + k] = x[len - 1 - k];
  }
  const frames = Math.floor(len / HOP) + 1;
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const mag = new Float64Array(BINS);
  const mel = new Float32Array(frames * MELS);
  const norm = 1 / Math.sqrt(NFFT);
  // メルのフィルタは、0 でない所だけを持っておく（速くするため）
  const ranges: { k0: number; k1: number }[] = [];
  for (let m = 0; m < MELS; m++) {
    let k0 = -1;
    let k1 = -1;
    for (let k = 0; k < BINS; k++) {
      if (fb[k * MELS + m] > 0) {
        if (k0 < 0) k0 = k;
        k1 = k;
      }
    }
    ranges.push({ k0: Math.max(0, k0), k1 });
  }
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < NFFT; i++) {
      re[i] = (pad[o + i] ?? 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < BINS; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
    const b = f * MELS;
    for (let m = 0; m < MELS; m++) {
      const { k0, k1 } = ranges[m];
      let acc = 0;
      for (let k = k0; k <= k1; k++) acc += mag[k] * fb[k * MELS + m];
      mel[b + m] = Math.log1p(1000 * acc);
    }
  }
  return { mel, frames };
}

// ---------- 予測の結果から拍を取り出す ----------

/**
 * 拍・小節の頭の確からしさ（フレームごとのロジット）から時刻を取り出す（Beat This! の minimal と同じ）。
 * 前後 3 フレーム（±60ms）でいちばん高く、確率 0.5 を超える所。隣り合うものは平均。
 * 拍の時刻は、山の前後の値で放物線を当てて、20ms より細かく求める。小節の頭は、いちばん近い拍に寄せる
 */
export function peaks(beat: Float32Array, down: Float32Array): BeatAI {
  const pick = (a: Float32Array, fine: boolean) => {
    const out: number[] = [];
    let run: number[] = [];
    const flush = () => {
      if (!run.length) return;
      let f = run.reduce((p, v) => p + v, 0) / run.length;
      if (fine && run.length === 1) {
        const i = run[0];
        const s = (v: number) => 1 / (1 + Math.exp(-v));
        const l = s(a[i - 1] ?? -1000);
        const c = s(a[i]);
        const r = s(a[i + 1] ?? -1000);
        const den = l - 2 * c + r;
        if (den < 0) f += Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den));
      }
      out.push(f / FPS);
      run = [];
    };
    for (let i = 0; i < a.length; i++) {
      if (!(a[i] > 0)) continue;
      let mx = -Infinity;
      for (let d = -3; d <= 3; d++) mx = Math.max(mx, a[i + d] ?? -1000);
      if (a[i] < mx) continue;
      if (run.length && i - run[run.length - 1] > 1) flush();
      run.push(i);
    }
    flush();
    return out;
  };
  const beats = pick(beat, true);
  const raw = pick(down, false);
  const set = new Set<number>();
  for (const d of raw) {
    if (!beats.length) break;
    let bi = 0;
    for (let i = 1; i < beats.length; i++) if (Math.abs(beats[i] - d) < Math.abs(beats[bi] - d)) bi = i;
    set.add(beats[bi]);
  }
  return { beats, downbeats: [...set].sort((a, b) => a - b) };
}

// ---------- モデルを動かす ----------

interface OrtTensor {
  data: Float32Array;
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
interface Ort {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(model: ArrayBuffer | Uint8Array, opts?: unknown): Promise<OrtSession> };
}

/** モデルを読む（端末に取ってあればそれを使う）。p = 読み込みの進み具合（0〜1） */
async function loadModel(url: string, progress?: (p: number) => void): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`拍の AI を読めませんでした（${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) progress?.(got / total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  try {
    await cache?.put(url, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
  } catch {
    // 取っておけなくても、今回は使える
  }
  return buf.buffer;
}

let session: { url: string; ort: Ort; s: OrtSession } | null = null;


/**
 * 拍の AI で拍と小節の頭を求める。base = サイトの頭の URL（ai/ がある所）。
 * progress は 0〜1（モデルの読み込み 0〜0.4、計算 0.4〜1）
 */
export async function runBeatThis(mono: Float32Array, sr: number, base: string, progress?: (p: number) => void): Promise<BeatAI> {
  const dir = new URL('ai/', base).href;
  const modelUrl = dir + MODEL_FILE;
  if (!session || session.url !== modelUrl) {
    // CPU（wasm）で計算する。GPU（WebGPU）版の実行環境は大きく、iPhone のアプリではメモリが足りなくなる
    const ort = (await import(/* @vite-ignore */ dir + 'ort.wasm.min.mjs')) as Ort;
    ort.env.wasm.wasmPaths = dir;
    // 複数のスレッドは、ページが cross-origin isolated のときしか使えない
    const iso = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    ort.env.wasm.numThreads = iso ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const model = new Uint8Array(await loadModel(modelUrl, (p) => progress?.(p * 0.35)));
    progress?.(0.36);
    const s = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false });
    session = { url: modelUrl, ort, s };
  }
  progress?.(0.4);
  const { ort, s } = session;
  const x = resample(mono, sr);
  const { mel, frames } = logMel(x);
  // 30 秒ずつに分ける（前後 6 フレームは捨てる所として重ね、最初と最後は 0 で埋める）
  const starts: number[] = [];
  for (let st = -BORDER; st < frames - BORDER; st += CHUNK - 2 * BORDER) starts.push(st);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  const beat = new Float32Array(frames).fill(-1000);
  const down = new Float32Array(frames).fill(-1000);
  // 重なった所は前の区切りの値を使う（keep_first）ので、後ろから順に書く
  const outs: { st: number; b: Float32Array; d: Float32Array; n: number }[] = [];
  for (let c = 0; c < starts.length; c++) {
    const st = starts[c];
    const a = Math.max(st, 0);
    const e = Math.min(st + CHUNK, frames);
    const left = Math.max(0, -st);
    const right = Math.max(0, Math.min(BORDER, st + CHUNK - frames));
    const n = left + (e - a) + right;
    const inp = new Float32Array(n * MELS);
    inp.set(mel.subarray(a * MELS, e * MELS), left * MELS);
    const r = await s.run({ [s.inputNames[0] ?? 'spectrogram']: new ort.Tensor('float32', inp, [1, n, MELS]) });
    outs.push({ st, b: r.beat.data, d: r.downbeat.data, n });
    progress?.(0.4 + (0.6 * (c + 1)) / starts.length);
  }
  for (let c = outs.length - 1; c >= 0; c--) {
    const { st, b, d, n } = outs[c];
    for (let i = BORDER; i < n - BORDER; i++) {
      const f = st + i;
      if (f < 0 || f >= frames) continue;
      beat[f] = b[i];
      down[f] = d[i];
    }
  }
  return peaks(beat, down);
}

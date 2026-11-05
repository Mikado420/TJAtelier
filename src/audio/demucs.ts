// 音源分離（HTDemucs, Meta, MIT ライセンス）で曲からドラムだけを取り出す。
// モデルは「波形」と「複素スペクトル」を受け取り、スペクトル側と波形側の出力を返す形で ONNX に書き出してある
// （tools/ai-export/export.py）。STFT・逆 STFT と、区切りの重ね合わせはここで行う。

export const SR = 44100;
const NFFT = 4096;
const HL = 1024;
/** モデルを分けて置いたファイル（GitHub Pages の 1 ファイル 100MB の上限のため） */
export const DEMUCS_MODEL = 'htdemucs-s20.onnx';
export const DEMUCS_PARTS = 4;
const CACHE = 'tjatelier-ai-v1';

// ---------- FFT（長さ 4096 の実数） ----------

const WIN = new Float64Array(NFFT);
for (let i = 0; i < NFFT; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
const BITREV = new Uint32Array(NFFT);
{
  const bits = Math.log2(NFFT);
  for (let i = 0; i < NFFT; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    BITREV[i] = r;
  }
}
const COS = new Float64Array(NFFT / 2);
const SIN = new Float64Array(NFFT / 2);
for (let i = 0; i < NFFT / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / NFFT);
  SIN[i] = Math.sin((2 * Math.PI * i) / NFFT);
}

/** 複素 FFT（その場で）。inv = 逆変換（1/N はかけない） */
function fft(re: Float64Array, im: Float64Array, inv: boolean): void {
  const n = NFFT;
  for (let i = 0; i < n; i++) {
    const j = BITREV[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  const sg = inv ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let st = 0; st < n; st += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step];
        const s = sg * SIN[k * step];
        const a = st + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 端を折り返して伸ばす（numpy の reflect と同じ） */
function reflectPad(x: Float64Array, l: number, r: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n + l + r);
  for (let i = 0; i < out.length; i++) {
    let j = i - l;
    while (j < 0 || j >= n) {
      if (j < 0) j = -j;
      if (j >= n) j = 2 * (n - 1) - j;
    }
    out[i] = x[j];
  }
  return out;
}

/**
 * demucs の _spec と同じスペクトル。x: 長さ L → re/im: [2048 × le]（周波数が先）
 */
export function spec(x: Float64Array): { re: Float64Array; im: Float64Array; le: number } {
  const L = x.length;
  const le = Math.ceil(L / HL);
  const pad = (HL / 2) * 3;
  const p1 = reflectPad(x, pad, pad + le * HL - L);
  const p = reflectPad(p1, NFFT / 2, NFFT / 2);
  const F = NFFT / 2;
  const re = new Float64Array(F * le);
  const im = new Float64Array(F * le);
  const fr = new Float64Array(NFFT);
  const fi = new Float64Array(NFFT);
  const norm = 1 / Math.sqrt(NFFT);
  for (let t = 0; t < le; t++) {
    const o = (t + 2) * HL;
    for (let i = 0; i < NFFT; i++) {
      fr[i] = p[o + i] * WIN[i];
      fi[i] = 0;
    }
    fft(fr, fi, false);
    for (let f = 0; f < F; f++) {
      re[f * le + t] = fr[f] * norm;
      im[f * le + t] = fi[f] * norm;
    }
  }
  return { re, im, le };
}

/** demucs の _ispec と同じ。re/im: [2048 × le] → 長さ L */
export function ispec(re: Float32Array, im: Float32Array, le: number, L: number, out: Float64Array, w: Float64Array): void {
  // 前後に 2 フレームずつ 0 を足して、center つきの逆 STFT
  const T = le + 4;
  const F = NFFT / 2;
  const n = NFFT + HL * (T - 1);
  const acc = new Float64Array(n);
  const ws = new Float64Array(n);
  const fr = new Float64Array(NFFT);
  const fi = new Float64Array(NFFT);
  const sc = Math.sqrt(NFFT) / NFFT;
  for (let t = 0; t < T; t++) {
    const tt = t - 2;
    fr.fill(0);
    fi.fill(0);
    if (tt >= 0 && tt < le) {
      for (let f = 0; f < F; f++) {
        fr[f] = re[f * le + tt];
        fi[f] = im[f * le + tt];
      }
      // 実数の信号になるよう、後ろ半分は共役（ナイキストの所は 0）
      for (let f = 1; f < F; f++) {
        fr[NFFT - f] = fr[f];
        fi[NFFT - f] = -fi[f];
      }
      fi[0] = 0;
      fft(fr, fi, true);
    }
    const o = t * HL;
    for (let i = 0; i < NFFT; i++) {
      acc[o + i] += fr[i] * sc * WIN[i];
      ws[o + i] += WIN[i] * WIN[i];
    }
  }
  const pad = (HL / 2) * 3;
  const s0 = NFFT / 2 + pad;
  for (let i = 0; i < L; i++) {
    const j = s0 + i;
    const v = ws[j] > 1e-11 ? acc[j] / ws[j] : acc[j];
    out[i] += v * w[i];
  }
}

// ---------- モデルを動かす ----------

interface OrtTensor {
  data: Float32Array;
  dims: readonly number[];
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}
interface Ort {
  env: { wasm: { wasmPaths?: string; numThreads?: number } };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: { create(model: Uint8Array, opts?: unknown): Promise<OrtSession> };
}

async function fetchCached(url: string, progress?: (got: number) => void): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(url);
    if (hit) {
      const b = new Uint8Array(await hit.arrayBuffer());
      progress?.(b.length);
      return b;
    }
  } catch {
    cache = null;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`音源分離の AI を読めませんでした（${res.status}）`);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    progress?.(value.length);
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
  return buf;
}

/** 分けて置いたモデルを 1 つにつなぐ */
async function loadParts(dir: string, progress?: (p: number) => void): Promise<Uint8Array> {
  const urls = Array.from({ length: DEMUCS_PARTS }, (_, i) => `${dir}${DEMUCS_MODEL}.part${i}`);
  const est = 45_000_000 * DEMUCS_PARTS;
  let got = 0;
  const parts: Uint8Array[] = [];
  for (const u of urls) parts.push(await fetchCached(u, (n) => progress?.(Math.min(1, (got += n) / est))));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
    p.fill(0);
  }
  return buf;
}

/** 44100Hz にする（線形補間） */
function to44k(x: Float32Array, sr: number): Float32Array {
  if (sr === SR) return x;
  const n = Math.floor((x.length * SR) / sr);
  const out = new Float32Array(n);
  const r = sr / SR;
  for (let i = 0; i < n; i++) {
    const p = i * r;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}

export type DemucsBackend = 'webgpu' | 'wasm';

/**
 * 曲（モノラル）からドラムだけを取り出す（44100Hz のモノラルで返す）。
 * base = サイトの頭の URL（ai/ がある所）。progress は 0〜1（読み込み 0〜0.3、計算 0.3〜1）
 */
export async function separateDrums(
  mono: Float32Array,
  sr: number,
  base: string,
  progress?: (p: number) => void,
  prefer: DemucsBackend[] = ['webgpu', 'wasm'],
  /** 計算を始める前に、どちらで動かすかを知らせる（途中で落ちたときに次は控えるため） */
  onBackend?: (b: DemucsBackend) => void,
): Promise<{ drums: Float32Array; backend: DemucsBackend }> {
  const dir = new URL('ai/', base).href;
  let model: Uint8Array | null = await loadParts(dir, (p) => progress?.(p * 0.28));
  let ort: Ort | null = null;
  let s: OrtSession | null = null;
  let backend: DemucsBackend = 'wasm';
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  for (const b of prefer) {
    if (b === 'webgpu' && !(gpu && (await gpu.requestAdapter().catch(() => null)))) continue;
    try {
      onBackend?.(b);
      ort = (await import(/* @vite-ignore */ dir + (b === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'))) as Ort;
      ort.env.wasm.wasmPaths = dir;
      const iso = (self as unknown as { crossOriginIsolated?: boolean }).crossOriginIsolated;
      ort.env.wasm.numThreads = iso ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      s = await ort.InferenceSession.create(model, {
        executionProviders: [b],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
      backend = b;
      break;
    } catch (e) {
      console.warn('音源分離', b, e);
      s = null;
    }
  }
  model = null;
  if (!ort || !s) throw new Error('音源分離の AI を動かせませんでした');
  progress?.(0.3);
  const x = to44k(mono, sr);
  const N = x.length;
  const L = 88200; // htdemucs-s20 の区切りの長さ（2 秒）
  const stride = Math.floor(0.75 * L);
  // 区切りの重みは三角（demucs の apply_model と同じ）
  const w = new Float64Array(L);
  const h = L >> 1;
  for (let i = 0; i < L; i++) w[i] = i < h ? i + 1 : L - i;
  let wmax = 0;
  for (let i = 0; i < L; i++) wmax = Math.max(wmax, w[i]);
  for (let i = 0; i < L; i++) w[i] /= wmax;
  const out = new Float32Array(N);
  const sw = new Float32Array(N);
  const offs: number[] = [];
  for (let off = 0; off < N; off += stride) {
    offs.push(off);
    if (off + L >= N) break;
  }
  const seg = new Float64Array(L);
  const segOut = new Float64Array(L);
  for (let k = 0; k < offs.length; k++) {
    const off = offs[k];
    const n = Math.min(L, N - off);
    seg.fill(0);
    for (let i = 0; i < n; i++) seg[i] = x[off + i];
    const z = spec(seg);
    const F = NFFT / 2;
    const le = z.le;
    // 左右とも同じ音なので、実部・虚部を 2ch 分並べる
    const mag = new Float32Array(4 * F * le);
    for (let c = 0; c < 2; c++) {
      mag.set(Float32Array.from(z.re), (2 * c) * F * le);
      mag.set(Float32Array.from(z.im), (2 * c + 1) * F * le);
    }
    const mix = new Float32Array(2 * L);
    for (let i = 0; i < L; i++) mix[i] = mix[L + i] = seg[i];
    const r = await s.run({ mix: new ort.Tensor('float32', mix, [1, 2, L]), mag: new ort.Tensor('float32', mag, [1, 4, F, le]) });
    // 出力: spec [1, 4 音源, 4ch, F, le]・wave [1, 4 音源, 2ch, L]。音源 0 がドラム
    const sp = r.spec.data;
    const wv = r.wave.data;
    segOut.fill(0);
    for (let c = 0; c < 2; c++) {
      const re = sp.subarray((2 * c) * F * le, (2 * c + 1) * F * le);
      const im = sp.subarray((2 * c + 1) * F * le, (2 * c + 2) * F * le);
      ispec(re, im, le, L, segOut, w);
      for (let i = 0; i < L; i++) segOut[i] += wv[c * L + i] * w[i];
    }
    for (let i = 0; i < n; i++) {
      out[off + i] += segOut[i] / 2;
      sw[off + i] += w[i];
    }
    progress?.(0.3 + (0.7 * (k + 1)) / offs.length);
  }
  await s.release?.();
  const drums = new Float32Array(N);
  for (let i = 0; i < N; i++) drums[i] = sw[i] > 0 ? out[i] / sw[i] : 0;
  return { drums, backend };
}

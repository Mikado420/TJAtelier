/**
 * 拍の AI（madmom の学習済みの拍・小節の頭の検出、Böck ほか 2016）を、ブラウザで動かせるように書き直したもの。
 *
 * - 学習済みのモデル（BLSTM 8 個）と、前処理のフィルタは public/ai/madmom-downbeats.bin に入れてある
 *   （madmom_models の downbeats/2016。CC BY-NC-SA 4.0、商用には使えない）
 * - 前処理: 44.1kHz の音を 3 つの窓（1024・2048・4096）で 1 秒 100 フレームのスペクトルにし、
 *   対数の帯（1 オクターブに 3・6・12 本、30〜17000Hz）にまとめ、log10(1 + x) と、その増え方（正の差）を並べる（314 個）
 * - 8 個のモデルの出力の平均が、フレームごとの「拍」「小節の頭」の確からしさ
 * - DBN（小節の中の位置と速さを状態にした隠れマルコフモデル）で、3 拍子・4 拍子それぞれの拍の並びを求め、
 *   確からしいほうを使う（madmom の DBNDownBeatTrackingProcessor と同じ設定）
 *
 * 描画や DOM に依存しないので、Web Worker の中で動く。
 */

export interface MadmomResult {
  /** 拍の時刻（秒） */
  beats: number[];
  /** 小節の頭（1 拍目）の時刻（秒、どれかの拍と同じ） */
  downbeats: number[];
  /** 1 小節の拍の数（3 か 4） */
  beatsPerBar: number;
}

type Ref = [number, number];
interface GateH { W: Ref; b: Ref; R: Ref; P?: Ref }
interface DirH { input_gate: GateH; forget_gate: GateH; cell: GateH; output_gate: GateH }
interface Header {
  fps: number;
  sr: number;
  res: { frame: number; bins: number; diff: number; bands: { k0: number; w: Ref }[]; window: Ref }[];
  models: { layers: { f: DirH; b: DirH; in: number; h: number }[]; out: { W: Ref; b: Ref; n: number } }[];
}

export interface MadmomModel {
  head: Header;
  data: Float32Array;
}

/** モデルのファイル（MMDB・ヘッダの長さ・ヘッダの JSON・float32 の並び）を読む */
export function parseModel(buf: ArrayBuffer): MadmomModel {
  const u8 = new Uint8Array(buf);
  if (String.fromCharCode(...u8.subarray(0, 4)) !== 'MMDB') throw new Error('拍の AI のファイルが正しくありません');
  const n = new DataView(buf).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + n))) as Header;
  return { head, data: new Float32Array(buf, 8 + n) };
}

const view = (m: MadmomModel, r: Ref) => m.data.subarray(r[0], r[0] + r[1]);

// ---------- 44.1kHz にする ----------

/** 窓付き sinc で 44.1kHz にする */
export function to44k(x: Float32Array, sr: number): Float32Array {
  const SR = 44100;
  if (sr === SR) return x;
  const ratio = SR / sr;
  const cut = Math.min(1, ratio) * 0.97;
  const half = 16;
  const n = Math.floor(x.length * ratio);
  const out = new Float32Array(n);
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

// ---------- 前処理 ----------

/** 大きさ n の FFT（回転因子とビット反転の表を先に作っておく） */
function makeFFT(n: number) {
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / n);
    sin[k] = Math.sin((-2 * Math.PI * k) / n);
  }
  return (re: Float64Array, im: Float64Array) => {
    for (let i = 1; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const cr = cos[k * step];
          const ci = sin[k * step];
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  };
}

/** 窓の大きさ 1 つ分（ri 番目）の特徴（フレーム数 × 帯の数 × 2） */
export function featureBlock(m: MadmomModel, x: Float32Array, ri: number): Float32Array {
  const one: MadmomModel = { data: m.data, head: { ...m.head, res: [m.head.res[ri]] } };
  return features(one, x).feat;
}

/** 窓の大きさごとの特徴を横に並べる */
export function stackBlocks(m: MadmomModel, blocks: Float32Array[], frames: number): { feat: Float32Array; dim: number } {
  const widths = m.head.res.map((r) => r.bands.length * 2);
  const dim = widths.reduce((p, v) => p + v, 0);
  const feat = new Float32Array(frames * dim);
  for (let f = 0; f < frames; f++) {
    let col = 0;
    blocks.forEach((bl, i) => {
      feat.set(bl.subarray(f * widths[i], (f + 1) * widths[i]), f * dim + col);
      col += widths[i];
    });
  }
  return { feat, dim };
}

/** 44.1kHz の音のフレーム数 */
export const frameCount = (m: MadmomModel, n: number) => Math.ceil(n / (m.head.sr / m.head.fps));

/** 44.1kHz の音から、モデルに入れる特徴（フレーム数 × 314、フレームごとに並べる） */
export function features(m: MadmomModel, x: Float32Array): { feat: Float32Array; frames: number; dim: number } {
  const { head } = m;
  const hop = head.sr / head.fps; // 441
  const frames = Math.ceil(x.length / hop);
  const dim = head.res.reduce((p, r) => p + r.bands.length * 2, 0);
  const feat = new Float32Array(frames * dim);
  let col = 0;
  for (const r of head.res) {
    const N = r.frame;
    const fft = makeFFT(N);
    const win = view(m, r.window);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const nb = r.bands.length;
    const bands = r.bands.map((b) => ({ k0: b.k0, w: view(m, b.w) }));
    const spec = new Float32Array(frames * nb);
    const mag = new Float64Array(r.bins);
    for (let f = 0; f < frames; f++) {
      // 窓の真ん中が f × 441 サンプル目（外は 0）
      const start = Math.floor(f * hop) - (N >> 1);
      for (let i = 0; i < N; i++) {
        const j = start + i;
        re[i] = j >= 0 && j < x.length ? x[j] * win[i] : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 0; k < r.bins; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      for (let b = 0; b < nb; b++) {
        const { k0, w } = bands[b];
        let acc = 0;
        for (let i = 0; i < w.length; i++) acc += mag[k0 + i] * w[i];
        spec[f * nb + b] = Math.log10(acc + 1);
      }
    }
    for (let f = 0; f < frames; f++) {
      const o = f * dim + col;
      for (let b = 0; b < nb; b++) {
        const v = spec[f * nb + b];
        feat[o + b] = v;
        const d = f >= r.diff ? v - spec[(f - r.diff) * nb + b] : 0;
        feat[o + nb + b] = d > 0 ? d : 0;
      }
    }
    col += nb * 2;
  }
  return { feat, frames, dim };
}

// ---------- ニューラルネット（双方向 LSTM 3 層 + 出力 3 つ） ----------

const sigm = (v: number) => 1 / (1 + Math.exp(-v));

/** 4 つのゲート（入力・忘却・セル・出力）の重みを横に並べたもの（速く掛けるため） */
interface DirW { W: Float32Array; R: Float32Array; b: Float32Array; Pi: Float32Array | null; Pf: Float32Array | null; Po: Float32Array | null }
const dirCache = new WeakMap<DirH, DirW>();
function dirWeights(m: MadmomModel, d: DirH, nin: number, h: number): DirW {
  const hit = dirCache.get(d);
  if (hit) return hit;
  const gs = [d.input_gate, d.forget_gate, d.cell, d.output_gate];
  const H4 = h * 4;
  const W = new Float32Array(nin * H4);
  const R = new Float32Array(h * H4);
  const b = new Float32Array(H4);
  gs.forEach((g, gi) => {
    const w = view(m, g.W);
    const r = view(m, g.R);
    const bb = view(m, g.b);
    for (let i = 0; i < nin; i++) for (let j = 0; j < h; j++) W[i * H4 + gi * h + j] = w[i * h + j];
    for (let i = 0; i < h; i++) for (let j = 0; j < h; j++) R[i * H4 + gi * h + j] = r[i * h + j];
    for (let j = 0; j < h; j++) b[gi * h + j] = bb[j];
  });
  const P = (g: GateH) => (g.P ? view(m, g.P) : null);
  const w = { W, R, b, Pi: P(d.input_gate), Pf: P(d.forget_gate), Po: P(d.output_gate) };
  dirCache.set(d, w);
  return w;
}

/** 片方向の LSTM。入力（T × nin）→ 出力を out の col 列目から h 個に書く（out は T × stride） */
function lstm(m: MadmomModel, d: DirH, inp: Float32Array, T: number, nin: number, h: number, rev: boolean, out: Float32Array, stride: number, col: number) {
  const { W, R, b, Pi, Pf, Po } = dirWeights(m, d, nin, h);
  const H4 = h * 4;
  // 入力の重みを先にまとめて掛ける（T × 4h）
  const pre = new Float32Array(T * H4);
  const acc = new Float64Array(H4);
  for (let t = 0; t < T; t++) {
    const o = t * H4;
    for (let j = 0; j < H4; j++) acc[j] = b[j];
    const xo = t * nin;
    for (let i = 0; i < nin; i++) {
      const v = inp[xo + i];
      if (v === 0) continue;
      const wr = i * H4;
      for (let j = 0; j < H4; j++) acc[j] += v * W[wr + j];
    }
    for (let j = 0; j < H4; j++) pre[o + j] = acc[j];
  }
  const prev = new Float32Array(h);
  const state = new Float32Array(h);
  const z = new Float64Array(H4);
  for (let s = 0; s < T; s++) {
    const t = rev ? T - 1 - s : s;
    const base = t * H4;
    for (let j = 0; j < H4; j++) z[j] = pre[base + j];
    for (let i = 0; i < h; i++) {
      const v = prev[i];
      if (v === 0) continue;
      const rr = i * H4;
      for (let j = 0; j < H4; j++) z[j] += v * R[rr + j];
    }
    const o = t * stride + col;
    for (let j = 0; j < h; j++) {
      const st = state[j];
      const i1 = sigm(z[j] + (Pi ? st * Pi[j] : 0));
      const f1 = sigm(z[h + j] + (Pf ? st * Pf[j] : 0));
      const ns = Math.tanh(z[2 * h + j]) * i1 + st * f1;
      state[j] = ns;
      const o1 = sigm(z[3 * h + j] + (Po ? ns * Po[j] : 0));
      const y = Math.tanh(ns) * o1;
      out[o + j] = y;
      prev[j] = y;
    }
  }
}

/** 8 個のモデルの出力の平均（フレームごとに [拍, 小節の頭]） */
export async function activations(m: MadmomModel, feat: Float32Array, frames: number, dim: number, progress?: (p: number) => void, only?: number[]): Promise<Float32Array> {
  const act = new Float32Array(frames * 2);
  const models = m.head.models;
  const use = only ?? models.map((_, i) => i);
  for (let ui = 0; ui < use.length; ui++) {
    const mi = use[ui];
    const md = models[mi];
    let cur = feat;
    let nin = dim;
    for (const L of md.layers) {
      const out = new Float32Array(frames * L.h * 2);
      lstm(m, L.f, cur, frames, nin, L.h, false, out, L.h * 2, 0);
      lstm(m, L.b, cur, frames, nin, L.h, true, out, L.h * 2, L.h);
      cur = out;
      nin = L.h * 2;
    }
    const W = view(m, md.out.W);
    const b = view(m, md.out.b);
    const n = md.out.n;
    const z = new Float64Array(n);
    for (let t = 0; t < frames; t++) {
      let mx = -Infinity;
      for (let j = 0; j < n; j++) {
        let s = b[j];
        for (let i = 0; i < nin; i++) s += cur[t * nin + i] * W[i * n + j];
        z[j] = s;
        if (s > mx) mx = s;
      }
      let sum = 0;
      for (let j = 0; j < n; j++) {
        z[j] = Math.exp(z[j] - mx);
        sum += z[j];
      }
      // 出力は [拍でない, 拍, 小節の頭]。拍でないものは使わない
      act[t * 2] += z[1] / sum / use.length;
      act[t * 2 + 1] += z[2] / sum / use.length;
    }
    progress?.((ui + 1) / use.length);
    // 計算の合間に、進み具合の知らせを送り出せるように
    await new Promise((r) => setTimeout(r, 0));
  }
  return act;
}

// ---------- DBN（小節の中の位置と速さ） ----------

const FPS = 100;
const MIN_BPM = 55;
const MAX_BPM = 215;
const NUM_TEMPI = 60;
const TRANSITION_LAMBDA = 100;
const OBSERVATION_LAMBDA = 16;
const THRESHOLD = 0.05;

/** 1 拍の長さ（フレーム）の候補。log 間隔で 60 個（madmom の BeatStateSpace と同じ作り方） */
function intervals(): number[] {
  const lo = (60 * FPS) / MAX_BPM;
  const hi = (60 * FPS) / MIN_BPM;
  const lin = Math.round(hi) - Math.round(lo) + 1;
  if (NUM_TEMPI >= lin) {
    const out: number[] = [];
    for (let v = Math.round(lo); v <= Math.round(hi); v++) out.push(v);
    return out;
  }
  let n = NUM_TEMPI;
  let iv: number[] = [];
  while (iv.length < NUM_TEMPI) {
    const a = Math.log2(lo);
    const b = Math.log2(hi);
    const s = new Set<number>();
    for (let i = 0; i < n; i++) s.add(roundHalfEven(Math.pow(2, a + ((b - a) * i) / (n - 1))));
    iv = [...s].sort((p, q) => p - q);
    n++;
  }
  return iv;
}
/** numpy の round と同じ（ちょうど .5 は偶数へ） */
function roundHalfEven(v: number) {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-12) return f % 2 === 0 ? f : f + 1;
  return Math.round(v);
}

/**
 * 1 小節 beats 拍の DBN を解く。状態 = (拍 b, 速さ i, 拍の中の位置 p)。
 * 拍の中は 1 フレームずつ進み、拍の最後から次の拍の最初へ移るときだけ速さを変えられる。
 * 戻り値: 状態の並びをたどるための情報と、いちばん確からしい並びの対数確率
 */
function decode(obs: Float32Array, T: number, beats: number) {
  const iv = intervals();
  const NI = iv.length;
  const per = iv.reduce((p, v) => p + v, 0);
  const N = per * beats;
  // 速さ i の最初の状態（拍の中での番号）
  const firstIn: number[] = [];
  {
    let o = 0;
    for (const v of iv) {
      firstIn.push(o);
      o += v;
    }
  }
  const first = (b: number, i: number) => b * per + firstIn[i];
  const last = (b: number, i: number) => b * per + firstIn[i] + iv[i] - 1;
  // 速さを変えるときの確率（exponential_transition、行ごとに足して 1）
  const lt: Float64Array[] = [];
  const eps = 2.220446049250313e-16;
  for (let i = 0; i < NI; i++) {
    const row = new Float64Array(NI);
    let sum = 0;
    for (let j = 0; j < NI; j++) {
      const p = Math.exp(-TRANSITION_LAMBDA * Math.abs(iv[j] / iv[i] - 1));
      row[j] = p <= eps ? 0 : p;
      sum += row[j];
    }
    for (let j = 0; j < NI; j++) row[j] = row[j] > 0 ? Math.log(row[j] / sum) : -Infinity;
    lt.push(row);
  }
  // 速さ i の拍の最初へ来られる、前の拍の速さ j の一覧（確率が 0 でないもの、j の小さい順）
  const from: Int32Array[] = [];
  const fromLp: Float64Array[] = [];
  for (let i = 0; i < NI; i++) {
    const js: number[] = [];
    for (let j = 0; j < NI; j++) if (lt[j][i] > -Infinity) js.push(j);
    from.push(Int32Array.from(js));
    fromLp.push(Float64Array.from(js.map((j) => lt[j][i])));
  }
  const lastOf: Int32Array[] = [];
  for (let b = 0; b < beats; b++) lastOf.push(Int32Array.from(iv.map((_, j) => last(b, j))));
  // 観測: 拍の最初の 1/16 は「拍」（1 拍目は「小節の頭」）、それ以外は「拍でない」
  const ptr = new Uint8Array(N);
  for (let b = 0; b < beats; b++) {
    for (let i = 0; i < NI; i++) {
      for (let p = 0; p < iv[i]; p++) {
        const pos = p / iv[i];
        ptr[first(b, i) + p] = pos < 1 / OBSERVATION_LAMBDA ? (b === 0 ? 2 : 1) : 0;
      }
    }
  }
  let v = new Float64Array(N).fill(Math.log(1 / N));
  let nv = new Float64Array(N);
  // 拍の最初の状態にどこから来たか（速さの番号）。それ以外の状態は 1 つ前の状態から来る
  const bt = new Uint8Array(T * beats * NI);
  const dens = new Float64Array(3);
  for (let f = 0; f < T; f++) {
    const a0 = obs[f * 2];
    const a1 = obs[f * 2 + 1];
    dens[0] = Math.log((1 - (a0 + a1)) / (OBSERVATION_LAMBDA - 1));
    dens[1] = Math.log(a0);
    dens[2] = Math.log(a1);
    for (let b = 0; b < beats; b++) {
      const pb = (b + beats - 1) % beats;
      for (let i = 0; i < NI; i++) {
        // 拍の中: 1 つ前の状態から
        const s0 = first(b, i);
        for (let p = 1; p < iv[i]; p++) nv[s0 + p] = v[s0 + p - 1] + dens[ptr[s0 + p]];
        // 拍の最初: 前の拍のどれかの速さの最後から（確率が 0 でない速さだけ）
        let best = -Infinity;
        let bj = 0;
        const src = from[i];
        const lp = fromLp[i];
        const lb = lastOf[pb];
        for (let q = 0; q < src.length; q++) {
          const j = src[q];
          const c = v[lb[j]] + lp[q];
          if (c > best) {
            best = c;
            bj = j;
          }
        }
        nv[s0] = best + dens[ptr[s0]];
        bt[(f * beats + b) * NI + i] = bj;
      }
    }
    const tmp = v;
    v = nv;
    nv = tmp;
  }
  let s = 0;
  for (let i = 1; i < N; i++) if (v[i] > v[s]) s = i;
  const logp = v[s];
  // 後ろからたどる
  const path = new Int32Array(T);
  const where = (st: number) => {
    const b = Math.floor(st / per);
    const r = st - b * per;
    let i = 0;
    while (i + 1 < NI && firstIn[i + 1] <= r) i++;
    return { b, i, p: r - firstIn[i] };
  };
  for (let f = T - 1; f >= 0; f--) {
    path[f] = s;
    const w = where(s);
    if (w.p > 0) s = s - 1;
    else s = last((w.b + beats - 1) % beats, bt[(f * beats + w.b) * NI + w.i]);
  }
  return { path, logp, ptr, per, iv, firstIn };
}

/** 拍と小節の頭の確からしさから、拍の時刻と小節の頭を求める（madmom の DBNDownBeatTrackingProcessor、correct=True） */
export function dbnDownbeats(act: Float32Array, frames: number): MadmomResult {
  // 確からしさが 0.05 以上の所だけ（前後の静かな所は使わない）
  let lo = -1;
  let hi = -1;
  for (let f = 0; f < frames; f++) {
    if (act[f * 2] >= THRESHOLD || act[f * 2 + 1] >= THRESHOLD) {
      if (lo < 0) lo = f;
      hi = f + 1;
    }
  }
  if (lo < 0) return { beats: [], downbeats: [], beatsPerBar: 4 };
  const T = hi - lo;
  const obs = act.subarray(lo * 2, hi * 2);
  let best: (ReturnType<typeof decode> & { beats: number }) | null = null;
  for (const beats of [3, 4]) {
    const r = decode(obs, T, beats);
    if (!best || r.logp > best.logp) best = { ...r, beats };
  }
  const { path, ptr, per, iv, firstIn, beats } = best!;
  const beatNo = (st: number) => Math.floor(st / per);
  // 「拍」の範囲（観測が拍・小節の頭の状態）が続く所ごとに、確からしさがいちばん高いフレームを拍にする
  const out: { t: number; n: number }[] = [];
  let f = 0;
  while (f < T) {
    if (ptr[path[f]] < 1) {
      f++;
      continue;
    }
    let e = f;
    while (e < T && ptr[path[e]] >= 1) e++;
    let pk = f;
    let pv = -Infinity;
    for (let g = f; g < e; g++) {
      for (const c of [0, 1]) {
        if (obs[g * 2 + c] > pv) {
          pv = obs[g * 2 + c];
          pk = g;
        }
      }
    }
    out.push({ t: (pk + lo) / FPS, n: beatNo(path[pk]) + 1 });
    f = e;
  }
  void iv;
  void firstIn;
  return { beats: out.map((x) => x.t), downbeats: out.filter((x) => x.n === 1).map((x) => x.t), beatsPerBar: beats };
}

// ---------- まとめ ----------

/** 拍の AI で、拍と小節の頭を求める。progress は 0〜1 */
export async function runMadmom(m: MadmomModel, mono: Float32Array, sr: number, progress?: (p: number) => void): Promise<MadmomResult> {
  const x = to44k(mono, sr);
  progress?.(0.02);
  const { feat, frames, dim } = features(m, x);
  progress?.(0.1);
  const act = await activations(m, feat, frames, dim, (p) => progress?.(0.1 + p * 0.8));
  const r = dbnDownbeats(act, frames);
  progress?.(1);
  return r;
}

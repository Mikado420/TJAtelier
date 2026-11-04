/**
 * BPM・OFFSET の自動測定。
 *
 * 1. 音の立ち上がりの強さ（スペクトルの増え方 = spectral flux）を約 11.6ms ごとに求める
 * 2. 8 秒の窓を 1 秒ずつずらしながら、その区間でいちばん繰り返しの強いテンポを求め、
 *    曲全体を通して「なるべく同じテンポが続く」ようにつなぐ（Viterbi）。テンポが変わり続ける所が BPM の変わり目
 * 3. 同じテンポの区間ごとに、区間全体の立ち上がりを重ねて BPM と拍の位置を細かく合わせ、
 *    さらに 1 拍ずつ実際の立ち上がりの時刻を拾って、区間全体で直線に当てはめる（1 小節だけで決めない）
 * 4. きりのいい BPM（整数・小数 1〜2 桁）でも区間全体のずれが小さければ、そちらを使う
 * 5. 低い音（キックなど）の強さから小節の頭（1 拍目）を決め、最初の 1 拍目の時刻から OFFSET を決める
 *
 * 描画や DOM に依存しないので、Web Worker の中でもテストでも動く。
 */

export interface TempoSegment {
  /** 区間の最初の拍と、次の区間の最初の拍（拍の番号） */
  startBeat: number;
  endBeat: number;
  /** 区間の始まり・終わり（秒） */
  start: number;
  end: number;
  /** 使う BPM（曲全体のずれが増えない範囲で、きりのいい値に丸めたもの） */
  bpm: number;
  /** 測った BPM（丸める前、曲全体でつながるように合わせた値） */
  rawBpm: number;
  /** 区間の拍の数と、実際の音の立ち上がりと合った拍の数 */
  beats: number;
  matched: number;
  /** 合った拍の、決めた BPM の拍とのずれ（ミリ秒、二乗平均） */
  jitterMs: number;
  /** 区間の頭が小節の頭だと分かっている */
  barStart?: boolean;
  /**
   * この区間の拍の線を、区間どうしを「ちょうど何拍」でつないだ位置から何秒ずらすか（最初の区間からの差）。
   * 譜面にするときは、前の区間の長さを半端な拍数だけ伸び縮みさせて表す（BPM の変わり目の 0.5 拍・3.75 拍の小節など）
   */
  lead?: number;
}

export interface TempoResult {
  segments: TempoSegment[];
  /** 拍 0 の時刻（曲全体でつながるように合わせた値） */
  t0: number;
  /** 小節の頭（1 拍目）の拍の番号 */
  downbeat: number;
  /** 曲の長さ（秒） */
  duration: number;
  /** 測り方の途中経過（うまく測れないときの確認用） */
  info?: string;
  /**
   * 拍子（小節の長さ）の変わる所。beat はその小節の頭の拍の番号（downbeat と同じ数え方）。
   * 最初のものは downbeat の位置。途中で 1 小節だけ短い・長い小節があるときも、ここに入る
   */
  meters?: { beat: number; num: number; den: number }[];
  /** 区間ごとに自動で決めた拍子 */
  meterAuto?: Meter[];
  /** 半拍ごとの音の強さ（区間の頭から順に。拍子を決め直すのに使う） */
  beatAcc?: number[];
  /** 拍の AI が見つけた小節の頭の時刻（秒）。拍子と小節の頭を決めるときに、音の強さより重く見る */
  aiDowns?: number[];
}

/** 拍子（num/den。4/4 なら 1 小節 = 4 拍） */
export interface Meter { num: number; den: number }
/** 1 小節の拍数（4 分音符で数える） */
export const meterLen = (m: Meter) => (m.num * 4) / m.den;

// ---------- FFT ----------

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

// ---------- 立ち上がりの強さ ----------

interface Envelope {
  /** 全体の立ち上がりの強さ（1 フレームごと） */
  all: Float32Array;
  /** 低い音（約 150Hz まで）の立ち上がりの強さ。小節の頭を決めるのに使う */
  low: Float32Array;
  /** 1 秒あたりのフレーム数 */
  fr: number;
  /** フレーム i の時刻 = t0 + i / fr */
  t0: number;
  /** 元の音（立ち上がりの時刻を元の細かさで求めるのに使う） */
  x: Float32Array;
  sr: number;
}

const N = 1024;
const HOP = 128;

function envelope(mono: Float32Array, sr: number, progress?: (p: number) => void): Envelope {
  // 約 11kHz に落とす（平均をとって間引く）
  const f = Math.max(1, Math.round(sr / 11025));
  const srD = sr / f;
  const len = Math.floor(mono.length / f);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += mono[i * f + k];
    x[i] = s / f;
  }
  const frames = Math.max(0, Math.floor((len - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const bins = N / 2;
  const lowBin = Math.max(2, Math.round((150 * N) / srD));
  const prev = new Float64Array(bins);
  const all = new Float32Array(frames);
  const low = new Float32Array(frames);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let fi = 0; fi < frames; fi++) {
    const o = fi * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let sa = 0;
    let sl = 0;
    for (let b = 1; b < bins; b++) {
      const m = Math.log(1 + 100 * Math.hypot(re[b], im[b]));
      const d = m - prev[b];
      prev[b] = m;
      if (d > 0) {
        sa += d;
        if (b <= lowBin) sl += d;
      }
    }
    all[fi] = fi === 0 ? 0 : sa;
    low[fi] = fi === 0 ? 0 : sl;
    if (progress && fi % 2000 === 0) progress((fi / frames) * 0.5);
  }
  // ゆっくりした音量の変化を引いて、立ち上がりだけを残す
  const norm = (a: Float32Array) => {
    const w = 20;
    const out = new Float32Array(a.length);
    let sum = 0;
    const q: number[] = [];
    for (let i = 0; i < a.length; i++) {
      q.push(a[i]);
      sum += a[i];
      if (q.length > w * 2 + 1) sum -= q.shift()!;
      const c = i - w;
      if (c >= 0) out[c] = Math.max(0, a[c] - sum / q.length);
    }
    let s2 = 0;
    for (let i = 0; i < out.length; i++) s2 += out[i] * out[i];
    const sd = Math.sqrt(s2 / Math.max(1, out.length)) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  };
  return { all: norm(all), low: norm(low), fr: srD / HOP, t0: N / 2 / srD, x: mono, sr };
}

/** 拍の時刻を合わせるときの、音の立ち上がり */
function fineOnset(env: Envelope, t: number, radius: number): number {
  return onsetIn(env, t, radius).t;
}

/**
 * t の近く（±radius 秒）で、音が鳴り始めた時刻を元の細かさで求める。
 * 3. 約 3ms ずつの音の大きさを前後で比べ、いちばん増えた所を、元の音（44.1kHz など）の 1 サンプル単位で探す
 * 4. そこから前へたどって、音が大きくなり始めた所（音量の山ではなく始まり）にする
 * clear: 立ち上がりのはっきりさ（山 ÷ 底）
 */
function onsetIn(env: Envelope, t: number, radius: number): { t: number; clear: number } {
  const { x, sr } = env;
  const n = x.length;
  const c = Math.round(t * sr);
  const r = Math.round(radius * sr);
  const W = Math.max(8, Math.round(sr * 0.003));
  const lo = Math.max(W * 2, c - r - W * 4);
  const hi = Math.min(n - W * 2, c + r + W * 2);
  if (hi <= lo) return { t, clear: 0 };
  // 区間の中だけ、音の大きさの累積和をとる
  const cum = new Float64Array(hi - lo + W * 4 + 1);
  const base = lo - W * 2;
  for (let i = 0; i < cum.length - 1; i++) {
    const v = x[base + i] ?? 0;
    cum[i + 1] = cum[i] + v * v;
  }
  const e = (i: number, w: number) => (cum[i - base + w] - cum[i - base]) / w + 1e-10;
  let best = c;
  let bv = -Infinity;
  for (let i = Math.max(lo, c - r); i <= Math.min(hi, c + r); i++) {
    const d = Math.log(e(i, W)) - Math.log(e(i - W, W));
    if (d > bv) {
      bv = d;
      best = i;
    }
  }
  // 始まり: いちばん増えた所の前 3ms〜後 12ms で、音の大きさ（約 1ms ごと）の底と山を見て、
  // いちばん増えた所から前へ、底から山までの 10% を下回る所まで戻る（底より前・後ろへは動かさない）
  const w1 = Math.max(4, Math.round(sr * 0.001));
  const s0 = Math.max(lo, best - W);
  const s1 = Math.min(hi - w1, best + Math.round(sr * 0.012));
  let floor = Infinity;
  for (let i = s0; i <= best; i++) floor = Math.min(floor, e(i, w1));
  let peak = 0;
  for (let i = best; i <= s1; i++) peak = Math.max(peak, e(i, w1));
  const clear = peak / floor;
  if (!(clear > 1.5)) return { t: best / sr, clear };
  const th = floor + (peak - floor) * 0.1;
  let start = best;
  while (start > s0 && e(start - 1, w1) > th) start--;
  return { t: start / sr, clear };
}

/**
 * t の近く（±radius 秒）の、音が大きくなり始めた所をすべて（約 3ms の音の大きさが 2 倍以上に増えた所の山ごとに、
 * 鳴り始めまで戻した時刻）。窓の位置によって拾う音が変わらないよう、いちばん強いものだけでなく全部を返す
 */
function onsetCands(env: Envelope, t: number, radius: number): { t: number; w: number }[] {
  const { x, sr } = env;
  const n = x.length;
  const c = Math.round(t * sr);
  const r = Math.round(radius * sr);
  const W = Math.max(8, Math.round(sr * 0.003));
  const lo = Math.max(W * 2, c - r - W * 4);
  const hi = Math.min(n - W * 2, c + r + W * 2);
  if (hi <= lo) return [];
  const cum = new Float64Array(hi - lo + W * 4 + 1);
  const base = lo - W * 2;
  for (let i = 0; i < cum.length - 1; i++) {
    const v = x[base + i] ?? 0;
    cum[i + 1] = cum[i] + v * v;
  }
  const e = (i: number, w: number) => (cum[i - base + w] - cum[i - base]) / w + 1e-10;
  const a = Math.max(lo, c - r);
  const b = Math.min(hi, c + r);
  const step = Math.max(1, Math.round(sr * 0.0005));
  const d: number[] = [];
  for (let i = a; i <= b; i += step) d.push(Math.log(e(i, W)) - Math.log(e(i - W, W)));
  const out: { t: number; w: number }[] = [];
  const w1 = Math.max(4, Math.round(sr * 0.001));
  for (let k = 1; k + 1 < d.length; k++) {
    if (d[k] < Math.LN2 || d[k] < d[k - 1] || d[k] < d[k + 1]) continue;
    // 近くにもっと強い山があれば、そちらの一部
    let top = true;
    for (let q = Math.max(0, k - Math.round(W / step)); q <= Math.min(d.length - 1, k + Math.round(W / step)); q++) if (d[q] > d[k]) top = false;
    if (!top) continue;
    const best = a + k * step;
    const s0 = Math.max(lo, best - W);
    let floor = Infinity;
    for (let i = s0; i <= best; i++) floor = Math.min(floor, e(i, w1));
    let peak = 0;
    for (let i = best; i <= Math.min(hi - w1, best + Math.round(sr * 0.012)); i++) peak = Math.max(peak, e(i, w1));
    const th = floor + (peak - floor) * 0.1;
    let st = best;
    while (st > s0 && e(st - 1, w1) > th) st--;
    out.push({ t: st / sr, w: d[k] });
  }
  return out;
}

// ---------- テンポの流れ ----------

const BPM_MIN = 50;
const BPM_MAX = 320;
const NBIN = 240;
const binBpm = (i: number) => BPM_MIN * Math.pow(BPM_MAX / BPM_MIN, i / (NBIN - 1));

/** 窓ごとのテンポの強さ（自己相関を、拍の倍数の所で足し合わせる） */
function tempogram(env: Float32Array, fr: number, progress?: (p: number) => void) {
  const W = Math.round(8 * fr);
  const H = Math.round(1 * fr);
  const lagMax = Math.ceil((fr * 60 * 4) / BPM_MIN) + 2;
  const out: { center: number; score: Float32Array }[] = [];
  const count = Math.max(1, Math.floor((env.length - W) / H) + 1);
  for (let w = 0; w < count; w++) {
    const a = Math.min(w * H, Math.max(0, env.length - W));
    const b = Math.min(env.length, a + W);
    const r = new Float32Array(Math.min(lagMax, b - a));
    for (let l = 0; l < r.length; l++) {
      let s = 0;
      for (let i = a; i + l < b; i++) s += env[i] * env[i + l];
      r[l] = s;
    }
    const at = (lag: number) => {
      const i = Math.floor(lag);
      if (i + 1 >= r.length) return 0;
      const t = lag - i;
      return r[i] * (1 - t) + r[i + 1] * t;
    };
    const score = new Float32Array(NBIN);
    let mx = 1e-9;
    for (let k = 0; k < NBIN; k++) {
      const bpm = binBpm(k);
      const lag = (60 * fr) / bpm;
      // 拍の長さと、その 2 倍の所の繰り返し。倍数を多く足すと遅いテンポ（半分の速さ）に寄りやすいので 2 倍まで
      let s = at(lag) + 0.5 * at(2 * lag);
      // 太鼓の曲でよくある速さ（140〜250 くらい）を優先する（倍・半分の取り違えを減らす）
      const PC = 190;
      const PS = 0.5;
      // 優先するのは「倍・半分のうちどれか」を選ぶときだけ。倍・半分の関係にない速さ（175 と 130 など）どうしは公平に比べる
      const prf = (b: number) => Math.exp(-0.5 * Math.pow(Math.log2(b / PC) / PS, 2));
      let pm = 0;
      for (let j = -3; j <= 3; j++) {
        const b2 = bpm * Math.pow(2, j);
        if (b2 >= BPM_MIN && b2 <= BPM_MAX) pm = Math.max(pm, prf(b2));
      }
      const pr = prf(bpm) / pm;
      const PW = 0.75;
      s *= 1 - PW + PW * pr;
      score[k] = s;
      if (s > mx) mx = s;
    }
    for (let k = 0; k < NBIN; k++) score[k] /= mx;
    out.push({ center: (a + (b - a) / 2) / fr, score });
    if (progress && w % 10 === 0) progress(0.5 + (w / count) * 0.3);
  }
  return out;
}

/** 窓ごとのテンポを、曲全体で「なるべく同じテンポが続く」ようにつなぐ */
function tempoPath(tg: { score: Float32Array }[]): number[] {
  const T = tg.length;
  if (!T) return [];
  const JUMP = 1.2; // テンポを大きく変えるときの減点（1 窓だけ外れた値には引っぱられない）
  let cur = Float64Array.from(tg[0].score);
  const back: Int16Array[] = [];
  for (let t = 1; t < T; t++) {
    let best = 0;
    for (let k = 1; k < NBIN; k++) if (cur[k] > cur[best]) best = k;
    const nxt = new Float64Array(NBIN);
    const bk = new Int16Array(NBIN);
    for (let k = 0; k < NBIN; k++) {
      // 近くのテンポ（±2 段 ≒ ±1.6%）へは減点なし、それ以外はどこからでも JUMP の減点で移れる
      let v = cur[best] - JUMP;
      let from = best;
      for (let d = -2; d <= 2; d++) {
        const j = k + d;
        if (j < 0 || j >= NBIN) continue;
        if (cur[j] > v) {
          v = cur[j];
          from = j;
        }
      }
      nxt[k] = v + tg[t].score[k];
      bk[k] = from;
    }
    back.push(bk);
    cur = nxt;
  }
  let k = 0;
  for (let i = 1; i < NBIN; i++) if (cur[i] > cur[k]) k = i;
  const path = new Array<number>(T);
  path[T - 1] = k;
  for (let t = T - 1; t > 0; t--) {
    k = back[t - 1][k];
    path[t - 1] = k;
  }
  return path.map(binBpm);
}

// ---------- 区間ごとに細かく合わせる ----------

/** フレームの山の位置（放物線で細かく） */
function peakNear(env: Float32Array, fr: number, t0: number, t: number, radius: number) {
  const c = Math.round((t - t0) * fr);
  const r = Math.max(1, Math.round(radius * fr));
  let bi = -1;
  let bv = 0;
  for (let i = Math.max(1, c - r); i <= Math.min(env.length - 2, c + r); i++) {
    if (env[i] > bv && env[i] >= env[i - 1] && env[i] >= env[i + 1]) {
      bv = env[i];
      bi = i;
    }
  }
  if (bi < 0) return null;
  const a = env[bi - 1];
  const b = env[bi];
  const cc = env[bi + 1];
  const den = a - 2 * b + cc;
  const off = den < 0 ? (0.5 * (a - cc)) / den : 0;
  return { t: t0 + (bi + Math.max(-0.5, Math.min(0.5, off))) / fr, v: bv };
}


// ---------- 拍を 1 つずつ追う ----------

/**
 * 拍の列を求める（動的計画法。状態 =「この時刻に拍があり、前の拍との間隔が p フレーム」）。
 * - 間隔は 1 拍ごとに 1 フレームまでなら自由に変えられる（少しずつ・1 小節ごとに速くなる曲を追える）
 * - それより大きく変えるとき（BPM が急に変わる所）は JUMP の減点
 * - テンポの流れ（tempoAt）から大きく離れる間隔（倍・半分の取り違え）は減点
 */
function trackBeats(env: Float32Array, fr: number, tempoAt: (sec: number) => number): number[] {
  const n = env.length;
  const pMin = Math.max(4, Math.floor((60 * fr) / BPM_MAX));
  const pMax = Math.ceil((60 * fr) / BPM_MIN);
  const np = pMax - pMin + 1;
  const C = new Float32Array(n * np).fill(-1e9);
  const back = new Int32Array(n * np).fill(-1); // 前の拍の (時刻 × np + 間隔の番号)、-1 は始まり
  const M = new Float32Array(n).fill(-1e9); // その時刻の拍の、いちばん高い点
  const Marg = new Int32Array(n).fill(-1);
  const JUMP = 2.5;
  const BETA = 3;
  // 拍 1 つごとの減点: 細かい音（8 分のハイハットなど）まで拍として拾うと拍の数が増えて得をしてしまうのを防ぐ
  const peaks: number[] = [];
  for (let i = 1; i + 1 < n; i++) if (env[i] > 0 && env[i] >= env[i - 1] && env[i] > env[i + 1]) peaks.push(env[i]);
  peaks.sort((a, b) => a - b);
  const KAPPA = (0.7) * (peaks[Math.floor(peaks.length * 0.75)] ?? 0);
  for (let t = 0; t < n; t++) {
    const pg = (60 * fr) / tempoAt(t / fr);
    const e = env[t];
    let mBest = -1e9;
    let mArg = -1;
    for (let pi = 0; pi < np; pi++) {
      const p = pMin + pi;
      const l = Math.log2(p / pg);
      let best = 0; // 前の拍がない（ここから始まる）
      let arg = -1;
      const u = t - p;
      if (u >= 0) {
        for (let d = -1; d <= 1; d++) {
          const q = pi + d;
          if (q < 0 || q >= np) continue;
          const v = C[u * np + q];
          if (v > best) {
            best = v;
            arg = u * np + q;
          }
        }
        const vj = M[u] - JUMP;
        if (vj > best) {
          best = vj;
          arg = Marg[u];
        }
      }
      const v = e - KAPPA - BETA * l * l + best;
      C[t * np + pi] = v;
      back[t * np + pi] = arg;
      if (v > mBest) {
        mBest = v;
        mArg = t * np + pi;
      }
    }
    M[t] = mBest;
    Marg[t] = mArg;
  }
  // 最後の 1.5 秒の中で、いちばん点の高い所から逆にたどる
  let end = -1;
  let ev = -Infinity;
  for (let t = Math.max(0, n - Math.round(1.5 * fr)); t < n; t++) if (M[t] > ev) { ev = M[t]; end = Marg[t]; }
  const beats: number[] = [];
  for (let s = end; s >= 0; s = back[s]) beats.push(Math.floor(s / np));
  return beats.reverse();
}

// ---------- テンポが一定の区間に分ける ----------


// ---------- テンポが一定の区間に分ける ----------

interface Stat { w: number; k: number; t: number; kk: number; kt: number; tt: number; n: number }

/**
 * 拍の列を「BPM が一定の区間」に分ける（区間の数を増やすほど減点し、ずれの合計との兼ね合いで決める）。
 * 区間は 1 小節（4 拍）以上。1 小節ごとに速くなる曲も、1 小節ずつの区間になる
 */
function segmentBeats(t: number[], w: number[], minLen: number, barPhase = -1): number[] {
  const B = t.length;
  const pre: Stat[] = [{ w: 0, k: 0, t: 0, kk: 0, kt: 0, tt: 0, n: 0 }];
  for (let k = 0; k < B; k++) {
    const p = pre[k];
    const wk = w[k];
    pre.push({
      w: p.w + wk, k: p.k + wk * k, t: p.t + wk * t[k], kk: p.kk + wk * k * k,
      kt: p.kt + wk * k * t[k], tt: p.tt + wk * t[k] * t[k], n: p.n + (wk > 0 ? 1 : 0),
    });
  }
  // 拍のずれの大きさ（曲から見積もる）: 隣り合う 3 拍の「間隔の差」のばらつき。テンポの変化にはほとんど左右されない
  const d2: number[] = [];
  for (let k = 1; k + 1 < B; k++) if (w[k - 1] > 0 && w[k] > 0 && w[k + 1] > 0) d2.push(Math.abs(t[k + 1] - 2 * t[k] + t[k - 1]));
  d2.sort((a, b) => a - b);
  const sigEst = ((d2[Math.floor(d2.length / 2)] ?? 0.003) * 1.4826) / Math.sqrt(6);
  const SIGMA = Math.min(0.006, Math.max(0.0008, sigEst));
  const LAMBDA = 6; // 区間を 1 つ増やす減点
  const OFFBAR = 6;
  // 区間 [i, j) の拍の間隔は、拍 i〜j（次の区間の最初の拍まで）で決まるので、拍 j も入れて当てはめる
  const cost = (i: number, j: number) => {
    const a = pre[i];
    const b = pre[Math.min(j + 1, B)];
    const sw = b.w - a.w;
    const n = b.n - a.n;
    if (n < 3 || sw <= 0) return n === 0 ? LAMBDA : Infinity; // 音のない所は前後とつなぐ
    const sk = b.k - a.k, st = b.t - a.t, skk = b.kk - a.kk, skt = b.kt - a.kt, stt = b.tt - a.tt;
    // 数値の誤差を減らすため、区間の最初の拍を基準にして計算する
    const k0 = i;
    const skc = sk - k0 * sw;
    const skkc = skk - 2 * k0 * sk + k0 * k0 * sw;
    const sktc = skt - k0 * st;
    const den = sw * skkc - skc * skc;
    if (den <= 1e-12) return Infinity;
    const P = (sw * sktc - skc * st) / den;
    const A = (st - P * skc) / sw;
    const sse = Math.max(0, stt - 2 * A * st - 2 * P * sktc + A * A * sw + 2 * A * P * skc + P * P * skkc);
    return sse / sw * (n) / (SIGMA * SIGMA) + LAMBDA;
  };
  const best = new Float64Array(B + 1).fill(Infinity);
  const from = new Int32Array(B + 1).fill(-1);
  best[0] = 0;
  for (let j = minLen; j <= B; j++) {
    for (let i = 0; i <= j - minLen; i++) {
      if (!Number.isFinite(best[i])) continue;
      // BPM の変わり目は小節の頭が多いので、小節の頭でない所で変えるときは少し減点
      const c = best[i] + cost(i, j) + (i > 0 && barPhase >= 0 && (((i - barPhase) % 4) + 4) % 4 !== 0 ? OFFBAR : 0);
      if (c < best[j]) {
        best[j] = c;
        from[j] = i;
      }
    }
  }
  // 最後まで届かない（拍が少ない）ときは 1 区間
  if (!Number.isFinite(best[B])) return [0];
  const starts: number[] = [];
  for (let j = B; j > 0; j = from[j]) starts.push(from[j]);
  return starts.reverse();
}

// ---------- 曲全体でつながるように合わせる ----------

/**
 * 区間ごとの拍の長さ P_j と、拍 0 の時刻 t0 を、曲全体の拍の時刻に重み付きで当てはめる。
 * 拍 k の時刻 = t0 + （それまでの区間の拍数 × その区間の P）の合計 + （区間の中の拍数 × P_j）。
 * fixed[j] が数なら、その区間の P は固定（きりのいい BPM を試すとき）
 */
export function jointFit(t: number[], w: number[], starts: number[], fixed: (number | null)[]) {
  const m = starts.length;
  const B = t.length;
  const free = fixed.map((f, j) => (f === null ? j : -1)).filter((j) => j >= 0);
  const nv = 1 + free.length;
  const idx = new Map(free.map((j, i) => [j, i + 1]));
  const A = Array.from({ length: nv }, () => new Float64Array(nv));
  const bvec = new Float64Array(nv);
  // 拍 k の係数: [1, 区間ごとの拍数...]
  const coef = new Float64Array(m);
  const rowFor = (k: number) => {
    coef.fill(0);
    for (let j = 0; j < m; j++) {
      const s = starts[j];
      const e = j + 1 < m ? starts[j + 1] : Infinity;
      if (k >= e) coef[j] = e - s;
      else if (k > s) coef[j] = k - s;
    }
  };
  for (let k = 0; k < B; k++) {
    if (w[k] <= 0) continue;
    rowFor(k);
    let y = t[k];
    const row = new Float64Array(nv);
    row[0] = 1;
    for (let j = 0; j < m; j++) {
      if (fixed[j] !== null) y -= coef[j] * (fixed[j] as number);
      else row[idx.get(j)!] = coef[j];
    }
    for (let a = 0; a < nv; a++) {
      bvec[a] += w[k] * row[a] * y;
      for (let b = 0; b < nv; b++) A[a][b] += w[k] * row[a] * row[b];
    }
  }
  // ガウスの消去法
  for (let c = 0; c < nv; c++) {
    let piv = c;
    for (let r = c + 1; r < nv; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]];
    [bvec[c], bvec[piv]] = [bvec[piv], bvec[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < nv; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let q = c; q < nv; q++) A[r][q] -= f * A[c][q];
      bvec[r] -= f * bvec[c];
    }
  }
  const x = Array.from({ length: nv }, (_, i) => (Math.abs(A[i][i]) > 1e-12 ? bvec[i] / A[i][i] : 0));
  const P = fixed.map((f, j) => (f === null ? x[idx.get(j)!] : (f as number)));
  const t0 = x[0];
  // 当てはまり具合
  const pred = (k: number) => {
    rowFor(k);
    let v = t0;
    for (let j = 0; j < m; j++) v += coef[j] * P[j];
    return v;
  };
  let sw = 0;
  let s2 = 0;
  let mx = 0;
  for (let k = 0; k < B; k++) {
    if (w[k] <= 0) continue;
    const r = t[k] - pred(k);
    sw += w[k];
    s2 += w[k] * r * r;
    mx = Math.max(mx, Math.abs(r));
  }
  return { t0, P, rms: Math.sqrt(s2 / Math.max(1e-9, sw)), max: mx, pred };
}

/** 細かい測り方: 拍を 1 つずつ追い、BPM が変わる所（1 小節ごとの変化も）を見つける */
function analyzeFine(env: Envelope, tg: { center: number; score: Float32Array }[], path: number[], duration: number, progress?: (p: number) => void): TempoResult {
  const tempoAt = (sec: number) => {
    if (!path.length) return 120;
    let i = 0;
    while (i + 1 < tg.length && tg[i + 1].center <= sec) i++;
    return path[i];
  };
  progress?.(0.82);
  // 1. 拍を 1 つずつ追う
  // 拍を追うときは、低い音（キック・太鼓など）の立ち上がりを重く見る（裏拍のハイハットなどに乗りにくくする）
  const LOWW = 1.5;
  const beatEnv = new Float32Array(env.all.length);
  for (let i = 0; i < beatEnv.length; i++) beatEnv[i] = env.all[i] + LOWW * env.low[i];
  const frames = trackBeats(beatEnv, env.fr, tempoAt);
  progress?.(0.9);
  // 2. それぞれの拍の、実際の音の立ち上がりの時刻（1ms 単位）と強さ
  const vals: number[] = [];
  const raw = frames.map((f) => {
    const tt = env.t0 + f / env.fr;
    const p = peakNear(env.all, env.fr, env.t0, tt, 0.035);
    if (p) vals.push(p.v);
    return { tt, p };
  });
  const sorted = [...vals].sort((a, b) => a - b);
  const thr = (sorted[Math.floor(sorted.length * 0.5)] ?? 0) * 0.35;
  // 拍の番号は、追った拍を数えるのではなく「前の確かな拍からの時間 ÷ 拍の長さ」を丸めて決める。
  // 追った拍が一時的に裏拍や 3 連のリズムに引っぱられても、拍の数え間違い（曲全体のずれ）にならない
  const med = sorted[Math.floor(sorted.length * 0.5)] || 1;
  const pts: { k: number; t: number; w: number }[] = [];
  let lastT = -1;
  let lastK = 0;
  let lastI = 0;
  let skips = 0;
  // 拍の長さの目安: 追った拍の間隔の、その近くでの真ん中の値（BPM が急に変わった所でもすぐ合う）
  const ibi = frames.map((f, i) => (i ? (f - frames[i - 1]) / env.fr : 0));
  const localP = (i0: number, i1: number) => {
    const v: number[] = [];
    for (let i = Math.max(1, i0 - 3); i <= Math.min(ibi.length - 1, i1 + 3); i++) v.push(ibi[i]);
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)] || 60 / tempoAt(frames[i0] / env.fr);
  };
  for (let ri = 0; ri < raw.length; ri++) {
    const r = raw[ri];
    if (!r.p || r.p.v < thr) continue;
    const tt = fineOnset(env, r.p.t, 0.03);
    const ww = Math.min(3, r.p.v / med);
    let k = 0;
    if (lastT >= 0) {
      const P = localP(lastI, ri);
      const x = (tt - lastT) / P;
      const nn = Math.round(x);
      if (nn >= 1 && Math.abs(x - nn) <= 0.22) {
        k = lastK + nn;
        skips = 0;
      } else if (++skips >= 8) {
        // 8 回続けて拍の格子から外れた → 拍の位置そのものがずれた（BPM が急に変わった等）とみなして、ここから数え直す
        k = lastK + Math.max(1, nn);
        skips = 0;
      } else continue;
    }
    pts.push({ k, t: tt, w: ww });
    lastT = tt;
    lastK = k;
    lastI = ri;
  }
  const K = (pts[pts.length - 1]?.k ?? -1) + 1;
  const t: number[] = new Array(K).fill(NaN);
  const w: number[] = new Array(K).fill(0);
  for (const p of pts) {
    t[p.k] = p.t;
    w[p.k] = p.w;
  }
  // 音のない拍の時刻は前後から補う（小節の頭を数えるときだけ使う）
  for (let k = 0; k < K; k++) {
    if (!Number.isNaN(t[k])) continue;
    let a = k - 1;
    let b = k + 1;
    while (b < K && Number.isNaN(t[b])) b++;
    const ta = t[a];
    const tb = b < K ? t[b] : ta + (b - a) * (60 / tempoAt(ta));
    for (let q = k; q < b; q++) t[q] = ta + ((tb - ta) * (q - a)) / (b - a);
    k = b - 1;
  }
  if (t.length < 8) {
    return { segments: [], t0: 0, downbeat: 0, duration };
  }
  // 小節の頭の位置（4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所）。曲全体で数える
  const barPhaseOf = (timeOf: (k: number) => number) => {
    const sums = [0, 0, 0, 0];
    const cnt = [0, 0, 0, 0];
    for (let k = 0; k < t.length; k++) {
      // 低い音の立ち上がりは少し遅れて大きくなるので、少し後ろまで見る
      const i = Math.round((timeOf(k) - env.t0) * env.fr);
      // スネアなど全体に広がる音ではなく、低い音が「目立って」強い所（キック・太鼓）を見る
      let lo = 0;
      let al = 0;
      for (let d = -2; d <= 5; d++) {
        lo = Math.max(lo, env.low[i + d] ?? 0);
        al = Math.max(al, env.all[i + d] ?? 0);
      }
      sums[k % 4] += lo - 0.4 * al;
      cnt[k % 4]++;
    }
    let bm = 0;
    for (let m = 1; m < 4; m++) if (sums[m] / Math.max(1, cnt[m]) > sums[bm] / Math.max(1, cnt[bm])) bm = m;
    return bm;
  };
  const barPhase = barPhaseOf((k) => t[k]);
  // 区間を分けたことで、ずれが本当に小さくなったかを確かめる。実際の曲は音の立ち上がりのずれが大きく、
  // 外れた拍もあるので、ずれの「真ん中の値」で比べ、つないでもほとんど変わらない隣どうしはつなぐ
  const segMad = (s0: number, e0: number) => {
    const ks: number[] = [];
    for (let k = s0; k <= Math.min(e0, t.length - 1); k++) if (w[k] > 0) ks.push(k);
    if (ks.length < 3) return { mad: 0, n: ks.length };
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const k of ks) {
      const x = k - s0;
      sw += w[k]; sk += w[k] * x; st += w[k] * t[k]; skk += w[k] * x * x; skt += w[k] * x * t[k];
    }
    const den = sw * skk - sk * sk;
    if (den <= 1e-12) return { mad: 0, n: ks.length };
    const P = (sw * skt - sk * st) / den;
    const A = (st - P * sk) / sw;
    const r = ks.map((k) => Math.abs(t[k] - (A + (k - s0) * P))).sort((x, y) => x - y);
    return { mad: r[Math.floor(r.length / 2)], n: ks.length };
  };
  const mergeSegs = () => {
    for (let guard = 0; guard < 500 && starts.length > 1; guard++) {
      let best = -1;
      let bestGain = Infinity;
      for (let j = 1; j < starts.length; j++) {
        const a0 = starts[j - 1];
        const b0 = starts[j];
        const c0 = j + 1 < starts.length ? starts[j + 1] : t.length - 1;
        const A = segMad(a0, b0);
        const B = segMad(b0, c0);
        const M = segMad(a0, c0);
        const worst = Math.max(A.mad, B.mad);
        if (M.mad <= worst * 1.15 + 0.0003 && M.mad - worst < bestGain) {
          bestGain = M.mad - worst;
          best = j;
        }
      }
      if (best < 0) break;
      starts.splice(best, 1);
    }
  };
  // 3. BPM が一定の区間に分ける（1 小節 = 4 拍以上。変わり目はなるべく小節の頭）→ 分けすぎた所をつなぐ
  let starts = segmentBeats(t, w, 4, barPhase);
  mergeSegs();
  // 4. 曲全体でつながるように当てはめ、外れた拍（裏拍を拾ったなど）を除いてもう一度
  let fit = jointFit(t, w, starts, starts.map(() => null));
  for (let iter = 0; iter < 3; iter++) {
    const res = t.map((tt, k) => (w[k] > 0 ? Math.abs(tt - fit.pred(k)) : 0));
    const used = res.filter((_, k) => w[k] > 0).sort((a, b) => a - b);
    const lim = Math.max(0.012, (used[Math.floor(used.length / 2)] ?? 0) * 4);
    for (let k = 0; k < t.length; k++) if (w[k] > 0 && res[k] > lim) w[k] = 0;
    starts = segmentBeats(t, w, 4, barPhase);
    mergeSegs();
    fit = jointFit(t, w, starts, starts.map(() => null));
  }
  // 隣と同じ BPM（差 0.05 未満）になった区間はつなぐ
  for (let j = starts.length - 1; j > 0; j--) {
    if (Math.abs(60 / fit.P[j] - 60 / fit.P[j - 1]) < 0.05) {
      starts.splice(j, 1);
      fit = jointFit(t, w, starts, starts.map(() => null));
    }
  }
  // 5. きりのいい BPM（整数 → 小数 1 桁 → 2 桁）にしても、曲全体のずれがほとんど増えなければそちらにする
  const fixed: (number | null)[] = starts.map(() => null);
  const base = fit;
  const order = starts.map((_, j) => j).sort((a, b) => {
    const len = (j: number) => (j + 1 < starts.length ? starts[j + 1] : t.length) - starts[j];
    return len(b) - len(a);
  });
  for (const j of order) {
    const rawBpm = 60 / fit.P[j];
    for (const d of [0, 1, 2]) {
      // その桁で切り下げ・切り上げの 2 つを試し、曲全体のずれが小さいほう（短い区間は測った値が少しぶれるため）
      const m = Math.pow(10, d);
      let bestF: ReturnType<typeof jointFit> | null = null;
      let bestC = 0;
      for (const c of [Math.floor(rawBpm * m) / m, Math.ceil(rawBpm * m) / m]) {
        const trial = fixed.slice();
        trial[j] = 60 / c;
        const f = jointFit(t, w, starts, trial);
        if (!bestF || f.rms < bestF.rms) {
          bestF = f;
          bestC = c;
        }
      }
      if (bestF && bestF.rms <= Math.max(base.rms * 1.25, base.rms + 0.0008) && bestF.max <= base.max + 0.004) {
        fixed[j] = 60 / bestC;
        fit = bestF;
        break;
      }
    }
    if (fixed[j] === null) {
      fixed[j] = 60 / Number(rawBpm.toFixed(3));
      fit = jointFit(t, w, starts, fixed);
    }
  }
  // 丸めた結果、隣と同じ BPM になった区間はつなぐ
  for (let j = starts.length - 1; j > 0; j--) {
    if (Math.abs(fixed[j]! - fixed[j - 1]!) < 1e-9) {
      starts.splice(j, 1);
      fixed.splice(j, 1);
    }
  }
  fit = jointFit(t, w, starts, fixed);
  const rawFit = jointFit(t, w, starts, starts.map(() => null));
  // 6. 区間ごとのまとめ
  const segs: TempoSegment[] = starts.map((s, j) => {
    const e = j + 1 < starts.length ? starts[j + 1] : t.length;
    let mt = 0;
    let s2 = 0;
    for (let k = s; k < e; k++) {
      if (w[k] <= 0) continue;
      mt++;
      s2 += Math.pow(t[k] - fit.pred(k), 2);
    }
    return {
      startBeat: s, endBeat: e,
      start: j === 0 ? 0 : fit.pred(s), end: j + 1 < starts.length ? fit.pred(e) : duration,
      bpm: Number((60 / fit.P[j]).toFixed(3)), rawBpm: 60 / rawFit.P[j],
      beats: e - s, matched: mt, jitterMs: Math.sqrt(s2 / Math.max(1, mt)) * 1000,
    };
  });
  // 7. 小節の頭（当てはめた拍の時刻で数え直す）
  const down = barPhaseOf((k) => fit.pred(k));
  progress?.(1);
  return { segments: segs, t0: fit.t0, downbeat: down, duration };
}


// ---------- 大まかな測り方（区間ごとに、区間全体の立ち上がりを重ねて合わせる） ----------
// 実際の曲（音が多く、立ち上がりのずれも大きい）では、こちらのほうが拍の数え間違いが起きにくい

interface CoarseSeg {
  start: number;
  end: number;
  /** この区間の拍のうち、小節の頭の 1 つ（分かっているとき） */
  down?: number;
  /** 区間の頭が小節の頭だと分かっている（BPM の変わり目を小節の頭で決めたとき） */
  barStart?: boolean;
  /** 区間の頭が前の区間の拍のちょうど整数個あと（拍の途中で変わらない） */
  whole?: boolean;
  bpm: number;
  rawBpm: number;
  phase: number;
  beats: number;
  matched: number;
  jitterMs: number;
}

/** 拍の長さ P・基準 phase の格子に、区間の立ち上がりがどれだけ乗っているか（位相を重ねたときの山の高さ） */
function foldScore(env: Float32Array, fr: number, t0: number, i0: number, i1: number, P: number) {
  const B = 96;
  const acc = new Float64Array(B);
  for (let i = i0; i < i1; i++) {
    const v = env[i];
    if (v <= 0) continue;
    const t = t0 + i / fr;
    let ph = (t / P) % 1;
    if (ph < 0) ph += 1;
    acc[Math.floor(ph * B) % B] += v;
  }
  let best = 0;
  let bi = 0;
  let mean = 0;
  for (let b = 0; b < B; b++) mean += acc[b];
  mean /= B;
  for (let b = 0; b < B; b++) {
    const s = acc[(b + B - 1) % B] * 0.5 + acc[b] + acc[(b + 1) % B] * 0.5;
    if (s > best) {
      best = s;
      bi = b;
    }
  }
  return { score: best / 2 - mean, phase: ((bi + 0.5) / B) * P };
}

/** フレームの山の位置（放物線で細かく） */

/** 手で決めた 1 拍目（秒、近くの音の立ち上がりに合わせたもの）。analyzeTempo の間だけ使う */
let curAnchors: number[] = [];

function refineCoarse(env: Envelope, start: number, end: number, roughBpm: number): CoarseSeg {
  const { all, fr, t0 } = env;
  const i0 = Math.max(0, Math.floor((start - t0) * fr));
  const i1 = Math.min(all.length, Math.ceil((end - t0) * fr));
  // 速さ（倍・半分の取り違え）はテンポの流れの段階で、曲全体を見て決めてある。ここでは ±2% だけ細かく合わせる
  const base = roughBpm;
  // 区間全体で重ねて、BPM を ±2% の範囲で細かく探す
  let bestBpm = base;
  let best = foldScore(all, fr, t0, i0, i1, 60 / base);
  for (let b = base * 0.98; b <= base * 1.02; b += 0.02) {
    const f = foldScore(all, fr, t0, i0, i1, 60 / b);
    if (f.score > best.score) {
      best = f;
      bestBpm = b;
    }
  }
  // 1 拍ずつ実際の立ち上がりを拾い、区間全体で直線（時刻 = 基準 + k × 拍の長さ）に当てはめる
  let P = 60 / bestBpm;
  let phase = best.phase;
  // 手で決めた 1 拍目がこの区間にあれば、拍の線は必ずそこを通す。
  // ただし区間の両端から 6 秒以内のものは使わない（大まかな区間の境目はずれていて、実は別の BPM の所かもしれない。
  // そこは BPM の変わり目を決めるときに使う）
  const inMid = (x: number) => x >= start + 6 && x < end - 6;
  const anchor = curAnchors.find(inMid);
  if (anchor !== undefined) {
    phase = anchor;
  } else {
    // 16 分音符が続く曲では、拍の 1/4・1/2・3/4 ずれた所にも同じくらい音が乗る。
    // 低い音（キック・太鼓など）も合わせて見て、いちばん強い所を拍にする。
    // 低い音をどれだけ重く見るかは区間ごとに決める（低い音が拍の位置にはっきり集まっている区間ほど重く見る）
    const sumAt = (arr: Float32Array, ph: number) => {
      let sum = 0;
      let n = 0;
      for (let t = ph + Math.ceil((start - ph) / P) * P; t < end; t += P) {
        const i = Math.round((t - t0) * fr);
        let v = 0;
        for (let d = -3; d <= 2; d++) v = Math.max(v, arr[i + d] ?? 0);
        sum += v;
        n++;
      }
      return n ? sum / n : 0;
    };
    const qa = [0, 1, 2, 3].map((q) => sumAt(all, phase + (q * P) / 4));
    const ql = [0, 1, 2, 3].map((q) => sumAt(env.low, phase + (q * P) / 4));
    const lmean = (ql[0] + ql[1] + ql[2] + ql[3]) / 4;
    const peak = lmean > 0 ? Math.max(...ql) / lmean : 1;
    const wLow = 1 + Math.max(0, Math.min(1, (peak - 1.3) / 0.4));
    let bq = 0;
    let bv = -Infinity;
    for (let q = 0; q < 4; q++) {
      const v = qa[q] + wLow * ql[q];
      if (v > bv * 1.02) { bv = v; bq = q; }
    }
    phase += (bq * P) / 4;
  }
  const k0 = Math.ceil((start - phase) / P);
  const k1 = Math.floor((end - phase) / P);
  const pts: { k: number; t: number; w: number }[] = [];
  const peaks: number[] = [];
  for (let k = k0; k <= k1; k++) {
    const p = peakNear(all, fr, t0, phase + k * P, Math.min(0.06, P * 0.2));
    if (p) {
      // 立ち上がりの時刻は、音の大きさから 1ms 単位で求め直す
      pts.push({ k, t: fineOnset(env, p.t, 0.03), w: p.v });
      peaks.push(p.v);
    }
  }
  peaks.sort((a, b) => a - b);
  const thr = (peaks[Math.floor(peaks.length * 0.5)] ?? 0) * 0.35;
  let use = pts.filter((p) => p.w >= thr);
  let a = phase;
  let jitter = 0;
  for (let iter = 0; iter < 4 && use.length >= 4; iter++) {
    // 重み付き最小二乗
    let sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
    for (const p of use) {
      const w = p.w;
      sw += w; sk += w * p.k; st += w * p.t; skk += w * p.k * p.k; skt += w * p.k * p.t;
    }
    const den = sw * skk - sk * sk;
    if (Math.abs(den) < 1e-9) break;
    P = (sw * skt - sk * st) / den;
    a = (st - P * sk) / sw;
    const res = use.map((p) => Math.abs(p.t - (a + p.k * P)));
    const sorted = [...res].sort((x, y) => x - y);
    const mad = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const lim = Math.max(0.008, mad * 3);
    use = use.filter((_, i) => res[i] <= lim);
    jitter = Math.sqrt(use.reduce((s, p) => s + Math.pow(p.t - (a + p.k * P), 2), 0) / Math.max(1, use.length));
  }
  phase = a;
  // 手で決めた 1 拍目が区間に 2 つ以上あれば、その間がちょうど整数拍になるように拍の長さを決める
  // （BPM が 0.5% 以上変わるときは、間で BPM が変わっているので使わない）
  const anchorsIn = curAnchors.filter(inMid);
  if (anchorsIn.length >= 2) {
    const span = anchorsIn[anchorsIn.length - 1] - anchorsIn[0];
    const n = Math.round(span / P);
    if (n > 0 && Math.abs(span / n / P - 1) < 0.005) P = span / n;
  }
  const rawBpm = 60 / P;
  // きりのいい BPM（整数 → 小数 1 桁 → 2 桁）にしても、区間全体のずれがほとんど増えなければそちらを使う
  const rmsWith = (Pc: number) => {
    let sw = 0, s = 0;
    for (const p of use) { sw += p.w; s += p.w * (p.t - p.k * Pc); }
    const ac = sw ? s / sw : 0;
    let s2 = 0;
    for (const p of use) s2 += p.w * Math.pow(p.t - (ac + p.k * Pc), 2);
    return Math.sqrt(s2 / Math.max(1e-9, sw));
  };
  const baseRms = rmsWith(P);
  let bpm = Number(rawBpm.toFixed(3));
  // 区間が短いときは、区間全体でのずれが 15ms 未満なら丸めた値を使う（短い区間では細かい値まで測れない）
  const spanBeats = Math.max(1, (end - start) / P);
  for (const d of [0, 1, 2]) {
    const c = Number(rawBpm.toFixed(d));
    if (rmsWith(60 / c) <= Math.max(baseRms * 1.1, baseRms + 0.001) || Math.abs(60 / c - P) * spanBeats < 0.015) {
      bpm = c;
      break;
    }
  }
  // 決めた BPM で基準の時刻を合わせ直す（手で決めた 1 拍目があれば、そこを通す）
  if (anchor !== undefined) phase = anchor;
  else if (use.length) {
    const Pc = 60 / bpm;
    let sw = 0, s = 0;
    for (const p of use) {
      sw += p.w;
      s += p.w * (p.t - p.k * Pc);
    }
    phase = s / sw;
  }
  return {
    start, end, bpm, rawBpm,
    phase,
    down: anchor,
    beats: k1 - k0 + 1,
    matched: use.length,
    jitterMs: jitter * 1000,
  };
}



/**
 * BPM が変わる所を細かく決める（だんだん速く・遅くなる所も）。
 * G = 続いた区間（最初 A・途中・最後 Z）。A の拍から始めて、1 拍ずつ「どの BPM で次の拍に進むか」を選び、Z の BPM で終わる道のうち、
 * 拍の位置に音がいちばんよく乗るものを探す（動的計画法）。BPM を変えるたびに減点し、同じ BPM は 4 拍（1 小節）以上続ける。
 * BPM は今の区間から次の区間の BPM へ向かう向きにだけ、小節の頭でだけ変える。
 * 戻り値は A と Z の間の区間（A.end・Z.start も直す）。見つからないときは null
 */
const KERN = [0.5, 0.85, 1, 0.85, 0.5];
/** 短い区間（16 拍以下）の BPM は細かく測れないので、5 の倍数まで 1.5% 以内なら 5 の倍数にする */
function snap5(bpm: number, beats: number) {
  const r = Math.round(bpm / 5) * 5;
  return beats <= 16 && Math.abs(bpm / r - 1) <= 0.015 ? r : bpm;
}
function bridge(env: Envelope, G: CoarseSeg[], shiftA = false): CoarseSeg[] | null {
  const { fr, t0, all } = env;
  const A = G[0];
  const Z = G[G.length - 1];
  // 途中の区間のうち短いもの（16 秒未満）は、だんだん変わる所を大まかに 1 つの BPM で見ただけのことが多いので、目印にしない
  const inner = G.slice(1, -1).filter((g) => g.end - g.start >= 16);
  const lo = Math.max(A.start, A.end - 12);
  const hi = Math.min(Z.end, Z.start + 12);
  if (hi - lo < 6) return null;
  const PA = 60 / A.bpm;
  const PZ = 60 / Z.bpm;
  // 立ち上がりの山は拍の位置より少し早めに出る。どれだけ早いかは、A の拍の所で山がいちばん高くなるずれから決める
  let lag = 0;
  {
    let bv = -Infinity;
    for (let d = -4; d <= 2; d++) {
      let sum = 0;
      for (let t = A.phase + Math.ceil((lo - A.phase) / PA) * PA; t < A.end; t += PA) sum += all[Math.round((t - t0) * fr) + d] ?? 0;
      if (sum > bv) { bv = sum; lag = d; }
    }
  }
  const hit = (t: number) => {
    const i = Math.round((t - t0) * fr) + lag;
    // 拍の位置から離れるほど弱く数える
    // （低い音は使わない。裏にキックがある曲で、拍の位置を取り違えやすいため）
    let a = 0;
    for (let d = -2; d <= 2; d++) a = Math.max(a, (all[i + d] ?? 0) * KERN[d + 2]);
    return a;
  };
  let mu = 0;
  let cnt = 0;
  for (let t = lo; t < hi; t += 0.01) { mu += hit(t); cnt++; }
  mu /= Math.max(1, cnt);
  if (!(mu > 0)) return null;
  const LAMBDA = 3 * mu;
  // 拍 1 つごとの基準は、その近く（前後 1.5 秒）の音の平均。曲全体の平均にすると、音の少ない所では
  // 拍が 1 つ増えるごとに減点されて、遅い BPM（拍が少ない）ほど得をしてしまう
  const LS = 0.01;
  const l0 = lo - 2;
  const nL = Math.ceil((hi + 2 - l0) / LS) + 1;
  const pre = new Float64Array(nL + 1);
  for (let i = 0; i < nL; i++) pre[i + 1] = pre[i] + hit(l0 + i * LS);
  const muAt = (t: number) => {
    const a = Math.max(0, Math.round((t - 1.5 - l0) / LS));
    const b = Math.min(nL, Math.round((t + 1.5 - l0) / LS));
    return b > a ? (pre[b] - pre[a]) / (b - a) : mu;
  };
  // BPM の候補: 0 = A、1 = Z（同じ BPM でも別に扱う）、途中の区間の BPM、その間（少し外側まで）の整数
  const all3 = G.map((g) => g.bpm);
  const bl = Math.min(...all3) * 0.97;
  const bh = Math.max(...all3) * 1.03;
  const cand: number[] = [A.bpm, Z.bpm];
  for (const g of inner) if (!cand.slice(2).includes(g.bpm)) cand.push(g.bpm);
  const nAnchor = cand.length;
  for (let b = Math.ceil(bl); b <= bh; b++) if (!cand.slice(2).includes(b)) cand.push(b);
  const nT = cand.length;
  // きりのいい BPM（5 の倍数）を少し優先する
  const odd = (k: number) => (k >= nAnchor && cand[k] % 5 !== 0 ? LAMBDA : 0);
  // 途中の区間の中ほどは、その区間の BPM のままでいて、拍は数えない。
  // 途中の区間の拍の位置は、区間の中の音の強さ（裏拍が強い曲などで迷う）ではなく、前後の BPM の変わり目からのつながりで決める。
  // 中ほど = 4 秒の窓で見て、その区間の BPM がほかの候補の BPM よりよく合う所が続く範囲（両端を少し内側に）
  const WIN = 4;
  const inside = inner.map((g) => {
    const others = cand.filter((b) => Math.abs(b / g.bpm - 1) > 0.05);
    const wins: { T: number; w: boolean }[] = [];
    const from = Math.max(lo, g.start - 10);
    const to = Math.min(hi, g.end + 10) - WIN;
    for (let T = from; T <= to + 1e-9; T += 0.5) {
      const i0 = Math.max(0, Math.round((T - t0) * fr));
      const i1 = Math.min(all.length, Math.round((T + WIN - t0) * fr));
      const own = foldScore(all, fr, t0, i0, i1, 60 / g.bpm).score;
      let w = own > 0;
      for (const b of others) if (foldScore(all, fr, t0, i0, i1, 60 / b).score * 0.9 > own) { w = false; break; }
      wins.push({ T, w });
    }
    // 勝つ窓が続く、いちばん長い範囲（1 つだけ負けた窓ははさんでもよい）
    let best: [number, number] | null = null;
    for (let i = 0; i < wins.length; i++) {
      if (!wins[i].w || (i > 0 && wins[i - 1].w)) continue;
      let j = i;
      while (j + 1 < wins.length && (wins[j + 1].w || (j + 2 < wins.length && wins[j + 2].w))) j++;
      if (!wins[j].w) j--;
      if (!best || wins[j].T - wins[i].T > best[1] - best[0]) best = [wins[i].T, wins[j].T];
    }
    // 窓の中に前後の BPM が少し入っていても勝つことがあるので、内側に 2.5 秒ずつ寄せる
    return best && best[1] + WIN - 2.5 > best[0] + 2.5 ? [best[0] + 2.5, best[1] + WIN - 2.5] : null;
  });
  const innerAt = (t: number) => {
    for (let j = 0; j < inner.length; j++) { const r = inside[j]; if (r && t > r[0] && t < r[1]) return j; }
    return -1;
  };
  const score = (_k: number, t: number) => (innerAt(t) >= 0 ? 0 : hit(t) - muAt(t));
  // 区間の順番（A → 途中の区間 → Z）。BPM は今の区間から次の区間の BPM へ向かう向きにだけ変える
  // （行ってすぐ戻るような変化は、拍の位置を合わせるためだけのものになりやすいので使わない）
  const ord = [0, ...inner.map((g) => cand.indexOf(g.bpm, 2)), 1];
  const nSt = ord.length - 1;
  const ts = Math.ceil((lo - A.phase) / PA);
  const tStart = A.phase + ts * PA;
  // 小節の中の拍の位置（0 = 小節の頭）。BPM は小節の頭で変わることが多いので、それ以外で変えるときは減点
  const aDown = A.down ?? findDownbeatCoarse(env, A);
  const bp0 = ((Math.round((tStart - aDown) / PA) % 4) + 4) % 4;
  // 手で決めた 1 拍目: そこに小節の頭が来る道を強く選ぶ（拍は来るが小節の頭でない道は強く避ける）
  const anchorsW = curAnchors.filter((x) => x > lo - 0.05 && x < hi + 0.05);
  const aBonus = (t: number, bp: number) => {
    for (const x of anchorsW) if (Math.abs(t - x) < 0.035) return bp === 0 ? 20 * LAMBDA : -20 * LAMBDA;
    return 0;
  };
  const NB = 4;
  // 状態は時刻を 2 フレームごとにまとめて持つ（メモリを減らすため。時刻そのものは別に細かく覚える）
  const BK = fr / 2;
  const nF = Math.ceil((hi - tStart) * BK) + 2;
  // 同じ BPM は 4 拍以上続ける（c = 今の BPM になってからの拍数。4 で止める）
  const MINLEN = 4;
  const S = nF * nT * NB * MINLEN * nSt;
  const val = new Float32Array(S).fill(-Infinity);
  // 時刻は tStart からの秒数
  const tim = new Float32Array(S);
  const back = new Int32Array(S).fill(-1);
  const key = (f: number, k: number, bp: number, c: number, st: number) => (((f * nT + k) * NB + bp) * MINLEN + (c - 1)) * nSt + st;
  // 最初の区間 A の拍の位置は、16 分が続く曲では 1/4 拍ずれた所と迷うことがある。
  // A が曲の最初の区間なら、1/4 拍ずつずらした始まりも試し（ずらすのは少し減点）、変わり目とのつながりで決める
  // 小節の頭の位置（A の拍のどれが小節の頭か）も、A が最初の区間なら変わり目のほうから決め直せるようにする
  // （BPM は小節の頭で変わるので、変わり目がはっきりしていれば小節の頭も決まる）
  for (let q = 0; q < (shiftA ? 4 : 1); q++) {
    for (let b = 0; b < (shiftA ? NB : 1); b++) {
      const dt = (q * PA) / 4;
      const bp = shiftA ? b : bp0;
      const s0 = key(Math.round(dt * BK), 0, bp, MINLEN, 0);
      val[s0] = (q ? -0.5 * LAMBDA : 0) + (bp !== bp0 ? -0.5 * LAMBDA : 0);
      tim[s0] = dt;
    }
  }
  const relax = (s2: number, v2: number, t2: number, from: number) => {
    if (v2 > val[s2]) {
      val[s2] = v2;
      tim[s2] = t2 - tStart;
      back[s2] = from;
    }
  };
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < nT; k++) {
      for (let bp = 0; bp < NB; bp++) for (let c = 1; c <= MINLEN; c++) {
        for (let st = 0; st < nSt; st++) {
          const s = key(f, k, bp, c, st);
          const v = val[s];
          if (v === -Infinity) continue;
          const t = tStart + tim[s];
          const bp2 = (bp + 1) % NB;
          // 同じ BPM で次の拍へ
          {
            const t2 = t + 60 / cand[k];
            const j = innerAt(t2);
            if (t2 < hi && (j < 0 || ord[j + 1] === k)) relax(key(Math.round((t2 - tStart) * BK), k, bp2, Math.min(MINLEN, c + 1), st), v + score(k, t2) + aBonus(t2, bp2), t2, s);
          }
          if (k === 1 || c < MINLEN) continue;
          // ここ（拍 t）から BPM を変える
          const target = cand[ord[st + 1]];
          for (let k2 = 0; k2 < nT; k2++) {
            if (k2 === k) continue;
            let st2 = st;
            if (k2 === ord[st + 1]) st2 = Math.min(nSt - 1, st + 1);
            else if (k2 < nAnchor) continue;
            else if (!((cand[k2] - cand[k]) * (target - cand[k2]) > 0)) continue;
            // BPM は小節の頭でだけ変える
            if (bp !== 0) continue;
            const pen = LAMBDA + odd(k2);
            const t2 = t + 60 / cand[k2];
            const j = innerAt(t2);
            if (t2 < hi && (j < 0 || ord[j + 1] === k2)) relax(key(Math.round((t2 - tStart) * BK), k2, bp2, 1, st2), v + score(k2, t2) + aBonus(t2, bp2) - pen, t2, s);
          }
        }
      }
    }
  }
  // 終わり: Z の BPM で、Z の拍の位置（±15ms）にいる所。
  // 16 分が続く曲では Z の拍が 1/4 拍ずれて測られていることがあるので、1/4 拍ずれた所も（少し減点して）認める
  let end = -1;
  let ev = -Infinity;
  for (let f = Math.max(0, nF - Math.ceil(PZ * BK) - 2); f < nF; f++) {
    for (let bp = 0; bp < NB; bp++) for (let c = 1; c <= MINLEN; c++) {
      const s = key(f, 1, bp, c, nSt - 1);
      if (val[s] === -Infinity) continue;
      const t = tStart + tim[s];
      const x = (t - Z.phase) / PZ;
      const q4 = Math.round(x * 4);
      const d = Math.abs(x * 4 - q4) * (PZ / 4);
      if (d > 0.015) continue;
      const v = val[s] - (q4 % 4 === 0 ? 0 : LAMBDA * 0.5);
      if (v > ev) { ev = v; end = s; }
    }
  }
  if (end < 0) return null;
  // たどって、BPM ごとの区間にする（拍 i から i+1 までは、拍 i+1 の状態の BPM）
  const path: { t: number; k: number }[] = [];
  let startState = end;
  for (let s = end; s >= 0; s = back[s]) { path.push({ t: tStart + tim[s], k: Math.floor(s / (NB * MINLEN * nSt)) % nT }); startState = s; }
  path.reverse();
  // A の拍を 1/4 拍ずらした始まりを選んだときは、A の拍の位置もずらす
  const q0 = Math.round((path[0].t - tStart) / (PA / 4));
  if (shiftA) {
    if (q0 > 0 && q0 < 4) A.phase += (q0 * PA) / 4;
    // 始まりの拍の、小節の中の位置から、A の小節の頭を決め直す
    const bpS = Math.floor(startState / (MINLEN * nSt)) % NB;
    A.down = path[0].t - bpS * PA;
  }
  const endBp = Math.floor(end / (MINLEN * nSt)) % NB;
  const pieces: { k: number; start: number; end: number; beats: number }[] = [];
  for (let i = 1; i < path.length; i++) {
    const k = path[i].k;
    const last = pieces[pieces.length - 1];
    if (last && last.k === k) { last.end = path[i].t; last.beats++; }
    else pieces.push({ k, start: path[i - 1].t, end: path[i].t, beats: 1 });
  }
  // ほとんど同じ BPM（1.5% 未満の差）の隣どうしはつなぐ（A・Z・途中の区間の BPM、または長いほうにする）
  for (let i = 1; i < pieces.length; ) {
    const p = pieces[i - 1];
    const q = pieces[i];
    if (Math.abs(cand[p.k] / cand[q.k] - 1) >= 0.015) { i++; continue; }
    const rank = (x: typeof p) => (x.k <= 1 ? Infinity : x.k < nAnchor ? 1e6 + x.end - x.start : x.end - x.start);
    const k = rank(p) >= rank(q) ? p.k : q.k;
    const P = 60 / cand[k];
    pieces.splice(i - 1, 2, { k, start: p.start, end: q.end, beats: Math.max(1, Math.round((q.end - p.start) / P)) });
  }
  const out: CoarseSeg[] = [];
  let aEnd = A.end;
  let zStart = A.end;
  for (const p of pieces) {
    if (p.k === 0) { aEnd = p.end; zStart = p.end; }
    else if (p.k === 1) { zStart = p.start; break; }
    else {
      // 途中の区間と同じ BPM なら、その区間の測った値（ずれの大きさなど）を使う
      const g = inner.find((x) => x.bpm === cand[p.k]);
      out.push(g && p.end - p.start > 8
        ? { ...g, start: p.start, end: p.end, phase: p.start, barStart: true }
        : { start: p.start, end: p.end, bpm: snap5(cand[p.k], p.beats), rawBpm: cand[p.k], phase: p.start, beats: p.beats, matched: p.beats, jitterMs: 0, barStart: true });
    }
  }
  A.end = aEnd;
  Z.start = zStart;
  // Z の拍の位置は、つながった所に合わせる（次の境目を探すときに使う）
  Z.phase = tStart + tim[end];
  Z.down = Z.phase - endBp * PZ;
  Z.barStart = true;
  return out;
}


// ---------- 仮説を立てて確かめる（BPM の変わり方） ----------

/**
 * BPM の変わり目を「仮説 → 検算」で決める。
 * 安定した区間（大まかに測ったもの）の間ごとに、次の形の変わり方をすべて試し、音とのいちばんよく合うものを選ぶ:
 *   前の BPM a のまま、ある小節の頭 s まで進み、そこから n 拍ごとに (b - a) / m ずつ BPM を変えて、m 段目で次の BPM b になる
 *   （m = 1 なら s でいきなり b。n は 1・2・4・8 拍。途中の BPM は整数に丸める）
 * 例: 175 → 160 → 145 → 130 は m = 3・n = 4、150 から 2 拍ごとに +2 で 180 は m = 15・n = 2。
 * 点数 = 拍の位置の音の強さ（その近くの平均との差）の合計 − 形の複雑さ。
 * 変わり目の前後で、次の区間の拍の位置（小節の頭）も決まる。区間が続くときは、上位の候補をいくつか残して
 * 次の変わり目と合わせて選ぶ（前の変わり目と次の変わり目のつながりで、途中の区間の拍の位置が決まる）
 */
const PEN_RAMP = 2;
const PEN_STEP = 0.3;
const BO_PEN = 0.5;
/** 変わり目が、次の区間の測った拍の位置に乗るときの加点 */
const W_PH = 1;
/** 1 つの小節の中で BPM を 2 回変える形の減点 */
const PEN_SPLIT = 1;
/** 拍のずれ（ms）がこれより大きい区間は、BPM が一定でない（だんだん変わる途中を 1 つの BPM で見た）ものとして、仮説の途中の段として扱う */
const JIT_MAX = 25;
/** 次の区間の BPM を倍・半分にするときの減点 */
const PEN_OCT = 1;
/** 次の区間の最初の 4 小節の頭の音の重み */
const W_BAR = 0.6;

/**
 * 曲の音が実際に鳴っている所の終わり（秒）。1 秒ごとの立ち上がりの強さの最大を、4 秒ずつ平均して、
 * 曲全体の中くらいの強さの 6 割以上ある最後の所。そのあとは余韻やフェードアウト
 */
function musicEnd(env: Envelope): number {
  const W = Math.max(1, Math.round(env.fr));
  const M: number[] = [];
  for (let i = 0; i + W <= env.all.length; i += W) {
    let m = 0;
    for (let k = i; k < i + W; k++) m = Math.max(m, env.all[k]);
    M.push(m);
  }
  if (M.length < 8) return Infinity;
  const med = [...M].sort((a, b) => a - b)[Math.floor(M.length / 2)];
  let last = M.length;
  for (let i = M.length - 4; i >= 0; i--) {
    if ((M[i] + M[i + 1] + M[i + 2] + M[i + 3]) / 4 >= 0.6 * med) { last = i + 4; break; }
  }
  return env.t0 + (last * W) / env.fr;
}

function solveChain(env: Envelope, segsIn: CoarseSeg[], shiftFirst: boolean): CoarseSeg[] | null {
  // 短い（16 秒未満の）区間は、だんだん変わる所を大まかに 1 つの BPM で見ただけのことが多いので、仮説の途中の段として扱う
  // 最後の区間も、短ければ前の区間の続き（曲の終わりの音の少ない所を別の BPM と見ただけのことが多い）
  // 曲の終わりの、音の少ない所（余韻・フェードアウト）は数えない
  const mEnd = musicEnd(env);
  const segs = segsIn.filter((x, i) => i === 0 || (Math.min(x.end, mEnd) - x.start >= 16 && x.jitterMs < JIT_MAX));
  for (let i = 1; i < segs.length; i++) segs[i - 1] = { ...segs[i - 1], end: segs[i].start };
  for (let i = segs.length - 1; i > 0; i--) if (Math.abs(segs[i].bpm / segs[i - 1].bpm - 1) < 0.015) {
    segs[i - 1] = { ...segs[i - 1], end: segs[i].end };
    segs.splice(i, 1);
  }
  if (segs.length < 2) return null;
  // 安定した区間の BPM は、整数に近ければ（0.2% 以内）整数にする（区間の端に変わり目の途中が入って、少しずれて測れることがある）
  for (let i = 0; i < segs.length; i++) {
    const r = Math.round(segs[i].bpm);
    if (Math.abs(segs[i].bpm - r) < segs[i].bpm * 0.002) segs[i] = { ...segs[i], bpm: r };
  }
  const { fr, t0, all } = env;
  const N = all.length;
  // 立ち上がりの山のずれ（最初の区間の拍で決める）
  const S0 = segs[0];
  const P0 = 60 / S0.bpm;
  let lag = 0;
  {
    let bv = -Infinity;
    for (let d = -4; d <= 2; d++) {
      let sum = 0;
      for (let t = S0.phase + Math.ceil((S0.start - S0.phase) / P0) * P0; t < Math.min(S0.end, S0.start + 60); t += P0) sum += all[Math.round((t - t0) * fr) + d] ?? 0;
      if (sum > bv) { bv = sum; lag = d; }
    }
  }
  const hk = new Float32Array(N);
  for (let f = 0; f < N; f++) {
    let v = 0;
    for (let d = -2; d <= 2; d++) v = Math.max(v, (all[f + lag + d] ?? 0) * KERN[d + 2]);
    hk[f] = v;
  }
  const pre = new Float64Array(N + 1);
  for (let f = 0; f < N; f++) pre[f + 1] = pre[f] + hk[f];
  const mu = pre[N] / Math.max(1, N);
  if (!(mu > 0)) return null;
  const W = Math.round(1.5 * fr);
  const sc = (t: number) => {
    const f = Math.round((t - t0) * fr);
    if (f < 0 || f >= N) return 0;
    const a = Math.max(0, f - W);
    const b = Math.min(N, f + W);
    return hk[f] - (pre[b] - pre[a]) / (b - a);
  };
  // 拍 1 つの点数: 拍の位置だけでなく、拍を 2・4 分割した所か 3 分割した所（合うほう）にも音が乗っているかを見る。
  // 拍の上に音がなく裏や 3 連の位置に音がある所（シンコペーション）でも、正しい BPM なら音が格子に乗る
  // 拍の長さ（秒）を掛けて、時間あたりの点数にする（速い BPM ほど拍が多くて、点数が多く・少なくなりやすいのを防ぐ）
  const bs = (t: number, P: number) => {
    const two = 0.6 * sc(t + P / 2) + 0.3 * (sc(t + P / 4) + sc(t + (3 * P) / 4));
    const three = 0.45 * (sc(t + P / 3) + sc(t + (2 * P) / 3));
    return (sc(t) + Math.max(two, three)) * (P / 0.4);
  };
  const LAM = 3 * mu;
  const aB = (t: number, bar: boolean) => {
    for (const x of curAnchors) if (Math.abs(t - x) < 0.035) return bar ? 20 * LAM : -20 * LAM;
    return 0;
  };
  // sp: 前の BPM の拍の点数を数えるときの拍の長さ（大まかに測った BPM の拍。倍・半分にした区間でも、点数の数え方はそろえる）
  type State = { score: number; bpm: number; sp: number; phase: number; barRef: number; from: number; out: CoarseSeg[] };
  const first = { ...segs[0] };
  const down0 = first.down ?? findDownbeatCoarse(env, first);
  let beam: State[] = [];
  for (let q = 0; q < (shiftFirst ? 4 : 1); q++) {
    for (let bo = 0; bo < (shiftFirst ? 4 : 1); bo++) {
      const dt = (q * P0) / 4;
      beam.push({
        score: (q ? -0.5 * LAM : 0) + (bo ? -BO_PEN * LAM : 0),
        bpm: first.bpm, sp: P0, phase: first.phase + dt, barRef: down0 + dt + bo * P0, from: -Infinity,
        out: [{ ...first, phase: first.phase + dt, down: down0 + dt + bo * P0 }],
      });
    }
  }
  const NS = [1, 2, 4, 8];
  const K = 8;
  for (let j = 0; j + 1 < segs.length; j++) {
    const Y = segs[j + 1];
    // 次の区間の BPM の拍の長さ（次の区間の中の合い方はこの長さで見る。倍・半分にしても拍の位置は同じ所を通るので）
    const PY = 60 / Y.bpm;
    const boundary = segs[j].end;
    const next: State[] = [];
    // どの仮説も同じ時間の範囲 [wStart, wEnd) で比べる（範囲が違うと、拍の多い仮説ほど得をする）
    const nextB = j + 2 < segs.length ? segs[j + 1].end : Infinity;
    const wEnd = Math.min(boundary + 20, nextB - 10, Y.end - 1);
    // 次の区間の拍の点数（ある時刻から wEnd までの、PY ごとの拍の点数の合計）を、拍の位置 1ms ごとに先に数えておく
    const YG = 0.001;
    const yBase = boundary - 40;
    const yBins = Math.ceil(PY / YG);
    const ySuf: Float64Array[] = [];
    for (let k = 0; k < yBins; k++) {
      const vals: number[] = [];
      for (let tt = yBase + k * YG; tt < wEnd; tt += PY) vals.push(bs(tt, PY));
      const suf = new Float64Array(vals.length + 1);
      for (let i = vals.length - 1; i >= 0; i--) suf[i] = suf[i + 1] + vals[i];
      ySuf.push(suf);
    }
    const yFrom = (tq: number) => {
      if (tq >= wEnd) return 0;
      if (tq < yBase) { let y = 0; for (let tt = tq; tt < wEnd; tt += PY) y += bs(tt, PY); return y; }
      let i0 = Math.floor((tq - yBase) / PY);
      let k = Math.round((tq - yBase - i0 * PY) / YG);
      if (k >= yBins) { k = 0; i0++; }
      const suf = ySuf[k];
      return i0 < suf.length ? suf[i0] : 0;
    };
    // 間にある、BPM が一定でない（仮説の途中の段として扱う）区間の BPM（長さで重みをつけた平均）
    let midL = 0;
    let midW = 0;
    for (const x of segsIn) {
      const c = (x.start + x.end) / 2;
      if (c <= segs[j].start || c >= Y.start || Math.abs(x.bpm / segs[j].bpm - 1) < 0.015) continue;
      midL += Math.log(x.bpm) * (x.end - x.start);
      midW += x.end - x.start;
    }
    const mid = midW ? Math.exp(midL / midW) : 0;
    for (const st of beam) {
      const a = st.bpm;
      // 次の区間の BPM の倍・半分は、間の区間の BPM が「前の BPM と次の BPM の間」に来るときだけ試す
      // （200 → 215 くらい → 150 と測れたなら、200 から 300 へだんだん速くなる所）
      const obs = [1, ...[2, 0.5].filter((o) => mid && (mid - a) * (Y.bpm * o - mid) > 0 && Y.bpm * o >= BPM_MIN && Y.bpm * o <= BPM_MAX)];
      const Pa = 60 / a;
      const wStart = Math.max(boundary - 31, st.from);
      // 小節の頭の候補
      // （大まかな区間の境目は、無音や音の少ない所ではかなりずれるので、前は 25 秒まで探す）
      const sMin = Math.max(boundary - 25, st.from + 2 * Pa);
      const sMax = Math.min(boundary + 8, Y.end - 6);
      const k0 = Math.ceil((sMin - st.barRef) / (4 * Pa));
      for (let k = k0; st.barRef + k * 4 * Pa <= sMax; k++) {
        const s0 = st.barRef + k * 4 * Pa;
        // s までの前の BPM の拍
        let xs = 0;
        const Sp = st.sp;
        const t1 = st.phase + Math.ceil((wStart - st.phase) / Sp - 1e-9) * Sp;
        for (let t = t1; t < s0 - 1e-6; t += Sp) {
          const c = Math.round((t - st.barRef) / Pa);
          xs += aB(t, ((c % 4) + 4) % 4 === 0);
        }
        for (let t = t1; t < s0 - 1e-6; t += Sp) xs += bs(t, Sp);
        // 次の区間の BPM は、大まかに測った値のほか、その倍・半分も試す（だんだん速くなって 200 → 300 になる所を、
        // 大まかには 150 と測ることがある。倍・半分は、だんだん変わる形のときだけ）
        for (const ob of obs) {
        // だんだん変わる形のときは、次の BPM を切りのよい値（10 の倍数・5 の倍数）にした形も試す
        // （大まかな測りは、区間の頭に変わる途中が入って 1〜2% ずれることがある。300 を 304 と測るなど）
        const b0 = Y.bpm * ob;
        const bList = [b0];
        for (const [u, tol] of [[10, 0.02], [5, 0.01]] as const) {
          const r = Math.round(b0 / u) * u;
          if (Math.abs(r / b0 - 1) < tol && !bList.includes(r)) bList.push(r);
        }
        for (const b of bList) {
        if (b < BPM_MIN || b > BPM_MAX) continue;
        const Pb = 60 / b;
        for (const n of NS) {
          for (let m = 1; m <= 17; m++) {
            if (m === 1 && n !== 1) continue;
            if ((ob !== 1 || b !== b0) && m === 1) continue;
            const R = (m - 1) * n;
            if (R > 96) break;
            // 1 小節より短い途中の段は使わない（拍の位置を少しずらすためだけの段になりやすい）
            if (m > 1 && R < 4) continue;
            // 途中の BPM
            const tempos: number[] = [];
            for (let i = 1; i < m; i++) tempos.push(Math.round(a + ((b - a) * i) / m));
            if (tempos.some((x, i) => x === (i ? tempos[i - 1] : a) || x === b)) continue;
            // 段の長さは n 拍ずつ。ただし、続く 2 段だけ n/2 拍ずつにした形も試す（1 つの小節の前半と後半で BPM が変わる所がある曲）
            for (let pv = -1; pv < (n >= 2 && m >= 4 ? m - 2 : 0); pv++) {
            const dur = tempos.map((_, i) => (pv >= 0 && (i === pv || i === pv + 1) ? n / 2 : n));
            let t = s0;
            let c = 0;
            let score = st.score + xs;
            const starts: number[] = [];
            tempos.forEach((tp, i) => {
              starts.push(t);
              const P = 60 / tp;
              for (let q2 = 0; q2 < dur[i]; q2++) { score += bs(t, P) + aB(t, c % 4 === 0); t += P; c++; }
            });
            if (pv >= 0) score -= PEN_SPLIT * LAM;
            if (t > wEnd - 2) continue;
            let eOwn = 0;
            // 次の区間の中の拍は、拍の位置（1/4・1/3 拍のずれ）を問わずに BPM が合っているかだけを見る。
            // 拍の上より裏に音の多い区間では、正しい拍の位置の点数が低くなるため（拍の位置は変わり目のつながりで決める）
            {
              let bestY = -Infinity;
              let ownY = -Infinity;
              for (const f of [0, 0.25, 0.5, 0.75, 1 / 3, 2 / 3]) {
                // 拍の位置の細かいずれ（±30ms）も許す（BPM を丸めた分や、立ち上がりの測り方のずれ）
                for (const e of [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03]) {
                  const y = yFrom(t + f * PY + e);
                  if (y > bestY) bestY = y;
                  if (f === 0 && y > ownY) { ownY = y; eOwn = e; }
                }
              }
              for (let tt = t; tt < wEnd; tt += Pb, c++) score += aB(tt, c % 4 === 0);
              score += bestY;
            }
            // 新しい BPM の拍の位置は、変わり目のつながりから少し（±30ms まで）ずらしてよい（前の区間の拍の位置の測りのずれを持ち越さない）
            const rampEnd = t + eOwn;
            // 新しい BPM の最初の 4 小節の頭の音（シンバルなど、区間の始まりの強い音は小節の頭に来る）
            {
              const firstBar = rampEnd + (((4 - (R % 4)) % 4) * Pb);
              for (let q3 = 0; q3 < 4; q3++) score += W_BAR * sc(firstBar + q3 * 4 * Pb);
            }
            // 変わり目が、次の区間を大まかに測った拍の位置（±40ms）に乗るなら加点。
            // 無音の所で変わるときは音から変わり目の位置が決まらないので、前の区間の小節の頭と次の区間の拍の位置が両方合う所を選ぶ
            {
              const x = (rampEnd - Y.phase) / PY;
              const d = Math.abs(x - Math.round(x)) * PY;
              if (d < 0.04) score += W_PH * LAM;
            }
            // 形の複雑さ
            if (m > 1) {
              score -= PEN_RAMP * LAM + PEN_STEP * LAM * (m - 1);
              if (Math.abs((b - a) / m - Math.round((b - a) / m)) > 1e-6) score -= 0.7 * LAM;
            }
            if (ob !== 1) score -= PEN_OCT * LAM;
            if (next.length >= K * 4 && score < next[next.length - 1].score) continue;
            // 結果の区間
            const out = st.out.map((x) => ({ ...x }));
            out[out.length - 1].end = s0;
            let cum = 0;
            tempos.forEach((tp, i) => {
              const st0 = starts[i];
              out.push({ start: st0, end: i + 1 < starts.length ? starts[i + 1] : rampEnd, bpm: tp, rawBpm: tp, phase: st0, beats: dur[i], matched: dur[i], jitterMs: 0, barStart: cum % 4 === 0, whole: true });
              cum += dur[i];
            });
            const barRefY = rampEnd + (((4 - (R % 4)) % 4) * Pb);
            out.push({ ...Y, bpm: b, rawBpm: b, start: rampEnd, phase: rampEnd, down: barRefY, barStart: R % 4 === 0, whole: true });
            next.push({ score, bpm: b, sp: PY, phase: rampEnd, barRef: barRefY, from: wEnd, out });
            next.sort((x, y) => y.score - x.score);
            if (next.length > K * 4) next.length = K * 4;
            }
          }
        }
        }
        }
      }
    }
    if (!next.length) return null;
    // 似た候補（同じ所で同じ形）ばかりにならないよう、上位から拍の位置の違うものを残す
    const kept: State[] = [];
    for (const x of next) {
      if (kept.some((y) => Math.abs(y.phase - x.phase) < 0.01 && Math.abs(y.barRef - x.barRef) < 0.01)) continue;
      kept.push(x);
      if (kept.length >= K) break;
    }
    beam = kept;
  }
  const best = beam[0];
  best.out[best.out.length - 1].end = segs[segs.length - 1].end;
  return best.out;
}

/** 小節の頭: 4 拍ごとの位置のうち、低い音の立ち上がりがいちばん強い所 */
function findDownbeatCoarse(env: Envelope, seg: CoarseSeg): number {
  if (seg.down !== undefined) return seg.down;
  const P = 60 / seg.bpm;
  const k0 = Math.ceil((seg.start - seg.phase) / P);
  const k1 = Math.floor((seg.end - seg.phase) / P);
  const sums = [0, 0, 0, 0];
  const cnt = [0, 0, 0, 0];
  for (let k = k0; k <= k1; k++) {
    const t = seg.phase + k * P;
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    // （BPM の変わり目を決める途中の目安。最後の小節の頭は computeMeters で、強い音の集まり方から決め直す）
    for (let d = -2; d <= 2; d++) v = Math.max(v, env.low[i + d] ?? 0, (env.all[i + d] ?? 0) * 0.3);
    const m = ((k % 4) + 4) % 4;
    sums[m] += v;
    cnt[m]++;
  }
  let bm = 0;
  for (let m = 1; m < 4; m++) if (sums[m] / Math.max(1, cnt[m]) > sums[bm] / Math.max(1, cnt[bm])) bm = m;
  // 区間の中で最初の、その位置の拍
  let k = k0;
  while (((k % 4) + 4) % 4 !== bm) k++;
  return seg.phase + k * P;
}

/** 曲の BPM（途中の変化も）と、小節の頭を測る */

function analyzeCoarse(env: Envelope, tg: { center: number; score: Float32Array }[], path: number[], duration: number): { segs: CoarseSeg[]; downbeat: number } {
  // 同じテンポ（±2%）が続く所をまとめて区間にする。4 秒未満の短い区間は前後にくっつける
  type Raw = { a: number; b: number; bpm: number[] };
  let raws: Raw[] = [];
  path.forEach((bpm, i) => {
    const last = raws[raws.length - 1];
    const med = last ? last.bpm[Math.floor(last.bpm.length / 2)] : 0;
    if (last && Math.abs(bpm / med - 1) < 0.02) {
      last.b = i;
      last.bpm.push(bpm);
    } else raws.push({ a: i, b: i, bpm: [bpm] });
  });
  const short = (r: Raw) => r.b - r.a + 1 < 4;
  for (let guard = 0; guard < 50 && raws.length > 1 && raws.some(short); guard++) {
    const i = raws.findIndex(short);
    const r = raws[i];
    const j = i === 0 ? 1 : i === raws.length - 1 ? i - 1 : (raws[i - 1].b - raws[i - 1].a > raws[i + 1].b - raws[i + 1].a ? i - 1 : i + 1);
    const o = raws[j];
    o.a = Math.min(o.a, r.a);
    o.b = Math.max(o.b, r.b);
    raws.splice(i, 1);
  }
  // 隣どうしで同じテンポになったものはつなぐ
  raws = raws.reduce<Raw[]>((acc, r) => {
    const last = acc[acc.length - 1];
    const m = (x: Raw) => [...x.bpm].sort((p, q) => p - q)[Math.floor(x.bpm.length / 2)];
    if (last && Math.abs(m(r) / m(last) - 1) < 0.02) {
      last.b = r.b;
      last.bpm.push(...r.bpm);
    } else acc.push(r);
    return acc;
  }, []);
  const segs: CoarseSeg[] = [];
  raws.forEach((r, i) => {
    // 区間の境目: 窓の中心の真ん中
    const start = i === 0 ? 0 : (tg[r.a - 1].center + tg[r.a].center) / 2;
    const end = i === raws.length - 1 ? duration : (tg[r.b].center + tg[r.b + 1].center) / 2;
    const med = [...r.bpm].sort((p, q) => p - q)[Math.floor(r.bpm.length / 2)];
    segs.push(refineCoarse(env, start, end, med));
  });
  // 区間の変わり目を細かく決める: 前の区間の拍と次の区間の拍が重なる所のうち、
  // 前 4 秒は前の区間の拍に、後ろ 4 秒は次の区間の拍に、いちばんよく音が乗っている所
  const strength = (t: number) => {
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    for (let d = -1; d <= 1; d++) v = Math.max(v, env.all[i + d] ?? 0);
    return v;
  };
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1];
    const b = segs[i];
    const Pa = 60 / a.bpm;
    const Pb = 60 / b.bpm;
    let bestT = b.phase + Math.round((b.start - b.phase) / Pb) * Pb;
    let bestScore = -Infinity;
    // テンポの流れから決めた境目は数秒ずれることがあるので、前後 10 秒（ただし両方の区間の中）を探す
    const lo = Math.max(a.start + 1, b.start - 10);
    const hi = Math.min(b.end - 1, b.start + 10);
    for (let n = Math.ceil((lo - a.phase) / Pa); a.phase + n * Pa <= hi; n++) {
      const T = a.phase + n * Pa;
      const tb = b.phase + Math.round((T - b.phase) / Pb) * Pb;
      if (Math.abs(tb - T) > 0.015) continue;
      // 前の 4 秒は「前の区間の拍のほうが、次の区間の拍より音に合う」、後ろの 4 秒はその逆になっているほど高い点
      const mean = (from: number, to: number, ph: number, P: number) => {
        let sum = 0;
        let n = 0;
        for (let k = Math.ceil((from - ph) / P); ph + k * P < to; k++) {
          sum += strength(ph + k * P);
          n++;
        }
        return n ? sum / n : 0;
      };
      const sc = mean(T - 4, T, a.phase, Pa) - mean(T - 4, T, b.phase, Pb) + mean(tb, tb + 4, b.phase, Pb) - mean(tb, tb + 4, a.phase, Pa);
      if (sc > bestScore) {
        bestScore = sc;
        bestT = tb;
      }
    }
    a.end = bestT;
    b.start = bestT;
  }
  const first = segs[0];
  return { segs, downbeat: first ? findDownbeatCoarse(env, first) : 0 };
}

// ---------- 譜面に入れる形にする ----------

/** 大まかな測り方の結果を、拍の番号で表す形にする */
function coarseToResult(c: { segs: CoarseSeg[]; downbeat: number }, duration: number): TempoResult {
  const segs = c.segs;
  if (!segs.length) return { segments: [], t0: 0, downbeat: 0, duration };
  const P1 = 60 / segs[0].bpm;
  // 拍 0 = 最初の区間の拍のうち、0 秒以降でいちばん早いもの
  const t0 = segs[0].phase + Math.ceil((0 - segs[0].phase) / P1) * P1;
  const out: TempoSegment[] = [];
  let beat = 0;
  let tPrev = t0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const P = 60 / s.bpm;
    const endT = i + 1 < segs.length ? segs[i + 1].start : duration;
    // BPM は拍の途中（1/4 拍単位）でも変わることがある
    // 次の区間が小節の頭から始まると分かっているときは、拍の途中では変えない（整数の拍）
    const whole = i + 1 < segs.length && (segs[i + 1].barStart || segs[i + 1].whole);
    const n = i + 1 < segs.length ? (whole ? Math.max(1, Math.round((endT - tPrev) / P)) : Math.max(0.25, Math.round((4 * (endT - tPrev)) / P) / 4)) : Math.max(1, Math.floor((endT - tPrev) / P));
    out.push({
      startBeat: beat, endBeat: beat + n, start: i === 0 ? 0 : tPrev, end: endT,
      bpm: s.bpm, rawBpm: s.rawBpm, beats: s.beats, matched: s.matched, jitterMs: s.jitterMs, barStart: s.barStart,
    });
    beat += n;
    tPrev += n * P;
  }
  const down = ((Math.round((c.downbeat - t0) / P1) % 4) + 4) % 4;
  return { segments: out, t0, downbeat: down, duration };
}

/**
 * 1 拍おきに強い音が来る（いちばん長い区間で、1 拍おきの拍の音の強さが、間の拍の 1.6 倍以上。低い音も 1.5 倍以上）曲は、
 * 測った拍は細かすぎるので、強いほうの拍だけを拍にして BPM を半分にする（200 → 半分の 100 の曲など）。
 * 区間の変わり目がどれも強いほうの拍にあるときだけ（変わり目が間の拍にあるなら、測った BPM のまま）
 */
function halveIfSlow(env: Envelope, r: TempoResult): TempoResult {
  if (!r.segments.length) return r;
  const v = (arr: Float32Array, t: number) => {
    const i = Math.round((t - env.t0) * env.fr);
    let m = 0;
    for (let d = -2; d <= 1; d++) m = Math.max(m, arr[i + d] ?? 0);
    return m;
  };
  // いちばん長い区間
  let li = 0;
  let ts = r.t0;
  const tStart: number[] = [];
  r.segments.forEach((s, i) => {
    tStart.push(ts);
    const len = ((s.endBeat - s.startBeat) * 60) / s.bpm;
    const ll = ((r.segments[li].endBeat - r.segments[li].startBeat) * 60) / r.segments[li].bpm;
    if (len > ll) li = i;
    ts += len;
  });
  const L = r.segments[li];
  if (L.bpm / 2 < 80 || L.endBeat - L.startBeat < 64) return r;
  const A = [0, 0];
  const Lo = [0, 0];
  const P = 60 / L.bpm;
  for (let j = 0; j < L.endBeat - L.startBeat - 1e-9; j++) {
    const t = tStart[li] + j * P;
    const par = (L.startBeat + j) % 2 === 0 ? 0 : 1;
    A[par] += v(env.all, t);
    Lo[par] += v(env.low, t);
  }
  const p = A[1] > A[0] ? 1 : 0;
  if (!(A[p] >= 1.6 * A[1 - p] && Lo[p] >= 1.5 * Lo[1 - p])) return r;
  // 変わり目がどれも強いほうの拍にあるか
  if (r.segments.some((s, i) => i > 0 && Math.abs(((s.startBeat - p) % 2 + 2) % 2) > 1e-9)) return r;
  const P0 = 60 / r.segments[0].bpm;
  const half = (b: number) => (b - p) / 2;
  const segments = r.segments.map((s, i) => ({
    ...s,
    startBeat: i === 0 ? 0 : half(s.startBeat),
    endBeat: i + 1 < r.segments.length ? half(s.endBeat) : Math.max(half(s.startBeat) + 1, Math.floor(half(s.endBeat))),
    bpm: s.bpm / 2, rawBpm: s.rawBpm / 2, beats: Math.round(s.beats / 2), matched: Math.round(s.matched / 2),
    // 前の BPM で小節の頭だった所は、半分の BPM では小節の途中のこともある（小節の頭は拍子を決めるときに決め直す）
    barStart: false,
  }));
  segments[0].endBeat = segments.length > 1 ? segments[1].startBeat : segments[0].endBeat;
  // 最初の区間の頭（拍 0 より前）に強いほうの拍が来ないときは、拍 0 を 1 つ後ろへ
  return { ...r, segments, t0: r.t0 + p * P0, downbeat: Math.floor((((r.downbeat - p) % 4) + 4) % 4 / 2) };
}

/** 案の拍が、曲の音の立ち上がりにどれだけ乗っているか（高いほどよい）。2 つの測り方のどちらを使うか決めるのに使う */

/** 拍の時刻の一覧（区間ごとに、半拍ずつ。step = 1 で 1 拍ずつ） */
function eachBeat(r: TempoResult, half: boolean, fn: (t: number, seg: number, h: number) => void) {
  let ts = r.t0;
  r.segments.forEach((s, si) => {
    const P = 60 / s.bpm;
    const nb = s.endBeat - s.startBeat;
    const n = half ? nb * 2 : nb;
    for (let h = 0; h < n - 1e-9; h++) fn(ts + (half ? h / 2 : h) * P, si, h);
    ts += nb * P;
  });
}

/** 手で決めた 1 拍目と、いちばん近い拍とのずれの最大（秒） */
function anchorErr(r: TempoResult): number {
  if (!r.segments.length) return Infinity;
  let worst = 0;
  for (const a of curAnchors) {
    let d = Infinity;
    eachBeat(r, false, (t) => { d = Math.min(d, Math.abs(t - a)); });
    worst = Math.max(worst, d);
  }
  return worst;
}

/** 半拍ごとの音の強さ（小節の頭は、キックなど低くて強い音が来やすいので、低い音を主に見る） */
function beatAccents(env: Envelope, r: TempoResult): number[] {
  const out: number[] = [];
  eachBeat(r, true, (t) => {
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    for (let d = -3; d <= 1; d++) v = Math.max(v, env.low[i + d] ?? 0, (env.all[i + d] ?? 0) * 0.3);
    out.push(v);
  });
  return out;
}

const sameMeter = (a: Meter, b: Meter) => a.num * b.den === b.num * a.den && a.den === b.den;

/** 小節の長さ（拍）から拍子にする */
function meterOfLen(len: number, like?: Meter): Meter {
  if (like && Math.abs(meterLen(like) - len) < 1e-6) return like;
  if (Math.abs(len - Math.round(len)) < 1e-6) return { num: Math.round(len), den: 4 };
  if (Math.abs(len * 2 - Math.round(len * 2)) < 1e-6) return { num: Math.round(len * 2), den: 8 };
  return { num: Math.max(1, Math.round(len * 4)), den: 16 };
}

/**
 * 拍子と小節の頭を決める（区間の拍はもう決まっている前提）。
 * - 区間ごとの拍子: 手で決めたものがあればそれ、なければ強い音が 3 拍ごとか 4 拍ごとかで決める（短い区間は前の区間と同じ）
 * - 小節の頭: 区間を 8 小節ずつに分け、それぞれで「強い音がいちばん集まる位置」を調べ、
 *   位置を変える（1 小節だけ短い・長い小節を入れる）のを減点しながら、曲全体でいちばん合う並びを選ぶ。
 *   区間の変わり目は、前の区間の小節がちょうど終わった所で次の区間の小節が始まるのを減点なしにする
 * - 手で決めた 1 拍目があれば、そこは必ず小節の頭にする
 * 結果は r.meters・r.downbeat・r.meterAuto に入れる
 */
export function computeMeters(r: TempoResult, override: (Meter | null)[] = [], anchorTimes: number[] = []) {
  const acc = r.beatAcc;
  const segs = r.segments;
  if (!acc || !segs.length) return;
  // 区間ごとの、半拍の強さの範囲
  const ranges: { off: number; n: number; t: number; P: number; base: number }[] = [];
  {
    let off = 0;
    let ts = r.t0;
    for (const s of segs) {
      const P = 60 / s.bpm;
      const nb = s.endBeat - s.startBeat;
      const n = Math.ceil(nb * 2 - 1e-9);
      ranges.push({ off, n, t: ts, P, base: s.startBeat });
      off += n;
      ts += nb * P;
    }
  }
  const a = (si: number, h: number) => acc[ranges[si].off + h] ?? 0;
  // 拍の AI の小節の頭: 区間ごとに、拍の線から 60ms 以内にあるものの半拍の番号
  const aiH: number[][] = ranges.map(() => []);
  for (const d of r.aiDowns ?? []) {
    const si = ranges.findIndex((R, i) => d >= R.t - R.P / 2 && (i === ranges.length - 1 || d < ranges[i + 1].t - ranges[i + 1].P / 2));
    if (si < 0) continue;
    const R = ranges[si];
    const h = Math.round((d - R.t) / (R.P / 2));
    if (h < 0 || h >= R.n || Math.abs(R.t + (h * R.P) / 2 - d) > 0.06) continue;
    aiH[si].push(h);
  }
  /** 拍の AI の小節の頭の間隔（拍）から決めた拍子（8 小節以上あって、7 割以上が同じ長さのとき） */
  const aiMeter = (si: number): Meter | null => {
    const hs = aiH[si];
    if (hs.length < 9) return null;
    const cnt = new Map<number, number>();
    for (let i = 1; i < hs.length; i++) {
      const L = (hs[i] - hs[i - 1]) / 2;
      if (L === 3 || L === 4) cnt.set(L, (cnt.get(L) ?? 0) + 1);
    }
    for (const [L, c] of cnt) if (c >= (hs.length - 1) * 0.7) return { num: L, den: 4 };
    return null;
  };
  // 1. 拍子（自動）
  const auto: (Meter | null)[] = segs.map((_, si) => {
    const am = aiMeter(si);
    if (am) return am;
    const R = ranges[si];
    const beats = Math.floor(R.n / 2);
    if (beats < 24) return null;
    const contrast = (m: number) => {
      const sum = new Array(m).fill(0);
      const cnt = new Array(m).fill(0);
      let all = 0;
      for (let j = 0; j < beats; j++) { const v = a(si, j * 2); sum[j % m] += v; cnt[j % m]++; all += v; }
      const mean = all / beats || 1;
      return Math.max(...sum.map((x, o) => x / Math.max(1, cnt[o]))) / mean - 1;
    };
    const c3 = contrast(3);
    const c4 = contrast(4);
    return c3 > c4 * 1.25 && c3 > 0.15 ? { num: 3, den: 4 } : { num: 4, den: 4 };
  });
  for (let i = 0; i < auto.length; i++) if (!auto[i]) auto[i] = auto.slice(0, i).reverse().find((x) => x) ?? null;
  for (let i = auto.length - 1; i >= 0; i--) if (!auto[i]) auto[i] = auto[i + 1] ?? { num: 4, den: 4 };
  r.meterAuto = auto as Meter[];
  const meters = segs.map((_, i) => override[i] ?? (auto[i] as Meter));
  // 2. 8 小節ずつの単位と、その中での小節の頭の位置（半拍の番号 o、0〜小節の長さ-1）ごとの点数
  type Unit = { si: number; h0: number; h1: number; L2: number; score: Float64Array; force: number };
  const units: Unit[] = [];
  segs.forEach((_, si) => {
    const R = ranges[si];
    const L2 = Math.max(1, Math.round(meterLen(meters[si]) * 2));
    const size = L2 * 8;
    for (let h0 = 0; h0 < R.n; h0 += size) {
      const h1 = Math.min(R.n, h0 + size);
      const score = new Float64Array(L2);
      let all = 0;
      for (let h = h0; h < h1; h++) all += a(si, h);
      const mean = all / Math.max(1, h1 - h0) || 1;
      const bars = Math.max(1, (h1 - h0) / L2);
      for (let o = 0; o < L2; o++) {
        // x/4 の拍子では、小節の頭は拍の上（半拍の位置にはしない）
        if (meters[si].den <= 4 && o % 2) { score[o] = -Infinity; continue; }
        let s2 = 0;
        let c = 0;
        for (let h = h0 + ((o - h0) % L2 + L2) % L2; h < h1; h += L2) { s2 += a(si, h); c++; }
        score[o] = c ? ((s2 / c) / mean - 1) * Math.sqrt(bars) : 0;
      }
      // BPM の変わり目（区間の頭）は小節の頭であることが多い。小節の頭で変わると分かっている区間は、そこを小節の頭にする
      if (si > 0 && h0 === 0 && score[0] !== -Infinity) score[0] += 3;
      // 拍の AI の小節の頭がこの単位に 3 つ以上あれば、それがそろう位置を重く見る
      {
        const v = new Array(L2).fill(0);
        let tot = 0;
        for (const h of aiH[si]) if (h >= h0 && h < h1) { v[h % L2]++; tot++; }
        if (tot >= 3) for (let o = 0; o < L2; o++) if (score[o] !== -Infinity) score[o] += (6 * v[o]) / tot;
      }
      units.push({ si, h0, h1, L2, score, force: si > 0 && h0 === 0 && segs[si].barStart ? 0 : -1 });
    }
  });
  // 手で決めた 1 拍目
  for (const at of anchorTimes) {
    const si = ranges.findIndex((R, i) => at >= R.t - R.P / 4 && (i === ranges.length - 1 || at < ranges[i + 1].t - ranges[i + 1].P / 4));
    if (si < 0) continue;
    const R = ranges[si];
    const h = Math.round((at - R.t) / (R.P / 2));
    const u = units.find((x) => x.si === si && h >= x.h0 && h < x.h1);
    if (u) u.force = ((h % u.L2) + u.L2) % u.L2;
  }
  if (!units.length) return;
  // 3. 動的計画法: 単位ごとの位置を選ぶ
  const C = 10;
  const lastDown = (u: Unit, o: number) => {
    const R = ranges[u.si];
    const lastH = o + Math.floor((R.n - 1 - o) / u.L2) * u.L2;
    return R.base + lastH / 2;
  };
  const trans = (u: Unit, o: number, v: Unit, o2: number) => {
    if (u.si === v.si) return o === o2 ? 0 : C;
    const gap = ranges[v.si].base + o2 / 2 - lastDown(u, o);
    return Math.abs(gap - u.L2 / 2) < 1e-6 ? 0 : C;
  };
  const val: Float64Array[] = [];
  const back: Int32Array[] = [];
  units.forEach((u, ui) => {
    const cur = new Float64Array(u.L2).fill(-Infinity);
    const bk = new Int32Array(u.L2).fill(-1);
    for (let o = 0; o < u.L2; o++) {
      if (u.force >= 0 && o !== u.force) continue;
      if (u.score[o] === -Infinity) continue;
      if (ui === 0) { cur[o] = u.score[o]; continue; }
      const p = units[ui - 1];
      for (let po = 0; po < p.L2; po++) {
        const pv = val[ui - 1][po];
        if (pv === -Infinity) continue;
        const v = pv - trans(p, po, u, o) + u.score[o];
        if (v > cur[o]) { cur[o] = v; bk[o] = po; }
      }
    }
    val.push(cur);
    back.push(bk);
  });
  const last = val[val.length - 1];
  let o = 0;
  for (let i = 1; i < last.length; i++) if (last[i] > last[o]) o = i;
  if (last[o] === -Infinity) return;
  const os = new Array<number>(units.length);
  for (let ui = units.length - 1; ui >= 0; ui--) {
    os[ui] = o;
    o = back[ui][o];
  }
  // 4. 小節の頭の並び。同じ区間の中で位置が変わる所（1 小節だけ短い・長い小節）は、
  //    前後の単位の中で「前の並びの最後の小節の頭」をどこにすると音にいちばん合うかで細かく決める
  type Piece = { si: number; o: number; h0: number; h1: number; L2: number };
  const pieces: Piece[] = [];
  units.forEach((u, ui) => {
    const last = pieces[pieces.length - 1];
    if (last && last.si === u.si && last.o === os[ui]) last.h1 = u.h1;
    else pieces.push({ si: u.si, o: os[ui], h0: u.h0, h1: u.h1, L2: u.L2 });
  });
  const first = (o: number, L2: number, from: number) => from + (((o - from) % L2) + L2) % L2;
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i - 1];
    const q = pieces[i];
    if (p.si !== q.si) continue;
    const si = p.si;
    let bestX = -1;
    let bestNew = -1;
    let bestS = -Infinity;
    for (let x = first(p.o, p.L2, p.h0); x < q.h1; x += p.L2) {
      const xNew = first(q.o, q.L2, x + 1);
      let sc = 0;
      for (let h = first(p.o, p.L2, p.h0); h <= x; h += p.L2) sc += a(si, h);
      for (let h = xNew; h < q.h1; h += q.L2) sc += a(si, h);
      if (sc > bestS) { bestS = sc; bestX = x; bestNew = xNew; }
    }
    if (bestX >= 0) {
      p.h1 = bestX + 1;
      q.h0 = bestNew;
    }
  }
  const downs: { beat: number; si: number }[] = [];
  for (const pc of pieces) {
    const R = ranges[pc.si];
    for (let h = first(pc.o, pc.L2, pc.h0); h < pc.h1; h += pc.L2) {
      const beat = R.base + h / 2;
      if (!downs.length || beat > downs[downs.length - 1].beat + 1e-6) downs.push({ beat, si: pc.si });
    }
  }
  if (!downs.length) return;
  const out: { beat: number; num: number; den: number }[] = [];
  let curLen = -1;
  downs.forEach((d, i) => {
    const len = i + 1 < downs.length ? downs[i + 1].beat - d.beat : meterLen(meters[d.si]);
    if (Math.abs(len - curLen) > 1e-6) {
      const m = meterOfLen(len, meters[d.si]);
      if (!out.length || !sameMeter(m, out[out.length - 1])) out.push({ beat: d.beat, num: m.num, den: m.den });
      curLen = len;
    }
  });
  r.meters = out;
  r.downbeat = downs[0].beat;
}

function alignScore(env: Envelope, r: TempoResult, phaseFree = false): number {
  if (!r.segments.length) return -Infinity;
  let sum = 0;
  let n = 0;
  let ts = r.t0;
  const at = (t: number) => {
    // 立ち上がりの山は少し早めに出るので、少し前を広めに見る（-35ms〜+12ms）
    const i = Math.round((t - env.t0) * env.fr);
    let v = 0;
    for (let d = -3; d <= 1; d++) v = Math.max(v, env.all[i + d] ?? 0);
    return v;
  };
  for (const s of r.segments) {
    const P = 60 / s.bpm;
    const nb = s.endBeat - s.startBeat;
    if (!phaseFree) {
      for (let j = 0; j < nb; j++) sum += at(ts + j * P);
      n += Math.max(0, Math.ceil(nb));
    } else {
      // 区間ごとに、拍を 1/4 拍ずつずらした中でいちばん合う所で数える（BPM が合っているかだけを見る。
      // 裏拍が強い曲では、正しい拍の位置より 1/4 拍ずれた所のほうが音が強いことがあるため）。
      // 半分の BPM（1 拍おき）でも数えて、よいほうにする（倍・半分のどちらで書いても、BPM が合っているかは同じに見る）。
      // 拍あたりの平均を、区間の長さで重みをつけて足す
      let best = -Infinity;
      for (const k of s.bpm / 2 >= BPM_MIN ? [1, 2] : [1]) {
        for (let q = 0; q < 4 * k; q++) {
          let sq = 0;
          let c = 0;
          for (let j = q / 4; j < nb; j += k) { sq += at(ts + j * P); c++; }
          if (c) best = Math.max(best, sq / c);
        }
      }
      if (best > -Infinity) { sum += best * nb * P; n += nb * P; }
    }
    ts += nb * P;
  }
  return n ? sum / n : -Infinity;
}

/**
 * 区間ごとの、拍の位置と音のずれ（秒、＋は音が後ろ）。BPM は譜面に書けるように整数などに丸め、区間の拍数も整数にするので、
 * 曲によっては区間ごとに音の位置が数十 ms ずつずれる（変わり目の前後で音源の拍の間がわずかに違うなど）
 */

/**
 * 曲の BPM（途中の変化も）と、小節の頭を測る。
 * 2 つの測り方（大まかに区間全体で合わせる／拍を 1 つずつ追う）で測り、曲の音の立ち上がりによく乗っているほうを使う
 */
export interface TempoOptions {
  /** 手で決めた 1 拍目（小節の頭）の時刻（秒） */
  anchors?: number[];
  /** 拍の AI（Beat This!）が見つけた拍と小節の頭の時刻（秒） */
  ai?: { beats: number[]; downbeats: number[] };
  /** 区間ごとに手で決めた拍子（null は自動） */
  meters?: (Meter | null)[];
}

export function analyzeTempo(mono: Float32Array, sr: number, progress?: (p: number) => void, opts: TempoOptions = {}): TempoResult {
  const duration = mono.length / sr;
  const env = envelope(mono, sr, progress);
  // 手で決めた 1 拍目は、近くの音の立ち上がりに合わせる
  curAnchors = (opts.anchors ?? []).filter((x) => x >= 0 && x < duration).map((x) => fineOnset(env, x, 0.04)).sort((a, b) => a - b);
  try {
    return analyzeInner(env, duration, progress, opts);
  } finally {
    curAnchors = [];
  }
}

/**
 * 区間ごとに、拍の線を音の立ち上がりに合わせ直す。
 * これまでは区間どうしを「ちょうど何拍」でつないでいたので、BPM の変わり目に半端な長さの小節がある曲
 * （0.5 拍・3.75 拍の小節など）では、つなぐために拍の線が区間ごとに数十 ms ずつずれていた。
 * 区間ごとに、拍の線と実際の音の立ち上がりのずれ（はっきり立ち上がっている拍ほど重く見た真ん中の値）を測り、
 * 最初の区間は OFFSET を、それ以降は前の区間の長さを半端な拍数だけ伸び縮みさせて、そのずれをなくす
 */
/**
 * 拍の線（t0 から P 秒ごとに nb 拍）と、実際の音の立ち上がりとのずれ（秒）。
 * 楽器によって鳴る時刻が少し違う（数十 ms 早い装飾音など）ので、平均ではなく、いちばん多くの拍がそろうずれ
 * （1ms ごとに数え、前後 2ms をならした山）にする。そろう拍が少ないときは null
 */
function onsetMode(env: Envelope, t0: number, P: number, nb: number, duration: number, lim = 30): number | null {
  const R = 60;
  const h = new Float64Array(R * 2 + 1);
  const ds: number[] = [];
  let n = 0;
  for (let k = 0; k < Math.floor(nb); k++) {
    const t = t0 + k * P;
    if (t < 0.05 || t > duration - 0.05) continue;
    n++;
    for (const o of onsetCands(env, t, Math.min((lim + 10) / 1000, P * 0.22))) {
      const d = (o.t - t) * 1000;
      const bi = Math.round(d) + R;
      if (bi < 0 || bi > R * 2) continue;
      h[bi] += o.w;
      ds.push(d);
    }
  }
  let best = -1;
  let bv = 0;
  // 探す範囲の端（±lim ms より外）の山は、拍の隣の別の音を拾ったものなので使わない
  for (let i = R - lim; i <= R + lim; i++) {
    let v = 0;
    for (let j = i - 2; j <= i + 2; j++) v += h[j] ?? 0;
    if (v > bv) {
      bv = v;
      best = i;
    }
  }
  if (best < 0 || bv < Math.max(4, n * 0.15) * Math.LN2 * 2) return null;
  const c = best - R;
  const near = ds.filter((d) => Math.abs(d - c) <= 3);
  return near.reduce((p, v) => p + v, 0) / near.length / 1000;
}

function alignSegments(env: Envelope, r: TempoResult): TempoResult {
  if (!r.segments.length) return r;
  const segs = r.segments.map((x) => ({ ...x }));
  // 区間ごとのずれ（今の拍の線から）。測れなかった区間は null
  const measure = (t0: number, lim: number) => {
    const off: (number | null)[] = [];
    let ts = t0;
    for (const sg of segs) {
      const nb = sg.endBeat - sg.startBeat;
      off.push(onsetMode(env, ts + (sg.lead ?? 0), 60 / sg.bpm, nb, r.duration, lim));
      ts += nb * (60 / sg.bpm);
    }
    return off;
  };
  let t0 = r.t0;
  // 測るのは 1 回（±30ms）。測れなかった区間は前（無ければ後ろ）の区間と同じだけ動かし、動かした所でもう 1 回だけ測る。
  // （測って動かすことを何度も繰り返すと、隣の別の楽器の音へ少しずつずれていってしまう）
  let pending = segs.map(() => true);
  for (let pass = 0; pass < 2 && pending.some((x) => x); pass++) {
    const off = measure(t0, 30);
    const got = off.map((v, i) => pending[i] && v !== null);
    const e = off.map((v, i) => (pending[i] ? v : 0));
    for (let i = 0; i < e.length; i++) if (e[i] === null) e[i] = i > 0 ? e[i - 1] : null;
    for (let i = e.length - 1; i >= 0; i--) if (e[i] === null) e[i] = e[i + 1] ?? 0;
    const ee = e as number[];
    // 最初の区間は OFFSET で、それ以降は区間ごとのずらし（lead）で合わせる
    const e0 = pending[0] ? ee[0] : 0;
    t0 += e0;
    segs.forEach((sg, j) => {
      const d = (sg.lead ?? 0) + (pending[j] ? ee[j] : 0) - e0;
      if (Math.abs(d) >= 0.0005) sg.lead = d;
      else delete sg.lead;
    });
    pending = pending.map((p, i) => p && !got[i]);
  }
  return { ...r, t0, segments: segs };
}

function analyzeInner(env: Envelope, duration: number, progress: ((p: number) => void) | undefined, opts: TempoOptions): TempoResult {
  const tg = tempogram(env.all, env.fr, progress);
  const path = tempoPath(tg);
  const craw = analyzeCoarse(env, tg, path, duration);
  const rawInfo = craw.segs.map((x) => Math.round(x.bpm)).join('→');
  let bridgeFail = 0;
  let solvedChain = false;
  // 大まかな測り方の区間の整理: 8 秒未満の短い区間（裏拍や 3 連のリズムが目立つだけのことが多い）は隣につなぎ、
  // BPM の差が 1.5% 未満の隣どうしもつなぐ（つないだ所は、つないだ範囲全体で合わせ直す）
  {
    let segs = craw.segs;
    // 倍・半分の取り違えを直す: いちばん長い区間を基準に、隣の区間との BPM の比が 1 に近くなるほうの倍・半分を選ぶ
    if (segs.length > 1) {
      const len = (x: CoarseSeg) => x.end - x.start;
      let a = 0;
      segs.forEach((x, i) => { if (len(x) > len(segs[a])) a = i; });
      // 隣の区間の BPM に近いほど、また太鼓の曲でよくある速さ（170 くらい）に近いほどよい
      const fix = (i: number, ref: number) => {
        const cost = (b: number) => Math.abs(Math.log2(b / ref)) + Math.abs(Math.log2(b / 170));
        const x = segs[i];
        let c = x.bpm;
        for (const m of [0.5, 2]) {
          const b = x.bpm * m;
          if (b >= BPM_MIN && b <= BPM_MAX && cost(b) < cost(c) - 0.1) c = b;
        }
        if (c !== x.bpm) segs[i] = refineCoarse(env, x.start, x.end, c);
      };
      for (let i = a + 1; i < segs.length; i++) fix(i, segs[i - 1].bpm);
      for (let i = a - 1; i >= 0; i--) fix(i, segs[i + 1].bpm);
    }
    // 同じ BPM の区間にはさまれた、BPM がちょうど 2/3・3/2 倍（1% 以内）の区間は、3 連のリズムが目立つだけのことが多いので、前後の BPM にする
    // （3/4・4/3 倍は 175 → 130 → 175 のような本当の変化と区別がつかないので入れない）
    for (let i = 1; i + 1 < segs.length; i++) {
      const p = segs[i - 1].bpm;
      const q = segs[i + 1].bpm;
      if (Math.abs(p / q - 1) >= 0.015) continue;
      const r = segs[i].bpm / p;
      if (![2 / 3, 3 / 2].some((x) => Math.abs(r / x - 1) < 0.01)) continue;
      segs[i] = refineCoarse(env, segs[i].start, segs[i].end, (p + q) / 2);
    }
    for (let guard = 0; guard < 50 && segs.length > 1; guard++) {
      let j = segs.findIndex((x) => x.end - x.start < 8);
      if (j < 0) j = segs.findIndex((x, i) => i > 0 && Math.abs(x.bpm / segs[i - 1].bpm - 1) < 0.015);
      if (j < 0) break;
      const k = j === 0 ? 1 : j === segs.length - 1 ? j - 1 : segs[j - 1].end - segs[j - 1].start >= segs[j + 1].end - segs[j + 1].start ? j - 1 : j + 1;
      const a0 = Math.min(j, k);
      const keep = segs[j].end - segs[j].start >= segs[k].end - segs[k].start ? segs[j] : segs[k];
      const merged = refineCoarse(env, segs[a0].start, segs[a0 + 1].end, keep.bpm);
      segs = [...segs.slice(0, a0), merged, ...segs.slice(a0 + 2)];
    }
    // 境目を細かく決め、だんだん変わる所は小さな区間に分ける。
    // 短い（40 秒未満の）区間をはさむときは、その前後の区間とまとめて 1 度に決める
    const solved = segs.length > 1 ? solveChain(env, segs, true) : null;
    solvedChain = !!solved;
    if (solved) segs = solved;
    else if (segs.length > 1) {
      const out: CoarseSeg[] = [segs[0]];
      let i = 0;
      while (i < segs.length - 1) {
        let j = i + 1;
        while (j < segs.length - 1 && segs[j].end - segs[j].start < 40) j++;
        const mid = bridge(env, segs.slice(i, j + 1), i === 0);
        if (!mid) bridgeFail++;
        out.push(...(mid ?? segs.slice(i + 1, j)), segs[j]);
        i = j;
      }
      segs = out;
    }
    craw.segs = segs;
    if (segs.length) craw.downbeat = segs[0].down ?? findDownbeatCoarse(env, segs[0]);
  }
  const coarse = coarseToResult(craw, duration);
  const fine = analyzeFine(env, tg, path, duration, progress);
  progress?.(1);
  // 曲全体を 1 つの BPM として合わせた案。多くの曲は BPM が変わらないので、変わる案ははっきりよいときだけ使う
  // （裏拍や 3 連のリズムが目立つ所を、BPM が変わったと取り違えないように）
  const med = [...path].sort((p, q) => p - q)[Math.floor(path.length / 2)] ?? 120;
  const one = refineCoarse(env, 0, duration, med);
  const single = coarseToResult({ segs: [one], downbeat: findDownbeatCoarse(env, one) }, duration);
  const ss = alignScore(env, single);
  const sc = alignScore(env, coarse);
  const sf = alignScore(env, fine);
  // 区間が多い案ほど、はっきりよいときだけ使う
  let best = single;
  let bs = ss;
  // 1 つの BPM と区間ごとのどちらにするかは、拍の位置（1/4 拍のずれ）を問わずに、BPM が合っているかで比べる
  // ただし、拍の位置まで含めた合い方で 1 つの BPM のほうが 1 割以上よいときは、1 つの BPM のまま
  // （BPM がだんだん変わっていくように見えても、拍の位置まで合うのは 1 つの BPM、という曲がある）
  if (coarse.segments.length > 1 && alignScore(env, coarse, true) > alignScore(env, single, true) * 1.04 && !(ss > sc * 1.1)) {
    best = coarse;
    bs = sc;
  }
  // 細かい測り方は、BPM が隣の区間と大きく（8% 以上）違う所が多いときは使わない（拍の数え間違いの印）
  let jumps = 0;
  for (let i = 1; i < fine.segments.length; i++) if (Math.abs(fine.segments[i].bpm / fine.segments[i - 1].bpm - 1) > 0.08) jumps++;
  const fineOk = jumps <= Math.max(2, fine.segments.length / 10);
  // 区間ごとの案が「仮説 → 検算」で決めた変わり方なら、1 拍ずつの案ははっきり（10% 以上）よいときだけ使う
  if (fineOk && sf > bs * (solvedChain && best === coarse ? 1.1 : 1.03) && sf > ss * 1.04) best = fine;
  // 手で決めた 1 拍目があるときは、そこに拍が来る案を使う
  if (curAnchors.length && anchorErr(best) > 0.035) {
    const ok = [coarse, single, fine].filter((r) => anchorErr(r) <= 0.035);
    if (ok.length) best = ok[0];
  }
  // 1 拍おきに強い音が来る曲は、半分の BPM で書く
  if (!curAnchors.length) best = halveIfSlow(env, best);
  // 拍の AI が見つけた小節の頭（拍子と小節の頭を決めるときに使う。手で決めた 1 拍目があるときはそちらに従う）
  if (!curAnchors.length && opts.ai?.downbeats.length) best.aiDowns = [...opts.ai.downbeats].sort((x, y) => x - y);
  const name = best === single ? '1 つの BPM' : best === coarse ? '区間ごと' : '1 拍ずつ';
  // 区間ごとに、拍の線を音の立ち上がりに合わせ直す（区間の境目では、拍の線が半端な長さだけずれてよい）
  if (!curAnchors.length) best = alignSegments(env, best);
  // 拍子と小節の頭（途中で 1 小節だけ短い・長い小節も）
  best.beatAcc = beatAccents(env, best);
  computeMeters(best, opts.meters ?? [], curAnchors);
  const bpms = (r: TempoResult) => r.segments.map((x) => x.bpm).join('→');
  best.info = `大まかな区間 ${rawInfo}／区間ごと ${bpms(coarse)}${bridgeFail ? `（つなぎ失敗 ${bridgeFail}）` : ''}／合い方 1 つ ${ss.toFixed(3)}・区間 ${sc.toFixed(3)}・1 拍ずつ ${sf.toFixed(3)}／採用 ${name}${best.aiDowns ? `／AI の小節の頭 ${best.aiDowns.length}` : ''}`;
  return best;
}

// ---------- 譜面に入れる形にする ----------

export interface TempoPlan {
  bpm: number;
  offset: number;
  /** 2 つ目以降の区間の #BPMCHANGE（tick は 1 拍 = tpb） */
  changes: { tick: number; bpm: number }[];
  /** #MEASURE（4/4 から変わる所。1 小節だけ短い・長い小節は、その小節と次の小節の 2 つ） */
  measures: { tick: number; num: number; den: number }[];
}

/**
 * 測った結果を譜面の形にする。mul = 区間ごとの速さの倍率（2 = 倍、0.5 = 半分）、shift = 1 拍目を何拍ずらすか、
 * fine = OFFSET の手での微調整（秒、＋で拍が後ろへ）
 * OFFSET は「最初の 1 拍目」の時刻（音源の頭以降でいちばん早い小節の頭）にそろえる
 */
export function tempoPlan(r: TempoResult, tpb: number, mul: number | number[] = 1, shift = 0, fine = 0): TempoPlan | null {
  if (!r.segments.length) return null;
  const m = (i: number) => (Array.isArray(mul) ? mul[i] ?? 1 : mul);
  // 区間ごとの拍の長さと拍数（倍率を掛けた後）
  const segs = r.segments.map((s, i) => ({ bpm: Number((s.bpm * m(i)).toFixed(3)), beats: (s.endBeat - s.startBeat) * m(i), start: s.startBeat }));
  // 区間ごとのずらし（lead）: 前の区間の長さを、その秒数ぶん伸び縮みさせる
  for (let i = 0; i + 1 < segs.length; i++) {
    const d = (r.segments[i + 1].lead ?? 0) - (r.segments[i].lead ?? 0);
    if (d) segs[i].beats += (d * segs[i].bpm) / 60;
  }
  // 拍の番号（測ったときの数え方）→ 倍率を掛けた後の拍の番号
  const sStart: number[] = [];
  {
    let acc = segs[0].start * m(0);
    segs.forEach((s) => { sStart.push(acc); acc += s.beats; });
  }
  const segOf = (b: number) => {
    let i = 0;
    while (i + 1 < r.segments.length && b >= r.segments[i + 1].startBeat - 1e-9) i++;
    return i;
  };
  const scaled = (b: number) => { const i = segOf(b); return sStart[i] + (b - r.segments[i].startBeat) * m(i); };
  const P1 = 60 / segs[0].bpm;
  const firstBeat = sStart[0];
  const meters = r.meters?.length ? r.meters : [{ beat: r.downbeat, num: 4, den: 4 }];
  const L0 = meterLen(meters[0]) * m(segOf(meters[0].beat));
  const t0 = r.t0 + fine;
  // 測った 1 拍目は、音源の頭以降でいちばん早い小節の頭に合わせる。
  // ただし音源の頭のわずかに前（0.1 秒以内）の小節の頭は、測りの誤差で前に出ただけのことが多いので、そこを 1 小節目にする
  // （例: 本当は 0.013 秒の 1 拍目が -0.003 秒と測れたとき、1 小節後ろを 1 小節目にすると譜面全体が 1 小節ずれる）
  // どの小節を 1 小節目にするかは、拍の線を手で動かす前（fine = 0）の位置で決める。
  // 動かした後の位置で決めると、少し動かすたびに 1 小節目が 1 小節ずつ入れ替わり、小節の番号が行ったり来たりする
  let d0 = scaled(r.downbeat);
  d0 -= Math.floor((r.t0 + (d0 - firstBeat) * P1 + 0.1) / (L0 * P1)) * L0;
  // そこから手で動かした拍数（音源の頭より前にも、何小節後ろにも動かせる。最初の BPM の区間の中まで）
  const d = Math.min(d0 + shift, firstBeat + segs[0].beats - 1);
  const down = t0 + (d - firstBeat) * P1;
  const changes: { tick: number; bpm: number }[] = [];
  let beatPos = segs[0].beats + firstBeat - d; // 2 つ目の区間の頭までの、1 拍目からの拍数
  for (let i = 1; i < segs.length; i++) {
    const tick = Math.round(beatPos * tpb);
    if (tick > (changes[changes.length - 1]?.tick ?? 0)) changes.push({ tick, bpm: segs[i].bpm });
    beatPos += segs[i].beats;
  }
  // 拍子: 小節の並びは 1 拍目からの位置で決まる（1 拍目を動かすと小節の並びごと動く）
  const measures: { tick: number; num: number; den: number }[] = [];
  let prev: Meter = { num: 4, den: 4 };
  meters.forEach((e, i) => {
    const mi = m(segOf(e.beat));
    const met = mi === 1 ? { num: e.num, den: e.den } : meterOfLen(meterLen(e) * mi);
    const tick = i === 0 ? 0 : Math.round((scaled(e.beat) - d0) * tpb);
    if (tick < 0 || sameMeter(met, prev)) return;
    if (measures.length && measures[measures.length - 1].tick === tick) measures.pop();
    measures.push({ tick, ...met });
    prev = met;
  });
  return { bpm: segs[0].bpm, offset: Number((-down).toFixed(3)), changes, measures };
}

/** その tick の時刻（秒） */
export function planTimeAt(plan: TempoPlan, tpb: number, tick: number): number {
  let t = -plan.offset;
  let tk = 0;
  let bpm = plan.bpm;
  for (const c of plan.changes) {
    if (c.tick >= tick) break;
    t += ((c.tick - tk) / tpb) * (60 / bpm);
    tk = c.tick;
    bpm = c.bpm;
  }
  return t + ((tick - tk) / tpb) * (60 / bpm);
}

/** 小節の頭の tick の一覧（untilTick まで）。n は小節の番号（1 から） */
export function planBars(plan: TempoPlan, tpb: number, untilTick: number): { tick: number; n: number }[] {
  const out: { tick: number; n: number }[] = [];
  let tick = 0;
  let len = 4 * tpb;
  let mi = 0;
  for (let n = 1; tick <= untilTick && n < 100000; n++) {
    while (mi < plan.measures.length && plan.measures[mi].tick <= tick) {
      len = Math.max(1, Math.round((plan.measures[mi].num * 4 * tpb) / plan.measures[mi].den));
      mi++;
    }
    out.push({ tick, n });
    // 拍子の変わり目が小節の途中にあるときは、そこで小節を区切る
    const nextM = plan.measures[mi]?.tick ?? Infinity;
    tick = Math.min(tick + len, nextM);
  }
  return out;
}

/** 案の拍の時刻（確認画面の波形に線を引く用）。小節の頭は bar、n は小節の番号 */
export function planBeatTimes(plan: TempoPlan, tpb: number, untilSec: number): { t: number; bar: boolean; n: number }[] {
  const out: { t: number; bar: boolean; n: number }[] = [];
  // untilSec までの tick を大まかに求める（BPM がいちばん遅い所でも届くように）
  let untilTick = 0;
  while (planTimeAt(plan, tpb, untilTick) <= untilSec && untilTick < tpb * 200000) untilTick += tpb * 16;
  const bars = planBars(plan, tpb, untilTick);
  const barAt = new Map(bars.map((b) => [b.tick, b.n]));
  const ticks = new Set<number>(bars.map((b) => b.tick));
  for (let k = 0; k * tpb <= untilTick; k++) ticks.add(k * tpb);
  for (const tick of [...ticks].sort((x, y) => x - y)) {
    const t = planTimeAt(plan, tpb, tick);
    if (t > untilSec) break;
    out.push({ t, bar: barAt.has(tick), n: barAt.get(tick) ?? 0 });
  }
  return out;
}

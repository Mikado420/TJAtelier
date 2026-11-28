/**
 * 書き出す音源の音量を上げる（音割れしないように、ピークの所だけ自然に抑えるリミッター付き）。
 *
 * gain 倍にしたとき ceiling を超える所だけ、そこに向けて少し前から（約 3ms）なめらかに音量を下げ、
 * 過ぎたら約 80ms かけて戻す。超えない所は、ちょうど gain 倍（音は変わらず大きくなるだけ）。
 * 全チャンネルに同じ音量を掛けるので、左右の定位は変わらない。
 */
export function boostWithLimiter(chs: Float32Array[], sr: number, gain: number, ceiling = 0.95, inPlace = false): Float32Array[] {
  const n = chs[0]?.length ?? 0;
  // その所で必要な音量（1 = 下げなくてよい）
  const need = new Float64Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const c of chs) { const v = Math.abs(c[i]); if (v > p) p = v; }
    const q = p * gain;
    if (q > ceiling) { need[i] = ceiling / q; any = true; } else need[i] = 1;
  }
  const g = need;
  if (any) {
    // 後ろから: ピークの少し前から下げ始める（ピークで急に下がらないように）
    const atk = 1 - Math.exp(-1 / (0.003 * sr));
    for (let i = n - 2; i >= 0; i--) {
      let back = g[i + 1] + (1 - g[i + 1]) * atk;
      if (back > 0.999999) back = 1; // 戻りきったら、ちょうど 1（下げていない所は正確に gain 倍）
      if (back < g[i]) g[i] = back;
    }
    // 前から: 下げたあと、ゆっくり戻す
    const rel = 1 - Math.exp(-1 / (0.08 * sr));
    for (let i = 1; i < n; i++) {
      let fwd = g[i - 1] + (1 - g[i - 1]) * rel;
      if (fwd > 0.999999) fwd = 1;
      if (fwd < g[i]) g[i] = fwd;
    }
  }
  // inPlace なら渡した配列をそのまま書き換える（曲の長さぶんの配列を新しく作らない）
  return chs.map((c) => {
    const o = inPlace ? c : new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = c[i] * gain * g[i];
    return o;
  });
}

/** .ogg（Vorbis）の最初のヘッダーから、サンプリング周波数を読む（読めなければ 0） */
export function oggSampleRate(data: ArrayBuffer): number {
  const b = new Uint8Array(data, 0, Math.min(data.byteLength, 4096));
  for (let i = 0; i + 16 < b.length; i++) {
    // 0x01 "vorbis" の後ろ: バージョン（4）・チャンネル数（1）・サンプリング周波数（4、リトルエンディアン）
    if (b[i] === 1 && b[i + 1] === 0x76 && b[i + 2] === 0x6f && b[i + 3] === 0x72 && b[i + 4] === 0x62 && b[i + 5] === 0x69 && b[i + 6] === 0x73) {
      const o = i + 7 + 4 + 1;
      return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    }
  }
  return 0;
}

/**
 * 曲の聞こえる大きさ（大きい所）。人の耳の感じ方に合わせた重み（BS.1770 の K 特性: 低音を軽く、高音を少し重く数える）を掛け、
 * 0.4 秒ごと（0.1 秒ずつずらす）に、左右それぞれの強さの平均を求め、大きい側から 1 割の所の大きさを返す（RMS と同じ単位）。
 * 低音の多い曲を大きいと見すぎない（前の測り方は低音も高音も同じに数えていた）
 */
export function musicLoudness(chs: Float32Array[], sr: number): number {
  const n = chs[0]?.length ?? 0;
  const hop = Math.max(1, Math.round(sr * 0.1));
  const nb = Math.floor(n / hop);
  if (nb < 1 || !chs.length) return 0;
  const sums = new Float64Array(nb);
  const [s1, s2] = kWeight(sr);
  for (const d of chs) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let i = 0; i < nb * hop; i++) {
      const x = d[i];
      const y = s1[0] * x + s1[1] * x1 + s1[2] * x2 - s1[3] * y1 - s1[4] * y2;
      x2 = x1; x1 = x;
      const z = y - 2 * y1 + y2 - s2[3] * z1 - s2[4] * z2;
      y2 = y1; y1 = y;
      z2 = z1; z1 = z;
      sums[(i / hop) | 0] += z * z;
    }
  }
  // 0.4 秒 = 0.1 秒の 4 つ分
  const W = 4;
  const nw = nb - W + 1;
  if (nw < 1) return Math.sqrt(sums.reduce((a, b) => a + b, 0) / (nb * hop * chs.length));
  const vals = new Float64Array(nw);
  let acc = 0;
  for (let k = 0; k < nb; k++) {
    acc += sums[k];
    if (k >= W) acc -= sums[k - W];
    if (k >= W - 1) vals[k - W + 1] = acc / (W * hop * chs.length);
  }
  vals.sort();
  return Math.sqrt(vals[Math.floor(nw * 0.9)]);
}

/** K 特性の 2 つのフィルター（高い音を少し上げる・とても低い音を切る）の係数 [b0, b1, b2, a1, a2] */
function kWeight(fs: number): [number[], number[]] {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Q1 = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const s1 = [(Vh + (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q1 + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q1 + K * K) / a0];
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  const s2 = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0];
  return [s1, s2];
}

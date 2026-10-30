/**
 * 音源をまるごと音のデータに直さずに、ファイルの中の情報から長さ（秒）を読む（読み込みを速くするため）。
 * 読めないときは null（そのときは今までどおり音のデータに直して測る）
 */

/** Ogg（Vorbis・Opus）: 最初のページのサンプリング周波数と、最後のページの位置（サンプル数）から */
export function oggDuration(buf: ArrayBuffer): number | null {
  const u = new Uint8Array(buf);
  if (u.length < 64 || u[0] !== 0x4f || u[1] !== 0x67 || u[2] !== 0x67 || u[3] !== 0x53) return null;
  const dv = new DataView(buf);
  const nseg = u[26];
  const pk = 27 + nseg;
  if (pk + 20 > u.length) return null;
  const str = (o: number, n: number) => String.fromCharCode(...u.subarray(o, o + n));
  let rate = 0;
  let skip = 0;
  if (u[pk] === 0x01 && str(pk + 1, 6) === 'vorbis') rate = dv.getUint32(pk + 12, true);
  else if (str(pk, 8) === 'OpusHead') {
    rate = 48000;
    skip = dv.getUint16(pk + 10, true);
  } else return null;
  if (!(rate > 0)) return null;
  const serial = dv.getUint32(14, true);
  // 後ろから、同じ流れ（serial）の最後のページを探す
  for (let i = u.length - 27; i >= Math.max(0, u.length - 1024 * 1024); i--) {
    if (u[i] !== 0x4f || u[i + 1] !== 0x67 || u[i + 2] !== 0x67 || u[i + 3] !== 0x53) continue;
    if (dv.getUint32(i + 14, true) !== serial) continue;
    const lo = dv.getUint32(i + 6, true);
    const hi = dv.getInt32(i + 10, true);
    if (hi < 0) continue; // -1 = このページでは決まらない
    const gran = hi * 2 ** 32 + lo;
    const sec = (gran - skip) / rate;
    return sec > 0 && sec < 6 * 3600 ? sec : null;
  }
  return null;
}

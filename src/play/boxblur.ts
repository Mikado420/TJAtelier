/**
 * canvas のぼかし（filter）が使えない端末（iPhone の Safari など）のための、画素を直接ぼかす処理。
 * 箱型のぼかしを縦横 3 回ずつかけて、ガウスぼかし（canvas の blur(σpx) と同じぼけ方）に近づける
 */

/** σ のガウスぼかしに近い、3 回の箱型ぼかしの半径 */
export function boxRadii(sigma: number): number[] {
  const n = 3;
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(((i < m ? wl : wu) - 1) / 2);
  return out;
}

/** 1 行（または 1 列）ずつの箱型ぼかし。端は端の画素が続くものとする */
function pass(src: Uint8ClampedArray, dst: Uint8ClampedArray, w: number, h: number, r: number, horiz: boolean) {
  if (r <= 0) { dst.set(src); return; }
  const lines = horiz ? h : w;
  const len = horiz ? w : h;
  const step = horiz ? 4 : w * 4;
  const inv = 1 / (r * 2 + 1);
  for (let l = 0; l < lines; l++) {
    const base = horiz ? l * w * 4 : l * 4;
    const last = base + (len - 1) * step;
    for (let c = 0; c < 4; c++) {
      const first = src[base + c];
      const end = src[last + c];
      let sum = first * (r + 1);
      for (let i = 1; i <= r; i++) sum += src[base + Math.min(i, len - 1) * step + c];
      for (let i = 0; i < len; i++) {
        dst[base + i * step + c] = sum * inv;
        const add = i + r + 1;
        const sub = i - r;
        sum += (add < len ? src[base + add * step + c] : end) - (sub > 0 ? src[base + sub * step + c] : first);
      }
    }
  }
}

/** 画素（RGBA）を σ px でぼかす（書き換える） */
export function blurRGBA(data: Uint8ClampedArray, w: number, h: number, sigma: number) {
  if (sigma <= 0 || w < 1 || h < 1) return;
  const tmp = new Uint8ClampedArray(data.length);
  for (const r of boxRadii(sigma)) {
    pass(data, tmp, w, h, r, true);
    pass(tmp, data, w, h, r, false);
  }
}

import { describe, expect, test } from 'vitest';
import { blurRGBA, boxRadii } from './boxblur';

describe('画素を直接ぼかす', () => {
  test('3 回の箱型ぼかしの広がりが σ に近い', () => {
    for (const s of [1, 3, 4.5, 9]) {
      const v = boxRadii(s).reduce((a, r) => a + ((2 * r + 1) ** 2 - 1) / 12, 0);
      expect(Math.abs(Math.sqrt(v) - s)).toBeLessThan(0.6);
    }
  });
  test('同じ色の絵は変わらない', () => {
    const d = new Uint8ClampedArray(20 * 10 * 4).fill(123);
    blurRGBA(d, 20, 10, 3);
    expect([...d].every((x) => x === 123)).toBe(true);
  });
  test('明るい四角が周りに広がり、合計がほぼ保たれる', () => {
    const w = 41, h = 41;
    const d = new Uint8ClampedArray(w * h * 4);
    const big = new Float64Array(w * h);
    for (let y = 15; y <= 25; y++) for (let x = 15; x <= 25; x++) d[(y * w + x) * 4] = 200;
    blurRGBA(d, w, h, 2);
    let sum = 0;
    for (let i = 0; i < w * h; i++) { big[i] = d[i * 4]; sum += big[i]; }
    expect(Math.abs(sum - 121 * 200)).toBeLessThan(121 * 200 * 0.02);
    expect(big[20 * w + 20]).toBeGreaterThan(150);
    expect(big[20 * w + 13]).toBeGreaterThan(10);
    expect(big[20 * w + 5]).toBe(0);
  });
});

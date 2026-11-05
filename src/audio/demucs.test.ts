import { describe, expect, it } from 'vitest';
import { spec, ispec } from './demucs';

describe('音源分離の STFT', () => {
  it('スペクトルにして戻すと元の音になる（端の 1 フレーム分を除く）', () => {
    const L = 88200;
    const x = new Float64Array(L);
    for (let i = 0; i < L; i++) x[i] = Math.sin(i * 0.013) * 0.5 + Math.sin(i * 0.31) * 0.2 + (i % 5000 < 30 ? 0.8 : 0);
    const z = spec(x);
    const out = new Float64Array(L);
    const w = new Float64Array(L).fill(1);
    ispec(Float32Array.from(z.re), Float32Array.from(z.im), z.le, L, out, w);
    let err = 0;
    for (let i = 4096; i < L - 4096; i++) err = Math.max(err, Math.abs(out[i] - x[i]));
    expect(z.le).toBe(87);
    expect(err).toBeLessThan(1e-3);
  });
});

import { describe, expect, it } from 'vitest';
import { logMel, melFilters, peaks, resample } from './beatThis';

describe('拍の AI（Beat This!）の前後の処理', () => {
  it('メルのフィルタは 513 × 128 で、どのメルも 0 でない所がある', () => {
    const fb = melFilters();
    expect(fb.length).toBe(513 * 128);
    for (let m = 0; m < 128; m++) {
      let s = 0;
      for (let k = 0; k < 513; k++) s += fb[k * 128 + m];
      expect(s).toBeGreaterThan(0);
    }
  });

  it('44.1kHz を 22.05kHz にして、1 秒 50 フレームのメルスペクトログラムにする', () => {
    const x = new Float32Array(44100 * 2);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.5;
    const y = resample(x, 44100);
    expect(y.length).toBe(44100);
    const { mel, frames } = logMel(y);
    expect(frames).toBe(Math.floor(44100 / 441) + 1);
    expect(mel.length).toBe(frames * 128);
    expect(mel.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
  });

  it('前後 3 フレームでいちばん高く 0 を超える所を拍にし、小節の頭はいちばん近い拍に寄せる', () => {
    const beat = new Float32Array(200).fill(-5);
    const down = new Float32Array(200).fill(-5);
    for (const f of [10, 35, 60, 85, 110, 135]) beat[f] = 3;
    beat[61] = 3; // 隣り合う山は平均
    down[11] = 2;
    down[111] = 2;
    const r = peaks(beat, down);
    expect(r.beats.map((t) => Math.round(t * 50 * 10) / 10)).toEqual([10, 35, 60.5, 85, 110, 135]);
    expect(r.downbeats.map((t) => Math.round(t * 50))).toEqual([10, 110]);
  });
});

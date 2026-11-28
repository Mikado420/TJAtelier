import { describe, expect, it } from 'vitest';
import { boostWithLimiter, musicLoudness, oggSampleRate } from './loudness';

describe('書き出しの音量', () => {
  it('小さい音は、ちょうど 1.5 倍になる', () => {
    const a = new Float32Array(1000).map((_, i) => Math.sin(i / 10) * 0.4);
    const [o] = boostWithLimiter([a], 44100, 1.5);
    for (let i = 0; i < a.length; i++) expect(o[i]).toBeCloseTo(a[i] * 1.5, 6);
  });

  it('大きい音でも上限を超えない（音割れしない）。ピークから離れた所は 1.5 倍に戻る', () => {
    const sr = 44100;
    const a = new Float32Array(sr).map((_, i) => Math.sin(i / 5) * 0.2);
    // 真ん中に大きいピーク
    for (let i = 22000; i < 22100; i++) a[i] = Math.sin(i / 5) * 0.99;
    const [o] = boostWithLimiter([a, a], sr, 1.5);
    let mx = 0;
    for (const v of o) mx = Math.max(mx, Math.abs(v));
    expect(mx).toBeLessThanOrEqual(0.95 + 1e-6);
    // ピークの 0.5 秒前・後はそのまま 1.5 倍
    expect(o[1000]).toBeCloseTo(a[1000] * 1.5, 6);
    // 後ろは約 80ms かけて戻るので、0.5 秒後には 1.5 倍とほぼ同じ（0.5% 以内）
    expect(o[sr - 100] / (a[sr - 100] * 1.5)).toBeGreaterThan(0.995);
  });

  it('.ogg のサンプリング周波数を読む', () => {
    const b = new Uint8Array(64);
    b.set([0x4f, 0x67, 0x67, 0x53], 0);
    b.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0], 28);
    expect(oggSampleRate(b.buffer)).toBe(44100);
    expect(oggSampleRate(new Uint8Array(10).buffer)).toBe(0);
  });
});

describe('曲の聞こえる大きさ（musicLoudness）', () => {
  const sine = (f: number, a: number, sr = 48000, sec = 3) => Float32Array.from({ length: sr * sec }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
  it('997Hz・振幅 1 の正弦波（左右とも）は 0 LUFS（BS.1770 の基準）', () => {
    const v = musicLoudness([sine(997, 1), sine(997, 1)], 48000);
    const lufs = -0.691 + 10 * Math.log10(2 * v * v);
    expect(Math.abs(lufs)).toBeLessThan(0.05);
  });
  it('同じ強さなら、低い音（60Hz）は 1000Hz より小さく測る', () => {
    const lo = musicLoudness([sine(60, 0.5)], 44100);
    const hi = musicLoudness([sine(1000, 0.5)], 44100);
    expect(20 * Math.log10(hi / lo)).toBeGreaterThan(0.8);
  });
  it('静かな前半と大きいサビ: 大きい所（大きい側から 1 割）の大きさを返す', () => {
    const q = sine(1000, 0.05, 48000, 9), l = sine(1000, 0.5, 48000, 3);
    const both = new Float32Array(q.length + l.length);
    both.set(q);
    both.set(l, q.length);
    expect(musicLoudness([both], 48000) / musicLoudness([l], 48000)).toBeCloseTo(1, 2);
  });
});


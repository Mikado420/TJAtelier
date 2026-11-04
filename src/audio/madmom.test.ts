import { describe, expect, it } from 'vitest';
import { activations, dbnDownbeats, features, parseModel } from './madmom';

// node の fs（型の定義は入れていないので、ここで形だけ決める）
const fsName = 'fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: URL): Uint8Array };
const buf = readFileSync(new URL('../../public/ai/madmom-downbeats.bin', import.meta.url));
const model = parseModel(new Uint8Array(buf).buffer as ArrayBuffer);

describe('拍の AI（madmom）', () => {
  it('モデルのファイルを読む（3 つの窓、8 個のモデル、特徴は 314 個）', () => {
    expect(model.head.res.map((r) => r.frame)).toEqual([1024, 2048, 4096]);
    expect(model.head.models.length).toBe(8);
    expect(model.head.res.reduce((p, r) => p + r.bands.length * 2, 0)).toBe(314);
  });

  it('DBN: 1 秒ごとの拍で、4 拍ごとに小節の頭が強い確からしさなら、4 拍子で 1 拍目をそこにする', () => {
    const frames = 1600;
    const act = new Float32Array(frames * 2);
    for (let f = 0; f < frames; f++) {
      act[f * 2] = 0.01;
      act[f * 2 + 1] = 0.01;
    }
    // 120 BPM（50 フレームごと）、最初の小節の頭は 0.3 秒
    for (let k = 0; k * 50 + 30 < frames; k++) {
      const f = k * 50 + 30;
      if (k % 4 === 0) act[f * 2 + 1] = 0.9;
      else act[f * 2] = 0.9;
    }
    const r = dbnDownbeats(act, frames);
    expect(r.beatsPerBar).toBe(4);
    expect(r.beats.length).toBeGreaterThan(28);
    for (const d of r.downbeats) expect(Math.round(((d - 0.3) / 2) * 100) / 100 % 1).toBe(0);
  });

  it('無音でも止まらない', async () => {
    const x = new Float32Array(44100);
    const { feat, frames, dim } = features(model, x);
    expect(frames).toBe(100);
    const act = await activations(model, feat, frames, dim, undefined, [0]);
    expect(act.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    expect(dbnDownbeats(act, frames).beats.length).toBe(0);
  });
});

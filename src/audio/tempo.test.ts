import { describe, expect, it } from 'vitest';
import { analyzeTempo, tempoPlan, computeMeters } from './tempo';

const TPB = 6720;

/** 毎回同じ結果になる乱数 */
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** テスト用の曲: 区間ごとの BPM で、1 拍目にキック、2・4 拍目にスネア、8 分でハイハット */
function song(sr: number, first: number, parts: { bpm: number; beats: number; bar?: number }[], tail = 2, jitter = 0) {
  let t = first;
  const hits: { t: number; kind: 'kick' | 'snare' | 'hat' }[] = [];
  for (const p of parts) {
    const P = 60 / p.bpm;
    for (let k = 0; k < p.beats; k++) {
      const bt = t + k * P + (rand() - 0.5) * 2 * jitter;
      const bar = p.bar ?? 4;
      hits.push({ t: bt, kind: k % bar === 0 ? 'kick' : bar === 4 && k % 2 === 1 ? 'snare' : 'hat' });
      hits.push({ t: bt + P / 2, kind: 'hat' });
    }
    t += p.beats * P;
  }
  const len = Math.ceil((t + tail) * sr);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = (rand() * 2 - 1) * 0.01; // 小さな雑音
  for (const h of hits) {
    const i0 = Math.round(h.t * sr);
    const n = Math.round(sr * 0.12);
    for (let i = 0; i < n && i0 + i < len; i++) {
      const tt = i / sr;
      let v = 0;
      // キック（低い音＋叩いた瞬間の短いアタック音）
      if (h.kind === 'kick') v = Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-tt / 0.02)) * tt) * Math.exp(-tt / 0.08) * 0.9 + (rand() * 2 - 1) * Math.exp(-tt / 0.004) * 0.4;
      else if (h.kind === 'snare') v = (rand() * 2 - 1) * Math.exp(-tt / 0.05) * 0.5 + Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.04) * 0.3;
      else v = (rand() * 2 - 1) * Math.exp(-tt / 0.015) * 0.25;
      x[i0 + i] += v;
    }
  }
  return x;
}

describe('BPM・OFFSET の自動測定', () => {
  it('一定の BPM と OFFSET', () => {
    const sr = 22050;
    const x = song(sr, 0.734, [{ bpm: 150, beats: 96 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(r.segments.length).toBe(1);
    expect(plan.bpm).toBe(150);
    expect(Math.abs(plan.offset - -0.734)).toBeLessThan(0.006);
    expect(plan.changes.length).toBe(0);
  });

  it('途中で BPM が変わる（150 → 180）。変わり目の位置も合う', () => {
    const sr = 22050;
    const x = song(sr, 0.5, [{ bpm: 150, beats: 64 }, { bpm: 180, beats: 72 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(plan.bpm).toBe(150);
    expect(plan.changes.length).toBe(1);
    expect(plan.changes[0].bpm).toBe(180);
    expect(plan.changes[0].tick).toBe(64 * TPB);
    expect(Math.abs(plan.offset - -0.5)).toBeLessThan(0.006);
  });

  it('小数の BPM（173.5）も区間全体で合わせる', () => {
    const sr = 22050;
    const x = song(sr, 1.1, [{ bpm: 173.5, beats: 120 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    expect(plan.bpm).toBe(173.5);
    // 1.1 秒は 1 小節（4 拍 = 1.383 秒）より短いので、そのまま 1 拍目
    expect(Math.abs(plan.offset - -1.1)).toBeLessThan(0.006);
  });

  it('短い区間だけ BPM が変わる（200 → 150 → 200）。変わり目は曲全体の拍のつながりで決める', () => {
    const sr = 22050;
    const x = song(sr, 1.37, [{ bpm: 200, beats: 64 }, { bpm: 150, beats: 32 }, { bpm: 200, beats: 64 }]);
    const r = analyzeTempo(x, sr);
    const plan = tempoPlan(r, TPB)!;
    // 1 小節 = 1.2 秒なので、最初の 1 拍目は 0.17 秒（音が鳴り始める 1.37 秒の 4 拍前）
    expect(Math.abs(plan.offset - -0.17)).toBeLessThan(0.006);
    expect(plan.changes.map((c) => [c.tick / TPB, c.bpm])).toEqual([[68, 150], [100, 200]]);
  });

  it('1 小節ごとに速くなる曲（160 から 1 小節ごとに +2）も、小節ごとの BPM を整数で出す', () => {
    const sr = 22050;
    const parts = [{ bpm: 160, beats: 16 }];
    for (let m = 1; m <= 15; m++) parts.push({ bpm: 160 + 2 * m, beats: 4 });
    parts.push({ bpm: 190, beats: 64 });
    const x = song(sr, 0.9, parts);
    const plan = tempoPlan(analyzeTempo(x, sr), TPB)!;
    expect(plan.bpm).toBe(160);
    expect(plan.changes.map((c) => [c.tick / TPB, c.bpm])).toEqual(
      Array.from({ length: 15 }, (_, i) => [16 + i * 4, 162 + 2 * i]),
    );
  });

  it('倍・半分の関係にない BPM への変化: 1 小節ずつ遅くなり（175 → 160 → 145 → 130）、2 小節ずつ速くなって戻る（→ 145 → 160 → 175）', () => {
    const sr = 22050;
    const parts = [
      { bpm: 175, beats: 88 },
      { bpm: 160, beats: 4 },
      { bpm: 145, beats: 4 },
      { bpm: 130, beats: 64 },
      { bpm: 145, beats: 8 },
      { bpm: 160, beats: 8 },
      { bpm: 175, beats: 96 },
    ];
    const x = song(sr, 0.4, parts);
    const plan = tempoPlan(analyzeTempo(x, sr), TPB)!;
    expect(plan.bpm).toBe(175);
    expect(plan.changes.map((c) => [c.tick / TPB, c.bpm])).toEqual([[88, 160], [92, 145], [96, 130], [160, 145], [168, 160], [176, 175]]);
  });

  it('2 拍ごとに速くなる曲（150 から 2 拍ごとに +2 で 180）も、2 拍ごとの BPM で出す', () => {
    const sr = 22050;
    const parts = [{ bpm: 150, beats: 32 }];
    for (let i = 1; i <= 15; i++) parts.push({ bpm: 150 + 2 * i, beats: 2 });
    parts.push({ bpm: 180, beats: 64 });
    const plan = tempoPlan(analyzeTempo(song(sr, 0.5, parts), sr), TPB)!;
    expect(plan.bpm).toBe(150);
    expect(Math.abs(plan.offset - -0.5)).toBeLessThan(0.006);
    expect(plan.changes.map((c) => [c.tick / TPB, c.bpm])).toEqual(
      Array.from({ length: 15 }, (_, i) => [32 + i * 2, 152 + 2 * i]),
    );
  });

  it('3/4 拍子の曲は #MEASURE 3/4 にする', () => {
    const sr = 22050;
    const x = song(sr, 0.5, [{ bpm: 150, beats: 120, bar: 3 }]);
    const plan = tempoPlan(analyzeTempo(x, sr), TPB)!;
    expect(plan.bpm).toBe(150);
    expect(plan.measures).toEqual([{ tick: 0, num: 3, den: 4 }]);
    expect(Math.abs(plan.offset - -0.5)).toBeLessThan(0.006);
  });

  it('途中に 1 小節だけ 2/4 の小節があれば、そこだけ #MEASURE 2/4 にして 4/4 に戻す', () => {
    const sr = 22050;
    const x = song(sr, 0.5, [{ bpm: 160, beats: 64 }, { bpm: 160, beats: 2, bar: 2 }, { bpm: 160, beats: 96 }]);
    const plan = tempoPlan(analyzeTempo(x, sr), TPB)!;
    expect(plan.bpm).toBe(160);
    expect(plan.changes.length).toBe(0);
    expect(plan.measures).toEqual([{ tick: 64 * TPB, num: 2, den: 4 }, { tick: 66 * TPB, num: 4, den: 4 }]);
  });

  it('手で決めた 1 拍目を通るように測り直す（拍子を手で決めても、そこが小節の頭になる）', () => {
    const sr = 22050;
    const P = 60 / 150;
    const x = song(sr, 0.6, [{ bpm: 150, beats: 96 }]);
    // 本当の小節の頭から 2 拍ずれた所を 1 拍目と決める
    const anchor = 0.6 + 20 * P + 2 * P;
    const r = analyzeTempo(x, sr, undefined, { anchors: [anchor] });
    const plan = tempoPlan(r, TPB)!;
    expect(plan.bpm).toBe(150);
    const beatsFromDown = (anchor + plan.offset) / P;
    expect(Math.abs(beatsFromDown - Math.round(beatsFromDown))).toBeLessThan(0.02);
    expect(((Math.round(beatsFromDown) % 4) + 4) % 4).toBe(0);
    // 拍子を 3/4 に決め直しても、手で決めた 1 拍目は小節の頭のまま
    computeMeters(r, [{ num: 3, den: 4 }], [anchor]);
    const p3 = tempoPlan(r, TPB)!;
    expect(p3.measures[0]).toEqual({ tick: 0, num: 3, den: 4 });
    const b3 = Math.round((anchor + p3.offset) / P);
    expect(b3 % 3).toBe(0);
  });

  it('BPM 230 は 229.98 などにせず 230 にする（音が少し揺れていても、曲全体のずれで判断）', () => {
    const sr = 22050;
    const x = song(sr, 0.6, [{ bpm: 230, beats: 400 }], 2, 0.004);
    const plan = tempoPlan(analyzeTempo(x, sr), TPB)!;
    expect(plan.bpm).toBe(230);
    expect(plan.changes.length).toBe(0);
  });

  it('区間ごとのずらし（lead）は、前の区間の長さを半端な拍数だけ伸び縮みさせて譜面にする', () => {
    const r = {
      segments: [
        { startBeat: 0, endBeat: 16, start: 0, end: 6.4, bpm: 150, rawBpm: 150, beats: 16, matched: 16, jitterMs: 0 },
        { startBeat: 16, endBeat: 48, start: 6.4, end: 16, bpm: 200, rawBpm: 200, beats: 32, matched: 32, jitterMs: 0, lead: 0.2 },
      ],
      t0: 0, downbeat: 0, duration: 16,
    };
    const plan = tempoPlan(r, TPB)!;
    // 0.2 秒 = 150 BPM で 0.5 拍 → 2 つ目の区間は 16.5 拍目から
    expect(plan.changes).toEqual([{ tick: Math.round(16.5 * TPB), bpm: 200 }]);
  });
});

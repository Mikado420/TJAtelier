import { describe, expect, it } from 'vitest';
import { analyzeCourse, simulateRolls } from './analyze';
import { parseTJA } from './tja';

const tja = (body: string, head = '') => parseTJA(`TITLE:t\nBPM:120\n${head}COURSE:Oni\nLEVEL:10\nBALLOON:40,30\n#START\n${body}\n#END\n`);

describe('譜面情報', () => {
  it('総ノーツ数・ドンとカッ・平均密度（(音符数 − 1) ÷ 演奏時間）', () => {
    const c = tja('1212,\n3400,');
    const a = analyzeCourse(c, c.courses[0]);
    expect(a.notes).toBe(6);
    expect([a.don, a.ka, a.bigDon, a.bigKa]).toEqual([2, 2, 1, 1]);
    // 120BPM の 1 小節 = 2 秒。最初の音符 0 秒、最後の音符 2.5 秒 → 5 ÷ 2.5 = 2
    expect(a.playTime).toBeCloseTo(2.5, 6);
    expect(a.density).toBeCloseTo(2, 6);
  });

  it('天井スコア: 全部良 ＋ 風船を全部割る（初項は 10 の位で切り上げ）', () => {
    const c = tja('1111,\n7008,');
    const a = analyzeCourse(c, c.courses[0]);
    // 初項 = ceil((1000000 − 40×100) ÷ 4 ÷ 10) × 10 = 249000
    expect(a.ceiling).toBe(249000 * 4 + 40 * 100);
    expect(a.hasRoll).toBe(false);
    expect(a.balloons).toEqual([{ sec: 1.5, hits: 40 }]);
  });

  it('BPM の下限・上限と、いちばん長く使われている BPM', () => {
    // 120 で 1 小節（2 秒）、240 で 2 小節（2 秒）、60 で 1 小節（4 秒）
    const c = tja('1111,\n#BPMCHANGE 240\n1111,\n1111,\n#BPMCHANGE 60\n1111,\n1,');
    const a = analyzeCourse(c, c.courses[0]);
    expect([a.bpmMin, a.bpmMax, a.bpmMain]).toEqual([60, 240, 60]);
  });

  it('#DELAY は演奏時間に入れない', () => {
    const c = tja('1000,\n#DELAY 3\n1000,');
    const a = analyzeCourse(c, c.courses[0]);
    expect(a.playTime).toBeCloseTo(2, 6);
  });

  it('連打の秒数と、秒速のシミュレーション', () => {
    const c = tja('5008,\n6000,\n0800,\n7008,');
    const a = analyzeCourse(c, c.courses[0]);
    expect(a.hasRoll).toBe(true);
    expect(a.rolls.map((r) => r.sec)).toEqual([1.5, 2.5]);
    const s = simulateRolls(a, 20);
    expect(s.roll).toEqual([30, 50]);
    // 風船 1.5 秒 × 20 = 30 打 → 40 打に足りないので割れない
    expect(s.balloon).toEqual([30]);
    expect(s.popped).toBe(0);
    expect(s.total).toBe(110);
    expect(s.rollScore).toBe(30 * 100 + 50 * 200);
    expect(s.balloonLoss).toBe(10 * 100);
  });
});

describe('1 拍ごとの密度', () => {
  it('拍の音符数 ÷ 拍の秒数', () => {
    // 120BPM の 1 拍 = 0.5 秒。1 小節目は 1 拍に 1 個 → 2、2 小節目は 1 拍に 2 個 → 4、最後の音符の拍 → 2
    const c = parseTJA('TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n11111111,\n1,\n#END\n');
    const a = analyzeCourse(c, c.courses[0]);
    expect(a.curve.map((m) => m.v)).toEqual([2, 2, 2, 2, 4, 4, 4, 4, 2]);
    expect(a.curve[4].t0).toBeCloseTo(2, 6);
  });
});

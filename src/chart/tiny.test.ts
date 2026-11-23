import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { measures, TICK_VER, TINY_TICKS, toPlayable, TPB, upgradeTicks, type EChart, type ENote } from './model';

const tja = (body: string) => `TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n${body}\n#END\n`;
const GIMMICK = '1111,\n#MEASURE 1/9999\n#SCROLL 2\n1\n#SCROLL 3\n2\n#SCROLL 4\n1\n#SCROLL 5\n2,\n1000200010002000,\n#SCROLL 1\n1,\n#MEASURE 4/4\n1111,';

describe('#MEASURE 1/9999 のとても短い小節', () => {
  it('小節の中の音符・命令が重ならず、書いた順に並ぶ', () => {
    const c = parseTJA(tja(GIMMICK)).courses[0];
    const ticks = c.notes.map((n) => n.tick);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    const sc = c.events.filter((e) => e.kind === 'scroll').map((e) => e.tick);
    expect(new Set(sc).size).toBe(sc.length);
  });

  it('それぞれの音符に、直前の #SCROLL が効く', () => {
    const ch = parseTJA(tja(GIMMICK));
    const p = toPlayable(ch, ch.courses[0]);
    expect(p.notes.slice(4, 8).map((n) => n.scroll)).toEqual([2, 3, 4, 5]);
  });

  it('秒は本来の長さ（とても短い小節は 1/9999 小節ぶん）', () => {
    const ch = parseTJA(tja(GIMMICK));
    const p = toPlayable(ch, ch.courses[0]);
    const len = 2 / 9999; // 120 BPM の 4/4 の 1 小節 = 2 秒
    expect(p.notes[4].time).toBeCloseTo(2, 6);
    expect(p.notes[13].time).toBeCloseTo(2 + 3 * len, 6);
    expect(p.notes[14].time).toBeCloseTo(2 + 3 * len + 0.5, 6);
  });

  it('書き出して読み直しても同じ', () => {
    const ch = parseTJA(tja(GIMMICK));
    const back = parseTJA(writeTJA(ch));
    expect(back.courses[0].notes).toEqual(ch.courses[0].notes);
    expect(back.courses[0].events).toEqual(ch.courses[0].events);
  });

  it('前の版で保存した譜面（とても短い小節が 3 tick）を今の tick に直す', () => {
    const now = parseTJA(tja('1111,\n#MEASURE 1/9999\n1,\n2,\n#MEASURE 4/4\n1212,'));
    const M = TPB * 4;
    // 前の版: 1/9999 の小節は round(26880 / 9999) = 3 tick
    const old: EChart = {
      ...now, tv: undefined,
      courses: [{
        ...now.courses[0],
        notes: ([] as ENote[]).concat(
          [0, 1, 2, 3].map((k) => ({ tick: (k * M) / 4, type: 'don' })),
          [{ tick: M, type: 'don' }, { tick: M + 3, type: 'ka' }],
          [0, 1, 2, 3].map((k) => ({ tick: M + 6 + (k * M) / 4, type: k % 2 ? 'ka' : 'don' })),
        ),
        events: [{ tick: M, kind: 'measure', num: 1, den: 9999 }, { tick: M + 6, kind: 'measure', num: 4, den: 4 }],
      }],
    };
    upgradeTicks(old);
    expect(old.tv).toBe(TICK_VER);
    expect(old.courses[0].notes).toEqual(now.courses[0].notes);
    expect(old.courses[0].events).toEqual(now.courses[0].events);
    const ms = measures(now.courses[0], M * 3);
    expect(ms[1].length).toBe(TINY_TICKS);
  });

  it('今の版の譜面はそのまま', () => {
    const ch = parseTJA(tja(GIMMICK));
    const before = JSON.stringify(ch);
    upgradeTicks(ch);
    expect(JSON.stringify(ch)).toBe(before);
  });
});

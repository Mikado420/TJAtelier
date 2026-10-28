import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { Timing, TPB } from '../chart/model';
import { DelayLanes } from './delayLanes';

const tja = (body: string) => `TITLE:t\nBPM:120\nOFFSET:0\nCOURSE:Oni\nLEVEL:8\n#START\n${body}\n#END\n`;
const make = (body: string) => {
  const c = parseTJA(tja(body));
  const course = c.courses[0];
  return new DelayLanes(course, new Timing(c, course));
};

describe('#DELAY の段', () => {
  it('DELAY がなければ 1 段で、位置はそのまま', () => {
    const ln = make('1111,\n1111,');
    expect(ln.rows).toBe(1);
    expect(ln.disp(TPB * 3)).toBe(TPB * 3);
  });
  it('マイナスの DELAY で重なった所だけ 2 段目に出し、重ならなくなったら 1 段目に戻る', () => {
    // BPM120: 1 秒 = 2 拍。-1 秒 = 2 拍ぶん前へ
    const ln = make('1111,\n#DELAY -1\n1111,\n1111,');
    expect(ln.rows).toBe(2);
    const m2 = TPB * 4;
    expect(ln.disp(m2)).toBeCloseTo(m2 - TPB * 2);
    expect(ln.rowOf(m2)).toBe(1);
    expect(ln.rowOf(m2 + TPB)).toBe(1);
    expect(ln.rowOf(m2 + TPB * 2)).toBe(0);
    expect(ln.tickAt(ln.disp(m2), 1)).toBeCloseTo(m2);
  });
  it('プラスの DELAY は空きになり、再生中の位置は空きの間も進む', () => {
    const ln = make('1111,\n#DELAY 1\n1111,');
    expect(ln.rows).toBe(1);
    const m2 = TPB * 4;
    expect(ln.disp(m2)).toBeCloseTo(m2 + TPB * 2);
    expect(ln.tickAt(m2 + TPB, 0)).toBeNull();
    expect(ln.dispOfTime(2.5)).toBeCloseTo(m2 + TPB);
    expect(ln.dispOfTime(3.5)).toBeCloseTo(m2 + TPB * 3);
    expect(ln.timeOfDisp(m2 + TPB)).toBeCloseTo(2.5);
  });
  it('DELAY・BPM・MEASURE が混ざっても、どの段の音符も鳴る時刻の位置に出る（再生の位置・波形とずれない）', () => {
    const c = parseTJA(tja('1111,\n1010101010101010,\n#DELAY -1.3\n#MEASURE 1/4\n1,\n1,\n#MEASURE 4/4\n#BPMCHANGE 180\n1111,\n#DELAY 0.7\n2222,\n#DELAY -2\n#BPMCHANGE 90\n1212,\n1111,'));
    const course = c.courses[0];
    const t = new Timing(c, course);
    const ln = new DelayLanes(course, t);
    expect(ln.rows).toBeGreaterThan(1);
    for (const n of course.notes) {
      const time = t.tickToTime(n.tick);
      const d = ln.disp(n.tick);
      expect(ln.dispOfTime(time)).toBeCloseTo(d, 3);
      expect(ln.timeOfDisp(d)).toBeCloseTo(time, 5);
      expect(ln.tickAt(d, ln.rowOf(n.tick))).toBeCloseTo(n.tick, 3);
    }
  });
});

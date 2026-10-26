import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { toPlayable } from './model';
import { beatAt, jposAt, scrollAhead } from './types';

const tja = (pre: string, body: string) => `TITLE:t\nBPM:120\nOFFSET:0\n\nCOURSE:Oni\nLEVEL:8\n${pre}\n#START\n${body}\n#END\n`;

describe('#HBSCROLL・#JPOSSCROLL', () => {
  it('#START の直前の #HBSCROLL を読んで、書き出しでも #START の直前に書く（#BMSCROLL は #HBSCROLL として読む）', () => {
    const c = parseTJA(tja('#HBSCROLL', '1111,'));
    expect(c.courses[0].scrollMode).toBe('hb');
    const out = writeTJA(c);
    expect(out.includes('#HBSCROLL\n#START')).toBe(true);
    const b = parseTJA(tja('#BMSCROLL', '1111,'));
    expect(b.courses[0].scrollMode).toBe('hb');
    expect(writeTJA(b).includes('#HBSCROLL\n#START')).toBe(true);
    expect(writeTJA(b).includes('#BMSCROLL')).toBe(false);
    expect(parseTJA(tja('', '1111,')).courses[0].scrollMode).toBe(undefined);
  });

  it('次の難易度には持ち越さない', () => {
    const c = parseTJA(`BPM:120\nCOURSE:Hard\nLEVEL:5\n#BMSCROLL\n#START\n1,\n#END\nCOURSE:Oni\nLEVEL:8\n#START\n1,\n#END\n`);
    expect(c.courses[0].scrollMode).toBe('hb');
    expect(c.courses[1].scrollMode).toBe(undefined);
  });

  it('#JPOSSCROLL a b c を読み書きする', () => {
    const c = parseTJA(tja('', '#JPOSSCROLL 0.5 300 0\n1111,'));
    const e = c.courses[0].events.find((x) => x.kind === 'jpos');
    expect(e).toEqual({ tick: 0, kind: 'jpos', time: 0.5, dist: 300, dir: 0 });
    expect(writeTJA(c).includes('#JPOSSCROLL 0.5 300 0')).toBe(true);
  });

  it('判定枠は a 秒かけて b px 動き、そのまま止まる（1 = 右、0 = 左）', () => {
    const c = parseTJA(tja('', '1111,\n#JPOSSCROLL 1 200 1\n1111,\n#JPOSSCROLL 0 50 0\n1111,'));
    const p = toPlayable(c, c.courses[0]);
    // 120 BPM: 1 小節 = 2 秒
    expect(jposAt(p.jpos, 2)).toBe(0);
    expect(jposAt(p.jpos, 2.5)).toBeCloseTo(100, 6);
    expect(jposAt(p.jpos, 3.5)).toBeCloseTo(200, 6);
    expect(jposAt(p.jpos, 4.01)).toBeCloseTo(150, 6);
  });

  it('#HBSCROLL: 拍の数で位置が決まり、BPM が変わった所から速さが急に変わる（拍の位置に SCROLL は入らない）', () => {
    const c = parseTJA(tja('#HBSCROLL', '1111,\n#BPMCHANGE 240\n#SCROLL 3\n1111,'));
    const p = toPlayable(c, c.courses[0]);
    expect(p.scrollMode).toBe('hb');
    // 2 小節目の頭の音符は 4 拍目、その次は 5 拍目（SCROLL は位置ではなく速さに掛かる）
    expect(p.notes[4].beat).toBe(4);
    expect(p.notes[5].beat).toBe(5);
    // 1 小節目は 1 秒に 2 拍、2 小節目からは 1 秒に 4 拍
    expect(beatAt(p.beatPoints!, 1)).toBeCloseTo(2, 6);
    expect(beatAt(p.beatPoints!, 2.5)).toBeCloseTo(6, 6);
  });

  it('#HBSCROLL: #BPMCHANGE が無ければ、#SCROLL はふつうと同じ（音符ごとの速さに掛かる）', () => {
    const body = '1111,\n#SCROLL 2\n1111,\n#SCROLL 0.5\n1111,';
    const bm = parseTJA(tja('#HBSCROLL', body));
    const nm = parseTJA(tja('', body));
    const pb = toPlayable(bm, bm.courses[0]);
    const pn = toPlayable(nm, nm.courses[0]);
    // 拍の位置は BPM だけで決まる（SCROLL は位置に足さない）
    expect(pb.notes[5].beat).toBe(5);
    expect(pb.notes[9].beat).toBe(9);
    // どの時刻でも、どの音符・小節線も、ふつうの流れ方と同じ所に描く
    for (const now of [0, 0.7, 1.9, 2.3, 4.1, 5.5]) {
      const bn = beatAt(pb.beatPoints!, now);
      pb.notes.forEach((n, i) => expect(scrollAhead('hb', n, now, bn)).toBeCloseTo(scrollAhead(undefined, pn.notes[i], now, null), 6));
      pb.bars.forEach((b, i) => expect(scrollAhead('hb', b, now, bn)).toBeCloseTo(scrollAhead(undefined, pn.bars[i], now, null), 6));
    }
  });

  it('#HBSCROLL: #BPMCHANGE があると、そこからレーン全体の速さが変わり、SCROLL も掛かる', () => {
    const c = parseTJA(tja('#HBSCROLL', '1111,\n#BPMCHANGE 240\n#SCROLL 2\n1111,'));
    const p = toPlayable(c, c.courses[0]);
    // 今 = 1 秒（2 拍目）。5 拍目の音符（BPM 240・SCROLL 2）は (5 − 2) × 2 = 6 拍ぶん先
    const bn = beatAt(p.beatPoints!, 1);
    expect(bn).toBeCloseTo(2, 6);
    expect(scrollAhead('hb', p.notes[5], 1, bn)).toBeCloseTo(6, 6);
  });

  it('#DELAY の間は止まる', () => {
    const c = parseTJA(tja('#HBSCROLL', '1111,\n#DELAY 1\n1111,'));
    const p = toPlayable(c, c.courses[0]);
    expect(beatAt(p.beatPoints!, 2.5)).toBeCloseTo(4, 6);
    expect(beatAt(p.beatPoints!, 3.5)).toBeCloseTo(5, 6);
  });
});

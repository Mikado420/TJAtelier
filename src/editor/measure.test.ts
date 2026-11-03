import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n1111,\n1111,\n#END\n';
const ms = (ed: Editor) => ed.course.events.filter((e) => e.kind === 'measure').sort((a, b) => a.tick - b.tick).map((e) => [e.tick, (e as { num: number }).num, (e as { den: number }).den]);

describe('#MEASURE を小節の途中に置く', () => {
  it('そこから小節が始まり、前の小節はそこまでの長さになる（音符の位置は変わらない）', () => {
    const ed = new Editor(parseTJA(TJA));
    const notes = ed.course.notes.map((n) => n.tick);
    // 2 小節目の 3 拍目に 4/4
    ed.addEvent({ tick: TPB * 4 + TPB * 2, kind: 'measure', num: 4, den: 4 });
    expect(ms(ed)).toEqual([[TPB * 4, 2, 4], [TPB * 6, 4, 4]]);
    expect(ed.measureOf(TPB * 6).start).toBe(TPB * 6);
    expect(ed.course.notes.map((n) => n.tick)).toEqual(notes);
    // TJA に書いて読み直しても同じ
    const ed2 = new Editor(parseTJA(writeTJA(ed.chart)));
    expect(ed2.course.notes.map((n) => n.tick)).toEqual(notes);
    expect(ed2.measureOf(TPB * 6).start).toBe(TPB * 6);
  });

  it('16 分の位置なら 前の小節は 5/16 など（分母を細かくする）', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.addEvent({ tick: (TPB * 5) / 4, kind: 'measure', num: 3, den: 4 });
    expect(ms(ed)).toEqual([[0, 5, 16], [(TPB * 5) / 4, 3, 4]]);
  });

  it('小節の頭なら、これまでどおりその小節の #MEASURE', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.addEvent({ tick: TPB * 4, kind: 'measure', num: 3, den: 4 });
    expect(ms(ed)).toEqual([[TPB * 4, 3, 4]]);
  });
});

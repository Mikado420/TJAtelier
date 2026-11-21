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

describe('選んだ音符すべての位置に小節線', () => {
  const T2 = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n1010220001000100,\n1111,\n#MEASURE 3/4\n111,\n#END\n';
  it('音符ごとに小節が始まり、音符の時刻とその先の小節線は変わらない', () => {
    const ed = new Editor(parseTJA(T2));
    const notes = ed.course.notes.map((n) => [n.tick, ed.timing.tickToTime(n.tick)]);
    const bars = (e: Editor) => {
      const out: number[] = [];
      for (let t = 0; t < TPB * 15; ) {
        const m = e.measureOf(t);
        out.push(m.start);
        t = m.start + m.length;
      }
      return out;
    };
    const before = bars(ed);
    // 2 小節目の 2 拍目から 4 拍目まで（2 拍目の頭・その 16 分後・3 拍目の 16 分後の 3 つ）
    ed.sel = { start: TPB * 5, end: TPB * 7 + 1 };
    expect(ed.barlinesAtNotes()).toBe(3);
    const after = bars(ed);
    expect(after.slice(0, 6)).toEqual([0, TPB * 4, TPB * 5, TPB * 5.25, TPB * 6.25, TPB * 8]);
    // 選んだ範囲の先の小節線は元のまま
    expect(after.filter((t) => t >= TPB * 8)).toEqual(before.filter((t) => t >= TPB * 8));
    expect(ed.course.notes.map((n) => [n.tick, ed.timing.tickToTime(n.tick)])).toEqual(notes);
    // 3/4 の小節もそのまま
    expect(ed.measureOf(TPB * 12)).toMatchObject({ num: 3, den: 4 });
    // TJA に書いて読み直しても同じ
    const ed2 = new Editor(parseTJA(writeTJA(ed.chart)));
    expect(bars(ed2)).toEqual(after);
    expect(ed2.course.notes.map((n) => n.tick)).toEqual(notes.map((n) => n[0]));
    // 元に戻すと元の小節線
    ed.undo();
    expect(bars(ed)).toEqual(before);
  });
});

describe('小節の途中に #MEASURE を置いたあと', () => {
  const TJA2 = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n1111,\n#MEASURE 3/4\n111,\n1111,\n#END\n';
  const M2 = TPB * 4;
  for (const [t, num, den] of [[M2 / 4, 4, 4], [M2 + M2 / 2, 3, 4], [M2 / 3, 4, 4], [M2 + (M2 * 3) / 16, 5, 8]] as const) {
    it(`${t / M2} 小節目に ${num}/${den}: 後ろの #MEASURE も小節の頭に書かれ、読み直しても音符の位置が同じ`, () => {
      const ed = new Editor(parseTJA(TJA2));
      ed.addEvent({ tick: t, kind: 'measure', num, den });
      const text = writeTJA(ed.chart);
      const body = text.slice(text.indexOf('#START'), text.indexOf('#END')).split('\n');
      // #MEASURE の前の行は、小節の終わり（,）か #START・ほかの命令
      body.forEach((l, i) => { if (l.startsWith('#MEASURE')) expect(/,$|^#/.test(body[i - 1])).toBe(true); });
      const back = parseTJA(text);
      expect(back.courses[0].notes.map((n) => n.tick)).toEqual(ed.course.notes.map((n) => n.tick).sort((a, b) => a - b));
    });
  }
});

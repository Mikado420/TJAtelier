import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { TPB } from '../chart/model';
import { Editor } from './editor';
import { APPEAR_BEATS } from './gimmick';

const M = TPB * 4;
const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1234,\n1111,\n1000,\n1000,\n#END\n';
const scrolls = (ed: Editor) => ed.course.events.filter((e) => e.kind === 'scroll').map((e) => [e.tick, (e as { value: number }).value]);

describe('ギミック', () => {
  it('あべこべ: 範囲のドン⇔カッ・大ドン⇔大カッを入れ替える', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.sel = { start: 0, end: (M * 3) / 4 };
    expect(ed.flipSelection()).toBe(4);
    expect(ed.course.notes.slice(0, 5).map((n) => n.type)).toEqual(['ka', 'don', 'bigKa', 'bigDon', 'don']);
  });

  it('同時出現: 判定枠が始点に来た瞬間に出る。音符・小節線ごとに 右端の拍数 ÷ (始点からの拍数)。後ろで元に戻す', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.sel = { start: M, end: M + (M * 3) / 4 };
    ed.simSelection(6);
    const D = APPEAR_BEATS;
    const r = (v: number) => Number(v.toFixed(6));
    expect(scrolls(ed)).toEqual([[M + M / 4, r(D / 1)], [M + M / 2, r(D / 2)], [M + (M * 3) / 4, r(D / 3)], [M * 2, 1]]);
  });

  it('同時出現: BPM が倍なら、その後ろの #SCROLL は半分（同じ秒数の位置で比べる）', () => {
    const ed = new Editor(parseTJA('TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1,\n#BPMCHANGE 240\n1,\n1,\n#END\n'));
    ed.sel = { start: 0, end: M };
    ed.simSelection(6);
    const D = APPEAR_BEATS;
    // 2 小節目の頭は始点から 2 秒後ろ。その位置の BPM は 240
    expect(scrolls(ed)).toEqual([[M, Number(((D * 60) / (240 * 2)).toFixed(6))], [M * 2, 1]]);
  });

  it('敷き詰め: コピーした範囲（+1 マス）を繰り返して置く。置き換え・空きだけ', () => {
    const ed = new Editor(parseTJA('TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1200,\n0000,\n0010,\n#END\n'));
    ed.divisor = 4;
    ed.sel = { start: 0, end: M / 4 };
    ed.copySelection();
    ed.sel = { start: M, end: M * 3 - 1 };
    const a = new Editor(parseTJA('TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1200,\n0000,\n0010,\n#END\n'));
    a.clip = ed.clip;
    a.sel = { start: M, end: M * 3 - 1 };
    expect(ed.fillSelection('replace')).toBe(8);
    expect(ed.course.notes.filter((n) => n.tick >= M).map((n) => [(n.tick - M) / (M / 4), n.type])).toEqual(
      [[0, 'don'], [1, 'ka'], [2, 'don'], [3, 'ka'], [4, 'don'], [5, 'ka'], [6, 'don'], [7, 'ka']],
    );
    // 空きだけ: 3 小節目の 3 拍目（ドン）は残り、そこには置かない
    expect(a.fillSelection('empty')).toBe(7);
  });
});

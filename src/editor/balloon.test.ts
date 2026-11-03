import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n0,\n0,\n#END\n';

describe('風船', () => {
  it('置いたときの打数は 1 秒に 15 打（切り上げ）', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.tool = 'balloon';
    // BPM 120 の 1 拍 = 0.5 秒 → 7.5 → 8 打
    ed.tap(0);
    ed.tap(TPB);
    expect(ed.course.notes[0]).toMatchObject({ type: 'balloon', hits: 8 });
    // 2 拍 = 1 秒 → 15 打
    ed.tap(TPB * 2);
    ed.tap(TPB * 4);
    expect(ed.course.notes.find((n) => n.tick === TPB * 2)).toMatchObject({ hits: 15 });
  });

  it('風船を選んでいても、風船をタップしたら消える', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.tool = 'balloon';
    ed.tap(0);
    ed.tap(TPB);
    expect(ed.course.notes.length).toBe(1);
    ed.tap(0);
    expect(ed.course.notes.length).toBe(0);
  });

  it('長押しで打数を変える風船を探す（始点でも途中でも）', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.tool = 'balloon';
    ed.tap(0);
    ed.tap(TPB * 2);
    expect(ed.balloonAt(0)?.type).toBe('balloon');
    expect(ed.balloonAt(TPB)?.type).toBe('balloon');
    expect(ed.balloonAt(TPB * 3)).toBeUndefined();
  });
});

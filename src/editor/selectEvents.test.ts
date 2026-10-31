import { describe, expect, it } from 'vitest';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const M = TPB * 4;
const evs = (ed: Editor) => ed.course.events.map((e) => `${e.tick / M}:${e.kind}${'on' in e ? (e.on ? '+' : '-') : 'value' in e ? e.value : 'num' in e ? `${e.num}/${e.den}` : ''}`);

describe('命令ごとコピー', () => {
  it('命令も写し、貼った範囲の後ろは元の状態に戻す', () => {
    const ed = new Editor();
    ed.mutate(() => {
      ed.course.events.push({ tick: M, kind: 'gogo', on: true }, { tick: M, kind: 'scroll', value: 2 }, { tick: 2 * M, kind: 'gogo', on: false });
    });
    ed.tool = 'don';
    ed.tap(M);
    ed.tool = 'select';
    ed.tap(M);
    ed.tap(2 * M);
    ed.clipEvents = true;
    ed.copySelection();
    ed.paste(4 * M);
    expect(evs(ed)).toEqual(['1:scroll2', '1:gogo+', '2:gogo-', '4:scroll2', '4:gogo+', '5:gogo-']);
  });

  it('途中から選んでも、頭の状態を写す。OFF ならノーツだけ', () => {
    const ed = new Editor();
    ed.mutate(() => { ed.course.events.push({ tick: 0, kind: 'gogo', on: true }, { tick: 3 * M, kind: 'gogo', on: false }); });
    ed.tool = 'select';
    ed.tap(M);
    ed.tap(2 * M);
    ed.copySelection();
    ed.paste(6 * M);
    expect(evs(ed)).toEqual(['0:gogo+', '3:gogo-']);
    ed.clipEvents = true;
    ed.tap(M);
    ed.tap(2 * M);
    ed.copySelection();
    ed.paste(6 * M);
    expect(evs(ed)).toEqual(['0:gogo+', '3:gogo-', '6:gogo+', '7:gogo-']);
  });

  it('命令ごと切り取ると、後ろの状態は変わらない', () => {
    const ed = new Editor();
    ed.mutate(() => { ed.course.events.push({ tick: M, kind: 'measure', num: 3, den: 4 }); });
    ed.tool = 'select';
    ed.clipEvents = true;
    ed.tap(M);
    ed.tap(2 * M);
    ed.cutSelection();
    expect(evs(ed)).toEqual(['2:measure3/4']);
  });
});

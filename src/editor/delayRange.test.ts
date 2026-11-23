import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { Timing, toPlayable, TPB } from '../chart/model';
import { DelayLanes } from './delayLanes';
import { applyGrad, gradTargets, type Grad } from './grad';
import { Editor } from './editor';

const tja = (body: string) => `TITLE:t\nBPM:120\nOFFSET:0\nCOURSE:Oni\nLEVEL:8\n#START\n${body}\n#END\n`;
// BPM120: 1 小節 = 2 秒。#DELAY -1 で 3 小節目の頭の 2 拍が、2 小節目の後ろ 2 拍と重なって 2 段目に出る
const BODY = '1111,\n1111,\n#DELAY -1\n2222,\n2222,\n1111,';
const M = TPB * 4;

describe('#DELAY で重なった段と、範囲（グラデ・ゴーゴー）', () => {
  it('1 段目の上で作った範囲から、2 段目に出ている所を外す', () => {
    const ch = parseTJA(tja(BODY));
    const c = ch.courses[0];
    const ln = new DelayLanes(c, new Timing(ch, c));
    // 1 小節目の頭（1 段目）から 4 小節目の 3 拍目（1 段目に戻った所）まで
    expect(ln.holes(M, 3 * M + 2 * TPB)).toEqual([[2 * M, 2 * M + 2 * TPB]]);
    // 2 段目の中だけの範囲は、そのまま
    expect(ln.holes(2 * M, 2 * M + TPB)).toEqual([]);
    // 1 段目から 2 段目へ（始点・終点の段が違う）は、どちらの段も入れる
    expect(ln.holes(M, 2 * M + TPB)).toEqual([]);
  });

  it('グラデは 2 段目の音符にかからず、そこはグラデの前の #SCROLL に戻る', () => {
    const ch = parseTJA(tja(BODY));
    const c = ch.courses[0];
    const ln = new DelayLanes(c, new Timing(ch, c));
    const g: Grad = { start: M, end: 3 * M + 2 * TPB, from: 1, to: 3, mode: 'linear', digits: 3, basis: 'count' };
    g.holes = ln.holes(g.start, g.end);
    const ts = gradTargets(c, g);
    expect(ts.includes(2 * M)).toBe(false);
    expect(ts.includes(2 * M + TPB)).toBe(false);
    expect(ts.includes(2 * M + 2 * TPB)).toBe(true);
    applyGrad(c, g, ch.bpm);
    const p = toPlayable(ch, c);
    const at = (tick: number) => p.notes.find((n) => Math.abs(n.time - new Timing(ch, c).tickToTime(tick)) < 1e-6 && (tick >= 2 * M ? n.type === 'ka' : n.type === 'don'))!;
    // 2 段目の 2 つはグラデの前（1）のまま
    expect(at(2 * M).scroll).toBe(1);
    expect(at(2 * M + TPB).scroll).toBe(1);
    // 1 段目の音符はグラデで増えていく
    expect(at(M + TPB).scroll).toBeGreaterThan(1);
    expect(at(2 * M + 2 * TPB).scroll).toBeGreaterThan(at(M + 3 * TPB).scroll);
  });

  it('ゴーゴーも 2 段目に出ている所では止めて、1 段目に戻ったらまた始める', () => {
    const ed = new Editor(parseTJA(tja(BODY)));
    ed.tool = 'gogo';
    ed.tap(M);
    ed.tap(3 * M + 2 * TPB);
    expect(ed.gogoRanges()).toEqual([[M, 2 * M], [2 * M + 2 * TPB, 3 * M + 2 * TPB]]);
  });

  it('エディタで置いたグラデも、2 段目の所を外す', () => {
    const ed = new Editor(parseTJA(tja(BODY)));
    ed.setGrad({ start: M, end: 3 * M + 2 * TPB, from: 1, to: 3, mode: 'linear', digits: 3, basis: 'count' });
    const g = ed.course.grads![0];
    expect(g.holes).toEqual([[2 * M, 2 * M + 2 * TPB]]);
    const sc = ed.course.events.filter((e) => e.kind === 'scroll' && e.tick >= 2 * M && e.tick < 2 * M + 2 * TPB);
    expect(sc).toEqual([{ tick: 2 * M, kind: 'scroll', value: 1 }]);
  });
});

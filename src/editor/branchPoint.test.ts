import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { forcedOf, preMeasureOf, toPlayable, TPB } from '../chart/model';
import { Editor } from './editor';

const M = TPB * 4;
const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n2222,\n1212,\n2121,\n#END\n';
const body = (ed: Editor) => { const s = writeTJA(ed.chart); return s.slice(s.indexOf('#START') + 7, s.indexOf('#END') - 1); };

describe('分岐（始まりの位置だけで置く）', () => {
  it('強制 達人・直前: とても短い小節のあとに #BRANCHSTART p,-1,-2 と #BRANCHEND、元の拍子に戻す', () => {
    const ed = new Editor(parseTJA(TJA));
    const b = ed.placeBranch(M * 2, { type: 'p', x: -1, y: -2, pre: true })!;
    expect(forcedOf(b)).toBe(2);
    expect(body(ed)).toBe('1111,\n2222,\n#MEASURE 1/9999\n#BARLINEOFF\n0,\n#BRANCHSTART p,-1,-2\n#BRANCHEND\n#MEASURE 4/4\n#BARLINEON\n1212,\n2121,');
    // 読み直しても同じ。直前で決める分岐として見つかる
    const back = new Editor(parseTJA(writeTJA(ed.chart)));
    const bb = back.branchAt(M * 2)!;
    expect(bb && preMeasureOf(back.mainCourse, bb)).toBeTruthy();
    expect(body(back)).toBe(body(ed));
    // 判定は分岐のほぼその位置（1 小節前ではない）
    const p = toPlayable(back.chart, back.mainCourse);
    expect(p.branches![0].start - p.branches![0].judge).toBeLessThan(0.01);
  });

  it('条件の分岐・1小節前: 次の分岐まで（無ければ終わりまで）を区間にして、玄人・達人に普通譜面を写す', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.placeBranch(M, { type: 'p', x: 60, y: 80, pre: false });
    expect(body(ed)).toBe('1111,\n#BRANCHSTART p,60,80\n#N\n2222,\n1212,\n2121,\n#E\n2222,\n1212,\n2121,\n#M\n2222,\n1212,\n2121,\n#BRANCHEND');
    // 区間の途中に強制分岐: 前の区間はそこで終わる
    ed.placeBranch(M * 3, { type: 'p', x: -1, y: 101, pre: false });
    expect(body(ed)).toBe('1111,\n#BRANCHSTART p,60,80\n#N\n2222,\n1212,\n#E\n2222,\n1212,\n#M\n2222,\n1212,\n#BRANCHEND\n#BRANCHSTART p,-1,101\n#BRANCHEND\n2121,');
  });

  it('直前 → 1小節前に戻すと、短い小節を外して元の位置に戻る。消しても戻る', () => {
    const ed = new Editor(parseTJA(TJA));
    const b = ed.placeBranch(M * 2, { type: 'r', x: 5, y: 10, pre: true })!;
    expect(ed.mainCourse.notes.some((n) => n.tick === M * 2)).toBe(false);
    ed.placeBranch(M * 2, { type: 'r', x: 5, y: 10, pre: false }, b);
    expect(ed.mainCourse.notes.filter((n) => n.tick >= M * 2).map((n) => n.tick)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => M * 2 + (i * M) / 4));
    expect(ed.mainCourse.events.filter((e) => e.kind === 'measure')).toEqual([]);
    ed.removeBranch(ed.branchAt(M * 2)!);
    const b2 = ed.placeBranch(M * 2, { type: 'p', x: -1, y: -2, pre: true })!;
    ed.removeBranch(b2);
    expect(body(ed)).toBe('1111,\n2222,\n1212,\n2121,');
  });

  it('黄色の小節線は分岐を置いた小節の頭（強制分岐も）。直前で決める分岐は、前のとても短い小節の線を隠す', () => {
    const yellow = (ed: Editor) => toPlayable(ed.chart, ed.mainCourse).bars.filter((b) => b.branch).map((b) => Math.round(b.time * 1000));
    const near = (ed: Editor, ms: number) => toPlayable(ed.chart, ed.mainCourse).bars.filter((b) => Math.abs(b.time * 1000 - ms) < 1).length;
    const a = new Editor(parseTJA(TJA));
    a.placeBranch(M * 2, { type: 'p', x: 60, y: 80, pre: false });
    expect(yellow(a)).toEqual([4000]); // 3 小節目の頭（BPM 120 で 4 秒）
    const b = new Editor(parseTJA(TJA));
    b.placeBranch(M * 2, { type: 'p', x: 60, y: 80, pre: true });
    expect(yellow(b)).toEqual([4000]);
    expect(near(b, 4000)).toBe(1); // 短い小節の線は出さない
    expect(body(b)).toContain('#MEASURE 1/9999\n#BARLINEOFF\n0,\n#BRANCHSTART p,60,80\n#N\n#MEASURE 4/4\n#BARLINEON\n');
    const c = new Editor(parseTJA(TJA));
    const f = c.placeBranch(M * 2, { type: 'p', x: -1, y: -2, pre: true })!;
    expect(yellow(c)).toEqual([4000]);
    c.placeBranch(M * 2, { type: 'p', x: 60, y: 80, pre: true }, f);
    expect(yellow(c)).toEqual([4000]);
    const d = new Editor(parseTJA(TJA));
    d.placeBranch(M, { type: 'p', x: -1, y: 101, pre: false });
    expect(yellow(d)).toEqual([2000]);
  });

  it('分岐の小節の頭を #BARLINEOFF にすると黄色の線も出ない。普通・玄人・達人のどれにも書き、読み直しても同じ', () => {
    const src = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n#BARLINEOFF\n#BRANCHSTART p,60,80\n#N\n2222,\n#BARLINEON\n1212,\n#E\n2222,\n#BARLINEON\n1212,\n#M\n2222,\n#BARLINEON\n1212,\n#BRANCHEND\n2121,\n#END\n';
    const ed = new Editor(parseTJA(src));
    const p = toPlayable(ed.chart, ed.mainCourse);
    expect(p.bars.filter((b) => b.branch)).toEqual([]);
    expect(p.bars.map((b) => Math.round(b.time * 1000))).toEqual([0, 4000, 6000]);
    const out = body(ed);
    expect(out).toBe('1111,\n#BRANCHSTART p,60,80\n#N\n#BARLINEOFF\n2222,\n#BARLINEON\n1212,\n#E\n#BARLINEOFF\n2222,\n#BARLINEON\n1212,\n#M\n#BARLINEOFF\n2222,\n#BARLINEON\n1212,\n#BRANCHEND\n2121,');
    expect(body(new Editor(parseTJA(writeTJA(ed.chart))))).toBe(out);
  });
});

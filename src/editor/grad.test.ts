import { describe, expect, it } from 'vitest';
import { parseTJA } from '../chart/tja';
import { writeTJA } from '../chart/tjaWrite';
import { TPB } from '../chart/model';
import { Editor } from './editor';

const M = TPB * 4;
const TJA = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n0,\n00001210,\n5008,\n0,\n#END\n';

describe('グラデ', () => {
  it('1111, に 1→2 の等差: 音符ごとに 1, 1.25, 1.5, 1.75、終点で 2', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => [e.tick, (e as { value: number }).value]);
    expect(s).toEqual([[0, 1], [M / 4, 1.25], [M / 2, 1.5], [(M * 3) / 4, 1.75], [M, 2]]);
  });

  it('小節線と 5〜7 の始まりは対象、8 は対象外。等比で 1→1.5', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: M, end: M * 4, from: 1, to: 1.5, mode: 'geometric', digits: 3 });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => (e as { value: number }).value);
    // 0, の小節線 / 00001210, の小節線と 1・2・1 / 5008, の 5（8 は対象外） = 6 か所 + 終点
    expect(s.length).toBe(7);
    expect(s[0]).toBe(1);
    expect(s[6]).toBe(1.5);
  });

  it('TJA のテキストを書き換えても、#SCROLL がそのままならグラデを引き継ぐ', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const text = writeTJA(ed.chart);
    ed.replaceChart(parseTJA(text));
    expect(ed.course.grads?.length).toBe(1);
    // 値を変えた #SCROLL は、グラデの中に単体で置いたものになる
    ed.replaceChart(parseTJA(text.replace('#SCROLL 1.25', '#SCROLL 1.3')));
    expect(ed.course.grads?.length).toBe(1);
    expect(ed.course.events.find((e) => e.kind === 'scroll' && e.tick === M / 4)).toMatchObject({ value: 1.3, pin: true });
    // グラデが置く #SCROLL を消すと、グラデは外れる
    ed.replaceChart(parseTJA(text.replace('#SCROLL 1.5\n', '')));
    expect(ed.course.grads?.length ?? 0).toBe(0);
  });

  it('グラデの間に単体の #SCROLL を差し込める（置き直しても残り、消すとグラデの値に戻る）', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const vals = () => ed.course.events.filter((e) => e.kind === 'scroll').sort((a, b) => a.tick - b.tick).map((e) => [e.tick, (e as { value: number }).value]);
    // 音符の位置（グラデが置く所）を上書き、音符の間（グラデが置かない所）にも置く
    ed.addEvent({ tick: M / 4, kind: 'scroll', value: 5 });
    ed.addEvent({ tick: (M * 3) / 8, kind: 'scroll', value: 0.5 });
    expect(vals()).toEqual([[0, 1], [M / 4, 5], [(M * 3) / 8, 0.5], [M / 2, 1.5], [(M * 3) / 4, 1.75], [M, 2]]);
    // グラデの設定を変えても残る
    const g = ed.course.grads![0];
    ed.setGrad({ ...g, to: 3 }, g);
    expect(vals()).toEqual([[0, 1], [M / 4, 5], [(M * 3) / 8, 0.5], [M / 2, 2], [(M * 3) / 4, 2.5], [M, 3]]);
    // TJA のテキストから読み直しても、グラデも差し込んだ #SCROLL も残る
    ed.replaceChart(parseTJA(writeTJA(ed.chart)));
    expect(ed.course.grads?.length).toBe(1);
    expect(vals()).toEqual([[0, 1], [M / 4, 5], [(M * 3) / 8, 0.5], [M / 2, 2], [(M * 3) / 4, 2.5], [M, 3]]);
    // 消すと、グラデの値に戻る
    ed.removeEvent(ed.course.events.find((e) => e.kind === 'scroll' && e.tick === M / 4)!);
    expect(vals()).toEqual([[0, 1], [M / 4, 1.5], [(M * 3) / 8, 0.5], [M / 2, 2], [(M * 3) / 4, 2.5], [M, 3]]);
  });

  it('見た目の速さで: BPM が倍になる所では SCROLL を半分にして、BPM × SCROLL を滑らかにする', () => {
    const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n#BPMCHANGE 240\n1111,\n#END\n';
    const ed = new Editor(parseTJA(t));
    ed.setGrad({ start: 0, end: M * 2, from: 1, to: 0.5, mode: 'linear', digits: 3, speed: 'visual' });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => (e as { value: number }).value);
    // 見た目の速さは 120 → 120 で一定なので、BPM 120 の間は 1、BPM 240 の間は 0.5
    expect(s).toEqual([1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5]);
  });

  it('見た目・始点の BPM: 1→2 は見た目でちょうど 2 倍（120 → 240）。終点の #SCROLL は 240 ÷ 240 = 1', () => {
    const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n#BPMCHANGE 120\n1111\n#BPMCHANGE 240\n1111,\n0,\n#END\n';
    const ed = new Editor(parseTJA(t));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3, speed: 'visualBase' });
    const s = ed.course.events.filter((e) => e.kind === 'scroll').map((e) => (e as { value: number }).value);
    expect(s).toEqual([1, 1.125, 1.25, 1.375, 0.75, 0.813, 0.875, 0.938, 1]);
  });

  describe('秒数基準', () => {
    const vals = (ed: Editor) => ed.course.events.filter((e) => e.kind === 'scroll').map((e) => [e.tick, (e as { value: number }).value]);

    it('音符の間隔が不均等でも、秒数で補間する（1→2、1 小節 = 2 秒）', () => {
      const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n11000001,\n0,\n#END\n';
      const ed = new Editor(parseTJA(t));
      ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3, basis: 'time' });
      // 位置 0, 1/8, 7/8 → 1, 1.125, 1.875、終点 2
      expect(vals(ed)).toEqual([[0, 1], [M / 8, 1.125], [(M * 7) / 8, 1.875], [M, 2]]);
    });

    it('BPM が途中で倍になると、後半は同じ拍でも秒数が短い', () => {
      // 前半 2 拍 = 1 秒、後半 2 拍（BPM 240）= 0.5 秒、合計 1.5 秒
      const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n11\n#BPMCHANGE 240\n11,\n0,\n#END\n';
      const ed = new Editor(parseTJA(t));
      ed.setGrad({ start: 0, end: M, from: 1, to: 2.5, mode: 'linear', digits: 3, basis: 'time', speed: 'scroll' });
      // 秒数 0, 0.5, 1, 1.25 → t = 0, 1/3, 2/3, 5/6
      expect(vals(ed)).toEqual([[0, 1], [M / 4, 1.5], [M / 2, 2], [(M * 3) / 4, 2.25], [M, 2.5]]);
    });

    it('#DELAY で止まっている時間も進んだことにする', () => {
      // 1 拍目と 2 拍目の間に 1 秒の #DELAY。秒数 0, 0.5+1, 2, 2.5、終点 3
      const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1\n#DELAY 1\n111,\n0,\n#END\n';
      const ed = new Editor(parseTJA(t));
      ed.setGrad({ start: 0, end: M, from: 0, to: 3, mode: 'linear', digits: 3, basis: 'time' });
      expect(vals(ed)).toEqual([[0, 0], [M / 4, 1.5], [M / 2, 2], [(M * 3) / 4, 2.5], [M, 3]]);
    });

    it('basis が無い（前に保存した）グラデは、今までどおり数で補間する', () => {
      const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n11000001,\n0,\n#END\n';
      const ed = new Editor(parseTJA(t));
      ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
      expect(vals(ed)).toEqual([[0, 1], [M / 8, 1.333], [(M * 7) / 8, 1.667], [M, 2]]);
    });

    it('TJA を書き戻しても、秒数基準のグラデを引き継ぐ', () => {
      const t = 'TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n11000001,\n0,\n#END\n';
      const ed = new Editor(parseTJA(t));
      ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3, basis: 'time' });
      ed.replaceChart(parseTJA(writeTJA(ed.chart)));
      expect(ed.course.grads?.[0]?.basis).toBe('time');
    });
  });

  it('グラデの始点・終点に重ねて SCROLL を置ける（置き直しても・TJA を読み直しても残る。消すとグラデの値に戻る）', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    const at = (t: number) => ed.course.events.filter((e) => e.kind === 'scroll' && e.tick === t).map((e) => (e as { value: number }).value);
    ed.addEvent({ tick: M, kind: 'scroll', value: 0.5 });
    ed.addEvent({ tick: 0, kind: 'scroll', value: 3 });
    expect(at(M)).toEqual([0.5]);
    expect(at(0)).toEqual([3]);
    expect(at(M / 2)).toEqual([1.5]);
    // ほかの編集でグラデを置き直しても残る
    ed.addEvent({ tick: M * 2, kind: 'bpm', value: 150 });
    expect(at(M)).toEqual([0.5]);
    // グラデを変えても残る
    ed.setGrad({ ...ed.course.grads![0], to: 4 }, ed.course.grads![0]);
    expect(at(M)).toEqual([0.5]);
    expect(at(M / 2)).toEqual([2.5]);
    // TJA のテキストから読み直しても、グラデも重ねた SCROLL も残る
    ed.replaceChart(parseTJA(writeTJA(ed.chart)));
    expect(ed.course.grads?.length).toBe(1);
    ed.addEvent({ tick: M * 2, kind: 'bpm', value: 160 });
    expect(at(M)).toEqual([0.5]);
    expect(at(0)).toEqual([3]);
    // 消すとグラデの値に戻る
    ed.removeEvent(ed.course.events.find((e) => e.kind === 'scroll' && e.tick === M)!);
    expect(at(M)).toEqual([4]);
  });

  it('つながったグラデを TJA から読み直しても、つなぎ目は重ねた SCROLL にならない', () => {
    const ed = new Editor(parseTJA(TJA));
    ed.setGrad({ start: 0, end: M, from: 1, to: 2, mode: 'linear', digits: 3 });
    ed.setGrad({ start: M, end: M * 3, from: 3, to: 1, mode: 'linear', digits: 3 });
    ed.replaceChart(parseTJA(writeTJA(ed.chart)));
    expect(ed.course.grads?.length).toBe(2);
    expect(ed.course.events.some((e) => e.kind === 'scroll' && e.pin)).toBe(false);
    ed.setGrad({ ...ed.course.grads![1], from: 5 }, ed.course.grads![1]);
    expect(ed.course.events.filter((e) => e.kind === 'scroll' && e.tick === M).map((e) => (e as { value: number }).value)).toEqual([5]);
  });
});

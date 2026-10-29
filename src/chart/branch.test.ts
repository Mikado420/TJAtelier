import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { branchPath, toPlayable, TPB } from './model';

const BAR = TPB * 4;
const TJA = `TITLE:t
BPM:120
OFFSET:0
COURSE:Oni
LEVEL:9
BALLOON:3,4,5,6

#START
1111,
#SECTION
2222,
#BRANCHSTART p,60,80
#N
1000,
7008,
#E
1100,
7008,
#M
#LEVELHOLD
1110,
7008,
#BRANCHEND
7008,
#END
`;

describe('譜面分岐', () => {
  it('区間と分岐ごとの音符を読む', () => {
    const c = parseTJA(TJA).courses[0];
    expect(c.branches).toHaveLength(1);
    const b = c.branches![0];
    expect([b.start, b.end, b.type, b.x, b.y, b.close]).toEqual([BAR * 2, BAR * 4, 'p', 60, 80, true]);
    // 普通譜面は course に（共通 8 + 区間 2）、玄人・達人は区間に
    expect(c.notes.filter((n) => n.tick >= BAR * 2 && n.tick < BAR * 4)).toHaveLength(2);
    expect(b.e.notes).toHaveLength(3);
    expect(b.m.notes).toHaveLength(4);
    // 風船はテキストの順
    expect(c.notes.find((n) => n.type === 'balloon' && n.tick === BAR * 3)?.hits).toBe(3);
    expect(b.e.notes.find((n) => n.type === 'balloon')?.hits).toBe(4);
    expect(b.m.notes.find((n) => n.type === 'balloon')?.hits).toBe(5);
    expect(c.notes.find((n) => n.tick === BAR * 4)?.hits).toBe(6);
    expect(b.m.events.map((e) => e.kind)).toEqual(['levelhold']);
    expect(c.events.map((e) => e.kind)).toEqual(['section']);
    // 達人で通した譜面
    const m = branchPath(c, 2);
    expect(m.notes).toHaveLength(8 + 4 + 1);
  });

  it('書き出して読み直しても同じ', () => {
    const chart = parseTJA(TJA);
    const out = writeTJA(chart);
    expect(out).toContain('#BRANCHSTART p,60,80');
    expect(out).toContain('#BRANCHEND');
    const again = parseTJA(out);
    expect(writeTJA(again)).toBe(out);
    expect(again.courses[0].branches).toEqual(chart.courses[0].branches);
    expect(again.courses[0].notes).toEqual(chart.courses[0].notes);
  });

  it('プレイ用: 全部の分岐の音符に印を付け、判定の時刻は 1 小節前', () => {
    const chart = parseTJA(TJA);
    const p = toPlayable(chart, chart.courses[0]);
    expect(p.branches).toEqual([{ start: 4, end: 8, judge: 2, type: 'p', x: 60, y: 80 }]);
    expect(p.sections).toEqual([2]);
    expect(p.holds).toEqual([{ time: 4, br: 2 }]);
    const inSec = p.notes.filter((n) => n.sec === 0);
    expect(inSec.filter((n) => n.br === 0)).toHaveLength(2);
    expect(inSec.filter((n) => n.br === 1)).toHaveLength(3);
    expect(inSec.filter((n) => n.br === 2)).toHaveLength(4);
  });
});

describe('譜面分岐: 元のテキストへの書き込み', () => {
  it('分岐の外を変えても、分岐の行はそのまま', async () => {
    const { tjaText } = await import('./tjaPatch');
    const src = TJA.replace('1111,\n#SECTION', '1111, // はじめ\n#SECTION');
    const chart = parseTJA(src);
    expect(tjaText({ ...chart })).toBe(src);
    chart.courses[0].notes = chart.courses[0].notes.filter((n) => n.tick !== 0);
    const t = tjaText({ ...chart, source: src });
    expect(t).toContain('0111, // はじめ');
    expect(t).toContain('#BRANCHSTART p,60,80\n#N\n1000,');
    // 分岐の中を変えたとき
    chart.courses[0].branches![0].m.notes.pop();
    const t2 = tjaText({ ...chart, source: src });
    expect(parseTJA(t2).courses[0].branches![0].m.notes.length).toBe(3);
  });
});

describe('譜面分岐: プレイ', () => {
  it('精度で分岐し、通らない分岐の音符は判定しない', async () => {
    const { Game } = await import('../engine/game');
    const chart = parseTJA(TJA);
    const p = toPlayable(chart, chart.courses[0]);
    const play = (acc: 'good' | 'bad' | 'mix', fixed?: number) => {
      const g = new Game(p.notes, { ...p, fixed });
      for (const n of p.notes) {
        if (n.time >= 2) break;
        if (n.type !== 'don' && n.type !== 'ka') continue;
        const k = n.type;
        if (acc === 'good' || (acc === 'mix' && n.time < 1)) g.hit(k, n.time);
      }
      g.update(3);
      return g;
    };
    // 判定は区間の 1 小節前（2 秒）。#SECTION も 2 秒なので、数える音符が無く普通
    expect(play('good').branch).toBe(0);
    const p2 = toPlayable(parseTJA(TJA.replace('#SECTION\n', '').replace('#START\n', '#START\n#SECTION\n')), parseTJA(TJA.replace('#SECTION\n', '').replace('#START\n', '#START\n#SECTION\n')).courses[0]);
    const g = new Game(p2.notes, p2);
    for (const n of p2.notes) if (n.time < 4 && (n.type === 'don' || n.type === 'ka')) { g.update(n.time); g.hit(n.type, n.time); }
    g.update(3);
    expect(g.branch).toBe(2);
    expect(g.states.filter((s) => s.skip).length).toBe(2 + 3);
    expect(g.states.filter((s) => s.note.br === 2).every((s) => g.active(s.note))).toBe(true);
    // 固定
    expect(play('bad', 1).branch).toBe(1);
    // 叩かなければ普通
    expect(play('bad').branch).toBe(0);
  });
});

describe('譜面分岐: 区間を足す・中を変える', () => {
  it('ほかの小節の書き方はそのまま', async () => {
    const { tjaText } = await import('./tjaPatch');
    const src = TJA.replace('1111,\n#SECTION', '1000100010001000, // はじめ\n#SECTION');
    const chart = parseTJA(src);
    const c = chart.courses[0];
    // 区間の中（達人）を変える
    c.branches![0].m.notes = c.branches![0].m.notes.slice(1);
    const t = tjaText({ ...chart, source: src });
    expect(t).toContain('1000100010001000, // はじめ');
    expect(t).toContain('#M\n#LEVELHOLD\n0110,');
    // 最後の小節に区間を足す
    c.branches!.push({ start: BAR * 4, end: BAR * 5, type: 'r', x: 5, y: 10, close: true, e: { notes: [], events: [] }, m: { notes: [], events: [] } });
    const t2 = tjaText({ ...chart, source: t });
    expect(t2).toContain('1000100010001000, // はじめ');
    expect(t2).toContain('#BRANCHSTART r,5,10');
    expect(parseTJA(t2).courses[0].branches).toHaveLength(2);
  });
});

import { describe, expect, it } from 'vitest';
import type { Note } from '../chart/types';
import { buildAutoEvents } from './auto';

const note = (o: Partial<Note>): Note => ({ type: 'don', time: 0, bpm: 120, scroll: 1, ...o }) as Note;

describe('オートの打撃', () => {
  it('音符はその時刻ちょうどに叩く', () => {
    const ev = buildAutoEvents([note({ time: 1 }), note({ type: 'ka', time: 1.5 })]);
    expect(ev.map((e) => [e.t, e.kind])).toEqual([[1, 'don'], [1.5, 'ka']]);
  });
  it('連打は 1 秒に 35 打', () => {
    const ev = buildAutoEvents([note({ type: 'roll', time: 0, endTime: 1 })]);
    expect(ev.length).toBe(36);
  });
  it('風船は時間内に割り切る（最後の打撃で割れる）', () => {
    const ev = buildAutoEvents([note({ type: 'balloon', time: 0, endTime: 1, hits: 20 })]);
    expect(ev.length).toBe(20);
    expect(ev[19].pop).toBe(true);
    expect(ev[19].t).toBeLessThanOrEqual(1);
  });
  it('風船は長くても 1 秒に 30 打より遅く叩かない', () => {
    const ev = buildAutoEvents([note({ type: 'balloon', time: 0, endTime: 4, hits: 10 })]);
    expect(ev.length).toBe(10);
    expect(ev[9].pop).toBe(true);
    expect(ev[9].t).toBeCloseTo(9 / 30, 6);
  });
  it('風船の速さは 1 秒 50 打まで（間に合わなければ割れない）', () => {
    const ev = buildAutoEvents([note({ type: 'balloon', time: 0, endTime: 0.5, hits: 100 })]);
    expect(ev.length).toBeLessThanOrEqual(26);
    expect(ev.some((e) => e.pop)).toBe(false);
  });
});

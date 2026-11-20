import { expect, test } from 'vitest';
import { applyMods } from './mods';
import type { Note } from './types';

const n = (type: Note['type'], time: number): Note => ({ type, time, bpm: 120, scroll: 1, gogo: false });
const chart = Array.from({ length: 400 }, (_, i) => n(i % 2 ? 'ka' : 'don', i * 0.1)).concat([n('roll', 50), n('bigDon', 51)]);

test('何もしないときは同じ配列', () => {
  expect(applyMods(chart, {})).toBe(chart);
  expect(applyMods(chart, { random: 'off' })).toBe(chart);
});

test('あべこべはドンとカッ（大も）を全部入れ替える', () => {
  const m = applyMods(chart, { mirror: true });
  expect(m.slice(0, 4).map((x) => x.type)).toEqual(['ka', 'don', 'ka', 'don']);
  expect(m.at(-2)!.type).toBe('roll');
  expect(m.at(-1)!.type).toBe('bigKa');
  expect(chart[0].type).toBe('don');
});

test('きまぐれは 4 つに 1 つほど、でたらめは半分ほど入れ替わる', () => {
  const diff = (m: Note[]) => m.filter((x, i) => x.type !== chart[i].type).length / chart.length;
  const k = diff(applyMods(chart, { random: 'kimagure' }, 7));
  const d = diff(applyMods(chart, { random: 'detarame' }, 7));
  expect(k).toBeGreaterThan(0.15);
  expect(k).toBeLessThan(0.35);
  expect(d).toBeGreaterThan(0.4);
  expect(d).toBeLessThan(0.6);
});

test('同じ種なら同じ並び', () => {
  const a = applyMods(chart, { random: 'detarame' }, 42).map((x) => x.type);
  const b = applyMods(chart, { random: 'detarame' }, 42).map((x) => x.type);
  expect(a).toEqual(b);
});

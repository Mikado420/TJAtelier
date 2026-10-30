import { expect, test } from 'vitest';
import { parseTJA } from './tja';
import { toPlayable } from './model';
import { writeTJA } from './tjaWrite';

const T = (tail: string) => `TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:5\n#START\n1010,\n2020,\n#END\n${tail}\nCOURSE:Hard\nLEVEL:3\n#START\n1,\n#END\n`;

test('#END の後ろの音符は、同じ譜面の続き（判定しない飾り）として読む', () => {
  const c = parseTJA(T('3333,\n#DELAY -4\n1111,'));
  expect(c.courses.length).toBe(2);
  const oni = c.courses[0];
  expect(oni.endTick).toBeDefined();
  const p = toPlayable(c, c.courses[0]);
  const dummies = p.notes.filter((n) => n.dummy);
  expect(dummies.length).toBe(8);
  expect(p.notes.filter((n) => !n.dummy).length).toBe(4);
  expect(c.courses[1].endTick).toBeUndefined();
});

test('#END の後ろに音符が無ければ、今までと同じ', () => {
  const c = parseTJA(T(''));
  expect(c.courses[0].endTick).toBeUndefined();
  expect(writeTJA(c).match(/#END/g)?.length).toBe(2);
});

test('書き出すと #END の後ろに音符が残る', () => {
  const c = parseTJA(T('3333,'));
  const again = parseTJA(writeTJA(c));
  expect(again.courses[0].endTick).toBe(c.courses[0].endTick);
  expect(toPlayable(again, again.courses[0]).notes.filter((n) => n.dummy).length).toBe(4);
});

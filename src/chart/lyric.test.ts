import { describe, expect, it } from 'vitest';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { parseScroll, scrollText, toPlayable } from './model';
import { lyricAt, scrollBase } from './types';

const TJA = `TITLE:t
BPM:120
OFFSET:0
COURSE:Oni
LEVEL:5
#START
#LYRIC さくら さくら
1111,
#SCROLL 1+i
1111,
#SCROLL -0.5-2i
#LYRIC
1111,
#SCROLL i
1,
#END
`;

describe('複素数の #SCROLL', () => {
  it('a+bi の形を読む', () => {
    expect(parseScroll('1+i')).toEqual({ value: 1, im: 1 });
    expect(parseScroll('1 - 2i')).toEqual({ value: 1, im: -2 });
    expect(parseScroll('-0.5-2i')).toEqual({ value: -0.5, im: -2 });
    expect(parseScroll('i')).toEqual({ value: 0, im: 1 });
    expect(parseScroll('-i')).toEqual({ value: 0, im: -1 });
    expect(parseScroll('0.5i')).toEqual({ value: 0, im: 0.5 });
    expect(parseScroll('2')).toEqual({ value: 2, im: 0 });
    expect(parseScroll('1e2+1e-1i')).toEqual({ value: 100, im: 0.1 });
    expect(parseScroll('abc')).toBeNull();
    expect(scrollText(1, 1)).toBe('1+i');
    expect(scrollText(-0.5, -2)).toBe('-0.5-2i');
    expect(scrollText(2)).toBe('2');
  });

  it('音符に縦の速さが入り、書き出しても同じ', () => {
    const c = parseTJA(TJA);
    const p = toPlayable(c, c.courses[0]);
    expect(p.notes[0].scrollY).toBeUndefined();
    expect(p.notes[4].scroll).toBe(1);
    expect(p.notes[4].scrollY).toBe(1);
    expect(p.notes[8].scrollY).toBe(-2);
    expect(p.notes[12].scroll).toBe(0);
    expect(p.notes[12].scrollY).toBe(1);
    // 判定枠より先（未来）の音符は、虚部が正なら下（＋）にいる
    expect(scrollBase(undefined, p.notes[12], 0, null) * p.notes[12].scrollY!).toBeGreaterThan(0);
    const out = writeTJA(c);
    expect(out).toContain('#SCROLL 1+i');
    expect(out).toContain('#SCROLL -0.5-2i');
    expect(out).toContain('#SCROLL 0+i');
    const again = parseTJA(out);
    expect(again.courses[0].events).toEqual(c.courses[0].events);
  });
});

describe('#LYRIC', () => {
  it('次の #LYRIC まで出し続け、空なら消す', () => {
    const c = parseTJA(TJA);
    const p = toPlayable(c, c.courses[0]);
    expect(p.lyrics).toEqual([{ time: 0, text: 'さくら さくら' }, { time: 4, text: '' }]);
    expect(lyricAt(p.lyrics, -1)).toBe('');
    expect(lyricAt(p.lyrics, 3.9)).toBe('さくら さくら');
    expect(lyricAt(p.lyrics, 4)).toBe('');
    const out = writeTJA(c);
    expect(out).toContain('#LYRIC さくら さくら');
    expect(out).toMatch(/^#LYRIC$/m);
  });
});

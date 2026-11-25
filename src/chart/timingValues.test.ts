import { describe, expect, it } from 'vitest';
import { Timing, type EChart, type ECourse, type EEvent } from './model';
import { parseTJA } from './tja';

/** 前の数え方（頭から 1 つずつ見る）。速くした引き方と答えが同じか比べる */
function slow(events: EEvent[], kind: string, tick: number) {
  let v: EEvent | undefined;
  for (const e of events) {
    if (e.tick > tick) break;
    if (e.kind === kind) v = e;
  }
  return v;
}

function rng(seed: number) {
  let x = seed;
  return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe('#SCROLL・ゴーゴー・小節線の値の引き方', () => {
  const ch = parseTJA('TITLE:t\nBPM:120\nCOURSE:Oni\nLEVEL:1\n#START\n1111,\n#END\n') as EChart;
  for (const sorted of [true, false]) {
    it(`前の数え方と同じ答え（命令の並び${sorted ? '順' : 'がばらばら'}）`, () => {
      const r = rng(sorted ? 7 : 11);
      for (let round = 0; round < 30; round++) {
        const events: EEvent[] = [];
        const n = Math.floor(r() * 60);
        for (let i = 0; i < n; i++) {
          const tick = Math.floor(r() * 40) * 10;
          const k = r();
          events.push(k < 0.4 ? { tick, kind: 'scroll', value: Math.round(r() * 30) / 10, ...(r() < 0.2 ? { im: 1 } : {}) }
            : k < 0.6 ? { tick, kind: 'gogo', on: r() < 0.5 }
              : k < 0.8 ? { tick, kind: 'barline', on: r() < 0.5 }
                : { tick, kind: 'bpm', value: 150 });
        }
        if (sorted) events.sort((a, b) => a.tick - b.tick);
        const course = { ...ch.courses[0], events } as ECourse;
        const t = new Timing(ch, course);
        for (let tick = -10; tick <= 420; tick += 5) {
          const s = slow(events, 'scroll', tick) as Extract<EEvent, { kind: 'scroll' }> | undefined;
          const g = slow(events, 'gogo', tick) as Extract<EEvent, { kind: 'gogo' }> | undefined;
          const b = slow(events, 'barline', tick) as Extract<EEvent, { kind: 'barline' }> | undefined;
          expect(t.scrollAt(tick)).toBe(s?.value ?? 1);
          expect(t.scrollImAt(tick)).toBe(s?.im ?? 0);
          expect(t.gogoAt(tick)).toBe(g?.on ?? false);
          expect(t.barlineAt(tick)).toBe(b?.on ?? true);
        }
      }
    });
  }

  it('命令を足したら引き直す', () => {
    const events: EEvent[] = [{ tick: 0, kind: 'scroll', value: 2 }];
    const course = { ...ch.courses[0], events } as ECourse;
    const t = new Timing(ch, course);
    expect(t.scrollAt(100)).toBe(2);
    events.push({ tick: 50, kind: 'scroll', value: 3 });
    expect(t.scrollAt(100)).toBe(3);
  });
});

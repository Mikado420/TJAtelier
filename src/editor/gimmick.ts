import { measures, measureScale, TPB, type ECourse, type ENote } from '../chart/model';
import type { NoteType } from '../chart/types';
import { bpmFn, timeFn } from './grad';

/**
 * ギミック（選んだ範囲 [start, end]（両端を含む）に使う）
 * - あべこべ: ドン⇔カッ、大ドン⇔大カッを入れ替える
 * - 同時出現: 範囲の音符と小節線が、同じ瞬間に右端から出てくるように #SCROLL を置く
 * - 敷き詰め: コピーした範囲を、範囲いっぱいに繰り返して置く
 */

const FLIP: Partial<Record<NoteType, NoteType>> = { don: 'ka', ka: 'don', bigDon: 'bigKa', bigKa: 'bigDon' };

/** あべこべ（入れ替えた数を返す） */
export function flipNotes(c: ECourse, start: number, end: number): number {
  let n = 0;
  for (const x of c.notes) {
    const to = x.tick >= start && x.tick <= end ? FLIP[x.type] : undefined;
    if (to) { x.type = to; n++; }
  }
  return n;
}

/**
 * 右端から判定枠の中心までの距離（#SCROLL 1 で何拍ぶんか）。
 * 画面の幅 1920 のうち判定枠の中心が 634、1 拍が 1470 / 4。音符の半径ぶん（60）外から出てくる
 */
export const APPEAR_BEATS = (1920 - 634 + 60) / (1470 / 4);

/** 拍の位置（#HBSCROLL 用。BPM・#DELAY に関係なく、譜面の上の拍） */
function beatFn(c: ECourse) {
  const evs = c.events.filter((e) => e.kind === 'measure').slice().sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let beat = 0;
    let t = 0;
    let sc = 1;
    for (const e of evs) {
      if (e.tick > tick) break;
      beat += ((e.tick - t) * sc) / TPB;
      t = e.tick;
      if (e.kind === 'measure') sc = measureScale(e.num, e.den);
    }
    return beat + ((tick - t) * sc) / TPB;
  };
}

/** 範囲の対象（始点より後ろの音符の始まり・小節の頭）と、範囲の後ろで元の #SCROLL に戻す位置 */
function simTargets(c: ECourse, start: number, end: number): { ticks: number[]; after: number | null } {
  const set = new Set<number>();
  let after = Infinity;
  for (const n of c.notes) {
    if (n.tick > start && n.tick <= end) set.add(n.tick);
    else if (n.tick > end) after = Math.min(after, n.tick);
  }
  const ms = measures(c, end + TPB * 16);
  for (const m of ms) {
    if (m.start > start && m.start <= end) set.add(m.start);
    else if (m.start > end) after = Math.min(after, m.start);
  }
  return { ticks: [...set].sort((a, b) => a - b), after: Number.isFinite(after) ? after : null };
}

/** その位置の #SCROLL の値（無ければ 1） */
function scrollAt(c: ECourse, tick: number): number {
  let v = 1;
  let at = -Infinity;
  for (const e of c.events) if (e.kind === 'scroll' && e.tick <= tick && e.tick >= at) { v = e.value; at = e.tick; }
  return v;
}

const round = (v: number, digits: number) => {
  const r = Number(v.toFixed(Math.max(0, Math.min(6, Math.round(digits)))));
  return Object.is(r, -0) ? 0 : r;
};

/**
 * 同時出現で置く #SCROLL。
 * 判定枠が範囲の始点に来た瞬間 T に、範囲（始点より後ろ）のすべての音符・小節線が右端から出てくるようにする。
 * 位置 k の #SCROLL = 右端までの拍数 ÷ （T から k までの拍数）（拍数は BPM × 秒数 ÷ 60。#HBSCROLL は譜面の拍）。
 * 始点そのものにある音符には #SCROLL を置かない（その瞬間に判定枠にいるので）。始点に前から #SCROLL があれば消す（前に置いた同時出現の残りなど）
 */
export function simScrolls(c: ECourse, start: number, end: number, baseBpm: number, digits: number): { tick: number; value: number }[] {
  const { ticks, after } = simTargets(c, start, end);
  if (!ticks.length) return [];
  const out: { tick: number; value: number }[] = [];
  if (c.scrollMode) {
    const beat = beatFn(c);
    const bT = beat(start);
    for (const k of ticks) out.push({ tick: k, value: round(APPEAR_BEATS / (beat(k) - bT), digits) });
  } else {
    const time = timeFn(c, baseBpm);
    const bpm = bpmFn(c, baseBpm);
    const T = time(start);
    for (const k of ticks) out.push({ tick: k, value: round((APPEAR_BEATS * 60) / (bpm(k) * (time(k) - T)), digits) });
  }
  if (after !== null) out.push({ tick: after, value: scrollAt(c, after) });
  return out;
}

/** 同時出現を置く（範囲の #SCROLL と、範囲にかかるグラデは置き直す） */
export function applySim(c: ECourse, start: number, end: number, baseBpm: number, digits: number): number {
  const list = simScrolls(c, start, end, baseBpm, digits);
  if (!list.length) return 0;
  const last = list[list.length - 1].tick;
  const keepAfter = list.length > 1 && last > end;
  const to = keepAfter ? last : end;
  // 戻す位置に元からある #SCROLL はそのまま
  const atAfter = keepAfter ? c.events.find((e) => e.kind === 'scroll' && e.tick === last) : undefined;
  c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= start && (e.tick < to || (e.tick === to && !atAfter))));
  if (c.grads) c.grads = c.grads.filter((g) => g.end < start || g.start > to);
  for (const s of list) {
    if (s.tick === last && keepAfter && atAfter) continue;
    c.events.push({ tick: s.tick, kind: 'scroll', value: s.value });
  }
  return list.length - (keepAfter ? 1 : 0);
}

export interface Clip { notes: ENote[]; span: number; step?: number }

/**
 * 敷き詰め: コピーした範囲（長さ span + 1 マス）を、範囲 [start, end] の頭から繰り返して置く。
 * fill = 'replace' は範囲の音符を消してから置く。'empty' は音符の無い所（連打の途中も除く）にだけ置く。
 * 置いた数を返す
 */
export function tileClip(c: ECourse, start: number, end: number, clip: Clip, fill: 'replace' | 'empty'): number {
  const period = clip.span + (clip.step ?? 0);
  if (!(period > 0) || !clip.notes.length) return 0;
  const add: ENote[] = [];
  for (let base = start; base <= end; base += period) {
    for (const n of clip.notes) {
      if (n.tick >= period) continue;
      const t = n.tick + base;
      const e = n.endTick !== undefined ? n.endTick + base : undefined;
      if (t > end || (e !== undefined && e > end)) continue;
      const x: ENote = { ...n, tick: t };
      if (e !== undefined) x.endTick = e;
      add.push(x);
    }
  }
  if (fill === 'replace') {
    // 範囲にかかる音符（連打の途中も）を消す
    c.notes = c.notes.filter((n) => (n.endTick ?? n.tick) < start || n.tick > end);
    c.notes.push(...add);
    return add.length;
  }
  const busy = (t: number, e: number) => c.notes.some((n) => n.tick <= e && (n.endTick ?? n.tick) >= t);
  let k = 0;
  for (const x of add) {
    if (busy(x.tick, x.endTick ?? x.tick)) continue;
    c.notes.push(x);
    k++;
  }
  return k;
}

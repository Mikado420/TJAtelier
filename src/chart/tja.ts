import type { NoteType } from './types';
import { measureTicks, newCourse, sortCourse, TPB, type EChart, type ECourse, type EEvent } from './model';

/**
 * TJA → 編集用モデル（tick ベース）
 * 対応: TITLE SUBTITLE BPM OFFSET WAVE DEMOSTART COURSE LEVEL BALLOON（他のヘッダは保持）
 *       #START #END #BPMCHANGE #SCROLL #MEASURE #DELAY #GOGOSTART #GOGOEND #BARLINEON #BARLINEOFF
 *       #HBSCROLL #BMSCROLL（#START の直前） #JPOSSCROLL
 * 譜面分岐は「普通譜面 (#N)」だけ採用。2P 譜面 (#START P2) は無視。
 */

const COURSE_KEYS = new Set([
  'LEVEL', 'BALLOON', 'SCOREINIT', 'SCOREDIFF', 'STYLE', 'TOTAL', 'GAUGEINCR', 'HIDDENBRANCH',
  'EXAM1', 'EXAM2', 'EXAM3', 'BALLOONNOR', 'BALLOONEXP', 'BALLOONMAS',
]);

export function normalizeCourse(v: string): string {
  const s = v.trim().toLowerCase();
  const names = ['easy', 'normal', 'hard', 'oni', 'edit'];
  const display = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
  const idx = names.indexOf(s);
  if (idx >= 0) return display[idx];
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 4) return display[n];
  return v.trim() || 'Oni';
}

type Item = { kind: 'note'; ch: string } | { kind: 'cmd'; name: string; arg: string };

const NOTE_CHARS = /[0-9AB]/;

const CHAR_TO_TYPE: Record<string, NoteType | undefined> = {
  '1': 'don', '2': 'ka', '3': 'bigDon', '4': 'bigKa', '5': 'roll', '6': 'bigRoll',
  '7': 'balloon', '9': 'balloon', A: 'bigDon', B: 'bigKa',
};

interface State {
  tick: number;
  measureTicks: number;
  pendingMeasure: number | null; // 小節の途中にあった #MEASURE は次の小節から
  balloonIndex: number;
  openLong: number | null; // course.notes のインデックス
}

export function parseTJA(text: string): EChart {
  const chart: EChart = {
    title: '', subtitle: '', wave: '', bpm: 120, offset: 0, demoStart: 0, extra: [], courses: [],
  };

  let header = { name: 'Oni', level: 0, balloons: [] as number[], extra: [] as [string, string][], scrollMode: undefined as 'hb' | 'bm' | undefined };
  let inChart = false;
  let items: Item[] = [];
  let branch: 'none' | 'N' | 'E' | 'M' = 'none';
  let course: ECourse = newCourse();
  let st: State = newState();

  const flushMeasure = () => {
    processMeasure(items, st, course, header.balloons);
    items = [];
  };

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = line.match(/^#([A-Z0-9]+)\s*(.*)$/i);
      if (!m) continue;
      const name = m[1].toUpperCase();
      const arg = m[2].trim();

      if (name === 'START') {
        if (/P2/i.test(arg)) { inChart = false; continue; }
        inChart = true;
        branch = 'none';
        items = [];
        st = newState();
        course = { ...newCourse(header.name, header.level), extra: header.extra.slice() };
        if (header.scrollMode) course.scrollMode = header.scrollMode;
        // 次の #START には持ち越さない（難易度ごとに書く）
        header.scrollMode = undefined;
        continue;
      }
      if (name === 'END') {
        if (!inChart) continue;
        if (items.length) flushMeasure();
        sortCourse(course);
        chart.courses.push(course);
        inChart = false;
        continue;
      }
      // 流れ方: #START の直前（または #START の後）に置く
      if (name === 'HBSCROLL' || name === 'BMSCROLL') {
        // #BMSCROLL は #HBSCROLL と同じにする（このアプリの #HBSCROLL は SCROLL も効く）
        const mode = 'hb' as const;
        if (inChart) course.scrollMode = mode;
        else header.scrollMode = mode;
        continue;
      }
      if (!inChart) continue;

      if (name === 'BRANCHSTART' || name === 'BRANCHEND') { branch = 'none'; continue; }
      if (name === 'N' || name === 'E' || name === 'M') { branch = name; continue; }
      if (branch === 'E' || branch === 'M') continue;

      items.push({ kind: 'cmd', name, arg });
      continue;
    }

    if (!inChart) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toUpperCase();
      const val = line.slice(idx + 1).trim();
      switch (key) {
        case 'TITLE': chart.title = val; break;
        case 'SUBTITLE': chart.subtitle = val; break;
        case 'BPM': chart.bpm = Number(val) || chart.bpm; break;
        case 'OFFSET': chart.offset = Number(val) || 0; break;
        case 'WAVE': chart.wave = val; break;
        case 'DEMOSTART': chart.demoStart = Number(val) || 0; break;
        case 'COURSE':
          // 新しい難易度: 難易度ごとのヘッダをリセット
          header = { name: normalizeCourse(val), level: 0, balloons: [], extra: [], scrollMode: header.scrollMode };
          break;
        case 'LEVEL': header.level = Number(val) || 0; break;
        case 'BALLOON':
          header.balloons = val.split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
          break;
        default:
          if (COURSE_KEYS.has(key)) header.extra.push([key, val]);
          else if (!chart.extra.some(([k]) => k === key)) chart.extra.push([key, val]);
      }
      continue;
    }

    if (branch === 'E' || branch === 'M') continue;

    for (const ch of line) {
      if (ch === ',') flushMeasure();
      else if (NOTE_CHARS.test(ch)) items.push({ kind: 'note', ch });
    }
  }

  chart.source = text;

  // #END が無いファイルへの保険
  if (inChart) {
    if (items.length) flushMeasure();
    sortCourse(course);
    chart.courses.push(course);
  }
  return chart;
}

function newState(): State {
  return { tick: 0, measureTicks: TPB * 4, pendingMeasure: null, balloonIndex: 0, openLong: null };
}

function processMeasure(items: Item[], st: State, course: ECourse, balloons: number[]) {
  if (st.pendingMeasure !== null) {
    st.measureTicks = st.pendingMeasure;
    st.pendingMeasure = null;
  }

  const noteCount = items.filter((i) => i.kind === 'note').length;
  let noteIdx = 0;
  let seenNote = false;

  const tickOf = (i: number) =>
    noteCount === 0 ? st.tick : st.tick + Math.round((i * st.measureTicks) / noteCount);

  for (const it of items) {
    if (it.kind === 'cmd') {
      const tick = tickOf(noteIdx);
      if (it.name === 'MEASURE') {
        const m = it.arg.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)/);
        if (!m || !(Number(m[2]) > 0)) continue;
        const num = Number(m[1]);
        const den = Number(m[2]);
        const ticks = measureTicks(num, den);
        if (!seenNote) {
          course.events.push({ tick: st.tick, kind: 'measure', num, den });
          st.measureTicks = ticks;
        } else {
          course.events.push({ tick: st.tick + st.measureTicks, kind: 'measure', num, den });
          st.pendingMeasure = ticks;
        }
        continue;
      }
      const ev = toEvent(it.name, it.arg, tick);
      if (ev) course.events.push(ev);
      continue;
    }

    seenNote = true;
    const tick = tickOf(noteIdx);
    noteIdx++;
    const ch = it.ch;
    if (ch === '8') {
      if (st.openLong !== null) {
        course.notes[st.openLong].endTick = tick;
        st.openLong = null;
      }
      continue;
    }
    const type = CHAR_TO_TYPE[ch];
    if (!type) continue;
    if (type === 'roll' || type === 'bigRoll' || type === 'balloon') {
      if (st.openLong !== null) course.notes[st.openLong].endTick = tick;
      if (type === 'balloon') course.notes.push({ tick, type, hits: balloons[st.balloonIndex++] ?? 5 });
      else course.notes.push({ tick, type });
      st.openLong = course.notes.length - 1;
    } else {
      course.notes.push({ tick, type });
    }
  }

  st.tick += st.measureTicks;
}

function toEvent(name: string, arg: string, tick: number): EEvent | null {
  const v = Number(arg);
  switch (name) {
    case 'BPMCHANGE': return v > 0 ? { tick, kind: 'bpm', value: v } : null;
    case 'SCROLL': return Number.isFinite(v) && arg !== '' ? { tick, kind: 'scroll', value: v } : null;
    case 'DELAY': return Number.isFinite(v) && arg !== '' ? { tick, kind: 'delay', value: v } : null;
    case 'GOGOSTART': return { tick, kind: 'gogo', on: true };
    case 'GOGOEND': return { tick, kind: 'gogo', on: false };
    case 'BARLINEON': return { tick, kind: 'barline', on: true };
    case 'BARLINEOFF': return { tick, kind: 'barline', on: false };
    case 'JPOSSCROLL': {
      // a b c = 移動時間（秒）・移動距離（px）・向き（1 = 右、0 = 左）
      const [a, b, c] = arg.split(/[\s,]+/).map(Number);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
      return { tick, kind: 'jpos', time: Math.max(0, a), dist: Math.abs(b), dir: c === 0 ? 0 : 1 };
    }
    default: return null;
  }
}

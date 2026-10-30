import type { NoteType } from './types';
import { measureTicks, newCourse, parseScroll, SHARED_KINDS, sortCourse, TPB, type BranchPart, type EBranch, type EChart, type ECourse, type EEvent } from './model';

/**
 * TJA → 編集用モデル（tick ベース）
 * 対応: TITLE SUBTITLE BPM OFFSET WAVE DEMOSTART COURSE LEVEL BALLOON（他のヘッダは保持）
 *       #START #END #BPMCHANGE #SCROLL #MEASURE #DELAY #GOGOSTART #GOGOEND #BARLINEON #BARLINEOFF
 *       #HBSCROLL #BMSCROLL（#START の直前） #JPOSSCROLL #LYRIC（#SCROLL は a+bi の複素数も）
 * 譜面分岐: #BRANCHSTART #N #E #M #BRANCHEND #SECTION #LEVELHOLD。分岐の中の #BPMCHANGE・#MEASURE・#DELAY は普通譜面のものを使う。
 * 2P 譜面 (#START P2) は無視。
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
  openLong: number | null; // notes のインデックス
}

type Key = 'N' | 'E' | 'M';

/** 読んでいる途中の分岐の区間 */
interface OpenBranch {
  b: EBranch;
  /** #BRANCHSTART の時の状態（それぞれの分岐はここから読む） */
  base: State;
  states: Partial<Record<Key, State>>;
  /** 最初に出てきた分岐（区間の長さはこれに合わせる） */
  first: Key | null;
  /** #BRANCHSTART の直前にあった命令（全部の分岐の頭に入れる） */
  pre: Item[];
}

/** 風船の打数の読み方: BALLOONNOR などがあれば分岐ごとの並び、無ければ BALLOON をテキストの順に */
interface Balloons {
  paths: boolean;
  list: Record<Key, number[]>;
  idx: Record<Key, number>;
}
function takeBalloon(bl: Balloons, key: Key | null): number {
  if (!bl.paths) return bl.list.N[bl.idx.N++] ?? 5;
  if (key) return bl.list[key][bl.idx[key]++] ?? 5;
  // 共通の所の風船は、どの分岐の並びでも 1 つ進む
  const v = bl.list.N[bl.idx.N] ?? 5;
  bl.idx.N++; bl.idx.E++; bl.idx.M++;
  return v;
}

export function parseTJA(text: string): EChart {
  const chart: EChart = {
    title: '', subtitle: '', wave: '', bpm: 120, offset: 0, demoStart: 0, extra: [], courses: [],
  };

  let header = { name: 'Oni', level: 0, balloons: [] as number[], extra: [] as [string, string][], scrollMode: undefined as 'hb' | 'bm' | undefined };
  let inChart = false;
  /** #END の後ろ（次の難易度・#START までに書かれた音符は、終わった後に流れる飾り） */
  let tail = false;
  let tailTick = 0;
  let items: Item[] = [];
  let course: ECourse = newCourse();
  let st: State = newState();
  /** 音符・命令を入れる所（共通・普通譜面は course、玄人・達人は区間の e・m） */
  let target: BranchPart = course;
  let sec: OpenBranch | null = null;
  let key: Key | null = null;
  let bl: Balloons = { paths: false, list: { N: [], E: [], M: [] }, idx: { N: 0, E: 0, M: 0 } };

  const flushMeasure = () => {
    processMeasure(items, st, target, () => takeBalloon(bl, sec ? key ?? 'N' : null));
    items = [];
  };
  const cloneSt = (x: State): State => ({ ...x, openLong: null });
  /** 区間を閉じる（close = #BRANCHEND） */
  const closeBranch = (close: boolean) => {
    const o = sec;
    if (!o) return;
    if (items.some((i) => i.kind === 'note')) flushMeasure();
    if (key) {
      for (const it of items) if (it.kind === 'cmd' && it.name !== 'MEASURE') { const ev = toEvent(it.name, it.arg, st.tick); if (ev) target.events.push(ev); }
      items = [];
      o.states[key] = st;
    }
    const lead = o.states.N ? 'N' : o.first ?? 'N';
    st = cloneSt(o.states[lead] ?? o.base);
    const b = o.b;
    b.end = st.tick;
    b.close = close;
    for (const p of [b.e, b.m]) {
      p.events = p.events.filter((e) => !SHARED_KINDS.has(e.kind) && e.tick < b.end);
      p.notes = p.notes.filter((n) => n.tick < b.end);
    }
    (course.branches ??= []).push(b);
    sec = null;
    key = null;
    target = course;
  };

  /** #END の後ろを読み終えた: 音符があれば #END の位置を覚えて、難易度を閉じる */
  const closeTail = () => {
    if (!tail) return;
    tail = false;
    inChart = false;
    if (items.length) flushMeasure();
    if (course.notes.some((n) => n.tick >= tailTick)) course.endTick = tailTick;
    else {
      course.events = course.events.filter((e) => e.tick < tailTick);
    }
    sortCourse(course);
    chart.courses.push(course);
  };

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    // #END の後ろ: 見出しの行（COURSE: など）か #START まで
    if (tail && ((!line.startsWith('#') && line.includes(':')) || /^#START\b/i.test(line))) closeTail();

    if (line.startsWith('#')) {
      const m = line.match(/^#([A-Z0-9]+)\s*(.*)$/i);
      if (!m) continue;
      const name = m[1].toUpperCase();
      const arg = m[2].trim();

      if (name === 'START') {
        if (/P2/i.test(arg)) { inChart = false; continue; }
        inChart = true;
        items = [];
        st = newState();
        const paths = header.extra.some(([k]) => /^BALLOON(NOR|EXP|MAS)$/.test(k));
        const val = (k: string) => header.extra.find(([x]) => x === k)?.[1];
        const nums = (v: string | undefined) => (v ?? '').split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
        bl = {
          paths,
          list: paths
            ? { N: val('BALLOONNOR') !== undefined ? nums(val('BALLOONNOR')) : header.balloons, E: val('BALLOONEXP') !== undefined ? nums(val('BALLOONEXP')) : header.balloons, M: val('BALLOONMAS') !== undefined ? nums(val('BALLOONMAS')) : header.balloons }
            : { N: header.balloons, E: header.balloons, M: header.balloons },
          idx: { N: 0, E: 0, M: 0 },
        };
        course = { ...newCourse(header.name, header.level), extra: header.extra.filter(([k]) => !paths || !/^BALLOON(NOR|EXP|MAS)$/.test(k)) };
        if (paths) course.balloonPaths = true;
        target = course;
        sec = null;
        key = null;
        if (header.scrollMode) course.scrollMode = header.scrollMode;
        // 次の #START には持ち越さない（難易度ごとに書く）
        header.scrollMode = undefined;
        continue;
      }
      if (name === 'END') {
        if (!inChart) continue;
        if (tail) { closeTail(); continue; }
        if (items.length) flushMeasure();
        closeBranch(false);
        // この後ろに音符があれば、同じ譜面の続き（終わった後に流れる飾り）として読む
        tail = true;
        tailTick = st.tick;
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

      if (name === 'BRANCHSTART') {
        closeBranch(false);
        // 直前の命令（音符の無い所）は、全部の分岐の頭に入れる
        const pre = items.every((i) => i.kind === 'cmd') ? items : [];
        if (pre.length) items = [];
        const [t, x, y] = arg.split(',').map((v) => v.trim());
        const type = (t ?? '').toLowerCase();
        sec = {
          b: {
            start: st.tick, end: Infinity, type: type === 'r' || type === 's' ? type : 'p',
            x: Number.isFinite(Number(x)) ? Number(x) : 0, y: Number.isFinite(Number(y)) ? Number(y) : 0,
            close: false, e: { notes: [], events: [] }, m: { notes: [], events: [] },
          },
          base: cloneSt(st), states: {}, first: null, pre,
        };
        key = null;
        continue;
      }
      if (name === 'BRANCHEND') { closeBranch(true); continue; }
      if (name === 'N' || name === 'E' || name === 'M') {
        if (!sec) continue;
        if (items.some((i) => i.kind === 'note')) flushMeasure();
        if (key) {
          // 前の分岐の終わりに残った命令は、その分岐の所に置く
          for (const it of items) if (it.kind === 'cmd' && it.name !== 'MEASURE') { const ev = toEvent(it.name, it.arg, st.tick); if (ev) target.events.push(ev); }
          sec.states[key] = st;
        } else sec.pre.push(...items);
        key = name;
        sec.first ??= name;
        st = sec.states[name] ?? cloneSt(sec.base);
        target = name === 'N' ? course : name === 'E' ? sec.b.e : sec.b.m;
        items = [...sec.pre];
        continue;
      }

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

    // 区間の中で、#N・#E・#M より前の音符は普通譜面
    if (sec && !key) {
      key = 'N';
      sec.first ??= 'N';
      st = cloneSt(sec.base);
      target = course;
      items = [...sec.pre, ...items];
    }
    for (const ch of line) {
      if (ch === ',') flushMeasure();
      else if (NOTE_CHARS.test(ch)) items.push({ kind: 'note', ch });
    }
  }

  chart.source = text;

  closeTail();
  // #END が無いファイルへの保険
  if (inChart) {
    if (items.length) flushMeasure();
    closeBranch(false);
    sortCourse(course);
    chart.courses.push(course);
  }
  return chart;
}

function newState(): State {
  return { tick: 0, measureTicks: TPB * 4, pendingMeasure: null, openLong: null };
}

function processMeasure(items: Item[], st: State, course: BranchPart, balloon: () => number) {
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
      if (type === 'balloon') course.notes.push({ tick, type, hits: balloon() });
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
    case 'SCROLL': {
      const s = parseScroll(arg);
      return s ? { tick, kind: 'scroll', value: s.value, ...(s.im ? { im: s.im } : {}) } : null;
    }
    case 'LYRIC': return { tick, kind: 'lyric', text: arg.slice(0, 500) };
    case 'SECTION': return { tick, kind: 'section' };
    case 'LEVELHOLD': return { tick, kind: 'levelhold' };
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

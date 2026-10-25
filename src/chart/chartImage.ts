/**
 * 譜面画像（譜面全体を 1 枚に並べた画像）。
 * 上に曲名・サブタイトル・難易度、その下に 4/4 の小節を 1 行に 4 つずつ並べる（小節の幅は拍の数に比例）。
 * ゴーゴータイムはレーンの上の桃色の帯、#SCROLL は赤（HS）、#BPMCHANGE は青（BPM）の文字で書く。
 */
import { measures, contentEnd, sortCourse, Timing, TPB, type EChart, type ECourse } from './model';
import { BIG_SCALE, COLOR, drawBalloon, drawNoteHead, isBig } from '../render/notes';
import type { NoteType } from './types';

const COURSE_JA: Record<string, string> = { Easy: 'かんたん', Normal: 'ふつう', Hard: 'むずかしい', Oni: 'おに', Edit: 'おに（裏）' };

/** 画像の寸法（基準の px） */
const PAD_X = 24;
const BEAT_W = 48;
const ROW_W = BEAT_W * 16; // 4/4 の小節 4 つ
const HEAD_H = 92;
const ROW_H = 74;
const LANE_Y = 34; // 行の中のレーンの上端（上に HS・BPM の文字と小節の番号）
const LANE_H = 32;
const NOTE_R = 11;
const FONT = "system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif";

interface Row {
  /** この行の小節（x は行の中の左端） */
  bars: { index: number; start: number; length: number; x: number; w: number }[];
  start: number;
  end: number;
}

/** 小節を行に並べる（行の幅を超えたら次の行へ） */
function layoutRows(course: ECourse): Row[] {
  const end = contentEnd(course);
  const ms = measures(course, end).filter((m) => m.start <= end);
  const rows: Row[] = [];
  let cur: Row | null = null;
  let x = 0;
  for (const m of ms) {
    if (m.start >= end && m.start > 0 && course.notes.every((n) => (n.endTick ?? n.tick) < m.start)) break;
    const w = (m.length / TPB) * BEAT_W;
    if (!cur || (x + w > ROW_W + 0.5 && cur.bars.length)) {
      cur = { bars: [], start: m.start, end: m.start };
      rows.push(cur);
      x = 0;
    }
    cur.bars.push({ index: m.index, start: m.start, length: m.length, x, w });
    cur.end = m.start + m.length;
    x += w;
  }
  if (!rows.length) rows.push({ bars: [{ index: 0, start: 0, length: TPB * 4, x: 0, w: ROW_W }], start: 0, end: TPB * 4 });
  return rows;
}

/** 譜面画像を描いた canvas（scale は画像の倍率。大きすぎる譜面は自動で下げる） */
export function drawChartImage(chart: EChart, course: ECourse, scale = 2): HTMLCanvasElement {
  sortCourse(course);
  const rows = layoutRows(course);
  const rowWidth = Math.max(ROW_W, ...rows.map((r) => r.bars.reduce((w, b) => w + b.w, 0)));
  const W = PAD_X * 2 + rowWidth;
  const H = HEAD_H + rows.length * ROW_H + 24;
  // iPhone の canvas の上限（約 1600 万ピクセル）を超えないように
  const k = Math.max(0.5, Math.min(scale, Math.sqrt(15_000_000 / (W * H))));
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * k);
  cv.height = Math.round(H * k);
  const c = cv.getContext('2d')!;
  c.scale(k, k);

  // 背景と見出し
  c.fillStyle = '#cfcfcf';
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#111';
  c.textBaseline = 'alphabetic';
  c.font = `800 22px ${FONT}`;
  c.fillText(chart.title || '（無題）', 12, 30);
  c.font = `700 15px ${FONT}`;
  c.fillText(chart.subtitle.replace(/^--/, ''), 12, 52);
  const stars = '★'.repeat(Math.max(0, Math.min(10, course.level)));
  c.font = `800 17px ${FONT}`;
  c.fillText(`${COURSE_JA[course.name] ?? course.name} ${stars} Lv.${course.level}`, 12, 78);

  const t = new Timing(chart, course);
  const rowOf = (tick: number) => {
    for (let i = rows.length - 1; i >= 0; i--) if (tick >= rows[i].start) return i;
    return 0;
  };
  /** tick の位置（行の番号と、画像の中の x） */
  const pos = (tick: number) => {
    const ri = rowOf(tick);
    const r = rows[ri];
    let b = r.bars[0];
    for (const bb of r.bars) if (tick >= bb.start) b = bb;
    return { ri, x: PAD_X + b.x + ((tick - b.start) / TPB) * BEAT_W };
  };
  const rowTop = (ri: number) => HEAD_H + ri * ROW_H;

  // ゴーゴータイム（レーンの上の桃色の帯）
  const gogo: [number, number][] = [];
  let gs: number | null = null;
  for (const e of course.events) {
    if (e.kind !== 'gogo') continue;
    if (e.on && gs === null) gs = e.tick;
    else if (!e.on && gs !== null) { gogo.push([gs, e.tick]); gs = null; }
  }
  if (gs !== null) gogo.push([gs, rows[rows.length - 1].end]);
  c.fillStyle = '#f5b8c0';
  for (const [a, b] of gogo) spanRows(a, b, (ri, x1, x2) => c.fillRect(x1, rowTop(ri) + 4, x2 - x1, LANE_Y - 4));

  /** tick a〜b を行ごとに分けて f(行, x1, x2) */
  function spanRows(a: number, b: number, f: (ri: number, x1: number, x2: number) => void) {
    const p = pos(a);
    const q = pos(b);
    for (let ri = p.ri; ri <= q.ri; ri++) {
      const r = rows[ri];
      const rowEnd = PAD_X + r.bars.reduce((w, bb) => w + bb.w, 0);
      const x1 = ri === p.ri ? p.x : PAD_X;
      const x2 = ri === q.ri ? q.x : rowEnd;
      if (x2 > x1) f(ri, x1, x2);
    }
  }

  // レーン・小節線・拍の線・小節の番号
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const y = rowTop(ri) + LANE_Y;
    const rowEnd = PAD_X + r.bars.reduce((w, b) => w + b.w, 0);
    c.fillStyle = '#7a7a7a';
    c.fillRect(0, y, rowEnd + PAD_X / 2, LANE_H);
    c.fillStyle = '#6a6a6a';
    c.fillRect(0, y + 6, rowEnd + PAD_X / 2, LANE_H - 12);
    c.fillStyle = '#fff';
    c.fillRect(0, y - 2, rowEnd + PAD_X / 2, 2);
    c.fillRect(0, y + LANE_H, rowEnd + PAD_X / 2, 2);
    for (const b of r.bars) {
      const x0 = PAD_X + b.x;
      c.fillStyle = 'rgba(255,255,255,0.22)';
      for (let k2 = TPB; k2 < b.length; k2 += TPB) c.fillRect(x0 + (k2 / TPB) * BEAT_W - 0.5, y, 1, LANE_H);
      if (t.barlineAt(b.start)) {
        c.fillStyle = '#fff';
        c.fillRect(x0 - 1, y - 6, 2, LANE_H + 6);
      }
      c.fillStyle = '#111';
      c.font = `700 9px ${FONT}`;
      c.fillText(String(b.index + 1), x0 + 2, y - 8);
    }
  }

  // #SCROLL（赤）と #BPMCHANGE（青）の文字。最初の BPM と、1 でない最初の SCROLL も書く
  const labels = new Map<number, string[]>();
  const add = (tick: number, s: string) => { const l = labels.get(tick) ?? []; l.push(s); labels.set(tick, l); };
  add(0, `BPM${num(chart.bpm)}`);
  for (const e of course.events) {
    if (e.kind === 'scroll') add(e.tick, `HS${num(e.value)}`);
    else if (e.kind === 'bpm' && e.tick > 0) add(e.tick, `BPM${num(e.value)}`);
    else if (e.kind === 'bpm' && e.tick === 0 && e.value !== chart.bpm) labels.set(0, [`BPM${num(e.value)}`]);
  }
  c.font = `700 8px ${FONT}`;
  for (const [tick, ls] of labels) {
    const p = pos(tick);
    // 小節の番号より上に、下から積む
    const base = rowTop(p.ri) + LANE_Y - 15;
    ls.forEach((s, i) => {
      c.fillStyle = s.startsWith('HS') ? '#d01e1e' : '#1d3fd0';
      c.fillText(s, p.x + 2, base - (ls.length - 1 - i) * 8);
    });
    if (tick > 0) {
      c.fillStyle = 'rgba(30,30,30,0.7)';
      c.fillRect(p.x - 0.5, base - ls.length * 8, 1, LANE_Y - base + rowTop(p.ri) + ls.length * 8 + LANE_H);
    }
  }

  // 音符（後ろから描いて、前の音符が上に来るように）
  const cy = (ri: number) => rowTop(ri) + LANE_Y + LANE_H / 2;
  const notes = [...course.notes].sort((a, b) => b.tick - a.tick);
  for (const n of notes) {
    const big = isBig(n.type as NoteType);
    const r = big ? NOTE_R * BIG_SCALE * 0.9 : NOTE_R;
    if (n.type === 'roll' || n.type === 'bigRoll' || n.type === 'balloon') {
      const endTick = n.endTick ?? n.tick;
      if (n.type !== 'balloon') spanRows(n.tick, endTick, (ri, x1, x2) => rollBar(c, x1, x2, cy(ri), r, COLOR.roll));
      const p = pos(n.tick);
      if (n.type === 'balloon') {
        const q = pos(endTick);
        drawBalloon(c, p.x, cy(p.ri), r, n.hits ?? 5, q.ri === p.ri ? q.x : undefined);
      } else drawNoteHead(c, p.x, cy(p.ri), r, n.type as NoteType);
      continue;
    }
    const p = pos(n.tick);
    drawNoteHead(c, p.x, cy(p.ri), r, n.type as NoteType);
  }

  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.font = `700 10px ${FONT}`;
  c.textAlign = 'right';
  c.fillText('TJAtelier', W - 8, H - 8);
  return cv;
}

/** 連打の帯（頭なし。行をまたぐ所はここだけ描く） */
function rollBar(c: CanvasRenderingContext2D, x1: number, x2: number, y: number, r: number, body: string) {
  const bar = (rr: number, fill: string) => {
    c.beginPath();
    c.moveTo(x1, y - rr);
    c.lineTo(x2, y - rr);
    c.arc(x2, y, rr, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x1, y + rr);
    c.closePath();
    c.fillStyle = fill;
    c.fill();
  };
  bar(r, COLOR.outline);
  bar(r * 0.9, COLOR.ring);
  bar(r * 0.73, body);
}

const num = (v: number) => String(Number(v.toFixed(3)));

/**
 * 譜面画像（譜面全体を 1 枚に並べた画像）。
 * 上に曲名・サブタイトル・難易度、その下に 4/4 の小節を 1 行に 4 つずつ並べる（小節の幅は拍の数に比例）。
 * ゴーゴータイムはレーンの上の桃色の帯、#SCROLL は赤（HS）、#BPMCHANGE は青（BPM）の文字で書く。
 */
import { measures, contentEnd, sortCourse, Timing, TPB, type EChart, type ECourse } from './model';
import { COLOR, drawBalloon, drawNoteHead, isBig } from '../render/notes';
import type { NoteType } from './types';

const COURSE_JA: Record<string, string> = { Easy: 'かんたん', Normal: 'ふつう', Hard: 'むずかしい', Oni: 'おに', Edit: 'おに（裏）' };

/** 画像の寸法（基準の px） */
const PAD_X = 24;
const BEAT_W = 72;
const ROW_W = BEAT_W * 16; // 4/4 の小節 4 つ
const HEAD_H = 92;
const ROW_H = 84;
const LANE_Y = 44; // 行の中のレーンの上端（上に HS・BPM の文字と小節の番号）
const LANE_H = 32;
/** 音符の半径: プレイ画面のハイスピード 1 と同じ「1 拍の幅に対する大きさ」（半径 54 ÷ 1 拍 367.5） */
const NOTE_R = (BEAT_W * 54) / 367.5;
/** 大音符の半径（プレイ画面と同じ 83 ÷ 54 倍） */
const BIG_R = (NOTE_R * 83) / 54;
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
  // 次の行へまたぐときは、その行の右端まで・次の行の左端から塗る
  for (const [a, b] of gogo) spanRows(a, b, (ri, x1, x2) => c.fillRect(x1, rowTop(ri) + 4, x2 - x1, LANE_Y - 4), true);

  /** tick a〜b を行ごとに分けて f(行, x1, x2) */
  function spanRows(a: number, b: number, f: (ri: number, x1: number, x2: number) => void, edges = false) {
    const p = pos(a);
    const q = pos(b);
    for (let ri = p.ri; ri <= q.ri; ri++) {
      const r = rows[ri];
      const rowEnd = PAD_X + r.bars.reduce((w, bb) => w + bb.w, 0);
      // edges: 行をまたぐ所はレーンの端（左は 0、右はレーンの終わり）まで
      const x1 = ri === p.ri ? p.x : edges ? 0 : PAD_X;
      const x2 = ri === q.ri ? q.x : edges ? rowEnd + PAD_X / 2 : rowEnd;
      if (x2 > x1) f(ri, x1, x2);
    }
  }

  // レーン・グリッド・小節線・小節の番号
  // グリッドは 8 分音符ごと（小節の頭から）。上の黒い縁はグリッドの所だけ切れ目を入れる
  const GRID = TPB / 2;
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    const y = rowTop(ri) + LANE_Y;
    const rowEnd = PAD_X + r.bars.reduce((w, b) => w + b.w, 0);
    const laneEnd = rowEnd + PAD_X / 2;
    c.fillStyle = '#7f7f7f';
    c.fillRect(0, y, laneEnd, LANE_H);
    c.fillStyle = '#111';
    c.fillRect(0, y - 6, laneEnd, 3);
    c.fillStyle = '#fff';
    c.fillRect(0, y - 3, laneEnd, 2);
    c.fillRect(0, y + LANE_H, laneEnd, 2);
    for (const b of r.bars) {
      const x0 = PAD_X + b.x;
      for (let k2 = GRID; k2 < b.length - 1; k2 += GRID) {
        const gx = x0 + (k2 / TPB) * BEAT_W;
        c.fillStyle = '#9c9c9c';
        c.fillRect(gx - 1, y, 2, LANE_H);
        // 上の黒い縁の切れ目
        c.fillStyle = '#cfcfcf';
        c.fillRect(gx - 1, y - 6, 2, 3);
      }
    }
    // 小節線（番号の上から、レーンの下まで）と、行の終わりの線
    for (const b of r.bars) {
      const x0 = PAD_X + b.x;
      if (t.barlineAt(b.start)) {
        c.fillStyle = '#fff';
        c.fillRect(x0 - 1, rowTop(ri) + 8, 2, LANE_Y - 8 + LANE_H);
      }
      pixText(c, String(b.index + 1), x0 + 3, y - 9, 1.8, '#111');
    }
    c.fillStyle = '#fff';
    c.fillRect(rowEnd - 1, rowTop(ri) + 8, 2, LANE_Y - 8 + LANE_H);
  }

  // #SCROLL（赤）と #BPMCHANGE（青）の数字。最初の BPM も書く
  const labels = new Map<number, { hs: boolean; text: string }[]>();
  const add = (tick: number, hs: boolean, v: number) => {
    const l = (labels.get(tick) ?? []).filter((x) => x.hs !== hs);
    l.push({ hs, text: num(v) });
    labels.set(tick, l);
  };
  add(0, false, chart.bpm);
  for (const e of course.events) {
    if (e.kind === 'scroll') add(e.tick, true, e.value);
    else if (e.kind === 'bpm') add(e.tick, false, e.value);
  }
  const LINE = 11;
  for (const [tick, ls] of labels) {
    const p = pos(tick);
    // 小節の番号より上に、下から積む（BPM の上に HS）
    ls.sort((x, y) => Number(x.hs) - Number(y.hs));
    const base = rowTop(p.ri) + LANE_Y - 22;
    ls.forEach((l, i) => pixText(c, l.text, p.x + 3, base - i * LINE, 1.6, l.hs ? '#d01e1e' : '#1d3fd0'));
    if (tick > 0) {
      c.fillStyle = 'rgba(30,30,30,0.7)';
      const top = base - ls.length * LINE;
      c.fillRect(p.x - 0.5, top, 1, rowTop(p.ri) + LANE_Y + LANE_H - top);
    }
  }

  // 音符（後ろから描いて、前の音符が上に来るように）
  const cy = (ri: number) => rowTop(ri) + LANE_Y + LANE_H / 2;
  const notes = [...course.notes].sort((a, b) => b.tick - a.tick);
  for (const n of notes) {
    const big = isBig(n.type as NoteType);
    const r = big ? BIG_R : NOTE_R;
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

/** ドット風の数字（3×5 の点）。0〜9 と . - / */
const GLYPH: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '.': ['0', '0', '0', '0', '1'],
  '-': ['000', '000', '111', '000', '000'],
  '/': ['001', '001', '010', '100', '100'],
};

/** ドット風の数字を書く（x = 左、y = 下の線、px = 1 つの点の大きさ） */
function pixText(c: CanvasRenderingContext2D, text: string, x: number, y: number, px: number, color: string) {
  c.fillStyle = color;
  let cx = x;
  const top = y - 5 * px;
  for (const ch of text) {
    const g = GLYPH[ch];
    if (!g) { cx += 2 * px; continue; }
    g.forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) if (row[rx] === '1') c.fillRect(cx + rx * px, top + ry * px, px, px);
    });
    cx += (g[0].length + 1) * px;
  }
}

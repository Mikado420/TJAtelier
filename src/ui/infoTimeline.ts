/**
 * 譜面情報の「譜面の流れ」: 上に横のレーン（音符を時刻の位置に並べた譜面）、下に密度の推移。
 * 横の位置（時刻）は上下で同じ。横に拡大・縮小（ボタン・2 本指・ホイール）、横にスクロールできる。
 */
import type { Course } from '../chart/types';
import { pixelRatio, uiScale } from '../orient';
import { BIG_SCALE, COLOR, drawBalloon, drawNoteHead, isBig } from '../render/notes';

export interface TimelineData {
  course: Course;
  /** 小節ごとの密度（時刻は曲の再生位置） */
  curve: { t0: number; t1: number; v: number }[];
  /** 平均密度 */
  density: number;
  /** 最初の音符の時刻 */
  firstTime: number;
  lastTime: number;
}

const LANE_H = 54;
const GRAPH_H = 120;
const AXIS_H = 18;
const H = LANE_H + GRAPH_H + AXIS_H;
const MAX_ZOOM = 60;
/** レーンの音符の半径（px） */
const NOTE_R = 9;

export function mountTimeline(root: HTMLElement, d: TimelineData) {
  root.innerHTML = `
    <div class="tl-tools">
      <span class="tl-hint"></span>
      <button data-tl="out" aria-label="縮小"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
      <button data-tl="reset" aria-label="全体を表示"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/></svg><b class="tl-zoom">100%</b></button>
      <button data-tl="in" aria-label="拡大"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
    <div class="tl-scroll"><div class="tl-inner"><canvas class="tl-canvas"></canvas></div></div>`;
  const scroller = root.querySelector<HTMLElement>('.tl-scroll')!;
  const inner = root.querySelector<HTMLElement>('.tl-inner')!;
  const cv = root.querySelector<HTMLCanvasElement>('.tl-canvas')!;
  const zoomLabel = root.querySelector<HTMLElement>('.tl-zoom')!;
  const t0 = d.firstTime - 0.6;
  const t1 = d.lastTime + 0.6;
  const dur = Math.max(1, t1 - t0);
  let zoom = 1;
  let viewW = 0;
  /** 1 秒の幅（px） */
  const pps = () => (viewW / dur) * zoom;
  const peak = d.curve.reduce((m, p) => (p.v > m.v ? p : m), d.curve[0] ?? { t0: 0, t1: 0, v: 0 });
  const top = Math.max(1, Math.ceil(peak.v));

  const layout = () => {
    viewW = Math.max(1, scroller.clientWidth);
    inner.style.width = `${Math.round(viewW * zoom)}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    draw();
  };

  const draw = () => {
    const dpr = Math.min(3, pixelRatio());
    const w = viewW;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(H * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${H}px`;
    }
    const c = cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, H);
    const sx = scroller.scrollLeft;
    const p = pps();
    const xOf = (time: number) => (time - t0) * p - sx;
    const vis0 = t0 + sx / p - 0.5;
    const vis1 = t0 + (sx + w) / p + 0.5;

    // レーン
    c.fillStyle = '#26292d';
    c.fillRect(0, 0, w, LANE_H);
    c.fillStyle = '#31353a';
    c.fillRect(0, 8, w, LANE_H - 16);
    // ゴーゴー
    c.fillStyle = 'rgba(255,120,60,0.22)';
    for (const [a, b] of d.course.gogo) {
      if (b < vis0 || a > vis1) continue;
      c.fillRect(xOf(a), 0, xOf(Math.min(b, t1)) - xOf(a), LANE_H);
    }
    // 小節線
    c.fillStyle = 'rgba(255,255,255,0.55)';
    for (const b of d.course.bars) {
      if (b.time < vis0 || b.time > vis1) continue;
      c.fillRect(Math.round(xOf(b.time)) - 0.5, 0, 1, LANE_H + GRAPH_H);
    }
    // 音符（後ろから）
    const cy = LANE_H / 2;
    // 音符の大きさは拡大率に関係なく同じ（拡大・縮小で変わるのは間隔だけ）
    const r = NOTE_R;
    const notes = d.course.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      const end = n.endTime ?? n.time;
      if (end < vis0 || n.time > vis1) continue;
      const rr = isBig(n.type) ? r * BIG_SCALE * 0.9 : r;
      const x = xOf(n.time);
      if (n.type === 'roll' || n.type === 'bigRoll') {
        const x2 = xOf(end);
        c.fillStyle = COLOR.outline;
        roundBar(c, x, x2, cy, rr);
        c.fillStyle = COLOR.roll;
        roundBar(c, x, x2, cy, rr * 0.75);
        drawNoteHead(c, x, cy, rr, n.type);
      } else if (n.type === 'balloon') drawBalloon(c, x, cy, rr, n.hits ?? 5, xOf(end));
      else drawNoteHead(c, x, cy, rr, n.type);
    }

    // 密度の推移
    const gy = LANE_H;
    c.fillStyle = '#1d2023';
    c.fillRect(0, gy, w, GRAPH_H);
    const yOf = (v: number) => gy + GRAPH_H - (v / top) * (GRAPH_H - 10);
    // 目盛り（打/秒）
    c.font = '600 10px system-ui, sans-serif';
    c.textBaseline = 'middle';
    const stepV = top > 16 ? 5 : top > 8 ? 2 : 1;
    for (let v = stepV; v < top; v += stepV) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(0, Math.round(yOf(v)), w, 1);
    }
    if (d.curve.length) {
      // 小節ごとの点（小節の真ん中）を、行き過ぎない滑らかな線（単調な 3 次曲線）でつなぐ
      let a0 = 0;
      while (a0 < d.curve.length - 1 && d.curve[a0 + 1].t1 < vis0) a0++;
      let a1 = d.curve.length - 1;
      while (a1 > a0 && d.curve[a1 - 1].t0 > vis1) a1--;
      const pts = d.curve.slice(Math.max(0, a0 - 1), a1 + 2).map((q) => ({ x: xOf((q.t0 + q.t1) / 2), y: yOf(q.v) }));
      const first = d.curve[0];
      const last = d.curve[d.curve.length - 1];
      if (a0 === 0) pts.unshift({ x: xOf(first.t0), y: yOf(first.v) });
      if (a1 === d.curve.length - 1) pts.push({ x: xOf(last.t1), y: yOf(last.v) });
      const path = new Path2D();
      smoothPath(path, pts);
      const area = new Path2D();
      area.moveTo(pts[0].x, gy + GRAPH_H);
      area.lineTo(pts[0].x, pts[0].y);
      smoothPath(area, pts, true);
      area.lineTo(pts[pts.length - 1].x, gy + GRAPH_H);
      area.closePath();
      c.fillStyle = 'rgba(77,159,190,0.28)';
      c.fill(area);
      c.strokeStyle = '#93cde2';
      c.lineWidth = 2;
      c.lineJoin = 'round';
      c.stroke(path);
      // いちばん高い小節
      const px = xOf((peak.t0 + peak.t1) / 2);
      c.fillStyle = '#ffd21f';
      c.beginPath();
      c.arc(px, yOf(peak.v), 3.5, 0, Math.PI * 2);
      c.fill();
      c.textAlign = px > w - 90 ? 'right' : px < 60 ? 'left' : 'center';
      c.fillText(`最大 ${peak.v.toFixed(2)}`, px, Math.max(gy + 8, yOf(peak.v) - 9));
    }
    // 平均（点線）
    c.setLineDash([5, 4]);
    c.strokeStyle = 'rgba(255,255,255,0.6)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, Math.round(yOf(d.density)) + 0.5);
    c.lineTo(w, Math.round(yOf(d.density)) + 0.5);
    c.stroke();
    c.setLineDash([]);
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.textAlign = 'right';
    c.fillText(`平均 ${d.density.toFixed(2)}`, w - 6, yOf(d.density) - 8);
    c.textAlign = 'left';
    c.fillStyle = 'rgba(255,255,255,0.45)';
    c.fillText(`${top} 打/秒`, 4, gy + 8);

    // 時刻の目盛り
    const ay = LANE_H + GRAPH_H;
    c.fillStyle = 'rgba(255,255,255,0.6)';
    const steps = [1, 2, 5, 10, 15, 30, 60];
    const st = steps.find((s) => s * p >= 56) ?? 120;
    c.textAlign = 'center';
    for (let s = Math.ceil(Math.max(0, vis0) / st) * st; s <= vis1; s += st) {
      const x = xOf(s);
      c.fillRect(Math.round(x) - 0.5, ay, 1, 4);
      c.fillText(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`, x, ay + 11);
    }
  };

  /** 拡大率を変える（cx = 画面の中で動かさない位置。省略すると真ん中） */
  const setZoom = (z: number, cx = viewW / 2) => {
    const nz = Math.max(1, Math.min(MAX_ZOOM, z));
    const time = (scroller.scrollLeft + cx) / pps() + t0;
    zoom = nz;
    layout();
    scroller.scrollLeft = (time - t0) * pps() - cx;
    draw();
  };

  root.querySelector('[data-tl="in"]')!.addEventListener('click', () => setZoom(zoom * 1.6));
  root.querySelector('[data-tl="out"]')!.addEventListener('click', () => setZoom(zoom / 1.6));
  root.querySelector('[data-tl="reset"]')!.addEventListener('click', () => setZoom(1));
  scroller.addEventListener('scroll', draw, { passive: true });
  // トラックパッドのピンチ・Ctrl ＋ ホイール
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const r = scroller.getBoundingClientRect();
    setZoom(zoom * Math.exp(-e.deltaY * 0.01), (e.clientX - r.left) / uiScale());
  }, { passive: false });
  // 2 本指で拡大・縮小（1 本指はふつうの横スクロール）
  let pinch: { d: number; z: number; cx: number } | null = null;
  const dist = (e: TouchEvent) => Math.abs(e.touches[0].clientX - e.touches[1].clientX) + 1;
  scroller.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const r = scroller.getBoundingClientRect();
      pinch = { d: dist(e), z: zoom, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left };
    }
  }, { passive: true });
  scroller.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    setZoom(pinch.z * (dist(e) / pinch.d), pinch.cx);
  }, { passive: false });
  scroller.addEventListener('touchend', (e) => { if (e.touches.length < 2) pinch = null; });

  const ro = new ResizeObserver(() => layout());
  ro.observe(scroller);
  layout();
  return () => ro.disconnect();
}

function roundBar(c: CanvasRenderingContext2D, x1: number, x2: number, y: number, r: number) {
  c.beginPath();
  c.arc(x1, y, r, Math.PI / 2, (Math.PI * 3) / 2);
  c.lineTo(x2, y - r);
  c.arc(x2, y, r, -Math.PI / 2, Math.PI / 2);
  c.closePath();
  c.fill();
}

/**
 * 点を滑らかにつなぐ線（単調な 3 次エルミート曲線。山と谷で行き過ぎない）。
 * cont = true なら、今の位置から続けて描く（最初の点へ moveTo しない）
 */
function smoothPath(p: Path2D, pts: { x: number; y: number }[], cont = false) {
  const n = pts.length;
  if (!n) return;
  if (!cont) p.moveTo(pts[0].x, pts[0].y);
  if (n < 3) { for (let i = 1; i < n; i++) p.lineTo(pts[i].x, pts[i].y); return; }
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1].x - pts[i].x || 1e-6);
    m.push((pts[i + 1].y - pts[i].y) / (dx[i] || 1e-6));
  }
  const tan: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) tan.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  tan.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    p.bezierCurveTo(pts[i].x + h, pts[i].y + tan[i] * h, pts[i + 1].x - h, pts[i + 1].y - tan[i + 1] * h, pts[i + 1].x, pts[i + 1].y);
  }
}

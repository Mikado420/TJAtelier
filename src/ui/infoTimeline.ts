/**
 * 譜面情報の「譜面の流れ」: いちばん上に全体の小さな図（白い枠が今見ている所。タップ・ドラッグで動かす）、
 * その下に横のレーン（音符を時刻の位置に並べた譜面）と 1 秒ごとの密度の棒（ドンとカッを積む）。
 * 横の位置（時刻）は上下で同じ。最初は音符が詰まらない広さで出し、横にスクロールして見る。拡大・縮小もできる。
 */
import type { Course } from '../chart/types';
import { pixelRatio, uiScale } from '../orient';
import { BIG_SCALE, COLOR, drawBalloon, drawNoteHead, isBig } from '../render/notes';

export interface TimelineData {
  course: Course;
  /** 1 秒ごとの密度（時刻は曲の再生位置）。don・ka はそのうちドン・カッの打/秒 */
  secs: { t0: number; t1: number; v: number; don: number; ka: number }[];
  /** 平均密度 */
  density: number;
  /** 最初の音符の時刻 */
  firstTime: number;
  lastTime: number;
}

/** レーンの高さ（低い置き場所では小さくする） */
let LANE_H = 54;
const AXIS_H = 18;
/** 高さは置き場所に合わせる（密度の棒の高さが変わる） */
let H = 192;
let GRAPH_H = H - LANE_H - AXIS_H;
const MAX_ZOOM = 60;
/** 最初に出すときの 1 秒の幅（px）。これより狭くなる（音符が詰まる）ときは広げて、横にスクロールする */
const START_PPS = 170;
/** 全体の小さな図の高さ */
const OV_H = 34;
/** レーンの音符の半径（px） */
const NOTE_R = 9;
const noteR = () => Math.min(NOTE_R, LANE_H / 6);

export function mountTimeline(root: HTMLElement, d: TimelineData) {
  root.innerHTML = `
    <div class="tl-tools">
      <span class="tl-lg"><i class="don"></i>ドン<i class="ka"></i>カッ</span>
      <button data-tl="out" aria-label="縮小"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>
      <button data-tl="reset" aria-label="全体を表示"><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/></svg><b class="tl-zoom">100%</b></button>
      <button data-tl="in" aria-label="拡大"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>
    </div>
    <canvas class="tl-ov"></canvas>
    <div class="tl-scroll"><div class="tl-inner"><canvas class="tl-canvas"></canvas></div></div>`;
  const ov = root.querySelector<HTMLCanvasElement>('.tl-ov')!;
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
  const top = Math.max(1, Math.ceil(d.secs.reduce((m, q) => Math.max(m, q.v), 0)));
  let started = false;

  const layout = () => {
    viewW = Math.max(1, scroller.clientWidth);
    // 最初だけ: 音符が詰まらない広さにする（画面に収まる曲はそのまま）
    if (!started && viewW > 1) {
      started = true;
      zoom = Math.max(1, Math.min(MAX_ZOOM, (START_PPS * dur) / viewW));
    }
    H = Math.max(80, scroller.clientHeight || 192);
    LANE_H = Math.round(Math.min(54, Math.max(30, H * 0.32)));
    GRAPH_H = H - LANE_H - AXIS_H;
    inner.style.width = `${Math.round(viewW * zoom)}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    draw();
  };

  /** 全体の小さな図（密度の棒と、今見ている所の白い枠） */
  const drawOverview = () => {
    const dpr = Math.min(3, pixelRatio());
    const w = Math.max(1, ov.clientWidth);
    if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(OV_H * dpr)) {
      ov.width = Math.round(w * dpr);
      ov.height = Math.round(OV_H * dpr);
    }
    const c = ov.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, OV_H);
    c.fillStyle = '#26292d';
    c.fillRect(0, 0, w, OV_H);
    const k = w / dur;
    for (const q of d.secs) {
      const x = (q.t0 - t0) * k;
      const bw = Math.max(1, (q.t1 - q.t0) * k - 1);
      const hd = (q.don / top) * (OV_H - 4);
      const hk = (q.ka / top) * (OV_H - 4);
      c.fillStyle = COLOR.don;
      c.fillRect(x, OV_H - hd, bw, hd);
      c.fillStyle = COLOR.ka;
      c.fillRect(x, OV_H - hd - hk, bw, hk);
    }
    const a = scroller.scrollLeft / (viewW * zoom);
    const b = Math.min(1, (scroller.scrollLeft + viewW) / (viewW * zoom));
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.fillRect(a * w, 0, (b - a) * w, OV_H);
    c.strokeStyle = '#fff';
    c.lineWidth = 2;
    c.strokeRect(a * w + 1, 1, Math.max(4, (b - a) * w - 2), OV_H - 2);
  };
  // 小さな図をタップ・ドラッグすると、その所を真ん中にする
  const ovJump = (e: PointerEvent) => {
    const r = ov.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    scroller.scrollLeft = f * viewW * zoom - viewW / 2;
  };
  ov.addEventListener('pointerdown', (e) => { ov.setPointerCapture(e.pointerId); ovJump(e); });
  ov.addEventListener('pointermove', (e) => { if (ov.hasPointerCapture(e.pointerId)) ovJump(e); });

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
    const r = noteR();
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
    c.font = '600 10px "Makinas 4 Flat", sans-serif';
    c.textBaseline = 'middle';
    const stepV = top > 16 ? 5 : top > 8 ? 2 : 1;
    for (let v = stepV; v < top; v += stepV) {
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(0, Math.round(yOf(v)), w, 1);
    }
    // 1 秒ごとの棒（下がドン・上にカッを積む）
    for (const q of d.secs) {
      if (q.t1 < vis0 || q.t0 > vis1) continue;
      const x0 = xOf(q.t0);
      const bw = (q.t1 - q.t0) * p;
      const pad = Math.min(3, bw * 0.12);
      const x = x0 + pad;
      const ww = Math.max(1, bw - pad * 2);
      const yd = yOf(q.don);
      const yk = yOf(q.don + q.ka);
      c.fillStyle = COLOR.don;
      c.fillRect(x, yd, ww, gy + GRAPH_H - yd);
      c.fillStyle = COLOR.ka;
      c.fillRect(x, yk, ww, yd - yk);
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
    for (let s = Math.ceil(Math.max(0, vis0) / st) * st; s <= vis1; s += st) {
      const x = xOf(s);
      if (x < 0 || x > w) continue;
      c.fillRect(Math.round(x) - 0.5, ay, 1, 4);
      // 端の文字は切れないように寄せる
      c.textAlign = x < 16 ? 'left' : x > w - 16 ? 'right' : 'center';
      c.fillText(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`, x, ay + 11);
    }
    drawOverview();
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

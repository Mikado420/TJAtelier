import type { NoteType } from '../chart/types';

/**
 * 太鼓風のノーツ描画（プレイ画面とエディタで共通）。
 * 公式素材は使わず、色・縁取りの比率だけを合わせたオリジナル描画。
 *   外側の黒縁 → 白い縁 → 本体（つやのない平らな色。参考動画の比率: 黒縁 10%・白縁 19%）
 */

export const COLOR = {
  don: '#e6352e',
  donLight: '#e6352e',
  ka: '#4ecbbe',
  kaLight: '#4ecbbe',
  roll: '#f7c11b',
  rollLight: '#f7c11b',
  balloon: '#e8731d',
  balloonLight: '#e8731d',
  outline: '#1a1617',
  ring: '#f8eee2',
};

export const isBig = (t: NoteType) => t === 'bigDon' || t === 'bigKa' || t === 'bigRoll';

/** 大音符は通常の 1.45 倍 */
export const BIG_SCALE = 1.45;

function colorsOf(t: NoteType): [string, string] {
  switch (t) {
    case 'don':
    case 'bigDon':
      return [COLOR.don, COLOR.donLight];
    case 'ka':
    case 'bigKa':
      return [COLOR.ka, COLOR.kaLight];
    case 'roll':
    case 'bigRoll':
      return [COLOR.roll, COLOR.rollLight];
    case 'balloon':
      return [COLOR.balloon, COLOR.balloonLight];
  }
}

/**
 * 音符の絵は、種類と大きさごとに一度だけ描いて（スプライト）、毎フレームはそれを貼るだけにする。
 * 1 フレームに数十個の音符それぞれでグラデーションを作ると、スマホでは描画が重くなり、
 * タッチの処理や打音が遅れる原因になる。
 */
const spriteCache = new Map<string, HTMLCanvasElement>();

/** r = 黒縁を含めた外径の半径 */
export function drawNoteHead(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: NoteType) {
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  // 端末ピクセルでの半径。少しずつ大きさが変わる音符（ゲージへ飛ぶ音符など）でも絵を作り直さないよう、
  // 大きさを 8 段階刻み（約 9%）にまとめ、少し大きめの絵を縮小して貼る
  const want = Math.max(1, r * scale);
  const pr = want <= 8 ? Math.ceil(want) : Math.ceil(Math.pow(1.09, Math.ceil(Math.log(want) / Math.log(1.09))));
  const key = `${type}:${pr}`;
  let sp = spriteCache.get(key);
  if (!sp) {
    if (spriteCache.size > 400) spriteCache.clear();
    sp = document.createElement('canvas');
    sp.width = sp.height = pr * 2 + 4;
    const c = sp.getContext('2d')!;
    drawNoteHeadRaw(c, pr + 2, pr + 2, pr, type);
    spriteCache.set(key, sp);
  }
  const half = ((pr + 2) / scale) * (want / pr);
  ctx.drawImage(sp, x - half, y - half, half * 2, half * 2);
}

function drawNoteHeadRaw(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, type: NoteType) {
  const [body] = colorsOf(type);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.outline;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
  ctx.fillStyle = COLOR.ring;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r * 0.73, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
}

/** 連打（頭は x1、尾は x2。横向き） */
export function drawRoll(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, r: number, type: NoteType) {
  const [body] = colorsOf(type);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const bar = (rr: number, fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.arc(left, y, rr, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.lineTo(right, y - rr);
    ctx.arc(right, y, rr, -Math.PI / 2, Math.PI / 2);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };
  bar(r, COLOR.outline);
  bar(r * 0.9, COLOR.ring);
  bar(r * 0.73, body);
  drawNoteHead(ctx, x1, y, r, type);
}

/** 風船（本体＋尻尾の糸）。left = 残り打数 */
export function drawBalloon(
  ctx: CanvasRenderingContext2D, x: number, y: number, r: number, left: number | null, tailX?: number,
) {
  // 終わりの位置（エディタ用）。細い線で示す
  const bulbEnd = x + r * 2.75;
  if (tailX !== undefined && tailX > bulbEnd) {
    ctx.strokeStyle = COLOR.outline;
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(bulbEnd, y);
    ctx.lineTo(tailX, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tailX, y, r * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.balloon;
    ctx.fill();
  }
  // 音符の右につながる風船（細い首 → 丸くふくらんだ玉）
  const neckX = x + r * 0.7;
  const cx = x + r * 1.9;
  const rx = r * 0.85;
  const ry = r * 0.62;
  const shape = () => {
    ctx.beginPath();
    ctx.moveTo(neckX, y - r * 0.14);
    ctx.quadraticCurveTo(cx - rx * 0.9, y - r * 0.14, cx - rx * 0.6, y - ry * 0.8);
    ctx.ellipse(cx, y, rx, ry, 0, Math.PI + 0.75, Math.PI - 0.75);
    ctx.quadraticCurveTo(cx - rx * 0.9, y + r * 0.14, neckX, y + r * 0.14);
    ctx.closePath();
  };
  shape();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, r * 0.16);
  ctx.strokeStyle = COLOR.outline;
  ctx.stroke();
  const g = ctx.createRadialGradient(cx - rx * 0.3, y - ry * 0.35, r * 0.05, cx, y, rx);
  g.addColorStop(0, '#ff9a4a');
  g.addColorStop(1, '#e8431a');
  ctx.fillStyle = g;
  ctx.fill();
  drawNoteHead(ctx, x, y, r, 'balloon');
  if (left !== null) {
    ctx.font = `900 ${Math.round(r * 0.9)}px 'Makinas 4 Square', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.strokeStyle = COLOR.outline;
    ctx.strokeText(String(left), x, y + r * 0.04);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(left), x, y + r * 0.04);
  }
}

export function drawAny(
  ctx: CanvasRenderingContext2D, type: NoteType, x: number, y: number, r: number, endX?: number, hitsLeft?: number | null,
) {
  if (type === 'roll' || type === 'bigRoll') drawRoll(ctx, x, endX ?? x, y, r, type);
  else if (type === 'balloon') drawBalloon(ctx, x, y, r, hitsLeft ?? null, endX);
  else drawNoteHead(ctx, x, y, r, type);
}

/** 六角形（Malody 風の UI 用） */
export function hexPath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    const px = x + r * Math.cos(a);
    const py = y + r * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 縁取り文字 */
export function outlinedText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, fill: string | CanvasGradient, stroke: string, width: number,
) {
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

const textCache = new Map<string, HTMLCanvasElement>();

/** 文字の絵を捨てる（Web フォントが読み込まれたとき） */
export function clearTextCache() {
  textCache.clear();
}

/**
 * 縁取り文字を絵として前もって作っておき、毎フレームは貼るだけにする（音符の下の「ドン」「カッ」など、
 * 1 フレームに何十個も描く文字向け）。font はピクセル指定（例 '800 31px ...'）。
 */
export function drawCachedText(
  ctx: CanvasRenderingContext2D, text: string, x: number, y: number, font: string, fill: string, stroke: string, width: number,
) {
  const m = ctx.getTransform();
  const scale = Math.hypot(m.a, m.b) || 1;
  const q = Math.round(scale * 20) / 20; // 拡大率が少し変わったくらいでは作り直さない
  const key = `${text}|${font}|${fill}|${stroke}|${width}|${q}`;
  let sp = textCache.get(key);
  if (!sp) {
    if (textCache.size > 200) textCache.clear();
    sp = document.createElement('canvas');
    const c0 = sp.getContext('2d')!;
    c0.font = font;
    const w = c0.measureText(text).width;
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 20);
    sp.width = Math.ceil((w + width * 2 + 4) * q);
    sp.height = Math.ceil((px * 1.4 + width * 2) * q);
    const c = sp.getContext('2d')!;
    c.scale(q, q);
    c.font = font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    outlinedText(c, text, sp.width / q / 2, sp.height / q / 2, fill, stroke, width);
    textCache.set(key, sp);
  }
  const w = sp.width / q;
  const h = sp.height / q;
  ctx.drawImage(sp, x - w / 2, y - h / 2, w, h);
}

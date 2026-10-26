/**
 * 曲の終わりの演出（レーンの上に出る帯と文字）。
 * - Failed...   : 青い帯。文字が落ちて並び、青い霧がかかって震えて沈む（雪のような粒）
 * - Clear!      : 橙の帯。文字が 1 つずつ跳ねて並ぶ
 * - Fullcombo!! : Clear! が縮んで金の粒になってはじけ、金の帯で白い文字が広がる（後ろで光がふくらみ、光沢が走る）
 * - Perfect!!!  : Clear! のあと大きく光って、虹色の帯に 1 文字ずつ色の違う文字が弾けて並ぶ（光線・紙吹雪・もう一度跳ねる）
 * 時間だけから毎回描く（状態を持たない）。乱数は番号から決まる値を使う
 */

export type EndKind = 'allgood' | 'fc' | 'clear' | 'fail';

/** 帯を見せる長さ（ms）。このあと結果へ */
export const END_HOLD: Record<EndKind, number> = { fail: 3000, clear: 2700, fc: 3400, allgood: 3800 };

export interface EndBox { x0: number; x1: number; top: number; bottom: number; vx0: number; vy0: number; vx1: number; vy1: number }

const RB = ['#ff4f8b', '#ff9f1c', '#ffd60a', '#2ed573', '#1e90ff', '#8c5cff'];
const RB_BAND = ['#ffc2e0', '#ffe7a3', '#c4f7d4', '#b5e6ff', '#ddcaff', '#ffc2e0'];
const FONT = "'Barlow Semi Condensed', 'M PLUS Rounded 1c', 'Arial Narrow', sans-serif";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const outCubic = (x: number) => 1 - (1 - x) ** 3;
const inOut = (x: number) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
/** 少し行き過ぎて戻る */
const backOut = (x: number, s = 1.7) => 1 + (s + 1) * (x - 1) ** 3 + s * (x - 1) ** 2;
const rnd = (n: number) => {
  const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 - Math.PI / 2;
    const rr = k % 2 ? r * 0.28 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

interface Letter { dx?: number; dy?: number; sc?: number; rot?: number; a?: number; color?: string }
interface WordStyle { fill: string | ((i: number) => string); stroke: string; lw: number; shadow?: string }

export function drawEndFx(ctx: CanvasRenderingContext2D, kind: EndKind, ms: number, B: EndBox) {
  const { x0, x1, top, bottom } = B;
  const w = x1 - x0;
  const h = bottom - top;
  const mid = (x0 + x1) / 2;
  const cy = (top + bottom) / 2;
  /** 見本（高さ 122px）からの倍率 */
  const S = h / 122;
  const WR = w / 654;
  const fontPx = Math.round(78 * S);
  const font = `italic 900 ${fontPx}px ${FONT}`;

  // 揺れ（at から 280ms）
  const shakeAt = (at: number, px: number) => {
    const k = (ms - at) / 280;
    if (k < 0 || k > 1) return 0;
    return Math.sin(k * Math.PI * 4) * (1 - k) * px * S;
  };

  const clipBand = () => {
    ctx.beginPath();
    ctx.rect(x0, top, w, h);
    ctx.clip();
  };

  const vgrad = (c1: string, c2: string, c3?: string) => {
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, c1);
    if (c3) { g.addColorStop(0.7, c2); g.addColorStop(1, c3); } else g.addColorStop(1, c2);
    return g;
  };

  /** 文字を 1 つずつ並べて描く。each(i) で文字ごとの動き */
  const drawWord = (text: string, st: WordStyle, each: (i: number) => Letter | null, wsc = 1, wa = 1, wdy = 0) => {
    const chars = [...text];
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const sp = fontPx * 0.02;
    const ws = chars.map((c) => ctx.measureText(c).width);
    const total = ws.reduce((a, b) => a + b, 0) + sp * (chars.length - 1);
    const y = cy + 2 * S + wdy;
    ctx.translate(mid, y);
    ctx.scale(wsc, wsc);
    let x = -total / 2;
    for (let i = 0; i < chars.length; i++) {
      const cx = x + ws[i] / 2;
      x += ws[i] + sp;
      const L = each(i);
      if (!L) continue;
      const a = (L.a ?? 1) * wa;
      if (a <= 0.01) continue;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.translate(cx + (L.dx ?? 0), L.dy ?? 0);
      if (L.rot) ctx.rotate(L.rot);
      const sc = L.sc ?? 1;
      if (sc !== 1) ctx.scale(sc, sc);
      if (st.shadow) {
        ctx.strokeStyle = st.shadow;
        ctx.lineWidth = st.lw;
        ctx.strokeText(chars[i], 0, 3 * S);
        ctx.fillStyle = st.shadow;
        ctx.fillText(chars[i], 0, 3 * S);
      }
      ctx.strokeStyle = st.stroke;
      ctx.lineWidth = st.lw;
      ctx.strokeText(chars[i], 0, 0);
      ctx.fillStyle = L.color ?? (typeof st.fill === 'function' ? st.fill(i) : st.fill);
      ctx.fillText(chars[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();
  };

  /** 上から落ちて、少し行き過ぎて止まる */
  const dropIn = (i: number, at: number, d: number, gap: number, from: number, s = 1.7): Letter | null => {
    const k = (ms - at - i * gap) / d;
    if (k <= 0) return null;
    const e = backOut(clamp01(k), s);
    return { dy: from * S * (1 - e), sc: 1.4 - 0.4 * e, a: clamp01(k * 2.5) };
  };

  /** 跳ねる（at から、文字ごとに gap ずつ遅れて） */
  const hopY = (i: number, at: number, hh: number, gap: number, d = 360) => {
    const k = (ms - at - i * gap) / d;
    if (k <= 0 || k >= 1) return 0;
    const e = k < 0.4 ? outCubic(k / 0.4) : 1 - inOut((k - 0.4) / 0.6);
    return -hh * S * e;
  };

  const sparks = (at: number, n: number, colors: string[], seed: number, o: { w?: number; h?: number; spread?: number; spreadY?: number } = {}) => {
    const t = ms - at;
    if (t < 0) return;
    for (let i = 0; i < n; i++) {
      const r = (k: number) => rnd(seed * 97 + i * 7 + k);
      const dur = 900 + r(1) * 700;
      const p = t / dur;
      if (p >= 1) continue;
      const sx = mid + (r(2) - 0.5) * (o.w ?? 523) * WR;
      const sy = top + 50 * S + (r(3) - 0.5) * (o.h ?? 60) * S;
      const dx = (r(4) - 0.5) * (o.spread ?? 380) * WR;
      const dy = (r(5) - 0.5) * (o.spreadY ?? 220) * S;
      const sz = (6 + r(6) * 12) * S * 0.5;
      const e = outCubic(p);
      let px: number, py: number, sc: number, al: number;
      if (e < 0.4) { const q = e / 0.4; px = dx * 0.6 * q; py = dy * 0.6 * q; sc = 1.2 * q; al = 1; }
      else { const q = (e - 0.4) / 0.6; px = dx * (0.6 + 0.4 * q); py = dy * (0.6 + 0.4 * q) + 40 * S * q; sc = 1.2 - 0.9 * q; al = 1 - q; }
      ctx.globalAlpha = al;
      ctx.fillStyle = colors[i % colors.length];
      star(ctx, sx + px, sy + py, sz * sc);
    }
    ctx.globalAlpha = 1;
  };

  const confetti = (at: number, n: number, seed: number) => {
    const t = ms - at;
    if (t < 0) return;
    for (let i = 0; i < n; i++) {
      const r = (k: number) => rnd(seed * 131 + i * 11 + k);
      const dur = 1600 + r(1) * 700;
      const p = t / dur;
      if (p >= 1) continue;
      const e = outCubic(p);
      const dx = (r(2) - 0.5) * 900 * WR;
      const dy = (-60 - r(3) * 140) * S;
      let px: number, py: number, rot: number, al = 1;
      if (e < 0.35) { const q = e / 0.35; px = dx * 0.6 * q; py = dy * q; rot = r(4) * 6 * q; }
      else { const q = (e - 0.35) / 0.65; px = dx * (0.6 + 0.4 * q); py = dy + 260 * S * q; rot = r(4) * 6 + r(5) * 10 * q; al = 1 - q; }
      ctx.save();
      ctx.globalAlpha = al;
      ctx.translate(mid + (r(6) - 0.5) * 120 * WR + px, top + 45 * S + py);
      ctx.rotate(rot);
      ctx.fillStyle = RB[i % RB.length];
      ctx.fillRect(-4 * S, -7 * S, 8 * S, 14 * S);
      ctx.restore();
    }
  };

  const ring = (at: number, color: string, max: number, lw: number, d = 650) => {
    const p = (ms - at) / d;
    if (p < 0 || p >= 1) return;
    const e = 1 - (1 - p) ** 2;
    ctx.globalAlpha = 1 - e;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * S;
    ctx.beginPath();
    ctx.arc(mid, top + 50 * S, 20 * S * (0.4 + (max - 0.4) * e), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  };

  /** 全体に白く光る */
  const flash = (at: number, a: number, d: number) => {
    const p = (ms - at) / d;
    if (p < 0 || p >= 1) return;
    ctx.globalAlpha = a * (1 - p);
    ctx.fillStyle = '#fff';
    ctx.fillRect(B.vx0, B.vy0, B.vx1 - B.vx0, B.vy1 - B.vy0);
    ctx.globalAlpha = 1;
  };

  /** 帯の上を光沢が走る（帯の中だけ） */
  const glint = (at: number, c: string) => {
    const p = (ms - at) / 650;
    if (p < 0 || p >= 1) return;
    ctx.save();
    clipBand();
    const gx = x0 - 100 * S + (w + 200 * S) * inOut(p);
    ctx.translate(gx, cy);
    ctx.transform(1, 0, -Math.tan((20 * Math.PI) / 180), 1, 0, 0);
    const gw = 30 * S;
    const g = ctx.createLinearGradient(-gw, 0, gw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, c);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-gw, -h, gw * 2, h * 2);
    ctx.restore();
  };

  const twinkle = (at: number, x: number, y: number, size: number) => {
    const t = ms - at;
    if (t < 0 || t > 2700) return;
    const p = (t % 900) / 900;
    const sc = p < 0.4 ? p / 0.4 : 1 - (p - 0.4) / 0.6;
    ctx.globalAlpha = p < 0.4 ? 1 : 1 - (p - 0.4) / 0.6;
    ctx.fillStyle = '#fff';
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p * Math.PI);
    star(ctx, 0, 0, (size / 2) * S * sc);
    ctx.restore();
    ctx.globalAlpha = 1;
  };

  ctx.save();

  // ---------- Failed... ----------
  if (kind === 'fail') {
    ctx.globalAlpha = clamp01(ms / 300);
    ctx.fillStyle = vgrad('#24406e', '#122347');
    ctx.fillRect(x0, top, w, h);
    ctx.globalAlpha = 1;
    // 青い霧（まわりから暗く）
    const fog = clamp01((ms - 1300) / 900);
    if (fog > 0) {
      ctx.save();
      clipBand();
      ctx.translate(mid, cy);
      ctx.scale(1, h / w);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.6);
      g.addColorStop(0.3, 'rgba(10,25,60,0)');
      g.addColorStop(1, 'rgba(10,25,60,0.8)');
      ctx.globalAlpha = fog;
      ctx.fillStyle = g;
      ctx.fillRect(-w, -w, w * 2, w * 2);
      ctx.restore();
    }
    // 震えて、沈んで薄くなる
    const sk = (ms - 1300) / 300;
    const sx = sk > 0 && sk < 1 ? [0, -4, 4, -2, 0][Math.floor(sk * 4)] * S + ([0, -4, 4, -2, 0][Math.floor(sk * 4) + 1] - [0, -4, 4, -2, 0][Math.floor(sk * 4)]) * S * ((sk * 4) % 1) : 0;
    const sink = outCubic(clamp01((ms - 1600) / 1000));
    drawWord('Failed...', { fill: '#bcd6ff', stroke: '#0c1630', lw: 7 * S }, (i) => {
      const L = dropIn(i, 0, 520, 90, -60, 1.0);
      if (L) L.dx = sx;
      return L;
    }, 1, 1 - 0.45 * sink, 8 * S * sink);
    // 雪のような粒
    ctx.save();
    clipBand();
    for (let i = 0; i < 20; i++) {
      const t = ms - 1300 - rnd(i * 3 + 1) * 900;
      const d = 1800 + rnd(i * 3 + 2) * 800;
      if (t < 0 || t > d) continue;
      const p = t / d;
      ctx.fillStyle = 'rgba(200,225,255,0.8)';
      ctx.beginPath();
      ctx.arc(x0 + rnd(i * 3) * w + (rnd(i * 5) - 0.5) * 30 * S * p, top - 6 * S + 110 * S * p, 2 * S, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
    return;
  }

  // ---------- Clear!（フルコンボ・全良もここから始まる） ----------
  const up = kind === 'clear' ? Infinity : 1000; // 格上げが始まる時刻
  const shake = kind === 'allgood' ? shakeAt(up, 5) : 0;
  ctx.translate(shake, shake * 0.4);

  if (ms < up + (kind === 'fc' ? 200 : 0)) {
    const open = outCubic(clamp01(ms / 220));
    ctx.fillStyle = vgrad('#ff9a5a', '#d8402a');
    ctx.fillRect(x0, cy - (h / 2) * open, w, h * open);
  }
  if (ms < up + (kind === 'fc' ? 220 : 0)) {
    // フルコンボ: 縮んで消える
    const shrink = kind === 'fc' ? clamp01((ms - up) / 220) : 0;
    const e = shrink * shrink;
    drawWord('Clear!', { fill: '#fff', stroke: '#10151a', lw: 6 * S }, (i) => dropIn(i, 120, 380, 80, -90), 1 - 0.8 * e, 1 - e);
  }
  if (kind === 'clear') {
    sparks(700, 14, ['#fff', '#ffd23f'], 1);
    ctx.restore();
    return;
  }

  // ---------- Fullcombo!!: はじけて金の帯 ----------
  if (kind === 'fc') {
    const at = up + 200;
    if (ms >= at) {
      ctx.fillStyle = vgrad('#ffe48a', '#f2a51c', '#d97f08');
      ctx.fillRect(x0, top, w, h);
      // 後ろでふくらむ光
      ctx.save();
      clipBand();
      const ph = ((ms - at) % 1400) / 1400;
      const pulse = ph < 0.5 ? inOut(ph * 2) : 1 - inOut((ph - 0.5) * 2);
      ctx.globalAlpha = 0.6 + 0.4 * pulse;
      ctx.translate(mid, cy);
      const rx = 260 * S * (0.9 + 0.15 * pulse);
      ctx.scale(1, (80 * S) / (260 * S));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      g.addColorStop(0, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.7, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      ctx.restore();
      const k = clamp01((ms - at) / 380);
      const sc = k < 0.6 ? 0.2 + 0.88 * outCubic(k / 0.6) : 1.08 - 0.08 * outCubic((k - 0.6) / 0.4);
      drawWord('Fullcombo!!', { fill: '#fff', stroke: '#7a4300', lw: 7 * S }, () => ({}), sc, clamp01(k / 0.6));
      glint(at + 400, 'rgba(255,255,255,0.75)');
    }
    sparks(at, 26, ['#fff', '#ffd23f', '#ffe9a0'], 2, { w: 40, h: 20, spread: 500, spreadY: 200 });
    flash(at, 0.6, 300);
    ctx.restore();
    return;
  }

  // ---------- Perfect!!!: 大きく光って虹色の帯 ----------
  if (ms >= up) {
    const t = ms - up;
    // 虹色の帯（横に流れる）
    ctx.save();
    clipBand();
    const L = w * 2;
    const off = ((t / 2500) % 1) * L;
    const g = ctx.createLinearGradient(0, 0, L, 0);
    RB_BAND.forEach((c, i) => g.addColorStop(i / (RB_BAND.length - 1), c));
    ctx.fillStyle = g;
    for (const base of [-off, L - off]) {
      ctx.save();
      ctx.translate(x0 + base, 0);
      ctx.fillRect(0, top, L, h);
      ctx.restore();
    }
    // 回る光線
    ctx.translate(mid, cy);
    ctx.rotate((t / 6000) * Math.PI);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const R = w;
    for (let k = 0; k < 24; k++) {
      const a0 = (k * 15 * Math.PI) / 180;
      const a1 = a0 + (5 * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * R, Math.sin(a0) * R);
      ctx.lineTo(Math.cos(a1) * R, Math.sin(a1) * R);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    drawWord('Perfect!!!', { fill: (i) => RB[i % RB.length], stroke: '#fff', lw: 8 * S, shadow: '#5a3a9a' }, (i) => {
      const k = (t - i * 45) / 380;
      if (k <= 0) return null;
      const sc = k < 0.6 ? 2.2 - 1.35 * outCubic(k / 0.6) : 0.85 + 0.15 * outCubic(clamp01((k - 0.6) / 0.4));
      return { sc, a: clamp01(k / 0.6), dy: hopY(i, 1100, 20, 45) };
    });
    glint(up + 1100, 'rgba(255,255,255,0.8)');
    ring(up, '#fff', 14, 6);
    ring(up + 1100, 'rgba(255,255,255,0.8)', 12, 4);
    confetti(up, 46, 3);
    sparks(up, 20, ['#fff'], 4);
    twinkle(up + 400, x0 + w * 0.2, top + 20 * S, 22);
    twinkle(up + 700, x0 + w * 0.8, top + 75 * S, 18);
  }
  ctx.translate(-shake, -shake * 0.4);
  flash(up, 1, 650);
  ctx.restore();
}

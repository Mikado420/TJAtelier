import type { NoteType } from '../chart/types';

/**
 * エディタで使う TNDE スキンの音符（notes.webp の切り出し）。
 * 1 マス 130 px。小さい音符は顔の半径 36、大きい音符は 54。
 */
let img: HTMLImageElement | null = null;
let ready = false;

/** 音符の絵を読み込む（一度だけ） */
export function loadTndeNotes(base: string, done?: () => void) {
  if (img) return;
  img = new Image();
  img.decoding = 'async';
  img.onload = () => { ready = true; done?.(); };
  img.src = `${base}skins/tnde/notes.webp`;
}

/** 絵が使えるか */
export function tndeNotesReady() {
  return ready;
}

const HEAD: Partial<Record<NoteType, [number, number, number]>> = {
  // [左, 上, 顔の半径]（大きい音符は、2 段目のまじめな顔）
  don: [130, 0, 36],
  ka: [260, 0, 36],
  bigDon: [390, 130, 54],
  bigKa: [520, 130, 54],
};

/** 連打の体（左, 右, 上, 下, 先の丸みの幅） */
const BODY = { roll: [780, 941, 29, 101, 42], bigRoll: [1170, 1352, 11, 119, 64] } as const;
const ROLL_HEAD = { roll: [650, 0, 36], bigRoll: [1040, 0, 54] } as const;

/** TNDE の音符を描く（描けたら true。絵がまだなら false で、いつもの音符を描く） */
export function drawTndeNote(
  ctx: CanvasRenderingContext2D, type: NoteType, x: number, y: number, r: number, endX?: number,
): boolean {
  if (!ready || !img) return false;
  const h = HEAD[type];
  if (h) {
    const k = r / h[2];
    ctx.drawImage(img, h[0], h[1], 130, 130, x - 65 * k, y - 65 * k, 130 * k, 130 * k);
    return true;
  }
  if (type === 'roll' || type === 'bigRoll') {
    const [bx0, bx1, by0, by1, cap] = BODY[type];
    const [hx, hy, hr] = ROLL_HEAD[type];
    const k = r / hr;
    const ex = Math.max(x, endX ?? x);
    const top = y - (65 - by0) * k;
    const bh = (by1 - by0) * k;
    // 体: まっすぐな所を伸ばして、先の丸みを終わりに付ける
    const capW = cap * k;
    const mid = Math.max(0, ex - x);
    if (mid > 0) ctx.drawImage(img, bx0 + 4, by0, 8, by1 - by0, x, top, mid + 1, bh);
    ctx.drawImage(img, bx1 - cap, by0, cap, by1 - by0, ex, top, capW, bh);
    ctx.drawImage(img, hx, hy, 130, 130, x - 65 * k, y - 65 * k, 130 * k, 130 * k);
    return true;
  }
  if (type === 'balloon') {
    const k = r / 36;
    // 顔の中心が 1493（左端 1430 から 63）
    ctx.drawImage(img, 1430, 0, 260, 130, x - 63 * k, y - 65 * k, 260 * k, 130 * k);
    return true;
  }
  return false;
}

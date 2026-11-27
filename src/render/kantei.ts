/**
 * 勘亭流の字の並べ方。本家（DF勘亭流の等幅）は、半角の英数字・記号を 0.5 字の幅のます目に 1 字ずつ入れる
 * （ます目より広い字は横に縮め、狭い字はます目の真ん中に置く）。全角の字（かな・漢字など）はフォントの幅のまま。
 * 参考動画「魔宵月」のサブタイトルで測った: 40px の字で半角は 20px ごと
 */

export interface KGlyph {
  ch: string;
  /** ます目の左（字の並びの左からの px） */
  x: number;
  /** 横の倍率 */
  kx: number;
  /** ます目の中で字を右へずらす量 */
  dx: number;
}

export interface KLayout {
  glyphs: KGlyph[];
  width: number;
}

const isHalf = (ch: string) => ch >= ' ' && ch <= '~';
/** かな・漢字・全角の記号（mono のときに 1 字の幅のます目に置く字。♪ などはフォントの幅のまま） */
const isWide = (ch: string) => (ch >= '\u3000' && ch <= '\u9fff') || (ch >= '\uff00' && ch <= '\uffef');

/**
 * g.font（px の大きさ）で字を並べる。punct = 「、」「。」の幅の倍率。
 * mono = かな・漢字も 1 字の幅のます目に真ん中そろえで置く（本家のサブタイトルの並び方。参考動画「魔宵月」で測った。♪ はフォントの幅のまま）
 */
export function kLayout(g: CanvasRenderingContext2D, text: string, px: number, punct = 1, mono = false): KLayout {
  const key = `${g.font}|${punct}|${mono}|${text}`;
  const have = cache.get(key);
  if (have) return have;
  const glyphs: KGlyph[] = [];
  let x = 0;
  for (const ch of text) {
    const m = g.measureText(ch).width;
    if (isHalf(ch)) {
      const cell = px * 0.5;
      const kx = m > cell ? cell / m : 1;
      glyphs.push({ ch, x, kx, dx: (cell - m * kx) / 2 });
      x += cell;
    } else if (mono && isWide(ch)) {
      glyphs.push({ ch, x, kx: 1, dx: (px - m) / 2 });
      x += px;
    } else {
      glyphs.push({ ch, x, kx: 1, dx: 0 });
      x += m * ('、。'.includes(ch) ? punct : 1);
    }
  }
  const l = { glyphs, width: x };
  // 毎フレーム描く字（ネームプレートなど）のために、並べた結果をとっておく（200 まで）
  if (cache.size >= 200) cache.delete(cache.keys().next().value!);
  cache.set(key, l);
  return l;
}
const cache = new Map<string, KLayout>();

/** 並べた字を (x, y) を左端にして描く（textAlign は left にしておく）。op = 1 字を描く（strokeText か fillText） */
export function kDraw(g: CanvasRenderingContext2D, l: KLayout, x: number, y: number, op: (ch: string, x: number, y: number) => void) {
  for (const gl of l.glyphs) {
    if (gl.kx === 1) { op(gl.ch, x + gl.x + gl.dx, y); continue; }
    g.save();
    g.translate(x + gl.x + gl.dx, y);
    g.scale(gl.kx, 1);
    op(gl.ch, 0, 0);
    g.restore();
  }
}

/** 字の大きさ（px）を font の文字列から */
export function fontPx(font: string) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : 16;
}

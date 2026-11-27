/**
 * 文字列 → シフトJIS（Windows の CP932）のバイト列。
 * ブラウザには書き出し用の変換が無いので、読み込み用の TextDecoder('shift_jis') で全部の文字コードを読んで、逆引きの表を作る。
 * シフトJIS に無い文字は「?」にする。
 */
let table: Map<number, number> | null = null;

function buildTable(): Map<number, number> {
  const m = new Map<number, number>();
  const dec = new TextDecoder('shift_jis');
  // 1 バイトの文字（半角カナ）
  for (let b = 0xa1; b <= 0xdf; b++) {
    const ch = dec.decode(new Uint8Array([b]));
    if (ch.length === 1 && ch !== '�') m.set(ch.charCodeAt(0), b);
  }
  // 2 バイトの文字。重複（NEC・IBM の拡張文字）は先に出てくるほうを使う
  const leads: number[] = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const lead of leads) {
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const ch = dec.decode(new Uint8Array([lead, trail]));
      if (ch.length !== 1 || ch === '�') continue;
      const c = ch.charCodeAt(0);
      if (!m.has(c)) m.set(c, (lead << 8) | trail);
    }
  }
  return m;
}

/**
 * Mac・iPhone で打つと出る、Windows の ANSI（CP932）とは別の番号の記号を、同じ見た目の CP932 の字にする
 * （〜 − — ‖ ¢ £ ¬ ¦）
 */
const ALIAS: Record<number, number> = {
  0x301c: 0xff5e, 0x2212: 0xff0d, 0x2014: 0x2015, 0x2016: 0x2225,
  0x00a2: 0xffe0, 0x00a3: 0xffe1, 0x00ac: 0xffe2, 0x00a6: 0xffe4,
};

/** 文字 1 つ（コードポイント）の CP932 の番号。無ければ undefined */
function code(c: number): number | undefined {
  if (c < 0x80) return c;
  const t = table!;
  return t.get(ALIAS[c] ?? c);
}

export function encodeSJIS(text: string): Uint8Array {
  table ??= buildTable();
  const out: number[] = [];
  const push = (v: number) => { if (v < 0x100) out.push(v); else out.push(v >> 8, v & 0xff); };
  for (const ch of text) {
    const v = code(ch.codePointAt(0)!);
    if (v !== undefined) { push(v); continue; }
    // é → e のように、飾りを外せば CP932 にある字はそれにする（Windows が ANSI にするときと同じ）
    const base = [...ch.normalize('NFD')].filter((x) => !/\p{M}/u.test(x)).map((x) => code(x.codePointAt(0)!));
    if (base.length && base.every((b) => b !== undefined)) base.forEach((b) => push(b!));
    else out.push(0x3f);
  }
  return new Uint8Array(out);
}

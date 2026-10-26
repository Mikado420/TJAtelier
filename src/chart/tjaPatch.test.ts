import { describe, expect, it } from 'vitest';
import { TPB } from './model';
import { parseTJA } from './tja';
import { writeTJA } from './tjaWrite';
import { patchTJA } from './tjaPatch';

const SRC = `// 作者メモ
TITLE:テスト曲   // タイトル
BPM:120
WAVE:a.ogg
OFFSET:0

COURSE:Oni
LEVEL:8
BALLOON:5

#START
// 前半
1011,  // 1 小節目

2020,
#GOGOSTART
1111, // サビ
#GOGOEND
0,
#END
`;

describe('patchTJA（自分で書いたテキストを保って、譜面の変更だけ書き込む）', () => {
  it('変わっていなければそのまま', () => {
    expect(patchTJA(SRC, parseTJA(SRC))).toBe(SRC);
  });

  it('音符を置いても、ほかの小節のコメント・空行・改行は残る', () => {
    const c = parseTJA(SRC);
    // 2 小節目（2020）の 2 拍目に ドン を足す
    const co = c.courses[0];
    co.notes.push({ tick: TPB * 4 + TPB, type: 'don' });
    const out = patchTJA(SRC, c);
    expect(out).toContain('// 作者メモ');
    expect(out).toContain('TITLE:テスト曲   // タイトル');
    expect(out).toContain('// 前半');
    expect(out).toContain('1011,  // 1 小節目');
    expect(out).toContain('1111, // サビ');
    expect(out).toContain('\n\n2120,\n');
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('書き直した小節の行末のコメントは、新しい行に付け直す', () => {
    const c = parseTJA(SRC);
    c.courses[0].notes = c.courses[0].notes.filter((n) => n.tick !== 0);
    const out = patchTJA(SRC, c);
    expect(out).toMatch(/0011,\s+\/\/ 1 小節目/);
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('ヘッダは変わった行だけ書き換える（コメントは残す）', () => {
    const c = parseTJA(SRC);
    c.title = '新しい名前';
    c.subtitle = 'サブ';
    c.courses[0].level = 9;
    const out = patchTJA(SRC, c);
    expect(out).toContain('TITLE:新しい名前   // タイトル');
    expect(out).toContain('TITLE:新しい名前   // タイトル\nSUBTITLE:サブ');
    expect(out).toContain('LEVEL:9');
    expect(out).toContain('// 作者メモ');
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('難易度を足しても、元の難易度のテキストは変わらない', () => {
    const c = parseTJA(SRC);
    const add = parseTJA(SRC.replace('COURSE:Oni', 'COURSE:Hard')).courses[0];
    c.courses.push(add);
    const out = patchTJA(SRC, c);
    expect(out.startsWith(SRC.trimEnd())).toBe(true);
    expect(out).toContain('COURSE:Hard');
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('難易度を消すと、その難易度だけ消える', () => {
    const two = `${SRC}\nCOURSE:Hard\nLEVEL:5\n\n#START\n1,\n#END\n`;
    const c = parseTJA(two);
    c.courses.splice(1, 1);
    const out = patchTJA(two, c);
    expect(out).not.toContain('COURSE:Hard');
    expect(out).toContain('// サビ');
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('改行が CRLF でも、そのまま', () => {
    const crlf = SRC.replace(/\n/g, '\r\n');
    const c = parseTJA(crlf);
    c.courses[0].notes.push({ tick: TPB * 4 + TPB / 2, type: 'ka' });
    const out = patchTJA(crlf, c);
    expect(out.split('\r\n').length).toBeGreaterThan(10);
    expect(out.includes('\n') && !/[^\r]\n/.test(out)).toBe(true);
    expect(out).toContain('// サビ');
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('小節を後ろに足すと、最後の小節の後ろに足される', () => {
    const c = parseTJA(SRC);
    c.courses[0].notes.push({ tick: TPB * 4 * 5 + TPB, type: 'don' });
    const out = patchTJA(SRC, c);
    expect(out).toContain('// サビ');
    expect(out).toMatch(/0,\n0100,\n#END/);
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
  });

  it('1 行に小節がいくつもある書き方・分岐・#BMSCROLL でも、読み直すと同じ譜面になる', () => {
    const src = `TITLE:x\nBPM:120\n\nCOURSE:Oni\nLEVEL:8\n#BMSCROLL\n#START\n1111,2222, // 2 つ\n#BRANCHSTART p,1,2\n#N\n1000,\n#E\n2000,\n#M\n3000,\n#BRANCHEND\n// おわり\n1,\n#END\n`;
    const c = parseTJA(src);
    c.courses[0].notes.push({ tick: TPB * 4 * 3 + TPB, type: 'ka' });
    const out = patchTJA(src, c);
    expect(writeTJA(parseTJA(out))).toBe(writeTJA(c));
    expect(out).toContain('// おわり');
    expect(out).toContain('#E\n2000,');
    const c2 = parseTJA(src);
    c2.courses[0].notes.push({ tick: TPB, type: 'ka' });
    const out2 = patchTJA(src, c2);
    expect(writeTJA(parseTJA(out2))).toBe(writeTJA(c2));
    expect(out2).toContain('// おわり');
  });
});

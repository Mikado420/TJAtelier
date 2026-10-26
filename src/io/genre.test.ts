import { expect, test } from 'vitest';
import { loadFiles } from './load';
import { writeZip } from './zip';

const TJA = (t: string) => `TITLE:${t}\nBPM:120\nCOURSE:Oni\nLEVEL:5\n#START\n1111,\n#END\n`;
const sjis = new Uint8Array([0x47, 0x65, 0x6e, 0x72, 0x65, 0x4e, 0x61, 0x6d, 0x65, 0x3d, 0x83, 0x51, 0x81, 0x5b, 0x83, 0x80]); // GenreName=ゲーム（Shift_JIS）

test('genre.ini の GenreName をフォルダ名にする（下のフォルダの譜面にも）', async () => {
  const enc = new TextEncoder();
  const blob = await writeZip([
    { name: 'pack/genre.ini', data: enc.encode('[Genre]\r\nGenreName=ナムコオリジナル\r\nGenreColor=#ff0000\r\n') },
    { name: 'pack/a/a.tja', data: enc.encode(TJA('A')) },
    { name: 'pack/b/b.tja', data: enc.encode(TJA('B')) },
    { name: 'game/genre.ini', data: sjis },
    { name: 'game/c.tja', data: enc.encode(TJA('C')) },
    { name: 'other/d.tja', data: enc.encode(TJA('D')) },
    { name: 'empty/genre.ini', data: enc.encode('[Genre]\r\nGenreName=\r\nGenreColor=#0080FF\r\n') },
    { name: 'empty/e.tja', data: enc.encode(TJA('E')) },
    { name: 'cr/genre.ini', data: enc.encode('\uFEFF[Genre]\rGenreName = ボーカロイド \rGenreColor=#0080FF\r') },
    { name: 'cr/f.tja', data: enc.encode(TJA('F')) },
  ]);
  const r = await loadFiles([new File([blob], 'x.zip')]);
  const g = Object.fromEntries(r.songs.map((s) => [s.chart.title, s.genre]));
  expect(g).toEqual({ A: 'ナムコオリジナル', B: 'ナムコオリジナル', C: 'ゲーム', D: undefined, E: 'empty', F: 'ボーカロイド' });
  expect(r.skipped).toEqual([]);
});

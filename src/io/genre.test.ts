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
    { name: 'pack/b/genre.ini', data: enc.encode('GenreName=アニメ/特撮\n') },
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
  expect(g).toEqual({ A: 'ナムコオリジナル', B: 'ナムコオリジナル/アニメ／特撮', C: 'ゲーム', D: undefined, E: 'empty', F: 'ボーカロイド' });
  expect(r.skipped).toEqual([]);
});

test('zip の音源・動画は、使うときに 1 つずつ読み出す（WAVE: で組み合わせる）', async () => {
  const enc = new TextEncoder();
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);
  const blob = await writeZip([
    { name: 's1/a.tja', data: enc.encode(TJA('A').replace('BPM:120', 'BPM:120\nWAVE:a.ogg')) },
    { name: 's1/a.ogg', data: ogg },
    { name: 's2/b.tja', data: enc.encode(TJA('B').replace('BPM:120', 'BPM:120\nWAVE:b.ogg\nBGMOVIE:b.mp4')) },
    { name: 's2/b.ogg', data: ogg },
    { name: 's2/b.mp4', data: new Uint8Array([9, 9, 9]) },
    { name: 's2/jacket.png', data: new Uint8Array([1]) },
    { name: 'lone.ogg', data: ogg },
  ]);
  const r = await loadFiles([new File([blob], 'x.zip')]);
  const a = r.songs.find((s) => s.chart.title === 'A')!;
  const b = r.songs.find((s) => s.chart.title === 'B')!;
  expect(a.audio?.name).toBe('a.ogg');
  expect(new Uint8Array(await a.audio!.read())).toEqual(ogg);
  expect(b.video?.name).toBe('b.mp4');
  expect(new Uint8Array(await b.video!.read())).toEqual(new Uint8Array([9, 9, 9]));
  expect(r.audios.map((x) => x.name)).toEqual(['lone.ogg']);
  expect(r.skipped).toEqual(['jacket.png']);
});

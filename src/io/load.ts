import { decodeText } from '../chart/decode';
import type { EChart } from '../chart/model';
import { parseTJA } from '../chart/tja';
import { isZip, readZip } from './zip';

export interface AudioFile {
  name: string;
  data: ArrayBuffer;
}

export interface LoadedSong {
  chart: EChart;
  audio: AudioFile | null;
  /** .tja のファイル名（zip の中ならフォルダ付き） */
  tjaName: string;
  /** 同じフォルダか上のフォルダにある genre.ini の GenreName（入れるフォルダの名前） */
  genre?: string;
}

export interface LoadResult {
  /** 読み込んだ譜面（.tja ごとに 1 曲。合う音源があれば組み合わせ済み） */
  songs: LoadedSong[];
  /** どの譜面にも組み合わなかった音源 */
  audios: AudioFile[];
  /** 読めなかったファイル */
  skipped: string[];
}

const base = (p: string) => p.split('/').pop() ?? p;
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** 中身から音源かどうかを見分ける（拡張子が変わっていても読めるように） */
export function isAudio(name: string, data: ArrayBuffer): boolean {
  if (/\.(ogg|oga|mp3|wav|m4a|aac|opus|flac|mp4|m4v|mov|webm|aif|aiff)$/i.test(name)) return true;
  const b = new Uint8Array(data, 0, Math.min(12, data.byteLength));
  const s = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  return s(0, 4) === 'OggS' || (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') || s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
    || s(4, 4) === 'ftyp' || s(0, 4) === 'fLaC' || s(0, 4) === 'FORM';
}

function isTja(name: string, data: ArrayBuffer): boolean {
  if (/\.tja$/i.test(name)) return true;
  if (data.byteLength > 2_000_000 || /\.(png|jpe?g|gif|txt|md|json|html?)$/i.test(name)) return false;
  return /#START/i.test(decodeText(data.slice(0, 200_000)));
}

/**
 * 選ばれたファイル（.tja・.zip・音源。いくつでも、混ぜても）を読み込む。
 * zip は中を展開する。.tja ごとに 1 曲にし、WAVE: と同じ名前 → 同じフォルダ → 1 曲だけなら残りの音源、の順で音源を組み合わせる
 */
export async function loadFiles(files: File[]): Promise<LoadResult> {
  const entries: { name: string; data: ArrayBuffer }[] = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    if (isZip(buf)) {
      for (const e of await readZip(buf)) if (!e.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(e.name)) entries.push({ name: e.name, data: toBuf(e.data) });
    } else entries.push({ name: f.name, data: buf });
  }
  // genre.ini（GenreName= がジャンル名）。置いてあるフォルダとその下の譜面に使う
  const genres = new Map<string, string>();
  for (const e of entries) {
    if (base(e.name).toLowerCase() !== 'genre.ini') continue;
    // 1 行ずつ見る（値が空の行から次の行へはみ出さないように）
    let name = '';
    for (const line of decodeText(e.data).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
      const m = /^[ \t]*GenreName[ \t]*=(.*)$/i.exec(line);
      if (m) { name = m[1].trim().replace(/^["']|["']$/g, '').trim(); break; }
    }
    // GenreName が空なら、genre.ini が置いてあるフォルダの名前
    if (!name) name = dir(e.name).split('/').filter(Boolean).pop() ?? '';
    if (name) genres.set(dir(e.name), name);
  }
  const genreOf = (path: string) => {
    let d = dir(path);
    for (;;) {
      const g = genres.get(d);
      if (g) return g;
      if (!d) return undefined;
      d = dir(d.slice(0, -1));
    }
  };
  const tjas: typeof entries = [];
  const audios: typeof entries = [];
  const skipped: string[] = [];
  for (const e of entries) {
    if (isAudio(e.name, e.data)) audios.push(e);
    else if (isTja(e.name, e.data)) tjas.push(e);
    else if (!/(^|\/)\./.test(e.name) && base(e.name).toLowerCase() !== 'genre.ini') skipped.push(base(e.name));
  }
  const used = new Set<(typeof entries)[number]>();
  const songs: LoadedSong[] = [];
  const parsed = tjas.map((t) => ({ t, chart: parseTJA(decodeText(t.data)) }));
  for (const { t, chart } of parsed) {
    const free = audios.filter((a) => !used.has(a));
    const audio =
      free.find((a) => base(a.name) === chart.wave && dir(a.name) === dir(t.name)) ??
      free.find((a) => base(a.name).toLowerCase() === chart.wave.toLowerCase()) ??
      free.find((a) => dir(a.name) === dir(t.name) && dir(t.name) !== '' && parsed.filter((p) => dir(p.t.name) === dir(t.name)).length === 1) ??
      (parsed.length === 1 && free.length === 1 ? free[0] : undefined);
    if (audio) used.add(audio);
    songs.push({ chart, audio: audio ? { name: base(audio.name), data: audio.data } : null, tjaName: t.name, genre: genreOf(t.name) });
  }
  return {
    songs,
    audios: audios.filter((a) => !used.has(a)).map((a) => ({ name: base(a.name), data: a.data })),
    skipped,
  };
}

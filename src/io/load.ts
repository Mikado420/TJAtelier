import { decodeText } from '../chart/decode';
import type { EChart } from '../chart/model';
import { parseTJA } from '../chart/tja';
import { isZipBlob, readZipIndex } from './zip';

export interface AudioFile {
  name: string;
  data: ArrayBuffer;
}

/** 中身を後から読む音源・動画（曲がたくさんあっても、全部を一度にメモリに置かないように） */
export interface AudioSrc {
  name: string;
  /** 大きさ（バイト。分からなければ 0） */
  size: number;
  read(): Promise<ArrayBuffer>;
}

export interface LoadedSong {
  chart: EChart;
  audio: AudioSrc | null;
  /** .tja のファイル名（zip の中ならフォルダ付き） */
  tjaName: string;
  /** 背景の動画（mp4 など）。fromAudio = 音源も同じファイル（mp4 だけの曲） */
  video?: AudioSrc & { fromAudio?: boolean };
  /** 同じフォルダか上のフォルダにある genre.ini の GenreName（入れるフォルダ。上にもあれば "親/子"） */
  genre?: string;
}

export interface LoadResult {
  /** 読み込んだ譜面（.tja ごとに 1 曲。合う音源があれば組み合わせ済み） */
  songs: LoadedSong[];
  /** どの譜面にも組み合わなかった音源 */
  audios: AudioSrc[];
  /** 読めなかったファイル */
  skipped: string[];
}

const base = (p: string) => p.split('/').pop() ?? p;
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const toBuf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** 動画のファイル（背景に流す。音も入っていれば音源にも使える） */
export const isVideoName = (name: string) => /\.(mp4|m4v|mov)$/i.test(name);

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

const AUDIO_EXT = /\.(ogg|oga|mp3|wav|m4a|aac|opus|flac|webm|aif|aiff)$/i;
/** 中身を見なくても譜面・音源ではないと分かるもの（画像・文書など） */
const OTHER_EXT = /\.(png|jpe?g|gif|bmp|webp|svg|txt|md|json|html?|ini|lua|ttf|otf|psd|pdf|db|dat|bak|csv|xml|log|exe|dll|zip)$/i;

interface Src { name: string; size: number; read(): Promise<ArrayBuffer> }

/**
 * 選ばれたファイル（.tja・.zip・音源。いくつでも、混ぜても）を読み込む。
 * zip は目次だけ読み、譜面（小さい）だけ先に展開する。音源・動画は read() したときに 1 つずつ展開する。
 * .tja ごとに 1 曲にし、WAVE: と同じ名前 → 同じフォルダ → 1 曲だけなら残りの音源、の順で音源を組み合わせる
 */
export async function loadFiles(files: File[]): Promise<LoadResult> {
  const entries: Src[] = [];
  const zipDirs = new Set<string>();
  for (const f of files) {
    if (await isZipBlob(f)) {
      // zip ごとに、zip の名前のフォルダの中にあるものとして扱う（いくつかの zip を一度に読み込んだとき、
      // いちばん上の genre.ini や同じ名前のフォルダが、ほかの zip の譜面と混ざらないように）
      let zd = f.name.replace(/\.zip$/i, '').replace(/\//g, '／') || 'zip';
      for (let k = 2; zipDirs.has(zd); k++) zd = `${f.name.replace(/\.zip$/i, '')} (${k})`;
      zipDirs.add(zd);
      for (const e of await readZipIndex(f)) {
        if (/(^|\/)__MACOSX\//.test(e.name)) continue;
        entries.push({ name: `${zd}/${e.name}`, size: e.size, read: async () => toBuf(await e.read()) });
      }
    } else entries.push({ name: f.name, size: f.size, read: () => f.arrayBuffer() });
  }
  // genre.ini（GenreName= がジャンル名）。置いてあるフォルダとその下の譜面に使う
  const genres = new Map<string, string>();
  for (const e of entries) {
    if (base(e.name).toLowerCase() !== 'genre.ini') continue;
    // 1 行ずつ見る（値が空の行から次の行へはみ出さないように）
    let name = '';
    for (const line of decodeText(await e.read()).replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
      const m = /^[ \t]*GenreName[ \t]*=(.*)$/i.exec(line);
      if (m) { name = m[1].trim().replace(/^["']|["']$/g, '').trim(); break; }
    }
    // GenreName が空なら、genre.ini が置いてあるフォルダの名前
    if (!name) name = dir(e.name).split('/').filter(Boolean).pop() ?? '';
    // フォルダの道のりの区切り（/）は名前に使えないので全角に
    if (name) genres.set(dir(e.name), name.replace(/\//g, '／'));
  }
  // 上のフォルダにも genre.ini があれば、フォルダの中のフォルダにする（"親ジャンル/子ジャンル"）
  const genreOf = (path: string) => {
    const chain: string[] = [];
    let d = dir(path);
    for (;;) {
      const g = genres.get(d);
      if (g) chain.unshift(g);
      if (!d) break;
      d = dir(d.slice(0, -1));
    }
    return chain.length ? chain.join('/') : undefined;
  };
  const tjas: { name: string; data: ArrayBuffer }[] = [];
  const audios: Src[] = [];
  const skipped: string[] = [];
  const videos: Src[] = [];
  for (const e of entries) {
    const bn = base(e.name);
    if (bn.toLowerCase() === 'genre.ini') continue;
    if (isVideoName(e.name)) videos.push(e);
    else if (AUDIO_EXT.test(e.name)) audios.push(e);
    else if (/\.tja$/i.test(e.name)) tjas.push({ name: e.name, data: await e.read() });
    else if (/(^|\/)\./.test(e.name)) continue;
    else if (OTHER_EXT.test(e.name)) skipped.push(bn);
    else {
      // 拡張子からは分からない: 中身を見る（音源なら、使うときにもう一度読む）
      const data = await e.read();
      if (isAudio(e.name, data)) audios.push(e);
      else if (isTja(e.name, data)) tjas.push({ name: e.name, data });
      else skipped.push(bn);
    }
  }
  const used = new Set<Src>();
  const songs: LoadedSong[] = [];
  const parsed = tjas.map((t) => ({ t, chart: parseTJA(decodeText(t.data)) }));
  // 同じフォルダの譜面の数（何度も数えないように）
  const perDir = new Map<string, number>();
  for (const p of parsed) perDir.set(dir(p.t.name), (perDir.get(dir(p.t.name)) ?? 0) + 1);
  for (const { t, chart } of parsed) {
    const free = audios.filter((a) => !used.has(a));
    const sameDir = perDir.get(dir(t.name)) === 1;
    const audio =
      free.find((a) => base(a.name) === chart.wave && dir(a.name) === dir(t.name)) ??
      free.find((a) => base(a.name).toLowerCase() === chart.wave.toLowerCase()) ??
      free.find((a) => dir(a.name) === dir(t.name) && dir(t.name) !== '' && sameDir) ??
      (parsed.length === 1 && free.length === 1 ? free[0] : undefined);
    if (audio) used.add(audio);
    // 背景の動画: BGMOVIE: の名前 → 同じフォルダ（譜面が 1 つだけのフォルダ）→ 譜面も動画も 1 つだけ
    const freeV = videos.filter((v) => !used.has(v));
    const bg = chart.extra.find(([k]) => k.toUpperCase() === 'BGMOVIE')?.[1] ?? '';
    const video =
      (bg ? freeV.find((v) => base(v.name).toLowerCase() === base(bg).toLowerCase() && dir(v.name) === dir(t.name)) ?? freeV.find((v) => base(v.name).toLowerCase() === base(bg).toLowerCase()) : undefined) ??
      freeV.find((v) => base(v.name).toLowerCase() === chart.wave.toLowerCase()) ??
      (sameDir && dir(t.name) !== '' ? freeV.find((v) => dir(v.name) === dir(t.name)) : undefined) ??
      (parsed.length === 1 && freeV.length === 1 ? freeV[0] : undefined);
    if (video) used.add(video);
    const named = (x: Src): AudioSrc => ({ name: base(x.name), size: x.size, read: x.read });
    const song: LoadedSong = { chart, audio: audio ? named(audio) : null, tjaName: t.name, genre: genreOf(t.name) };
    if (video) {
      // 音源が無ければ、動画の音を音源にする（変換しない。動画は音源と同じファイルを使う）
      if (!song.audio) {
        song.audio = named(video);
        song.video = { ...named(video), fromAudio: true };
      } else song.video = named(video);
    }
    songs.push(song);
  }
  // どの譜面にも組み合わなかった動画は、音源として扱う（その動画の音で新しい曲）
  for (const v of videos) if (!used.has(v)) audios.push(v);
  return {
    songs,
    audios: audios.filter((a) => !used.has(a)).map((a) => ({ name: base(a.name), size: a.size, read: a.read })),
    skipped,
  };
}

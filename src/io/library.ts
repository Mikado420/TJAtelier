import type { EChart } from '../chart/model';
import type { AudioFile } from './load';
import { oggDuration } from '../audio/duration';
import { dbDel, dbGet, dbKeys, dbPut } from './storage';

/**
 * 曲の一覧（ライブラリ）。曲ごとに譜面と音源をブラウザ内（IndexedDB）に保存し、フォルダで分ける。
 * 一覧（lib-index）には、曲選択の画面に出す情報だけを持つ（譜面・音源は曲ごとの別のキー）。
 */

export interface SongEntry {
  id: string;
  title: string;
  subtitle: string;
  bpm: number;
  /** 曲の長さ（秒。音源が無いときは 0） */
  length: number;
  /** BPM の最小・最大（途中で変わる曲） */
  bpmMin: number;
  bpmMax: number;
  courses: { name: string; level: number }[];
  /** 入っているフォルダ（いくつでも。空なら未分類） */
  folders: string[];
  /** 前の版の「入っているフォルダ（1 つだけ、'' は一番上）」。読み込むときに folders へ移す */
  folder?: string;
  audioName: string;
  /** 背景の動画のファイル名（無ければ undefined） */
  video?: string;
  /** 背景の動画のずれ（秒。+ で動画を先へ進める） */
  videoOffset?: number;
  demoStart: number;
  updatedAt: number;
}

export interface SongData {
  chart: EChart;
  courseIndex: number;
}

const kIndex = 'lib-index';
const kFolders = 'lib-folders';
/** フォルダの色（genre.ini の GenreColor。道のり → '#rrggbb'） */
const kFolderColors = 'lib-folder-colors';
/** フォルダの文字の色（genre.ini の FontColor。色のついた帯の上の文字） */
const kFolderFonts = 'lib-folder-fonts';
const kChart = (id: string) => `lib-chart-${id}`;
const kAudio = (id: string) => `lib-audio-${id}`;
const kVideo = (id: string) => `lib-video-${id}`;

/** 背景の動画。fromAudio = 音源と同じファイル（mp4 だけの曲。二重に持たない） */
export interface VideoFile { name: string; data: ArrayBuffer | null; fromAudio?: boolean }

/** 前の版（フォルダが 1 つだけ）の一覧を、今の形（いくつでも）に直す */
const norm = (x: SongEntry): SongEntry => {
  if (Array.isArray(x.folders)) return x;
  const { folder, ...rest } = x;
  return { ...rest, folders: folder ? [folder] : [] };
};
export const listSongs = async () => ((await dbGet<SongEntry[]>(kIndex)) ?? []).map(norm);
export const listFolders = async () => (await dbGet<string[]>(kFolders)) ?? [];
export const listFolderColors = async () => (await dbGet<Record<string, string>>(kFolderColors)) ?? {};
export const listFolderFonts = async () => (await dbGet<Record<string, string>>(kFolderFonts)) ?? {};

/** フォルダの色・文字の色を決める（いくつでも。null なら決めた色を外す） */
export function setFolderColors(colors: Record<string, string | null>, fonts: Record<string, string | null> = {}) {
  return serial(async () => {
    for (const [key, list] of [[kFolderColors, colors], [kFolderFonts, fonts]] as const) {
      if (!Object.keys(list).length) continue;
      const cur = (await dbGet<Record<string, string>>(key)) ?? {};
      for (const [k, v] of Object.entries(list)) {
        if (v) cur[k] = v;
        else delete cur[k];
      }
      await dbPut(key, cur);
    }
  });
}
export const loadSongData = (id: string) => dbGet<SongData>(kChart(id));
export const loadSongAudio = (id: string) => dbGet<AudioFile>(kAudio(id));
export const getCurrentId = () => dbGet<string>('lib-current');
export const setCurrentId = (id: string | null) => (id ? dbPut('lib-current', id) : dbDel('lib-current'));

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 譜面から一覧に出す情報を作る */
export function entryOf(id: string, chart: EChart, prev: Partial<SongEntry> = {}, length?: number): SongEntry {
  const bpms = [chart.bpm];
  for (const c of chart.courses) for (const e of c.events) if (e.kind === 'bpm' && e.value > 0) bpms.push(e.value);
  return {
    id,
    title: chart.title || '（無題）',
    subtitle: chart.subtitle.replace(/^--/, ''),
    bpm: chart.bpm,
    bpmMin: Math.min(...bpms),
    bpmMax: Math.max(...bpms),
    length: length ?? prev.length ?? 0,
    courses: chart.courses.map((c) => ({ name: c.name, level: c.level })),
    folders: prev.folders ?? (prev.folder ? [prev.folder] : []),
    ...(prev.video ? { video: prev.video, videoOffset: prev.videoOffset } : {}),
    audioName: chart.wave,
    demoStart: chart.demoStart,
    updatedAt: Date.now(),
  };
}

/**
 * 曲の一覧・フォルダの一覧の「読んで → 変えて → 書く」は 1 つずつ順に行う。
 * 同時に行うと（何曲か同時に読み込むときなど）、後から書いたほうが先の変更を消してしまうため
 */
let libTail: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = libTail.then(fn, fn);
  libTail = p.catch(() => {});
  return p;
}

function writeIndex(f: (list: SongEntry[]) => SongEntry[]) {
  return serial(async () => {
    const list = await listSongs();
    // 前の版の folder は持たない（folders に移してある）
    await dbPut(kIndex, f(list).map(({ folder: _old, ...x }) => x));
  });
}

/**
 * 一覧を直す（同時に書いて消えてしまったものを戻す）:
 * - 譜面は保存してあるのに一覧から消えた曲を、一覧に戻す（入っていたフォルダは分からないので未分類）
 * - 曲が入っているのにフォルダの一覧に無いフォルダ（と、その上のフォルダ）を足す
 * 戻した曲の数を返す
 */
export async function repairLibrary(): Promise<number> {
  const keys = await dbKeys('lib-chart-');
  let back = 0;
  // ほかの書き込みが終わってから見る
  await serial(async () => {});
  const list = await listSongs();
  const have = new Set(list.map((x) => x.id));
  const lost = keys.map((k) => k.slice('lib-chart-'.length)).filter((id) => id && !have.has(id));
  const add: SongEntry[] = [];
  for (const id of lost) {
    const data = await dbGet<SongData>(kChart(id));
    if (!data?.chart) continue;
    // 曲の長さは .ogg ならファイルの情報から読む（読めなければ空のまま）
    const au = await dbGet<AudioFile>(kAudio(id));
    const len = au?.data ? oggDuration(au.data) ?? 0 : 0;
    add.push(entryOf(id, data.chart, { folders: [] }, len));
  }
  if (add.length) {
    await writeIndex((l) => [...l.filter((x) => !add.some((a) => a.id === x.id)), ...add]);
    back = add.length;
  }
  const used = [...new Set(list.flatMap((x) => x.folders))];
  await serial(async () => {
    const fs = await listFolders();
    const miss = used.flatMap((f) => [...folderParents(f), f]).filter((f, i, a) => !fs.includes(f) && a.indexOf(f) === i);
    if (miss.length) await dbPut(kFolders, [...fs, ...miss]);
  });
  return back;
}

/** 曲を保存する（audio は undefined なら音源はそのまま、null なら消す。folder は新しい曲を入れるフォルダ） */
export async function saveSong(id: string, data: SongData, audio?: AudioFile | null, length?: number, folder?: string) {
  await dbPut(kChart(id), data);
  if (audio !== undefined) {
    if (audio) await dbPut(kAudio(id), audio);
    else await dbDel(kAudio(id));
  }
  await writeIndex((list) => {
    const prev = list.find((x) => x.id === id);
    const folders = prev ? prev.folders : folder ? [folder] : [];
    const e = entryOf(id, data.chart, { ...prev, folders }, audio === null ? 0 : length);
    return prev ? list.map((x) => (x.id === id ? e : x)) : [...list, e];
  });
}

export async function deleteSong(id: string) {
  await dbDel(kChart(id));
  await dbDel(kAudio(id));
  await dbDel(kVideo(id));
  await writeIndex((list) => list.filter((x) => x.id !== id));
}

/** 背景の動画を入れる・消す（null で消す） */
export async function saveSongVideo(id: string, v: VideoFile | null) {
  if (v) await dbPut(kVideo(id), v.fromAudio ? { name: v.name, data: null, fromAudio: true } : v);
  else await dbDel(kVideo(id));
  await writeIndex((list) => list.map((x) => (x.id === id ? { ...x, video: v?.name } : x)));
}

/** 背景の動画（音源と同じファイルなら、音源のデータを使う） */
export async function loadSongVideo(id: string): Promise<{ name: string; data: ArrayBuffer; fromAudio: boolean } | null> {
  const v = await dbGet<VideoFile>(kVideo(id));
  if (!v) return null;
  if (v.fromAudio) {
    const a = await dbGet<AudioFile>(kAudio(id));
    return a ? { name: v.name, data: a.data, fromAudio: true } : null;
  }
  return v.data ? { name: v.name, data: v.data, fromAudio: false } : null;
}

/** 動画のずれ（秒）を変える */
export async function setVideoOffset(id: string, sec: number) {
  await writeIndex((list) => list.map((x) => (x.id === id ? { ...x, videoOffset: sec } : x)));
}

/** 曲（いくつでも）をフォルダに入れる（ほかのフォルダからは外さない） */
export async function addToFolder(ids: string[], folder: string) {
  await addFolder(folder);
  await writeIndex((list) => list.map((x) => (ids.includes(x.id) && !x.folders.includes(folder) ? { ...x, folders: [...x.folders, folder] } : x)));
}

/** 曲（いくつでも）をフォルダから外す */
export async function removeFromFolder(ids: string[], folder: string) {
  await writeIndex((list) => list.map((x) => (ids.includes(x.id) ? { ...x, folders: x.folders.filter((f) => f !== folder) } : x)));
}

/**
 * フォルダは「親/子/孫」のように / でつないだ道のりで表す（フォルダの中のフォルダ）。
 * f が root そのものか、root の中（下のどこか）にあるか
 */
export const inFolderTree = (f: string, root: string) => f === root || f.startsWith(`${root}/`);
/** 道のりの親たち（"A/B/C" → ["A", "A/B"]） */
export const folderParents = (f: string) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'));

/** フォルダを作る（親のフォルダも無ければ作る） */
export function addFolder(name: string) {
  return serial(async () => {
    const fs = await listFolders();
    const add = [...folderParents(name), name].filter((f) => !fs.includes(f));
    if (add.length) await dbPut(kFolders, [...fs, ...add]);
  });
}

/** フォルダの名前（道のり）を変える。中のフォルダもいっしょに移る */
export async function renameFolder(from: string, to: string) {
  const mv = (f: string) => (inFolderTree(f, from) ? to + f.slice(from.length) : f);
  await serial(async () => {
    const fs = await listFolders();
    await dbPut(kFolders, [...fs.map(mv), ...folderParents(to)].filter((f, i, a) => a.indexOf(f) === i));
    // 色もいっしょに移す
    for (const key of [kFolderColors, kFolderFonts]) {
      const cs = (await dbGet<Record<string, string>>(key)) ?? {};
      if (Object.keys(cs).some((f) => inFolderTree(f, from))) await dbPut(key, Object.fromEntries(Object.entries(cs).map(([f, c]) => [mv(f), c])));
    }
  });
  await writeIndex((list) => list.map((x) => (x.folders.some((f) => inFolderTree(f, from)) ? { ...x, folders: [...new Set(x.folders.map(mv))] } : x)));
}

/** フォルダを消す（中のフォルダも。曲は消さず、そのフォルダから外すだけ） */
export async function deleteFolder(name: string) {
  await serial(async () => {
    const fs = await listFolders();
    await dbPut(kFolders, fs.filter((f) => !inFolderTree(f, name)));
    for (const key of [kFolderColors, kFolderFonts]) {
      const cs = (await dbGet<Record<string, string>>(key)) ?? {};
      if (Object.keys(cs).some((f) => inFolderTree(f, name))) await dbPut(key, Object.fromEntries(Object.entries(cs).filter(([f]) => !inFolderTree(f, name))));
    }
  });
  await writeIndex((list) => list.map((x) => (x.folders.some((f) => inFolderTree(f, name)) ? { ...x, folders: x.folders.filter((f) => !inFolderTree(f, name)) } : x)));
}

/** バックアップから戻す: 曲を、同じ id のまま入れる（同じ id の曲があれば置き換える） */
export async function restoreSong(entry: SongEntry, data: SongData, audio: AudioFile | null) {
  await dbPut(kChart(entry.id), data);
  if (audio) await dbPut(kAudio(entry.id), audio);
  else await dbDel(kAudio(entry.id));
  await writeIndex((list) => [...list.filter((x) => x.id !== entry.id), norm(entry)]);
  for (const f of norm(entry).folders) await addFolder(f);
}

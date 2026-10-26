import type { EChart } from '../chart/model';
import type { AudioFile } from './load';
import { dbGet, dbPut, dbDel } from './storage';

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
  demoStart: number;
  updatedAt: number;
}

export interface SongData {
  chart: EChart;
  courseIndex: number;
}

const kIndex = 'lib-index';
const kFolders = 'lib-folders';
const kChart = (id: string) => `lib-chart-${id}`;
const kAudio = (id: string) => `lib-audio-${id}`;

/** 前の版（フォルダが 1 つだけ）の一覧を、今の形（いくつでも）に直す */
const norm = (x: SongEntry): SongEntry => {
  if (Array.isArray(x.folders)) return x;
  const { folder, ...rest } = x;
  return { ...rest, folders: folder ? [folder] : [] };
};
export const listSongs = async () => ((await dbGet<SongEntry[]>(kIndex)) ?? []).map(norm);
export const listFolders = async () => (await dbGet<string[]>(kFolders)) ?? [];
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
    audioName: chart.wave,
    demoStart: chart.demoStart,
    updatedAt: Date.now(),
  };
}

async function writeIndex(f: (list: SongEntry[]) => SongEntry[]) {
  const list = await listSongs();
  // 前の版の folder は持たない（folders に移してある）
  await dbPut(kIndex, f(list).map(({ folder: _old, ...x }) => x));
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
  await writeIndex((list) => list.filter((x) => x.id !== id));
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
export async function addFolder(name: string) {
  const fs = await listFolders();
  const add = [...folderParents(name), name].filter((f) => !fs.includes(f));
  if (add.length) await dbPut(kFolders, [...fs, ...add]);
}

/** フォルダの名前（道のり）を変える。中のフォルダもいっしょに移る */
export async function renameFolder(from: string, to: string) {
  const mv = (f: string) => (inFolderTree(f, from) ? to + f.slice(from.length) : f);
  const fs = await listFolders();
  await dbPut(kFolders, [...fs.map(mv), ...folderParents(to)].filter((f, i, a) => a.indexOf(f) === i));
  await writeIndex((list) => list.map((x) => (x.folders.some((f) => inFolderTree(f, from)) ? { ...x, folders: [...new Set(x.folders.map(mv))] } : x)));
}

/** フォルダを消す（中のフォルダも。曲は消さず、そのフォルダから外すだけ） */
export async function deleteFolder(name: string) {
  const fs = await listFolders();
  await dbPut(kFolders, fs.filter((f) => !inFolderTree(f, name)));
  await writeIndex((list) => list.map((x) => (x.folders.some((f) => inFolderTree(f, name)) ? { ...x, folders: x.folders.filter((f) => !inFolderTree(f, name)) } : x)));
}

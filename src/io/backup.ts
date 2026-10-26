/**
 * バックアップ（曲・音源・背景の動画・フォルダ・遊んだ記録をまとめて 1 つの .zip に書き出す・戻す）。
 * 音源が多いと大きくなるので、だいたい 80MB ごとに分けて書き出す（戻すときは全部まとめて選べばよい）
 */
import { addFolder, listFolders, listSongs, loadSongAudio, loadSongData, loadSongVideo, restoreSong, saveSongVideo, type SongData, type SongEntry } from './library';
import type { ZipEntry } from './zip';
import { writeZip } from './zip';

export const BACKUP_MANIFEST = 'tjatelier-backup.json';
const BEST = 'malody-web:best';
const PART_BYTES = 80 * 1024 * 1024;

interface Manifest {
  app: 'TJAtelier';
  version: 1;
  createdAt: number;
  part: number;
  parts: number;
  folders: string[];
  best: Record<string, { score: number; crown: string }>;
  songs: { entry: SongEntry; audioName: string | null; videoName?: string; videoFromAudio?: boolean }[];
}

const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

/** バックアップを作る。1 つ作るごとに save に渡す（大きいときは何回か） */
export async function exportBackup(save: (blob: Blob, name: string) => Promise<void> | void, progress?: (r: number) => void) {
  const songs = await listSongs();
  const folders = await listFolders();
  let best = {};
  try { best = JSON.parse(localStorage.getItem(BEST) ?? '{}'); } catch { /* 無い */ }
  // 音源の大きさで分ける（一覧の情報だけで先に決める）
  const groups: SongEntry[][] = [[]];
  let size = 0;
  for (const s of songs) {
    const a = await loadSongAudio(s.id);
    const v = s.video ? await loadSongVideo(s.id) : null;
    const n = (a?.data.byteLength ?? 0) + (v && !v.fromAudio ? v.data.byteLength : 0);
    if (size + n > PART_BYTES && groups[groups.length - 1].length) { groups.push([]); size = 0; }
    groups[groups.length - 1].push(s);
    size += n;
  }
  const name = `TJAtelier-backup-${stamp()}`;
  const enc = new TextEncoder();
  let done = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const files: { name: string; data: Uint8Array; compress?: boolean }[] = [];
    const list: Manifest['songs'] = [];
    for (const s of groups[gi]) {
      const data = await loadSongData(s.id);
      if (!data) continue;
      files.push({ name: `charts/${s.id}.json`, data: enc.encode(JSON.stringify(data)), compress: true });
      const a = await loadSongAudio(s.id);
      if (a) files.push({ name: `audio/${s.id}/${a.name}`, data: new Uint8Array(a.data) });
      // 背景の動画（音源と同じファイルなら入れない）
      const v = s.video ? await loadSongVideo(s.id) : null;
      if (v && !v.fromAudio) files.push({ name: `video/${s.id}/${v.name}`, data: new Uint8Array(v.data) });
      list.push({ entry: s, audioName: a?.name ?? null, ...(v ? { videoName: v.name, videoFromAudio: v.fromAudio } : {}) });
      progress?.(++done / Math.max(1, songs.length));
    }
    const m: Manifest = { app: 'TJAtelier', version: 1, createdAt: Date.now(), part: gi + 1, parts: groups.length, folders, best, songs: list };
    files.unshift({ name: BACKUP_MANIFEST, data: enc.encode(JSON.stringify(m)), compress: true });
    const blob = await writeZip(files);
    await save(blob, groups.length > 1 ? `${name}-${gi + 1}of${groups.length}.zip` : `${name}.zip`);
  }
  return { songs: songs.length, parts: groups.length };
}

/** zip の中身がバックアップか */
export const isBackup = (entries: ZipEntry[]) => entries.some((e) => e.name === BACKUP_MANIFEST);

/** バックアップから戻す（今ある曲はそのまま。同じ曲は置き換える）。戻した曲の数 */
export async function importBackup(entries: ZipEntry[]): Promise<number> {
  const me = entries.find((e) => e.name === BACKUP_MANIFEST);
  if (!me) return 0;
  const m = JSON.parse(new TextDecoder().decode(me.data)) as Manifest;
  if (m.app !== 'TJAtelier') throw new Error('TJAtelier のバックアップではありません');
  const byName = new Map(entries.map((e) => [e.name, e]));
  let n = 0;
  for (const { entry, audioName, videoName, videoFromAudio } of m.songs) {
    const c = byName.get(`charts/${entry.id}.json`);
    if (!c) continue;
    const data = JSON.parse(new TextDecoder().decode(c.data)) as SongData;
    const a = audioName ? byName.get(`audio/${entry.id}/${audioName}`) : undefined;
    const audio = a ? { name: audioName!, data: a.data.buffer.slice(a.data.byteOffset, a.data.byteOffset + a.data.byteLength) as ArrayBuffer } : null;
    await restoreSong(entry, data, audio);
    if (videoName) {
      const v = videoFromAudio ? null : byName.get(`video/${entry.id}/${videoName}`);
      if (videoFromAudio) await saveSongVideo(entry.id, { name: videoName, data: null, fromAudio: true });
      else if (v) await saveSongVideo(entry.id, { name: videoName, data: v.data.buffer.slice(v.data.byteOffset, v.data.byteOffset + v.data.byteLength) as ArrayBuffer });
    }
    n++;
  }
  // 遊んだ記録は、良いほうを残す
  try {
    const cur = JSON.parse(localStorage.getItem(BEST) ?? '{}') as Manifest['best'];
    const rank: Record<string, number> = { fail: 0, clear: 1, fc: 2, allgood: 3 };
    for (const [k, v] of Object.entries(m.best ?? {})) {
      const p = cur[k];
      cur[k] = { score: Math.max(v.score, p?.score ?? 0), crown: !p || (rank[v.crown] ?? 0) > (rank[p.crown] ?? 0) ? v.crown : p.crown };
    }
    localStorage.setItem(BEST, JSON.stringify(cur));
  } catch { /* 残せない */ }
  // 空のフォルダも戻す
  for (const f of m.folders ?? []) await addFolder(f);
  return n;
}

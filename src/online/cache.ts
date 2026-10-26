/**
 * オンラインで受け取った音源をとっておく（同じ曲をもう一度遊ぶとき・次に同じ曲が予約されたときに、受け取らずに済むように）。
 * 新しい 12 曲まで。ブラウザの中（IndexedDB）に置く
 */
import { dbDel, dbGet, dbPut } from '../io/storage';

const INDEX = 'olcache-index';
const MAX = 12;
const key = (hash: string) => `olcache-${hash}`;

export async function getCachedAudio(hash: string): Promise<ArrayBuffer | null> {
  if (!hash) return null;
  try {
    const v = await dbGet<ArrayBuffer>(key(hash));
    if (!v) return null;
    // 使ったものを新しい側へ
    const list = ((await dbGet<string[]>(INDEX)) ?? []).filter((h) => h !== hash);
    await dbPut(INDEX, [...list, hash]);
    return v;
  } catch {
    return null;
  }
}

export async function putCachedAudio(hash: string, data: ArrayBuffer) {
  if (!hash) return;
  try {
    await dbPut(key(hash), data);
    const list = ((await dbGet<string[]>(INDEX)) ?? []).filter((h) => h !== hash);
    list.push(hash);
    while (list.length > MAX) await dbDel(key(list.shift()!));
    await dbPut(INDEX, list);
  } catch {
    // とっておけなくても遊べる
  }
}

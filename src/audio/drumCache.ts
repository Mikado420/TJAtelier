// 曲から取り出したドラムの音を端末（IndexedDB）に取っておき、同じ曲なら取り出しを飛ばす

const DB = 'tjatelier-drums';
const STORE = 'drums';
/** いつ取っておいたか（中身を読まずに古いものを探すため） */
const META = 'meta';
/** 取っておく曲の数（古いものから消す） */
const KEEP = 4;

/** 曲の中身から作る目印（長さ・周波数と、飛び飛びの値） */
export function audioKey(mono: Float32Array, sr: number): string {
  let h = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(mono.length / 20000));
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < mono.length; i += step) {
    f[0] = mono[i];
    h = Math.imul(h ^ u[0], 16777619) >>> 0;
  }
  return `${mono.length}:${sr}:${h.toString(36)}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((ok, ng) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(STORE);
      r.result.createObjectStore(META);
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => ng(r.error);
  });
}

type Rec = { drums: Float32Array; sr: number };

export async function loadDrums(key: string): Promise<{ drums: Float32Array; sr: number } | null> {
  try {
    const db = await open();
    const rec = await new Promise<Rec | undefined>((ok, ng) => {
      const r = db.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => ok(r.result as Rec | undefined);
      r.onerror = () => ng(r.error);
    });
    db.close();
    return rec ? { drums: rec.drums, sr: rec.sr } : null;
  } catch {
    return null;
  }
}

export async function saveDrums(key: string, drums: Float32Array, sr: number): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((ok, ng) => {
      const tx = db.transaction([STORE, META], 'readwrite');
      const st = tx.objectStore(STORE);
      const mt = tx.objectStore(META);
      st.put({ drums, sr } satisfies Rec, key);
      mt.put(Date.now(), key);
      const ats = mt.getAll();
      const keys = mt.getAllKeys();
      tx.oncomplete = () => ok();
      tx.onerror = () => ng(tx.error);
      keys.onsuccess = () => {
        const recs = (ats.result as number[]).map((at, i) => ({ k: keys.result[i], at })).sort((a, b) => b.at - a.at);
        for (const r of recs.slice(KEEP)) {
          st.delete(r.k);
          mt.delete(r.k);
        }
      };
    });
    db.close();
  } catch {
    // 取っておけなくても、今回は使える
  }
}

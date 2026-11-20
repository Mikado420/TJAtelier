import type { Note, NoteType } from './types';

/** 演奏オプションの、譜面を変えるもの（あべこべ・ランダム） */
export interface NoteMods {
  /** あべこべ: ドンとカッを全部入れ替える */
  mirror?: boolean;
  /** ランダム: きまぐれ（ときどき）・でたらめ（半分ほど）ドンとカッを入れ替える */
  random?: 'off' | 'kimagure' | 'detarame';
}

const SWAP: Partial<Record<NoteType, NoteType>> = { don: 'ka', ka: 'don', bigDon: 'bigKa', bigKa: 'bigDon' };
/** 1 つの音符が入れ替わる割合（本家の体感に合わせる: きまぐれ 4 つに 1 つ・でたらめ 2 つに 1 つ） */
const RATE = { kimagure: 0.25, detarame: 0.5 } as const;

/** 決まった種からの乱数（同じ譜面・同じ種なら、何度遊んでも同じ並びにする） */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** 演奏オプションで音符を変えた写しを返す（何も変えないときは同じ配列） */
export function applyMods(notes: Note[], mods: NoteMods, seed = Date.now()): Note[] {
  const rate = mods.random && mods.random !== 'off' ? RATE[mods.random] : 0;
  if (!mods.mirror && !rate) return notes;
  const r = rng(seed);
  return notes.map((n) => {
    const to = SWAP[n.type];
    if (!to) return n;
    let t = n.type;
    if (rate && r() < rate) t = to;
    if (mods.mirror) t = SWAP[t] ?? t;
    return t === n.type ? n : { ...n, type: t };
  });
}

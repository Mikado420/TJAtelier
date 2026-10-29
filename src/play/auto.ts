import type { Note } from '../chart/types';

/** オートで叩く 1 打 */
export interface AutoEvent {
  t: number;
  kind: 'don' | 'ka';
  /** この打撃で風船が割れる */
  pop?: boolean;
  /** 叩く音符（譜面分岐で通らない音符は叩かない） */
  note?: Note;
}

/** 連打は 1 秒に 35 打。風船は時間内に割れる速さ（上限 1 秒に 50 打） */
const ROLL_RATE = 35;
const BALLOON_MAX_RATE = 50;

/** オートで叩く予定を作る（音符・連打・風船） */
export function buildAutoEvents(notes: readonly Note[], from = -Infinity): AutoEvent[] {
  const ev: AutoEvent[] = [];
  for (const n of notes) {
    if (n.type === 'don' || n.type === 'bigDon') {
      if (n.time >= from - 0.05) ev.push({ t: n.time, kind: 'don', note: n });
    } else if (n.type === 'ka' || n.type === 'bigKa') {
      if (n.time >= from - 0.05) ev.push({ t: n.time, kind: 'ka', note: n });
    } else if (n.type === 'roll' || n.type === 'bigRoll') {
      const end = n.endTime ?? n.time;
      for (let t = n.time; t <= end + 1e-6; t += 1 / ROLL_RATE) if (t >= from) ev.push({ t, kind: 'don', note: n });
    } else if (n.type === 'balloon') {
      const end = n.endTime ?? n.time;
      const hits = Math.max(1, n.hits ?? 5);
      const dur = Math.max(0, end - n.time);
      // 受付時間の 9 割で割り切る速さ。ただし 1 秒 50 打まで
      const rate = Math.min(BALLOON_MAX_RATE, dur > 0 ? Math.max(1, (hits - 1) / (dur * 0.9)) : BALLOON_MAX_RATE);
      for (let k = 0; k < hits; k++) {
        const t = n.time + k / rate;
        if (t > end + 1e-6) break;
        if (t >= from) ev.push({ t, kind: 'don', pop: k === hits - 1, note: n });
      }
    }
  }
  return ev.sort((a, b) => a.t - b.t);
}


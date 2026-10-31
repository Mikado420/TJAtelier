/** 星の色: 'red' = 赤い星 / 'on' = 白い星 / 'off' = 無し */
export type Star = 'red' | 'on' | 'off';

/** 星 11〜20 は、星 1〜10 の位置を赤い星にして表す（10 個並べる） */
export function starSlots(level: number): Star[] {
  const lv = Math.max(0, Math.min(20, Math.round(level)));
  return Array.from({ length: 10 }, (_, k) => (lv > 10 ? (k < lv - 10 ? 'red' : 'on') : k < lv ? 'on' : 'off'));
}

export const STAR_RED = '#ff3b3b';

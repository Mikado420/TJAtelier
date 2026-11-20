/** 色を決めていないフォルダの色（名前から決まる。いつもの一覧と TNDE の選曲画面で同じ色にする） */
export const FOLDER_COLORS = ['#3a7ca5', '#7b4bd0', '#c8337e', '#1fa59a', '#e8603c', '#c9a227', '#5a8f3c', '#b3477a'];

export function nameColor(key: string) {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}

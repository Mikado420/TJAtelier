/**
 * Expo Go のアプリ（expo/App.js）の中では、Web のダウンロード（<a download>）が動かない。
 * そこでファイルを base64 に分けてアプリへ送り、アプリが保存して共有シート（「ファイルに保存」など）を開く。
 */
type RN = { postMessage(s: string): void };
const rn = () => (window as unknown as { ReactNativeWebView?: RN }).ReactNativeWebView;

export const canNativeSave = () => !!rn();

/** 1 回に送る大きさ（base64 の文字数） */
const CHUNK = 512 * 1024;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** アプリへファイルを渡す。アプリの中でなければ false */
export async function nativeSave(blob: Blob, name: string, mime = blob.type || 'application/octet-stream'): Promise<boolean> {
  const host = rn();
  if (!host) return false;
  const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = Math.max(1, Math.ceil(b64.length / CHUNK));
  for (let i = 0; i < total; i++) {
    host.postMessage(JSON.stringify({ type: 'file', id, name, mime, part: i, total, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) }));
    // 大きいときは少しずつ（アプリ側が詰まらないように）
    if (total > 1) await new Promise((r) => setTimeout(r, 0));
  }
  return true;
}

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

type W = { __nativeFileAck?: (id: string) => void; __nativeSaveError?: (msg: string) => void };
const acks = new Map<string, () => void>();
let onError: (msg: string) => void = () => {};
(window as unknown as W).__nativeFileAck = (id) => { acks.get(id)?.(); acks.delete(id); };
(window as unknown as W).__nativeSaveError = (msg) => onError(msg);
// アプリからの WebView.postMessage（もう一つの道）
const onMsg = (e: Event) => {
  try {
    const m = JSON.parse(String((e as MessageEvent).data));
    if (m && m.type === 'fileAck') (window as unknown as W).__nativeFileAck?.(m.id);
  } catch { /* 関係ないメッセージ */ }
};
window.addEventListener('message', onMsg);
document.addEventListener('message', onMsg);
/** アプリ本体の版（古いアプリでは無い） */
export const nativeAppVersion = () => (window as unknown as { __nativeApp?: number }).__nativeApp ?? 0;
/** アプリで保存に失敗したときに知らせる先 */
export function onNativeSaveError(f: (msg: string) => void) { onError = f; }

/**
 * アプリへファイルを渡す。
 * 'ok' = アプリが受け取った / 'old' = アプリが受け取らなかった（古い版のアプリ） / 'none' = アプリの中ではない
 */
export async function nativeSave(blob: Blob, name: string, mime = blob.type || 'application/octet-stream'): Promise<'ok' | 'old' | 'none'> {
  const host = rn();
  if (!host) return 'none';
  const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = Math.max(1, Math.ceil(b64.length / CHUNK));
  const acked = new Promise<boolean>((res) => {
    acks.set(id, () => res(true));
    setTimeout(() => { acks.delete(id); res(false); }, 4000);
  });
  for (let i = 0; i < total; i++) {
    host.postMessage(JSON.stringify({ type: 'file', id, name, mime, part: i, total, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) }));
    // 大きいときは少しずつ（アプリ側が詰まらないように）
    if (total > 1) await new Promise((r) => setTimeout(r, 0));
  }
  return (await acked) ? 'ok' : 'old';
}

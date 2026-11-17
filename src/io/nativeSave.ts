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

type W = { __nativeFileAck?: (id: string, part?: number | string) => void; __nativeSaveError?: (msg: string) => void };
const acks = new Map<string, () => void>();
let onError: (msg: string) => void = () => {};
// part 付き = 大きいファイルを順に送るときの、1 つずつの受け取り
(window as unknown as W).__nativeFileAck = (id, part) => {
  const k = part === undefined ? id : `${id}:${part}`;
  acks.get(k)?.();
  acks.delete(k);
};
(window as unknown as W).__nativeSaveError = (msg) => onError(msg);
// アプリからの WebView.postMessage（もう一つの道）
const onMsg = (e: Event) => {
  try {
    const m = JSON.parse(String((e as MessageEvent).data));
    if (m && m.type === 'fileAck') (window as unknown as W).__nativeFileAck?.(m.id, m.part);
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
  if (nativeAppVersion() >= 8) return streamSave(host, blob, name, mime);
  const b64 = toBase64(new Uint8Array(await blob.arrayBuffer()));
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = Math.max(1, Math.ceil(b64.length / CHUNK));
  let got = false;
  let done: (ok: boolean) => void = () => {};
  const acked = new Promise<boolean>((res) => { done = res; });
  acks.set(id, () => { got = true; done(true); });
  for (let i = 0; i < total; i++) {
    host.postMessage(JSON.stringify({ type: 'file', id, name, mime, part: i, total, data: b64.slice(i * CHUNK, (i + 1) * CHUNK) }));
    // 大きいときは少しずつ（アプリ側が詰まらないように）
    if (total > 1) await new Promise((r) => setTimeout(r, 0));
  }
  // 大きいファイル（譜面画像など）はアプリが受け取るまで時間がかかるので、送り終えてから大きさに応じて待つ
  if (!got) setTimeout(() => { acks.delete(id); done(false); }, 6000 + total * 1500);
  return (await acked) ? 'ok' : 'old';
}

/** 1 回に送る大きさ（バイト。base64 にすると 4/3 倍） */
const PART = 3 * 1024 * 1024;
/** 受け取りを待たずに送ってよい数 */
const AHEAD = 4;

/** 受け取りの知らせを待つ（来なければ false） */
function waitAck(key: string, ms: number) {
  return new Promise<boolean>((res) => {
    const t = setTimeout(() => {
      acks.delete(key);
      res(false);
    }, ms);
    acks.set(key, () => {
      clearTimeout(t);
      res(true);
    });
  });
}

/**
 * 大きいファイル（録画した動画など）を、少しずつ読みながら送る。アプリは届いた所から順にファイルへ書き足す。
 * どちらも全部をメモリにためないので、大きくても落ちない
 */
async function streamSave(host: RN, blob: Blob, name: string, mime: string): Promise<'ok' | 'old'> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const total = Math.max(1, Math.ceil(blob.size / PART));
  const started = waitAck(`${id}:-1`, 8000);
  host.postMessage(JSON.stringify({ type: 'fileStart', id, name, mime, size: blob.size, total }));
  if (!(await started)) return 'old';
  const pending: Promise<boolean>[] = [];
  for (let i = 0; i < total; i++) {
    // 先に送った分の受け取りを待つ（アプリ側が詰まらないように）
    if (pending.length >= AHEAD) {
      if (!(await pending.shift()!)) throw new Error('アプリが受け取れませんでした');
    }
    const bytes = new Uint8Array(await blob.slice(i * PART, Math.min(blob.size, (i + 1) * PART)).arrayBuffer());
    pending.push(waitAck(`${id}:${i}`, 60000));
    host.postMessage(JSON.stringify({ type: 'filePart', id, part: i, data: toBase64(bytes) }));
  }
  for (const p of pending) if (!(await p)) throw new Error('アプリが受け取れませんでした');
  const ended = waitAck(`${id}:end`, 30000);
  host.postMessage(JSON.stringify({ type: 'fileEnd', id, mime }));
  if (!(await ended)) throw new Error('アプリが受け取れませんでした');
  return 'ok';
}

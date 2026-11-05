import { separateDrums, SR, type DemucsBackend } from './demucs';

/**
 * 音源分離（HTDemucs）で曲からドラムだけを取り出す。拍の AI・BPM の測定とは別のスレッドで動かし、
 * 終わったらこのスレッドを閉じて、分離に使ったメモリを返してから次へ進む
 */
const ctx = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<{ mono: Float32Array; sr: number; base: string; prefer?: DemucsBackend[] }>) => void) | null;
};
ctx.onmessage = async (e) => {
  const { mono, sr, base, prefer } = e.data;
  try {
    const { drums, backend } = await separateDrums(mono, sr, base, (p) => ctx.postMessage({ type: 'progress', p }), prefer, (b) => ctx.postMessage({ type: 'backend', backend: b }));
    ctx.postMessage({ type: 'done', drums, sr: SR, backend }, [drums.buffer]);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

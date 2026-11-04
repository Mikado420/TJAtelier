import { runBeatThis } from './beatThis';

/**
 * 拍の AI（Beat This!）を、BPM の測定とは別のスレッドで動かす。
 * AI の実行環境が使ったメモリは、スレッドを閉じるまで返らないので、AI が終わったらこのスレッドを閉じてから測る
 * （同じスレッドで続けて測ると、AI の分と測る分のメモリが重なって、iPhone のアプリが落ちる）
 */
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<{ mono: Float32Array; sr: number; base: string }>) => void) | null;
};
ctx.onmessage = async (e) => {
  const { mono, sr, base } = e.data;
  try {
    const ai = await runBeatThis(mono, sr, base, (p) => ctx.postMessage({ type: 'progress', p }));
    ctx.postMessage({ type: 'done', ai });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

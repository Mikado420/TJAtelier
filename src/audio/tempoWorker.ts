import { analyzeTempo, type TempoOptions } from './tempo';

/** BPM・OFFSET の測定を、画面を止めないように別のスレッドで行う（拍の AI の結果は opts.ai で受け取る） */
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<{ mono: Float32Array; sr: number; opts?: TempoOptions }>) => void) | null;
};
ctx.onmessage = (e) => {
  const { mono, sr, opts } = e.data;
  try {
    const result = analyzeTempo(mono, sr, (p) => ctx.postMessage({ type: 'progress', p }), opts ?? {});
    ctx.postMessage({ type: 'done', result });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

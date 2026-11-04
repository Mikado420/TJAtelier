import { analyzeTempo, type TempoOptions } from './tempo';
import { runBeatThis, type BeatAI } from './beatThis';

/**
 * BPM・OFFSET の測定を、画面を止めないように別のスレッドで行う。
 * aiBase があれば、先に拍の AI（Beat This!）で拍と小節の頭を求めてから測る（opts.ai が渡されていればそれを使う）
 */
const ctx = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<{ mono: Float32Array; sr: number; opts?: TempoOptions; aiBase?: string }>) => void) | null;
};
ctx.onmessage = async (e) => {
  const { mono, sr, opts, aiBase } = e.data;
  let ai: BeatAI | undefined = opts?.ai;
  // 拍の AI の分（0〜0.7）と、これまでの測り方の分（0.7〜1）
  const AI = !ai && aiBase ? 0.7 : 0;
  if (!ai && aiBase) {
    try {
      ai = await runBeatThis(mono, sr, aiBase, (p) => ctx.postMessage({ type: 'progress', p: p * AI }));
    } catch (err) {
      // 拍の AI が使えないとき（読み込めない・端末が対応していない）は、これまでの測り方だけで測る
      console.warn('拍の AI を使えませんでした', err);
      ai = undefined;
    }
  }
  try {
    const result = analyzeTempo(mono, sr, (p) => ctx.postMessage({ type: 'progress', p: AI + p * (1 - AI) }), { ...(opts ?? {}), ai });
    ctx.postMessage({ type: 'done', result, ai });
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

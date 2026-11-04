import { activations, dbnDownbeats, featureBlock, parseModel, to44k, type MadmomModel } from './madmom';

/**
 * 拍の AI（madmom）の計算を、いくつかのスレッドに分けて行うためのもの。
 * feat: 窓の大きさ 1 つ分の特徴 / nn: 8 個のモデルのうちいくつか / dbn: 拍と小節の頭を決める
 */
type Msg =
  | { type: 'feat'; model: ArrayBuffer; mono: Float32Array; sr: number; ri: number }
  | { type: 'nn'; model: ArrayBuffer; feat: Float32Array; frames: number; dim: number; only: number[] }
  | { type: 'dbn'; act: Float32Array; frames: number };

const ctx = self as unknown as {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
};
let model: { buf: ArrayBuffer; m: MadmomModel } | null = null;
const getModel = (buf: ArrayBuffer) => {
  if (!model || model.buf.byteLength !== buf.byteLength) model = { buf, m: parseModel(buf) };
  return model.m;
};

ctx.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === 'feat') {
      const m = getModel(d.model);
      const block = featureBlock(m, to44k(d.mono, d.sr), d.ri);
      ctx.postMessage({ type: 'done', block }, [block.buffer]);
    } else if (d.type === 'nn') {
      const m = getModel(d.model);
      const act = await activations(m, d.feat, d.frames, d.dim, (p) => ctx.postMessage({ type: 'progress', p }), d.only);
      ctx.postMessage({ type: 'done', act }, [act.buffer]);
    } else {
      ctx.postMessage({ type: 'done', result: dbnDownbeats(d.act, d.frames) });
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

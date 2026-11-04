import { frameCount, parseModel, stackBlocks, type MadmomResult } from './madmom';

/**
 * 拍の AI（madmom）を、いくつかのスレッドに分けて動かす（画面のスレッドから呼ぶ）。
 * 1. 窓の大きさ 3 つの特徴を、3 つのスレッドで  2. 8 個のモデルを、使えるスレッドに分けて  3. 拍と小節の頭を決める
 * progress は 0〜1
 */
let modelBuf: Promise<ArrayBuffer> | null = null;

export async function runMadmomParallel(mono: Float32Array, sr: number, progress?: (p: number) => void): Promise<MadmomResult> {
  modelBuf ??= fetch(new URL('./ai/madmom-downbeats.bin', location.href).href).then((r) => {
    if (!r.ok) throw new Error(`拍の AI を読めませんでした（${r.status}）`);
    return r.arrayBuffer();
  });
  let buf: ArrayBuffer;
  try {
    buf = await modelBuf;
  } catch (err) {
    modelBuf = null;
    throw err;
  }
  const m = parseModel(buf);
  const cores = Math.max(1, (navigator.hardwareConcurrency || 2) - 1);
  const K = Math.min(4, cores);
  const pool: Worker[] = [];
  const worker = (i: number) => (pool[i] ??= new Worker(new URL('./madmomWorker.ts', import.meta.url), { type: 'module' }));
  // 1 つのスレッドには 1 度に 1 つの仕事だけ（前の仕事が終わってから次を渡す）
  const busy: Promise<unknown>[] = [];
  const call = <T>(i: number, msg: unknown, onProgress?: (p: number) => void): Promise<T> => {
    const job = (busy[i] ?? Promise.resolve()).catch(() => undefined).then(() => send<T>(i, msg, onProgress));
    busy[i] = job;
    return job;
  };
  const send = <T>(i: number, msg: unknown, onProgress?: (p: number) => void) =>
    new Promise<T>((res, rej) => {
      const w = worker(i);
      w.onmessage = (e: MessageEvent<{ type: string; p?: number; message?: string } & T>) => {
        if (e.data.type === 'progress') onProgress?.(e.data.p ?? 0);
        else if (e.data.type === 'error') rej(new Error(e.data.message));
        else res(e.data);
      };
      w.onerror = (ev) => rej(new Error(ev.message || '拍の AI を動かせませんでした'));
      w.postMessage(msg);
    });
  try {
    // 1. 特徴（窓の大きさごと）
    const x44 = sr === 44100 ? mono.length : Math.floor((mono.length * 44100) / sr);
    const frames = frameCount(m, x44);
    let doneFeat = 0;
    const blocks = await Promise.all(
      m.head.res.map((_, ri) =>
        call<{ block: Float32Array }>(ri % Math.max(K, 1), { type: 'feat', model: buf, mono, sr, ri }).then((r) => {
          progress?.(0.2 * (++doneFeat / m.head.res.length));
          return r.block;
        }),
      ),
    );
    const { feat, dim } = stackBlocks(m, blocks, frames);
    // 2. モデルをスレッドに分ける
    const n = m.head.models.length;
    const parts: number[][] = Array.from({ length: K }, () => []);
    for (let i = 0; i < n; i++) parts[i % K].push(i);
    const prog = new Array(K).fill(0);
    const acts = await Promise.all(
      parts.map((only, i) =>
        call<{ act: Float32Array }>(i, { type: 'nn', model: buf, feat, frames, dim, only }, (p) => {
          prog[i] = p;
          progress?.(0.2 + (0.75 * prog.reduce((a, b) => a + b, 0)) / K);
        }).then((r) => r.act),
      ),
    );
    // それぞれのスレッドは、受け持ったモデルの平均を返す → モデルの数で重みを付けて平均
    const act = new Float32Array(frames * 2);
    acts.forEach((a, i) => {
      const w = parts[i].length / n;
      for (let j = 0; j < act.length; j++) act[j] += a[j] * w;
    });
    // 3. 拍と小節の頭
    const r = await call<{ result: MadmomResult }>(0, { type: 'dbn', act, frames });
    progress?.(1);
    return r.result;
  } finally {
    for (const w of pool) w?.terminate();
  }
}

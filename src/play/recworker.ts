/**
 * 録画の別スレッド: 渡された区間を描いて H.264 にし、できたものを画面のスレッドへ返す
 */
import './recshim';
import { SegRenderer, type RecPlan } from './recseg';

type Msg =
  | { type: 'init'; plan: RecPlan; fonts: [string, string][] }
  | { type: 'seg'; k: number; a: number; b: number }
  | { type: 'skip'; k: number }
  | { type: 'stop' };

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
let seg: SegRenderer | null = null;
let stop = false;
/** 画面のスレッドが先に描き終えた区間（やめる） */
let skip = -1;

self.onmessage = async (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const set = (self as unknown as { fonts?: FontFaceSet }).fonts;
      if (!set) throw new Error('fonts');
      await Promise.all(
        m.fonts.map(async ([name, url]) => {
          const ff = new FontFace(name, `url(${url})`);
          set.add(ff);
          await Promise.race([ff.load(), new Promise((r) => setTimeout(r, 10000))]).catch(() => {});
        }),
      );
      seg = await SegRenderer.create(m.plan);
      post({ type: 'ready' });
    } catch (err) {
      post({ type: 'fail', msg: String((err as Error)?.message ?? err) });
    }
  } else if (m.type === 'seg') {
    // 絵を読み込んでいる間なども、止まっていないと知らせる
    const alive = setInterval(() => post({ type: 'alive' }), 2000);
    try {
      if (!seg) throw new Error('not ready');
      await seg.render(
        m.a,
        m.b,
        (c) => post({ type: 'chunk', k: m.k, data: c.data, key: c.key, avcC: c.avcC, ts: c.ts }, [c.data.buffer]),
        () => stop || skip === m.k,
        (n) => post({ type: 'frames', n }),
      );
      post({ type: 'done', k: m.k });
    } catch (err) {
      if (skip === m.k) post({ type: 'skipped', k: m.k });
      else post({ type: 'segfail', k: m.k, msg: String((err as Error)?.message ?? err) });
    } finally {
      clearInterval(alive);
    }
  } else if (m.type === 'skip') {
    skip = m.k;
  } else if (m.type === 'stop') {
    stop = true;
    seg?.close();
    seg = null;
  }
};

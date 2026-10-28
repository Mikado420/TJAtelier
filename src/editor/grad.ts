import { measures, measureScale, TPB, type ECourse, type EEvent } from '../chart/model';

/**
 * グラデ（#SCROLL を少しずつ変えて、音符の見た目を滑らかに加速・減速させる）。
 *
 * 決まり:
 * - 対象は範囲 [start, end) の中の「音符（1〜7。連打・風船は始まりだけ。8 は対象外）」と「小節の頭（小節線）」の位置
 * - 対象（n 個）それぞれの直前に、開始値から終了値までを進み具合 t で補間した値を置く
 * - 終点 end には終了値を置く
 *
 * 進み具合の基準（basis）:
 * - 'time': その位置の秒数で決める。t = (位置の秒数 − 始点の秒数) ÷ (終点の秒数 − 始点の秒数)
 *           秒数は BPM（#BPMCHANGE）と #DELAY から求める（#DELAY で止まっている時間も進んだことにする）
 * - 'count'（未設定のときも）: 対象の数で決める。k 番目は t = k / n
 * 等差: from + (to - from) * t、等比: from * (to / from)^t
 *
 * #BPMCHANGE があるときの選び方（speed）:
 * - 'scroll': #SCROLL の値そのものを滑らかに変える（BPM が変わるとそこで見た目の速さが跳ねる）
 * - 'visual': 見た目の速さ（BPM × SCROLL）を滑らかに変える。各位置の #SCROLL = その位置の見た目の速さ ÷ その位置の BPM。
 *             範囲の中の #BPMCHANGE の位置にも #SCROLL を置く（置かないとそこで速さが跳ねる）。
 *             開始値・終了値は、始点・終点での #SCROLL の値（終点の見た目の速さ = 終了値 × 終点の BPM）
 * - 'visualBase': 'visual' と同じく見た目の速さを滑らかにするが、開始値・終了値は「始点の BPM を基準にした見た目の速さ」。
 *             終点の見た目の速さ = 終了値 × 始点の BPM（終点の #SCROLL は、それを終点の BPM で割った値）
 * 小節線（#MEASURE で長さが変わっても同じ）はいつも対象に入れる。
 *
 * グラデの設定はエディタの中だけで覚えておき、.tja には書き込まない（書き出すのは普通の #SCROLL）。
 */
export interface Grad {
  start: number;
  end: number;
  from: number;
  to: number;
  mode: 'linear' | 'geometric';
  /** 小数の桁数 */
  digits: number;
  /** 進み具合の基準。'time' = 秒数、'count' = 対象の数（未設定は前に保存したデータとの互換のため 'count'） */
  basis?: 'count' | 'time';
  /** #BPMCHANGE があるとき、何を滑らかにするか（無いときは 'scroll'） */
  speed?: 'scroll' | 'visual' | 'visualBase';
  /** （使わない。小節線はいつも対象。前に保存したデータとの互換のため残す） */
  barlines?: boolean;
}

/** その位置の BPM を返す関数（譜面の最初の BPM と、難易度の #BPMCHANGE から） */
function bpmFn(c: ECourse, baseBpm: number) {
  const evs = c.events.filter((e) => e.kind === 'bpm' && e.value > 0) as { tick: number; value: number }[];
  evs.sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let b = baseBpm > 0 ? baseBpm : 120;
    for (const e of evs) {
      if (e.tick > tick) break;
      b = e.value;
    }
    return b;
  };
}

/**
 * その位置の秒数を返す関数（BPM・#DELAY と、#MEASURE の短い小節の本当の長さ（measureScale）から。
 * 始点からの差だけを使うので、OFFSET は入れない）
 */
function timeFn(c: ECourse, baseBpm: number) {
  const evs = c.events.filter((e) => e.kind === 'bpm' || e.kind === 'delay' || e.kind === 'measure').slice().sort((a, b) => a.tick - b.tick);
  return (tick: number) => {
    let time = 0;
    let t = 0;
    let b = baseBpm > 0 ? baseBpm : 120;
    let sc = 1;
    for (const e of evs) {
      // 位置と同じ tick の #DELAY は、その音符より前に止まるので入れる
      if (e.tick > tick) break;
      time += (((e.tick - t) * sc) / TPB) * (60 / b);
      t = e.tick;
      if (e.kind === 'bpm' && e.value > 0) b = e.value;
      if (e.kind === 'delay') time += e.value;
      if (e.kind === 'measure') sc = measureScale(e.num, e.den);
    }
    return time + (((tick - t) * sc) / TPB) * (60 / b);
  };
}

/** 各位置の進み具合（0 以上 1 未満）。秒数の幅が 0 以下のときは数で決める */
function gradProgress(c: ECourse, g: Grad, ts: number[], baseBpm: number): number[] {
  const n = ts.length;
  if (g.basis === 'time') {
    const time = timeFn(c, baseBpm);
    const t0 = time(g.start);
    const span = time(g.end) - t0;
    if (span > 0) return ts.map((tick) => Math.min(1, Math.max(0, (time(tick) - t0) / span)));
  }
  return ts.map((_, k) => k / n);
}

/** 値を置く位置（tick、重なりなし・昇順） */
export function gradTargets(c: ECourse, g: Pick<Grad, 'start' | 'end' | 'speed' | 'barlines'>): number[] {
  const { start, end } = g;
  const set = new Set<number>();
  for (const n of c.notes) if (n.tick >= start && n.tick < end) set.add(n.tick);
  for (const m of measures(c, end)) if (m.start >= start && m.start < end) set.add(m.start);
  if (g.speed === 'visual' || g.speed === 'visualBase') for (const e of c.events) if (e.kind === 'bpm' && e.tick > start && e.tick < end) set.add(e.tick);
  return [...set].sort((a, b) => a - b);
}

export function gradValid(g: Pick<Grad, 'from' | 'to' | 'mode'>): string | null {
  if (!Number.isFinite(g.from) || !Number.isFinite(g.to)) return '数値を入力してください';
  if (g.mode === 'geometric' && !(g.from * g.to > 0)) return '等比は開始値と終了値の符号をそろえてください';
  return null;
}

const round = (v: number, digits: number) => {
  const r = Number(v.toFixed(Math.max(0, Math.min(6, Math.round(digits)))));
  return Object.is(r, -0) ? 0 : r;
};

const interp = (mode: Grad['mode'], a: number, b: number, t: number) =>
  mode === 'geometric' ? a * Math.pow(b / a, t) : a + (b - a) * t;

/** このグラデで置く #SCROLL（終点の終了値を含む） */
export function gradScrolls(c: ECourse, g: Grad, baseBpm: number): { tick: number; value: number }[] {
  const ts = gradTargets(c, g);
  const p = gradProgress(c, g, ts, baseBpm);
  const out: { tick: number; value: number }[] = [];
  if (g.speed === 'visual' || g.speed === 'visualBase') {
    // 見た目の速さ（BPM × SCROLL）を滑らかにする
    const bpm = bpmFn(c, baseBpm);
    const v0 = g.from * bpm(g.start);
    const v1 = g.to * (g.speed === 'visualBase' ? bpm(g.start) : bpm(g.end));
    ts.forEach((tick, k) => out.push({ tick, value: round(interp(g.mode, v0, v1, p[k]) / bpm(tick), g.digits) }));
    out.push({ tick: g.end, value: round(v1 / bpm(g.end), g.digits) });
  } else {
    ts.forEach((tick, k) => out.push({ tick, value: round(interp(g.mode, g.from, g.to, p[k]), g.digits) }));
    out.push({ tick: g.end, value: round(g.to, g.digits) });
  }
  return out;
}

/** グラデの始点・終点に重ねて置いた #SCROLL（pin）か */
export const isPin = (e: EEvent, g: Grad) => e.kind === 'scroll' && !!e.pin && (e.tick === g.start || e.tick === g.end);

/**
 * 範囲 [start, end] の #SCROLL を、このグラデの値で置き直す。
 * 始点・終点に重ねて置いた #SCROLL（pin）はそのまま残し、その位置にはグラデの値を置かない
 */
export function applyGrad(c: ECourse, g: Grad, baseBpm: number) {
  c.events = c.events.filter((e) => !(e.kind === 'scroll' && e.tick >= g.start && e.tick <= g.end) || isPin(e, g));
  const pinned = new Set(c.events.filter((e) => isPin(e, g)).map((e) => e.tick));
  for (const s of gradScrolls(c, g, baseBpm)) if (!pinned.has(s.tick)) c.events.push({ tick: s.tick, kind: 'scroll', value: s.value });
}

/** 始点・終点の #SCROLL がグラデの値と違えば、重ねて置いたもの（pin）にする（TJA のテキストから読み直したとき用） */
export function markPins(c: ECourse, g: Grad, baseBpm: number, checkEnd = true) {
  const want = new Map(gradScrolls(c, g, baseBpm).map((s) => [s.tick, s.value]));
  for (const e of c.events) {
    // 終点で次のグラデが始まるときは、終点の値は次のグラデのもの（そちらで確かめる）
    if (e.kind !== 'scroll' || (e.tick !== g.start && (e.tick !== g.end || !checkEnd))) continue;
    const w = want.get(e.tick);
    if (w === undefined || Math.abs(e.value - w) >= 1e-9) e.pin = true;
  }
}

/** 譜面の #SCROLL が、このグラデで置いたとおりになっているか（TJA のテキストを書き換えた後の確認用） */
export function gradMatches(c: ECourse, g: Grad, baseBpm: number, checkEnd = true): boolean {
  // 終点で次のグラデが始まるときは、終点の値は次のグラデの開始値で上書きされているので比べない
  const last = checkEnd ? g.end : g.end - 1;
  const want = gradScrolls(c, g, baseBpm).filter((s) => s.tick <= last);
  const have = c.events.filter((e) => e.kind === 'scroll' && e.tick >= g.start && e.tick <= last) as { tick: number; value: number }[];
  if (have.length !== want.length) return false;
  const sorted = [...have].sort((a, b) => a.tick - b.tick);
  // 始点・終点は、重ねて置いた #SCROLL（pin）かもしれないので、位置だけ比べる
  return sorted.every((e, i) => e.tick === want[i].tick && (e.tick === g.start || e.tick === g.end || Math.abs(e.value - want[i].value) < 1e-9));
}

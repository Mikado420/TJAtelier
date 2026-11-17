/**
 * 録画で区間ごとに描くときの下調べ（オートで叩いた結果から、前もって分かること）。
 * - その区間で使う TNDE スキンの絵（使わない大きな絵は読み込まない。メモリを空ける）
 * - 区間の頭の前に描いておく長さ（区間の頭をまたいで続く演出の分だけ）
 */
import type { Course } from '../chart/types';
import { CLEAR_LINE, Game } from '../engine/game';
import type { AutoEvent } from './auto';

/** 叩くたびのコンボとゲージ（オートなので、どちらも減らない） */
export interface Timeline {
  t: number[];
  combo: number[];
  gauge: number[];
}

export function buildTimeline(course: Course, fixed: number | undefined, auto: AutoEvent[]): Timeline {
  const g = new Game(course.notes, { ...course, fixed });
  const tl: Timeline = { t: [], combo: [], gauge: [] };
  for (const e of auto) {
    g.update(e.t);
    if (e.note && !g.active(e.note)) continue;
    g.hit(e.kind, e.t);
    tl.t.push(e.t);
    tl.combo.push(g.stats.combo);
    tl.gauge.push(g.stats.gauge);
  }
  return tl;
}

/** t 秒の時点（その時刻までに叩いた所まで）の位置 */
function idx(tl: Timeline, t: number) {
  let lo = 0;
  let hi = tl.t.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (tl.t[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}
const gaugeAt = (tl: Timeline, t: number) => {
  const i = idx(tl, t);
  return i < 0 ? 0 : tl.gauge[i];
};

/** t 秒の 1 拍の長さ（秒） */
function beatAt(course: Course, t: number) {
  const ps = (course as Course & { params?: { time: number; bpm: number }[] }).params ?? [];
  let bpm = course.bars[0]?.bpm ?? 120;
  for (const p of ps) {
    if (p.time > t) break;
    bpm = p.bpm;
  }
  return 60 / Math.max(1, Math.abs(bpm) || 120);
}

const ROLLS = new Set(['roll', 'bigRoll']);

/**
 * w0〜w1 秒（曲の時刻）に使う絵か。迷うものは使うことにする（欠けるよりはよい）。
 * しぼるのは大きな絵だけ: ゴーゴー・風船・クリア・魂ゲージ満タン・踊り子の出てくる動き
 */
export function needFor(course: Course, tl: Timeline, w0: number, w1: number) {
  const a = w0 - 1.5;
  const b = w1 + 1.5;
  const g0 = gaugeAt(tl, a);
  const g1 = gaugeAt(tl, b);
  const gogo = course.gogo.some(([x, y]) => x < b && (Number.isFinite(y) ? y : Infinity) > a);
  const balloon = course.notes.some((n) => !n.dummy && n.type === 'balloon' && n.time < b && (n.endTime ?? n.time) + 2 > a);
  const clear = g1 >= CLEAR_LINE;
  const max = g1 >= 100;
  const cross = (k: number) => g0 < k + 1e-9 && g1 >= k;
  return (name: string) => {
    if (name === 'chara/GoGo' || name === 'chara/GoGoStart' || name === 'fx/GoGoSplash' || name === 'fx/Fire' || name === 'lane/Background_GoGo') return gogo;
    if (name === 'chara/GoGo_Max' || name === 'chara/GoGoStart_Max') return gogo && max;
    if (name.startsWith('chara/Balloon') || name === 'balloon/Balloon' || name.startsWith('balloon/Breaking') || name === 'fx/Rainbow') return balloon;
    if (name === 'chara/Clear' || name === 'chara/Clearin' || name.startsWith('bg/clear/')) return clear;
    if (name === 'chara/Clear_Max' || name === 'chara/Soulin' || name === 'chara/10combo_Max' || name === 'mob' || name === 'gauge/Fire') return max;
    if (name === 'chara/Normal') return g0 < CLEAR_LINE;
    // 踊り子が出てくる動き: ゲージが 40%・クリアの線を越える所（区間の前に描く間に出てくることもある）
    if (name.startsWith('dancer/In')) return cross(40) || cross(CLEAR_LINE) || g0 >= 40;
    return true;
  };
}

/**
 * 区間の頭（tA 秒）の前に描いておく長さ（秒）。区間の頭をまたいで続いている演出が終わるまでの分。
 * 何も続いていなくても 1.2 秒（踊り子の出てくる動きなど、描き始めに一度だけ起きる動きが終わる分）は描く
 */
export function warmFor(course: Course, tl: Timeline, tA: number) {
  let need = 1.2;
  const add = (t: number, dur: number) => {
    if (t <= tA && t + dur > tA) need = Math.max(need, tA - t + 0.3);
  };
  const look = tA - 6;
  for (let i = Math.max(0, idx(tl, look)); i < tl.t.length && tl.t[i] <= tA; i++) {
    const t = tl.t[i];
    const c = tl.combo[i];
    const p = i > 0 ? tl.combo[i - 1] : 0;
    const beats2 = 2 * beatAt(course, t);
    // 10 コンボごとのどんちゃん（2 拍）・50・100… の巻物（約 3 秒）・顔（0.7 秒）
    if (Math.floor(c / 10) > Math.floor(p / 10)) add(t, beats2);
    if ((p < 50 && c >= 50) || (c >= 100 && Math.floor(c / 100) > Math.floor(p / 100))) add(t, 3);
    const g = tl.gauge[i];
    const gp = i > 0 ? tl.gauge[i - 1] : 0;
    // クリア・魂ゲージ満タンの瞬間（2 拍）、踊り子が出てくる（1.1 秒）
    if ((gp < CLEAR_LINE && g >= CLEAR_LINE) || (gp < 100 && g >= 100)) add(t, Math.max(beats2, 1.1));
    if (gp < 40 && g >= 40) add(t, 1.1);
  }
  // ゴーゴーの始まり（2 拍）
  for (const [x] of course.gogo) add(x, 2 * beatAt(course, x) + 0.2);
  // 連打（終わってから扇が閉じるまで約 2.7 秒）・風船（割れる動き 0.5 秒）
  for (const n of course.notes) {
    if (n.dummy) continue;
    if (ROLLS.has(n.type)) add(n.time, (n.endTime ?? n.time) - n.time + 2.8);
    if (n.type === 'balloon') add(n.time, (n.endTime ?? n.time) - n.time + 1);
  }
  return Math.min(4, need);
}

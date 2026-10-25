/**
 * 譜面分析（難易度ごと）。
 * 総ノーツ数・天井スコア・BPM（下限〜上限と、いちばん長く使われている BPM）・ドンとカッの割合・平均密度・
 * 連打（本数と秒数）・風船（本数と打数）・演奏時間・密度の推移。秒速を決めて連打・風船に何打入るかのシミュレーションも。
 */
import { scoreBase, BALLOON_HIT_SCORE } from '../engine/game';
import { sortCourse, Timing, toPlayable, type EChart, type ECourse } from './model';

export interface Analysis {
  /** 判定のある音符（ドン・カッ・大ドン・大カッ）の数 = 最大コンボ数 */
  notes: number;
  don: number;
  ka: number;
  bigDon: number;
  bigKa: number;
  /** 天井スコア（全部「良」・風船は全部割る・連打は入れない） */
  ceiling: number;
  /** 黄色の連打（連打・大連打）があるか（あれば「天井スコア＋連打」） */
  hasRoll: boolean;
  bpmMin: number;
  bpmMax: number;
  /** 曲の中でいちばん長い秒数使われている BPM */
  bpmMain: number;
  /** 平均密度（打/秒）=（音符数 − 1）÷ 演奏時間。演奏時間は（60 ÷ BPM）× 拍数（#DELAY は入れない） */
  density: number;
  /** 最初の音符から最後の音符まで（秒。#DELAY は入れない） */
  playTime: number;
  /** 連打の長さ（秒）。type は roll / bigRoll */
  rolls: { type: 'roll' | 'bigRoll'; sec: number }[];
  /** 風船の長さ（秒）と打数 */
  balloons: { sec: number; hits: number }[];
  /** 密度の推移: 演奏の最初からの秒（区間の真ん中）と、その区間の打/秒 */
  curve: { t: number; v: number }[];
  /** 最初の音符の時刻と最後の音符（連打・風船の終わりも含む）の時刻（秒、曲の再生位置） */
  firstTime: number;
  lastTime: number;
}

const COMBO = new Set(['don', 'ka', 'bigDon', 'bigKa']);

export function analyzeCourse(chart: EChart, course: ECourse): Analysis {
  sortCourse(course);
  const t = new Timing(chart, course);
  const pc = toPlayable(chart, course);
  const combo = pc.notes.filter((n) => COMBO.has(n.type));
  const count = (ty: string) => combo.filter((n) => n.type === ty).length;
  const balloonsAll = pc.notes.filter((n) => n.type === 'balloon');
  const balloonHits = balloonsAll.reduce((a, n) => a + (n.hits ?? 0), 0);
  const base = scoreBase(combo.length, balloonHits);
  const ceiling = base * combo.length + balloonHits * BALLOON_HIT_SCORE;

  // #DELAY を除いた時刻（（60 ÷ BPM）× 拍数 の合計）
  // （#DELAY は同じ位置の音符の前に入るので、その位置までの #DELAY を引く）
  const delays = course.events.filter((e) => e.kind === 'delay').map((e) => ({ tick: e.tick, value: (e as { value: number }).value }));
  const noDelay = (tick: number) => t.tickToTime(tick) - delays.reduce((a, d) => a + (d.tick <= tick ? d.value : 0), 0);

  const ticks = course.notes.filter((n) => COMBO.has(n.type)).map((n) => n.tick);
  const firstTick = ticks.length ? ticks[0] : 0;
  const lastTick = ticks.length ? ticks[ticks.length - 1] : 0;
  const playTime = ticks.length > 1 ? noDelay(lastTick) - noDelay(firstTick) : 0;
  const density = playTime > 0 ? (combo.length - 1) / playTime : 0;

  // BPM: 最初の音符から最後の音符（連打の終わりも含む）までに使われている BPM と、その秒数
  const allNotes = course.notes;
  const startTick = allNotes.length ? allNotes[0].tick : 0;
  const endTick = allNotes.reduce((m, n) => Math.max(m, n.endTick ?? n.tick), 0);
  const changes: { tick: number; bpm: number }[] = [{ tick: 0, bpm: chart.bpm > 0 ? chart.bpm : 120 }];
  for (const e of course.events) if (e.kind === 'bpm' && e.value > 0) changes.push({ tick: e.tick, bpm: e.value });
  const used = new Map<number, number>();
  for (let i = 0; i < changes.length; i++) {
    const a = Math.max(changes[i].tick, startTick);
    const b = Math.min(i + 1 < changes.length ? changes[i + 1].tick : endTick, endTick);
    const bpm = changes[i].bpm;
    if (b > a) used.set(bpm, (used.get(bpm) ?? 0) + (noDelay(b) - noDelay(a)));
  }
  if (!used.size) used.set(t.bpmAt(startTick), 0);
  const bpms = [...used.keys()];
  let bpmMain = bpms[0];
  for (const [b, s] of used) if (s > (used.get(bpmMain) ?? 0)) bpmMain = b;

  const rolls = pc.notes
    .filter((n) => n.type === 'roll' || n.type === 'bigRoll')
    .map((n) => ({ type: n.type as 'roll' | 'bigRoll', sec: Math.max(0, (n.endTime ?? n.time) - n.time) }));
  const balloons = balloonsAll.map((n) => ({ sec: Math.max(0, (n.endTime ?? n.time) - n.time), hits: n.hits ?? 0 }));

  const firstTime = pc.notes.length ? pc.notes[0].time : 0;
  const lastTime = pc.notes.reduce((m, n) => Math.max(m, n.endTime ?? n.time), firstTime);

  return {
    notes: combo.length,
    don: count('don'),
    ka: count('ka'),
    bigDon: count('bigDon'),
    bigKa: count('bigKa'),
    ceiling,
    hasRoll: rolls.length > 0,
    bpmMin: Math.min(...bpms),
    bpmMax: Math.max(...bpms),
    bpmMain,
    density,
    playTime,
    rolls,
    balloons,
    curve: densityCurve(combo.map((n) => n.time), firstTime, lastTime),
    firstTime,
    lastTime,
  };
}

/** 密度の推移: 2 秒の幅の窓を 0.5 秒ずつずらして、窓の中の音符の数 ÷ 2 */
export function densityCurve(times: number[], from: number, to: number, win = 2, step = 0.5): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  if (!times.length || to <= from) return out;
  const sorted = [...times].sort((a, b) => a - b);
  let lo = 0;
  let hi = 0;
  for (let s = from - win / 2; s <= to - win / 2 + 1e-9; s += step) {
    while (lo < sorted.length && sorted[lo] < s) lo++;
    while (hi < sorted.length && sorted[hi] < s + win) hi++;
    out.push({ t: s + win / 2 - from, v: (hi - lo) / win });
  }
  return out;
}

/**
 * 秒速 rate 打で叩いたときに、連打・風船に何打入るか。
 * 1 本の連打に入る数 = floor(秒数 × 秒速)。風船は必要な打数まで（それ以上は入らない）、足りなければ割れない
 */
export function simulateRolls(a: Pick<Analysis, 'rolls' | 'balloons'>, rate: number) {
  const n = (sec: number) => Math.max(0, Math.floor(sec * rate + 1e-9));
  const roll = a.rolls.map((r) => n(r.sec));
  const balloon = a.balloons.map((b) => Math.min(b.hits, n(b.sec)));
  const popped = a.balloons.filter((b, i) => balloon[i] >= b.hits).length;
  const rollHits = roll.reduce((x, y) => x + y, 0);
  const balloonHits = balloon.reduce((x, y) => x + y, 0);
  // 点数: 連打は 1 打 100 点（大連打は 200 点）。風船は天井スコアに入っているので、割れなかった分を引く
  const rollScore = a.rolls.reduce((s, r, i) => s + roll[i] * (r.type === 'bigRoll' ? 200 : 100), 0);
  const balloonLoss = a.balloons.reduce((s, b, i) => s + (b.hits - balloon[i]) * BALLOON_HIT_SCORE, 0);
  return { roll, balloon, rollHits, balloonHits, total: rollHits + balloonHits, popped, rollScore, balloonLoss };
}

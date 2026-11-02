/**
 * 譜面情報の数値（難易度ごと）。
 * 総ノーツ数・天井スコア・BPM（下限〜上限と、いちばん長く使われている BPM）・ドンとカッの割合・平均密度・
 * 連打（本数と秒数）・風船（本数と打数）・演奏時間・密度の推移。秒速を決めて連打・風船に何打入るかのシミュレーションも。
 */
import { scoreBase, BALLOON_HIT_SCORE } from '../engine/game';
import { contentEnd, measures, sortCourse, Timing, toPlayable, TPB, type EChart, type ECourse } from './model';

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
  /**
   * 小節ごとの密度: 小節の始まりと終わりの時刻（秒、曲の再生位置）と、その小節の打/秒（音符数 ÷ 小節の秒数）。
   * don・ka はそのうちドン（大ドン）・カッ（大カッ）の打/秒。連打・風船は入れない
   */
  curve: { t0: number; t1: number; v: number; don: number; ka: number }[];
  /** 小節数 */
  measureCount: number;
  /** #SCROLL の下限と上限（音符の所の値） */
  scrollMin: number;
  scrollMax: number;
  /** いちばん細かい音符の間隔: 何分音符か（割り切れないときは 0）と秒数。音符が 2 つ未満なら null */
  finest: { div: number; sec: number } | null;
  /** 16 分以下の間隔で続く音符の、いちばん長い続き（打数） */
  longestRun: number;
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

  /** 小節ごとの密度（最初の音符の小節から最後の音符の小節まで）。秒数は（60 ÷ BPM）× 拍数（#DELAY は入れない） */
  const comboNotes = course.notes.filter((n) => COMBO.has(n.type));
  const allMeasures = measures(course, contentEnd(course));
  function measureDensity() {
    const out: Analysis['curve'] = [];
    if (!ticks.length) return out;
    for (const m of allMeasures) {
      const end = m.start + m.length;
      if (end <= firstTick) continue;
      if (m.start > lastTick) break;
      const inM = comboNotes.filter((n) => n.tick >= m.start && n.tick < end);
      const dn = inM.filter((n) => n.type === 'don' || n.type === 'bigDon').length;
      const sec = noDelay(end) - noDelay(m.start);
      const ps = (x: number) => (sec > 0 ? x / sec : 0);
      out.push({ t0: t.tickToTime(m.start), t1: t.tickToTime(end), v: ps(inM.length), don: ps(dn), ka: ps(inM.length - dn) });
    }
    return out;
  }

  // いちばん細かい音符（同じ位置の音符は 1 つに数える）と、16 分以下の間隔で続くいちばん長い続き
  const uniq = [...new Set(ticks)].sort((x, y) => x - y);
  let finest: Analysis['finest'] = null;
  let run = uniq.length ? 1 : 0;
  let longestRun = run;
  for (let i = 1; i < uniq.length; i++) {
    const dt = uniq[i] - uniq[i - 1];
    const sec = noDelay(uniq[i]) - noDelay(uniq[i - 1]);
    if (sec > 0 && (!finest || sec < finest.sec - 1e-6)) {
      const d = (TPB * 4) / dt;
      finest = { div: Math.abs(d - Math.round(d)) < 1e-6 ? Math.round(d) : 0, sec };
    }
    run = dt <= TPB / 4 ? run + 1 : 1;
    longestRun = Math.max(longestRun, run);
  }
  const scrolls = pc.notes.filter((n) => !n.dummy).map((n) => n.scroll);
  if (!scrolls.length) scrolls.push(1);

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
    curve: measureDensity(),
    measureCount: allMeasures.length,
    scrollMin: Math.min(...scrolls),
    scrollMax: Math.max(...scrolls),
    finest,
    longestRun,
    firstTime,
    lastTime,
  };
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

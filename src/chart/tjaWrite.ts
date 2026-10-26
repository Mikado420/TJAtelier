import type { NoteType } from './types';
import { contentEnd, measures, sortCourse, type EChart, type ECourse, type EEvent } from './model';

/** 編集用モデル → TJA テキスト */

const TYPE_TO_CHAR: Record<NoteType, string> = {
  don: '1', ka: '2', bigDon: '3', bigKa: '4', roll: '5', bigRoll: '6', balloon: '7',
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * 1 小節を何文字で書くか: 全部の位置 p が「k 文字目 = round(k × len ÷ d)」で表せる、いちばん小さい d。
 * 13 分割・17 分割のように tick で割り切れない分割（位置は丸めてある）も、その分割数で書ける。
 * exact（tick の最大公約数で割った数）なら必ず表せるので、それより小さい d だけ探す
 */
export function measureDiv(len: number, positions: number[], exact: number): number {
  const fits = (d: number) => positions.every((p) => Math.round((Math.round((p * d) / len) * len) / d) === p);
  for (let d = 1; d < exact; d++) if (fits(d)) return d;
  return exact;
}
const num = (v: number) => String(Number(v.toFixed(6)));

function eventLine(e: EEvent): string {
  switch (e.kind) {
    case 'bpm': return `#BPMCHANGE ${num(e.value)}`;
    case 'scroll': return `#SCROLL ${num(e.value)}`;
    case 'measure': return `#MEASURE ${e.num}/${e.den}`;
    case 'gogo': return e.on ? '#GOGOSTART' : '#GOGOEND';
    case 'barline': return e.on ? '#BARLINEON' : '#BARLINEOFF';
    case 'delay': return `#DELAY ${num(e.value)}`;
    case 'jpos': return `#JPOSSCROLL ${num(e.time)} ${num(e.dist)} ${e.dir}`;
  }
}

export function writeTJA(chart: EChart): string {
  const out: string[] = [];
  out.push(`TITLE:${chart.title}`);
  if (chart.subtitle) out.push(`SUBTITLE:${chart.subtitle}`);
  out.push(`BPM:${num(chart.bpm)}`);
  out.push(`WAVE:${chart.wave}`);
  out.push(`OFFSET:${num(chart.offset)}`);
  if (chart.demoStart) out.push(`DEMOSTART:${num(chart.demoStart)}`);
  for (const [k, v] of chart.extra) out.push(`${k}:${v}`);
  out.push('');

  for (const c of chart.courses) {
    sortCourse(c);
    out.push(`COURSE:${c.name}`);
    out.push(`LEVEL:${c.level}`);
    const balloons = c.notes.filter((n) => n.type === 'balloon').map((n) => n.hits ?? 5);
    if (balloons.length) out.push(`BALLOON:${balloons.join(',')}`);
    for (const [k, v] of c.extra) out.push(`${k}:${v}`);
    out.push('');
    if (c.scrollMode) out.push('#HBSCROLL');
    out.push('#START');
    out.push(...writeCourseBody(c));
    out.push('#END');
    out.push('');
  }
  return out.join('\n');
}

export function writeCourseBody(c: ECourse): string[] {
  const lines: string[] = [];
  const end = contentEnd(c);

  // tick → 文字
  const chars = new Map<number, string>();
  for (const n of c.notes) {
    chars.set(n.tick, TYPE_TO_CHAR[n.type]);
  }
  for (const n of c.notes) {
    if (n.endTick !== undefined && !chars.has(n.endTick)) chars.set(n.endTick, '8');
  }

  const ms = measures(c, end);
  // 最後の小節の内容があるところまで
  const lastIdx = ms.findIndex((m) => m.start + m.length > end);
  const used = ms.slice(0, (lastIdx < 0 ? ms.length - 1 : lastIdx) + 1);

  for (const m of used) {
    const mEnd = m.start + m.length;
    const evs = c.events.filter((e) => e.tick >= m.start && e.tick < mEnd);
    const positions: number[] = [];
    for (const t of chars.keys()) if (t >= m.start && t < mEnd) positions.push(t - m.start);
    for (const e of evs) positions.push(e.tick - m.start);

    let g = m.length;
    for (const p of positions) g = gcd(g, p);
    const div = measureDiv(m.length, positions, Math.round(m.length / g));

    let cur = '';
    for (let k = 0; k < div; k++) {
      // 読み込むときと同じ丸め方（tja.ts の tickOf）。13 分割のように tick で割り切れない分割も、元の位置に戻る
      const t = m.start + Math.round((k * m.length) / div);
      const here = evs.filter((e) => e.tick === t);
      if (here.length) {
        if (cur) { lines.push(cur); cur = ''; }
        for (const e of here) lines.push(eventLine(e));
      }
      cur += chars.get(t) ?? '0';
    }
    lines.push(cur + ',');
  }
  return lines;
}

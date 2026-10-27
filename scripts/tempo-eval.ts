/**
 * BPM 測定の答え合わせ（開発用）。
 *   bun scripts/tempo-eval.ts <曲のフォルダ> [...]
 * フォルダの中の TJA（正しい BPM・OFFSET・#BPMCHANGE・#MEASURE が入っている譜面）と、その音源を読み、
 * 自動測定の結果と比べる。音源は ffmpeg で読む。
 *
 * 見るもの（譜面の最初の音符から最後の音符までの間の拍で数える）
 *   拍ずれ  … 正しい拍と、いちばん近い測った拍との差（ms）の中央値と、10ms・25ms 以内の割合
 *   半拍    … 半拍ずれている拍の割合（裏拍を拍と取り違えた）
 *   BPM     … 正しい BPM と測った BPM の差（その拍の所の BPM どうし）が 0.05% 以内の拍の割合
 *   小節    … 正しい小節の頭に、測った小節の頭が 25ms 以内で来ている割合
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, basename } from 'node:path';
import { parseTJA } from '../src/chart/tja';
import { measures, Timing, TPB } from '../src/chart/model';
import { analyzeTempo, planBeatTimes, tempoPlan } from '../src/audio/tempo';

const SR = 22050;

function findTJA(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...findTJA(p));
    else if (extname(n).toLowerCase() === '.tja') out.push(p);
  }
  return out;
}

function readText(p: string) {
  const b = readFileSync(p);
  const u = new TextDecoder('utf-8', { fatal: true });
  try { return u.decode(b); } catch { return new TextDecoder('shift_jis').decode(b); }
}

function decode(p: string): Float32Array {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const pct = (a: boolean[]) => (a.length ? (100 * a.filter(Boolean).length) / a.length : NaN);

const rows: string[] = [];
const sums = { n: 0, beat10: 0, half: 0, bpm: 0, bar: 0 };
const files = process.argv.slice(2).flatMap((d) => (statSync(d).isDirectory() ? findTJA(d) : [d]));
for (const f of files) {
  const text = readText(f);
  const chart = parseTJA(text);
  const wave = /^WAVE:(.*)$/m.exec(text)?.[1]?.trim();
  if (!wave) continue;
  const audio = join(dirname(f), wave);
  let x: Float32Array;
  try { x = decode(audio); } catch { console.log(`× 音源を読めません: ${audio}`); continue; }
  const course = chart.courses.find((c) => /oni|edit|4|3/i.test(c.name)) ?? chart.courses[0];
  if (!course || !course.notes.length) continue;
  if (course.events.some((e) => e.kind === 'delay')) { console.log(`- #DELAY があるので飛ばす: ${basename(f)}`); continue; }
  const timing = new Timing(chart, course);
  const lastTick = Math.max(...course.notes.map((n) => n.endTick ?? n.tick));
  const firstT = timing.tickToTime(course.notes[0].tick);
  const lastT = timing.tickToTime(lastTick);
  // 正しい拍・小節の頭
  const ms = measures(course, lastTick + 1);
  const truthBeats: { t: number; P: number; bpm: number }[] = [];
  for (let k = 0; k * TPB <= lastTick; k++) {
    const t = timing.tickToTime(k * TPB);
    if (t < firstT - 0.01 || t > lastT + 0.01) continue;
    const bpm = timing.bpmAt(k * TPB);
    truthBeats.push({ t, P: 60 / bpm, bpm });
  }
  const truthBars = ms.map((m) => timing.tickToTime(m.start)).filter((t) => t >= firstT - 0.01 && t <= lastT + 0.01);

  const t0 = performance.now();
  const r = analyzeTempo(x, SR);
  const sec = (performance.now() - t0) / 1000;
  const plan = tempoPlan(r, TPB);
  if (!plan) { console.log(`× 測れませんでした: ${basename(f)}`); continue; }
  const det = planBeatTimes(plan, TPB, x.length / SR + 2);
  const detT = det.map((b) => b.t);
  const detBars = det.filter((b) => b.bar).map((b) => b.t);
  const nearest = (arr: number[], t: number) => {
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; }
    let best = arr[lo];
    if (lo > 0 && Math.abs(arr[lo - 1] - t) < Math.abs(best - t)) best = arr[lo - 1];
    return best - t;
  };
  const errs = truthBeats.map((b) => nearest(detT, b.t));
  const abs = errs.map((e) => Math.abs(e) * 1000);
  const half = truthBeats.map((b, i) => Math.abs(Math.abs(errs[i]) - b.P / 2) < b.P / 8);
  // その拍の所の測った BPM（前後の測った拍の間隔）
  const bpmOk = truthBeats.map((b) => {
    let i = detT.findIndex((t) => t > b.t);
    if (i <= 0) return false;
    // 小節の頭だけの点（拍の途中の小節線）を避けて、拍の間隔を見る
    const P = detT[i] - detT[i - 1];
    return Math.abs(60 / P / b.bpm - 1) < 0.0005 || Math.abs(P / b.P - 1) < 0.0005;
  });
  const barOk = truthBars.map((t) => Math.abs(nearest(detBars, t)) < 0.025);
  const signedMed = med(errs) * 1000;
  const row = {
    name: basename(f, '.tja').slice(0, 28),
    truth: `${chart.bpm}${course.events.some((e) => e.kind === 'bpm') ? '+変化' : ''} / ${chart.offset}`,
    got: `${plan.bpm}${plan.changes.length ? `+${plan.changes.length}変化` : ''} / ${plan.offset}`,
    medMs: med(abs).toFixed(1),
    signed: signedMed.toFixed(1),
    beat10: pct(abs.map((a) => a <= 10)),
    beat25: pct(abs.map((a) => a <= 25)),
    half: pct(half),
    bpm: pct(bpmOk),
    bar: pct(barOk),
  };
  sums.n++;
  sums.beat10 += row.beat10;
  sums.half += row.half;
  sums.bpm += row.bpm;
  sums.bar += row.bar;
  const line = `${row.name.padEnd(28)} 正解 ${row.truth.padEnd(18)} 測定 ${row.got.padEnd(22)} 拍ずれ中央 ${row.medMs.padStart(6)}ms（向き ${row.signed.padStart(6)}）10ms内 ${row.beat10.toFixed(0).padStart(3)}% 25ms内 ${row.beat25.toFixed(0).padStart(3)}% 半拍 ${row.half.toFixed(0).padStart(3)}% BPM ${row.bpm.toFixed(0).padStart(3)}% 小節 ${row.bar.toFixed(0).padStart(3)}% ${sec.toFixed(1)}s`;
  rows.push(line);
  console.log(line);
}
if (sums.n) console.log(`\n平均（${sums.n} 曲）: 拍 10ms 内 ${(sums.beat10 / sums.n).toFixed(1)}%  半拍 ${(sums.half / sums.n).toFixed(1)}%  BPM ${(sums.bpm / sums.n).toFixed(1)}%  小節 ${(sums.bar / sums.n).toFixed(1)}%`);

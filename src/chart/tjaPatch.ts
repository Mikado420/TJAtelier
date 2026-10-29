/**
 * 自分で書いた TJA のテキストを保ったまま、譜面の変更だけを書き込む。
 *
 * 元のテキスト（source）を読んだ譜面と、今の譜面を、それぞれ書き出した形（ヘッダ・小節ごとの行）で比べて、
 * 変わったところだけを元のテキストに差し替える:
 * - ヘッダは「KEY:値」の行ごとに、値が変わった行だけ書き換える（無くなった行は消し、増えた行は近くに足す）
 * - 本体は小節ごとに比べ、変わった小節の行だけ書き直す。小節の中の // のコメントは書き直した行に付け直し、
 *   コメントだけの行・空行・使わない分岐（#E・#M）の行はそのまま残す
 * - 難易度が増えた・減ったときは、その難易度のところだけ足す・消す
 * 書き換えた結果を読み直して、今の譜面と同じにならなければ、ふつうの書き出し（コメントは消える）にする
 */
import { measures, type EChart, type ECourse } from './model';
import { parseTJA } from './tja';
import { writeCourseHead, writeHead, writeMeasures, writeTJA } from './tjaWrite';

const COURSE_KEYS = new Set([
  'COURSE', 'LEVEL', 'BALLOON', 'SCOREINIT', 'SCOREDIFF', 'STYLE', 'TOTAL', 'GAUGEINCR', 'HIDDENBRANCH',
  'EXAM1', 'EXAM2', 'EXAM3', 'BALLOONNOR', 'BALLOONEXP', 'BALLOONMAS',
]);

/** 1 行を、コードの部分と // のコメント（前の空白ごと）に分ける */
function splitComment(raw: string): { code: string; comment: string } {
  const i = raw.indexOf('//');
  if (i < 0) return { code: raw, comment: '' };
  let j = i;
  while (j > 0 && /[ \t]/.test(raw[j - 1])) j--;
  return { code: raw.slice(0, j), comment: raw.slice(j) };
}

/** ヘッダの行の見分け方（KEY:値 は KEY、#HBSCROLL・#BMSCROLL は #HBSCROLL） */
function headKey(code: string): string | null {
  const t = code.trim();
  if (!t) return null;
  if (t.startsWith('#')) {
    const n = t.slice(1).split(/\s/)[0].toUpperCase();
    return n === 'HBSCROLL' || n === 'BMSCROLL' ? '#HBSCROLL' : null;
  }
  const i = t.indexOf(':');
  return i < 0 ? null : t.slice(0, i).trim().toUpperCase();
}

interface SrcCourse {
  /** この難易度のヘッダが始まる行（前の #END の次の行） */
  headFrom: number;
  /** #START の行 */
  start: number;
  /** #END の行（無ければ最後の行の次） */
  end: number;
  /** 小節ごとの行の範囲（両端を含む） */
  measures: { from: number; to: number }[];
  /** 1 行に小節の区切り（,）が 2 つ以上ある、または , の後ろに続きがある */
  inline: boolean;
  /** 譜面に関係しない行（コメントだけ・空行・使わない分岐） */
  keep: Set<number>;
  /** 譜面分岐の区間の行（#BRANCHSTART から #BRANCHEND まで。#BRANCHEND が無ければ区間の最後の行まで） */
  blocks: { from: number; to: number }[];
}

/** 元のテキストの、難易度・小節がどの行にあるか（parseTJA と同じ読み方） */
function mapSource(lines: string[]): SrcCourse[] | null {
  const out: SrcCourse[] = [];
  let inChart = false;
  let branch: 'none' | 'N' | 'E' | 'M' = 'none';
  let cur: SrcCourse | null = null;
  let headFrom = 0;
  let from = -1; // 今の小節の最初のコード行
  let pending = false; // 区切りのあとに中身（音符・命令）がある
  for (let i = 0; i < lines.length; i++) {
    const code = splitComment(lines[i]).code.trim();
    if (!inChart) {
      if (/^#START\b/i.test(code)) {
        if (/P2/i.test(code.slice(6))) continue;
        inChart = true;
        branch = 'none';
        cur = { headFrom, start: i, end: lines.length, measures: [], inline: false, keep: new Set(), blocks: [] };
        from = -1;
        pending = false;
      }
      continue;
    }
    const c = cur!;
    if (!code) { c.keep.add(i); continue; }
    if (code.startsWith('#')) {
      const name = (code.match(/^#([A-Z0-9]+)/i)?.[1] ?? '').toUpperCase();
      const openB = c.blocks[c.blocks.length - 1];
      if (name === 'END') {
        if (openB && openB.to < 0) openB.to = i - 1;
        if (pending) c.measures.push({ from: from < 0 ? i : from, to: i - 1 });
        c.end = i;
        out.push(c);
        cur = null;
        inChart = false;
        headFrom = i + 1;
        continue;
      }
      if (name === 'BRANCHSTART') {
        if (openB && openB.to < 0) openB.to = i - 1;
        c.blocks.push({ from: i, to: -1 });
      }
      if (name === 'BRANCHEND' && openB && openB.to < 0) openB.to = i;
      if (name === 'BRANCHSTART' || name === 'BRANCHEND') { branch = 'none'; c.keep.add(i); continue; }
      if (name === 'N' || name === 'E' || name === 'M') { branch = name; c.keep.add(i); continue; }
      if (branch === 'E' || branch === 'M') { c.keep.add(i); continue; }
      if (name === 'HBSCROLL' || name === 'BMSCROLL' || name === 'START') { c.keep.add(i); continue; }
      if (from < 0) from = i;
      pending = true;
      continue;
    }
    if (branch === 'E' || branch === 'M') { c.keep.add(i); continue; }
    // 音符の行
    if (from < 0) from = i;
    const commas = (code.match(/,/g) ?? []).length;
    if (commas === 0) { if (/[0-9AB]/.test(code)) pending = true; continue; }
    const rest = code.slice(code.lastIndexOf(',') + 1).trim();
    if (commas > 1 || rest) c.inline = true;
    for (let k = 0; k < commas; k++) c.measures.push({ from, to: i });
    from = rest ? i : -1;
    pending = !!rest && /[0-9AB]/.test(rest);
  }
  if (cur) {
    if (pending) cur.measures.push({ from: from < 0 ? lines.length - 1 : from, to: lines.length - 1 });
    const ob = cur.blocks[cur.blocks.length - 1];
    if (ob && ob.to < 0) ob.to = lines.length - 1;
    out.push(cur);
  }
  return out;
}

/** 行の差し替え（元の行番号で at から del 行を消して lines を入れる） */
interface Splice { at: number; del: number; lines: string[]; seq: number }

/**
 * 元のテキスト source に、譜面 chart の変更を書き込んだテキストを返す。
 * source が chart と同じ内容なら source をそのまま返す
 */
export function patchTJA(source: string, chart: EChart): string {
  const canon = writeTJA(chart);
  let old: EChart;
  try {
    old = parseTJA(source);
  } catch {
    return canon;
  }
  if (writeTJA(old) === canon) return source;
  try {
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const lines = source.replace(/^﻿/, '').split(/\r?\n/);
    const bom = source.startsWith('﻿') ? '﻿' : '';
    const map = mapSource(lines);
    if (!map || map.length !== old.courses.length) return canon;
    const edits: Splice[] = [];
    let seq = 0;
    const splice = (at: number, del: number, ls: string[]) => edits.push({ at, del, lines: ls, seq: seq++ });

    // ---------- ヘッダ ----------
    patchHead(lines, map, old, chart, splice);

    // ---------- 難易度の対応（増えた・減ったとき） ----------
    const oc = old.courses;
    const nc = chart.courses;
    const pairs: [number, number][] = [];
    if (oc.length === nc.length) oc.forEach((_, i) => pairs.push([i, i]));
    else {
      const key = (c: ECourse) => `${c.name}\n${writeMeasures(c).flat().join('\n')}`;
      const ok = oc.map(key);
      const nk = nc.map(key);
      // いちばん長い共通の並び（数は少ないので素直に）
      const L = Array.from({ length: ok.length + 1 }, () => new Array<number>(nk.length + 1).fill(0));
      for (let i = ok.length - 1; i >= 0; i--) for (let j = nk.length - 1; j >= 0; j--) L[i][j] = ok[i] === nk[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      let i = 0;
      let j = 0;
      while (i < ok.length && j < nk.length) {
        if (ok[i] === nk[j]) { pairs.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
      }
      // 消えた難易度: COURSE: の行（無ければヘッダの始まり）から #END まで消す
      for (let k = 0; k < oc.length; k++) {
        if (pairs.some(([a]) => a === k)) continue;
        const s = map[k];
        let from = s.headFrom;
        for (let l = s.headFrom; l < s.start; l++) if (headKey(splitComment(lines[l]).code) === 'COURSE') { from = l; break; }
        splice(from, Math.min(lines.length, s.end + 1) - from, []);
      }
      // 増えた難易度: 前の難易度の #END の後ろに足す
      for (let k = 0; k < nc.length; k++) {
        if (pairs.some(([, b]) => b === k)) continue;
        const prev = [...pairs].reverse().find(([, b]) => b < k);
        const at = prev ? Math.min(lines.length, map[prev[0]].end + 1) : map.length ? firstCourseLine(lines, [map[0].headFrom, map[0].start]) : lines.length;
        const c = nc[k];
        const h = writeCourseHead(c);
        const hb = h[h.length - 1] === '#HBSCROLL';
        splice(at, 0, ['', ...(hb ? h.slice(0, -1) : h), '', ...(hb ? ['#HBSCROLL'] : []), '#START', ...writeMeasures(c).flat(), '#END']);
      }
    }

    // ---------- 本体（小節ごと） ----------
    for (const [a, b] of pairs) patchBody(lines, map[a], oc[a], nc[b], splice);

    // 後ろから差し替える（同じ所は入れた順に並ぶように）
    // 同じ行では、書き換え・削除を先に、入れる行は後から（入れた順に並ぶように）
    edits.sort((x, y) => y.at - x.at || Number(y.del > 0) - Number(x.del > 0) || y.seq - x.seq);
    const res = lines.slice();
    for (const e of edits) res.splice(e.at, e.del, ...e.lines);
    const text = bom + res.join(eol);
    // 念のため: 読み直して今の譜面と同じか確かめる
    if (writeTJA(parseTJA(text)) !== canon) return canon;
    return text;
  } catch {
    return canon;
  }
}

/** ヘッダ: 値が変わった KEY の行だけ書き換える */
function patchHead(lines: string[], map: SrcCourse[], old: EChart, chart: EChart, splice: (at: number, del: number, ls: string[]) => void) {
  const toMap = (ls: string[]) => {
    const m = new Map<string, string>();
    for (const l of ls) { const k = headKey(l); if (k) m.set(k, l); }
    return m;
  };
  // 難易度ごとのヘッダの範囲（前の #END の次 〜 #START の前）と、最後の #END より後ろ
  const regions = map.map((c) => [c.headFrom, c.start] as [number, number]);
  const tailFrom = map.length ? map[map.length - 1].end + 1 : 0;
  const allHead = [...regions, [tailFrom, lines.length] as [number, number]];
  const keyedIn = (from: number, to: number, key: string) => {
    const r: number[] = [];
    for (let l = from; l < to; l++) if (headKey(splitComment(lines[l]).code) === key) r.push(l);
    return r;
  };
  const apply = (oldLs: string[], newLs: string[], search: [number, number][], fallbackAt: number) => {
    const om = toMap(oldLs);
    const nm = toMap(newLs);
    const keys = [...newLs.map(headKey), ...oldLs.map(headKey)].filter((k, i, a): k is string => !!k && a.indexOf(k) === i);
    for (const k of keys) {
      const o = om.get(k);
      const n = nm.get(k);
      if (o === n) continue;
      const found = search.flatMap(([f, t]) => keyedIn(f, t, k));
      if (n !== undefined && found.length) {
        // 値が変わった: その行を書き換える（コメントは残す）
        for (const l of found) {
          const { code, comment } = splitComment(lines[l]);
          const indent = code.match(/^\s*/)![0];
          splice(l, 1, [indent + n + comment]);
        }
      } else if (n !== undefined) {
        // 増えた: 新しい並びで 1 つ前にある KEY の行の後ろに足す
        const idx = newLs.indexOf(n);
        let at = fallbackAt;
        for (let p = idx - 1; p >= 0; p--) {
          const pk = headKey(newLs[p]);
          const f = pk ? search.flatMap(([a, b]) => keyedIn(a, b, pk)) : [];
          if (f.length) { at = f[f.length - 1] + 1; break; }
        }
        splice(at, 0, [n]);
      } else {
        // 無くなった: 行を消す（コメントはコメントだけの行として残す）
        for (const l of found) {
          const { comment } = splitComment(lines[l]);
          splice(l, 1, comment.trim() ? [comment.trim()] : []);
        }
      }
    }
  };
  // 曲全体のヘッダ（どこに書いてあってもよい）
  apply(writeHead(old), writeHead(chart), allHead, regions.length ? firstCourseLine(lines, regions[0]) : lines.length);
  // 難易度ごと（同じ数のときだけ。増えた・減ったときは難易度ごと足す・消す）
  if (old.courses.length !== chart.courses.length) return;
  old.courses.forEach((oc, i) => {
    const [f, t] = regions[i];
    // #HBSCROLL は #START の直前に
    const ol = writeCourseHead(oc);
    const nl = writeCourseHead(chart.courses[i]);
    apply(ol, nl, [[f, t]], t);
  });
}

/** ヘッダの範囲で、COURSE: の行（無ければ範囲の終わり） */
function firstCourseLine(lines: string[], [from, to]: [number, number]) {
  for (let l = from; l < to; l++) if (COURSE_KEYS.has(headKey(splitComment(lines[l]).code) ?? '')) return l;
  return to;
}

/** 本体: 変わった小節の行だけ書き直す */
function patchBody(lines: string[], s: SrcCourse, oc: ECourse, nc: ECourse, splice: (at: number, del: number, ls: string[]) => void) {
  const n = s.measures.length;
  const ob = writeMeasures(oc, n);
  const nb = writeMeasures(nc, n);
  const same = (j: number) => (ob[j] ?? []).join('\n') === (nb[j] ?? []).join('\n');
  const changed: number[] = [];
  for (let j = 0; j < Math.max(n, nb.length); j++) if (!same(j)) changed.push(j);
  if (!changed.length) return;
  // 元の譜面分岐の区間: 中の小節が変わったら、区間の行（#BRANCHSTART〜）をまとめて書き直す
  const obs = oc.branches ?? [];
  const done = new Set<number>();
  if (obs.length) {
    if (obs.length !== s.blocks.length) {
      const keep = [];
      for (let l = s.start + 1; l < s.end; l++) {
        const { code, comment } = splitComment(lines[l]);
        if (!code.trim() && comment.trim()) keep.push(lines[l]);
      }
      splice(s.start + 1, s.end - s.start - 1, [...nb.flat(), ...keep]);
      return;
    }
    const oms = measures(oc, Math.max(...obs.map((b) => (Number.isFinite(b.end) ? b.end : b.start))) + 1);
    obs.forEach((b, i) => {
      const js = oms.map((m, j) => (m.start >= b.start && m.start < b.end ? j : -1)).filter((j) => j >= 0);
      for (const j of js) done.add(j);
      if (!js.some((j) => changed.includes(j))) return;
      const blk = s.blocks[i];
      splice(blk.from, blk.to - blk.from + 1, js.flatMap((j) => nb[j] ?? []));
    });
  }
  const todo = changed.filter((j) => !done.has(j));
  if (!todo.length) return;
  // 1 行に小節がいくつもある書き方で、その小節が変わったときは、本体ごと書き直す（コメントだけの行は残す）
  if (s.inline && todo.some((j) => j < n)) {
    const keep = [];
    for (let l = s.start + 1; l < s.end; l++) if (s.keep.has(l) && lines[l].trim()) keep.push(lines[l]);
    splice(s.start + 1, s.end - s.start - 1, [...nb.flat(), ...keep]);
    return;
  }
  for (const j of todo) {
    if (j < n) replaceMeasure(lines, s, s.measures[j], nb[j] ?? [], splice);
  }
  // 元より小節が増えた: 最後の小節の後ろに足す
  const extra = nb.slice(n).flat();
  if (extra.length) {
    const at = n ? s.measures[n - 1].to + 1 : s.start + 1;
    splice(at, 0, extra);
  }
}

/** 1 小節の行を書き直す。コメントだけの行・空行はそのまま、行末のコメントは新しい行に付け直す */
function replaceMeasure(lines: string[], s: SrcCourse, r: { from: number; to: number }, next: string[], splice: (at: number, del: number, ls: string[]) => void) {
  const out: string[] = [];
  const comments: string[] = [];
  const keepAfter: string[] = [];
  let placed = false;
  for (let l = r.from; l <= r.to; l++) {
    const raw = lines[l];
    const { code, comment } = splitComment(raw);
    if (s.keep.has(l) || !code.trim()) {
      (placed ? keepAfter : out).push(raw);
      continue;
    }
    if (comment) comments.push(comment);
    placed = true;
  }
  const indent = (() => {
    for (let l = r.from; l <= r.to; l++) if (!s.keep.has(l) && splitComment(lines[l]).code.trim()) return lines[l].match(/^\s*/)![0];
    return '';
  })();
  const body = next.map((x) => indent + x);
  // 行末のコメント: 行の数が同じなら同じ行に、余った分は最後の行に
  comments.forEach((c, i) => {
    const k = Math.min(i, body.length - 1);
    if (k >= 0) body[k] += i < body.length ? c : ` ${c.trim()}`;
  });
  out.push(...body, ...keepAfter);
  splice(r.from, r.to - r.from + 1, out);
}

/** 譜面のテキスト（自分で書いたテキストがあれば、それを保ったまま今の譜面にしたもの） */
export function tjaText(chart: EChart & { source?: string }): string {
  if (!chart.source) return writeTJA(chart);
  const t = patchTJA(chart.source, chart);
  chart.source = t;
  return t;
}

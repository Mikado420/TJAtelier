/**
 * 合作（リアルタイム共同編集）のデータの形と決まり。サーバー（worker/src/collab.ts）とアプリの両方で使う。
 *
 * - プロジェクト = 曲の情報（タイトル・音源など）＋ レーン（それぞれが独立した TJA の 1 難易度）＋ メンバー
 * - レーンの中身は「位置ごと」に持つ: 音符は tick ごと、命令は「tick:種類」ごと、グラデは番号ごと
 *   → 違う位置を触っている限り、変更がぶつからない。同じ所はサーバーに後から届いた方が残る
 * - 変更（Op）は「その値にする（null なら消す）」だけなので、何度当てても同じ結果になる（入り直しで送り直しても大丈夫）
 */
import { TPB } from '../chart/model';

/** レーンに置く音符（tick は鍵の方に持つ） */
export interface NoteVal {
  type: 'don' | 'ka' | 'bigDon' | 'bigKa' | 'roll' | 'bigRoll' | 'balloon';
  endTick?: number;
  hits?: number;
}

/** 命令（tick と種類は鍵の方にも持つ） */
export type EventVal =
  | { tick: number; kind: 'bpm'; value: number }
  | { tick: number; kind: 'scroll'; value: number; im?: number }
  | { tick: number; kind: 'measure'; num: number; den: number }
  | { tick: number; kind: 'gogo'; on: boolean }
  | { tick: number; kind: 'barline'; on: boolean }
  | { tick: number; kind: 'delay'; value: number }
  | { tick: number; kind: 'jpos'; time: number; dist: number; dir: 0 | 1 }
  | { tick: number; kind: 'lyric'; text: string }
  | { tick: number; kind: 'section' }
  | { tick: number; kind: 'levelhold' };

/** グラデ（エディタの Grad と同じ形。id で見分ける） */
export interface GradVal {
  id: string;
  start: number;
  end: number;
  from: number;
  to: number;
  mode: 'linear' | 'geometric';
  digits: number;
  basis?: 'count' | 'time';
  speed?: 'scroll' | 'visual' | 'visualBase';
}

/** レーンのヘッダー（独立した TJA としての値） */
export interface LaneHead {
  bpm: number;
  offset: number;
  level: number;
  scrollMode: '' | 'hb' | 'bm';
  /** LEVEL・BALLOON 以外の難易度ごとのヘッダー（SCOREINIT など） */
  extra: [string, string][];
}

export interface Lane {
  id: string;
  /** 難易度（Easy / Normal / Hard / Oni / Edit） */
  course: string;
  name: string;
  /** 作った人（メンバーの id） */
  owner: string;
  color: string;
  /** 本譜面（難易度ごとに 1 本。書き出すのはこれ） */
  main: boolean;
  /** 並べる順（小さい方が上） */
  order: number;
  head: LaneHead;
  notes: Record<string, NoteVal>;
  events: Record<string, EventVal>;
  grads: Record<string, GradVal>;
  /** 本譜面の小節が、だれの案から来たか（鍵は小節の頭の tick） */
  prov?: Record<string, ProvVal>;
}

/** 本譜面の小節の出どころ */
export interface ProvVal {
  /** 小節の終わりの tick */
  end: number;
  /** 案を作った人（メンバーの id） */
  by: string;
  /** 案のレーンの色 */
  color: string;
}

export interface SongMetaC {
  title: string;
  subtitle: string;
  demoStart: number;
  /** 未対応のヘッダー（GENRE など） */
  extra: [string, string][];
  /** 共有している音源（中身から作った値・ファイル名・バイト数） */
  audio: { hash: string; name: string; size: number } | null;
}

export interface Perms {
  /** （前の版の値。今は any と同じ） */
  main: boolean;
  /** 本譜面のどこでも編集できる（担当の外も。本譜面のヘッダーや丸ごとの書き換えもこれが要る） */
  any: boolean;
}

/** 担当の範囲（本譜面のレーンの小節 from〜to。1 から数える・両端を含む。#MEASURE で小節の長さが変わっても小節で合わせる） */
export interface BarRange {
  lane: string;
  from: number;
  to: number;
}

/** 担当（A・B・C…）。リーダーが範囲を決めて、人を割り当てる */
export interface Group {
  id: string;
  name: string;
  color: string;
  ranges: BarRange[];
  members: string[];
}

export interface Member {
  id: string;
  name: string;
  color: string;
  perms: Perms;
  /** 見学の人（メンバーには入らない。前の版の値） */
  viewer: boolean;
  lastSeen: number;
}

export interface TrashItem {
  id: string;
  name: string;
  course: string;
  by: string;
  at: number;
}

export interface CollabDoc {
  meta: SongMetaC;
  lanes: Record<string, Lane>;
  members: Record<string, Member>;
  leader: string;
  trash: TrashItem[];
  /** 担当（A・B・C…） */
  groups: Record<string, Group>;
}

/** 変更 1 つ */
export type Op =
  | { o: 'n'; l: string; k: string; v: NoteVal | null }
  | { o: 'e'; l: string; k: string; v: EventVal | null }
  | { o: 'g'; l: string; k: string; v: GradVal | null }
  | { o: 'h'; l: string; v: Partial<LaneHead> }
  /** レーンの名前・色・順番・難易度（作った人・リーダー） */
  | { o: 'lm'; l: string; v: Partial<Pick<Lane, 'name' | 'color' | 'order' | 'course'>> }
  /** レーンを足す（中身ごと） */
  | { o: 'new'; lane: Lane }
  /** レーンの中身をまとめて置き換える（ヘッダー・音符・命令・グラデ） */
  | { o: 'rep'; l: string; head: LaneHead; notes: Record<string, NoteVal>; events: Record<string, EventVal>; grads: Record<string, GradVal> }
  | { o: 'm'; v: Partial<SongMetaC> }
  /** 本譜面の小節の出どころ */
  | { o: 'pv'; l: string; k: string; v: ProvVal | null };

/** 1 プロジェクトに入れる人数 */
export const MAX_MEMBERS = 8;
/** 見比べ（自分のレーンも入れて何本まで） */
export const COMPARE_MAX = 4;
/** だれも入らないまま、この日数がたった部屋は消える */
export const ROOM_DAYS = 14;

/** 部屋の設定（リーダーが変える） */
export interface RoomSettings {
  name: string;
  /** あいことば（一度入った端末は、次から要らない） */
  pass: string;
  /** 一覧に出さない（部屋番号で探した人だけ） */
  unlisted: boolean;
  /** 見学（あいことばなしで、見るだけで入れる） */
  watch: boolean;
}

/** 部屋の一覧に出す内容 */
export interface RoomInfo {
  id: string;
  name: string;
  title: string;
  leader: string;
  members: number;
  online: number;
  viewers: number;
  watch: boolean;
  unlisted: boolean;
  /** 最後にだれかが入った・出た時刻（ここから ROOM_DAYS 日で消える） */
  lastActive: number;
  /** 最後に編集した時刻 */
  updatedAt: number;
  /** 難易度ごとの本譜面のノーツ数 */
  courses: [string, number][];
}
/** ごみ箱に残す日数 */
export const TRASH_DAYS = 30;
/** チャットを残す数 */
export const CHAT_KEEP = 1000;

export const COLORS = ['#ffd166', '#7ce0c3', '#f78fb3', '#8ab4ff', '#ffa45c', '#c3a6ff', '#9be15d', '#ff6b6b'];

export const noteKey = (tick: number) => String(Math.round(tick));
export const eventKey = (e: { tick: number; kind: string }) => `${Math.round(e.tick)}:${e.kind}`;

export function emptyHead(bpm = 120, offset = 0): LaneHead {
  return { bpm, offset, level: 1, scrollMode: '', extra: [] };
}

/** レーンのヘッダーを、ほかの所から届いた値で安全に作る */
function cleanHead(h: Partial<LaneHead> | undefined, base: LaneHead): LaneHead {
  const out = { ...base };
  if (!h) return out;
  if (typeof h.bpm === 'number' && h.bpm > 0 && h.bpm < 100000) out.bpm = h.bpm;
  if (typeof h.offset === 'number' && Number.isFinite(h.offset)) out.offset = h.offset;
  if (typeof h.level === 'number' && Number.isFinite(h.level)) out.level = h.level;
  if (h.scrollMode === '' || h.scrollMode === 'hb' || h.scrollMode === 'bm') out.scrollMode = h.scrollMode;
  if (Array.isArray(h.extra)) out.extra = h.extra.filter((x) => Array.isArray(x) && x.length === 2).map((x) => [String(x[0]), String(x[1])] as [string, string]).slice(0, 50);
  return out;
}

/**
 * その変更が触る tick（範囲の確認用）。null = レーン全体（ヘッダー・丸ごと）。
 * 1 つ目が置く位置、2 つ目からは終わりの位置（連打の終わり・グラデの終わり。範囲の終わりちょうどでもよい）
 */
export function opTicks(op: Op): number[] | null {
  if (op.o === 'n') {
    const t = Number(op.k);
    return op.v?.endTick !== undefined ? [t, op.v.endTick] : [t];
  }
  if (op.o === 'e') return [Number(op.k.split(':')[0])];
  if (op.o === 'g') return op.v ? [op.v.start, op.v.end] : null;
  return null;
}

/** 1 小節の tick（エディタの measureTicks と同じ） */
const barTicks = (num: number, den: number) => Math.max(1, Math.round((TPB * 4 * num) / den));

/** 小節の頭の tick の表（n 小節目の頭 = starts[n - 1]）。#MEASURE で長さが変わっても合う */
export function barStarts(lane: Lane, upto: number): number[] {
  const ms = Object.values(lane.events)
    .filter((e): e is Extract<EventVal, { kind: 'measure' }> => e.kind === 'measure')
    .sort((a, b) => a.tick - b.tick);
  const out: number[] = [];
  let num = 4;
  let den = 4;
  let start = 0;
  let mi = 0;
  for (let i = 0; i <= upto && i < 100000; i++) {
    while (mi < ms.length && ms[mi].tick <= start) {
      num = ms[mi].num;
      den = ms[mi].den;
      mi++;
    }
    out.push(start);
    start += barTicks(num, den);
  }
  return out;
}

/** その tick が何小節目か（1 から） */
export function barAt(lane: Lane, tick: number): number {
  let upto = 64;
  for (;;) {
    const st = barStarts(lane, upto);
    if (st[st.length - 1] > tick || upto >= 100000) {
      let i = 0;
      while (i + 1 < st.length && st[i + 1] <= tick) i++;
      return i + 1;
    }
    upto *= 4;
  }
}

/** 小節の範囲の tick [頭, 終わり) */
export function barSpan(lane: Lane, from: number, to: number): [number, number] {
  const st = barStarts(lane, Math.max(from, to) + 1);
  return [st[Math.max(0, from - 1)] ?? 0, st[Math.max(0, to)] ?? st[st.length - 1]];
}

/** その人が本譜面のそのレーンで担当している tick の範囲 */
export function mySpans(doc: CollabDoc, mid: string, laneId: string): [number, number][] {
  const lane = doc.lanes[laneId];
  if (!lane) return [];
  const out: [number, number][] = [];
  for (const g of Object.values(doc.groups ?? {})) {
    if (!g.members.includes(mid)) continue;
    for (const r of g.ranges) if (r.lane === laneId) out.push(barSpan(lane, r.from, r.to));
  }
  return out;
}

/** 本譜面を編集できるか（リーダーと、本譜面の権限がある人） */
export function canEditMainAt(doc: CollabDoc, mid: string, _lane: string, _ticks: number[] | null): boolean {
  if (mid === doc.leader) return true;
  const m = doc.members[mid];
  return !!m && !m.viewer && m.perms.any;
}

/** そのレーンのその tick を編集できるか（アプリのタップの判定にも使う） */
export function canEditLane(doc: CollabDoc, mid: string, laneId: string, ticks: number[] | null): boolean {
  const lane = doc.lanes[laneId];
  const m = doc.members[mid];
  if (!lane || !m || m.viewer) return false;
  if (lane.main) return canEditMainAt(doc, mid, laneId, ticks);
  // 自分のレーンは本人だけ（ほかの人は見る・取り込むだけ）
  return lane.owner === mid;
}

const NOTE_TYPES = new Set(['don', 'ka', 'bigDon', 'bigKa', 'roll', 'bigRoll', 'balloon']);
const fin = (x: unknown, lo: number, hi: number) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
const MAX_TICK = 2 ** 40;
const TICK_RE = /^-?\d{1,13}$/;

/** 音符の値が正しいか（壊れた値で全員の譜面が開けなくならないように） */
export function validNote(k: string, v: NoteVal | null): boolean {
  if (!TICK_RE.test(k)) return false;
  if (v === null) return true;
  if (!v || typeof v !== 'object' || !NOTE_TYPES.has(v.type)) return false;
  if (v.endTick !== undefined && !(fin(v.endTick, -MAX_TICK, MAX_TICK) && v.endTick > Number(k))) return false;
  if (v.hits !== undefined && !(Number.isInteger(v.hits) && v.hits >= 1 && v.hits <= 99999)) return false;
  return true;
}

/** 命令の値が正しいか */
export function validEvent(k: string, v: EventVal | null): boolean {
  const [t, kind] = k.split(':');
  if (!TICK_RE.test(t) || !kind) return false;
  if (v === null) return true;
  if (!v || typeof v !== 'object' || v.kind !== kind || !fin(v.tick, -MAX_TICK, MAX_TICK) || Math.round(v.tick) !== Number(t)) return false;
  switch (v.kind) {
    case 'bpm': return fin(v.value, 0.0001, 100000);
    case 'scroll': return fin(v.value, -100000, 100000) && (v.im === undefined || fin(v.im, -100000, 100000));
    case 'lyric': return typeof v.text === 'string' && v.text.length <= 500;
    case 'section': case 'levelhold': return true;
    case 'measure': return Number.isInteger(v.num) && Number.isInteger(v.den) && v.num >= 1 && v.den >= 1 && v.num <= 100000 && v.den <= 100000;
    case 'gogo': case 'barline': return typeof v.on === 'boolean';
    case 'delay': return fin(v.value, -600, 600);
    case 'jpos': return fin(v.time, 0, 600) && fin(v.dist, -100000, 100000) && (v.dir === 0 || v.dir === 1);
  }
  return false;
}

/** グラデの値が正しいか */
export function validGrad(v: GradVal | null): boolean {
  if (v === null) return true;
  return !!v && typeof v === 'object' && fin(v.start, -MAX_TICK, MAX_TICK) && fin(v.end, -MAX_TICK, MAX_TICK) && v.end > v.start
    && fin(v.from, -100000, 100000) && fin(v.to, -100000, 100000) && (v.mode === 'linear' || v.mode === 'geometric') && fin(v.digits, 0, 10);
}

/** 変更の値が正しいか（サーバーとアプリの両方で確かめる） */
export function validOp(op: Op): boolean {
  if (!op || typeof op !== 'object') return false;
  switch (op.o) {
    case 'n': return typeof op.k === 'string' && validNote(op.k, op.v);
    case 'e': return typeof op.k === 'string' && validEvent(op.k, op.v);
    case 'g': return typeof op.k === 'string' && validGrad(op.v);
    case 'h': return !!op.v && typeof op.v === 'object' && (op.v.bpm === undefined || fin(op.v.bpm, 0.0001, 100000)) && (op.v.offset === undefined || fin(op.v.offset, -3600, 3600));
    case 'new':
    case 'rep': {
      const src = op.o === 'new' ? op.lane : op;
      if (!src || typeof src !== 'object') return false;
      const notes = Object.entries(src.notes ?? {});
      const events = Object.entries(src.events ?? {});
      const grads = Object.values(src.grads ?? {});
      if (notes.length > 50000 || events.length > 20000 || grads.length > 2000) return false;
      if (op.o === 'new' && src.head && !validOp({ o: 'h', l: '', v: src.head } as Op)) return false;
      if (op.o === 'rep' && op.head && !validOp({ o: 'h', l: '', v: op.head } as Op)) return false;
      return notes.every(([k, v]) => validNote(k, v)) && events.every(([k, v]) => validEvent(k, v)) && grads.every((g) => validGrad(g));
    }
    case 'lm': case 'm': return !!op.v && typeof op.v === 'object';
    case 'pv': return typeof op.k === 'string' && TICK_RE.test(op.k) && (op.v === null || (!!op.v && typeof op.v === 'object' && fin(op.v.end, -MAX_TICK, MAX_TICK) && op.v.end > Number(op.k) && typeof op.v.by === 'string' && typeof op.v.color === 'string' && op.v.color.length <= 20));
  }
  return false;
}

/** 曲全体の時間に効く命令（担当の人は置けない。ほかの担当の小節や時刻まで動くため） */
export const GLOBAL_EVENTS = new Set(['bpm', 'measure', 'delay']);

/** その変更をしてよいか */
export function canApply(doc: CollabDoc, mid: string, op: Op): boolean {
  const m = doc.members[mid];
  if (!m || m.viewer || !validOp(op)) return false;
  const leader = mid === doc.leader;
  switch (op.o) {
    case 'e': {
      const lane = doc.lanes[op.l];
      if (lane?.main && GLOBAL_EVENTS.has(op.k.split(':')[1]) && !leader && !m.perms.any) return false;
      return canEditLane(doc, mid, op.l, opTicks(op));
    }
    case 'n':
    case 'g':
    case 'h':
    case 'rep':
      return canEditLane(doc, mid, op.l, op.o === 'h' || op.o === 'rep' ? null : opTicks(op));
    case 'lm': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      if (lane.main) return leader || m.perms.any;
      return leader || lane.owner === mid;
    }
    case 'new':
      // 本譜面を足せるのはリーダーと、本譜面を自由に編集できる人。下書きは誰でも（自分のもの）
      if (op.lane.main) return leader || m.perms.any;
      return op.lane.owner === mid;
    case 'm':
      return leader || m.perms.any;
    case 'pv':
      return !!doc.lanes[op.l]?.main && (leader || m.perms.any);
  }
}

const isNote = (v: unknown): v is NoteVal => !!v && typeof v === 'object' && typeof (v as NoteVal).type === 'string';

/** 変更を当てる（当てられなかったら false）。サーバーとアプリで同じ結果になる */
export function applyOp(doc: CollabDoc, op: Op): boolean {
  switch (op.o) {
    case 'n': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      if (op.v === null) delete lane.notes[op.k];
      else if (isNote(op.v)) lane.notes[op.k] = { ...op.v };
      else return false;
      return true;
    }
    case 'e': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      if (op.v === null) delete lane.events[op.k];
      else lane.events[op.k] = { ...op.v };
      return true;
    }
    case 'g': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      if (op.v === null) delete lane.grads[op.k];
      else lane.grads[op.k] = { ...op.v, id: op.k };
      return true;
    }
    case 'h': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      lane.head = cleanHead(op.v, lane.head);
      return true;
    }
    case 'lm': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      if (typeof op.v.name === 'string') lane.name = op.v.name.slice(0, 40);
      if (typeof op.v.color === 'string') lane.color = op.v.color.slice(0, 20);
      if (typeof op.v.order === 'number') lane.order = op.v.order;
      if (typeof op.v.course === 'string' && !lane.main) lane.course = op.v.course.slice(0, 20);
      return true;
    }
    case 'new': {
      const l = op.lane;
      if (!l || typeof l.id !== 'string' || doc.lanes[l.id]) return false;
      // 本譜面は難易度ごとに 1 本だけ
      if (l.main && Object.values(doc.lanes).some((x) => x.main && x.course === l.course)) return false;
      doc.lanes[l.id] = {
        id: l.id, course: String(l.course || 'Oni').slice(0, 20), name: String(l.name || '').slice(0, 40), owner: String(l.owner), color: String(l.color || COLORS[0]),
        main: !!l.main, order: Number(l.order) || 0, head: cleanHead(l.head, emptyHead()),
        notes: { ...(l.notes ?? {}) }, events: { ...(l.events ?? {}) }, grads: { ...(l.grads ?? {}) }, prov: { ...(l.prov ?? {}) },
      };
      return true;
    }
    case 'rep': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      lane.head = cleanHead(op.head, lane.head);
      lane.notes = { ...(op.notes ?? {}) };
      lane.events = { ...(op.events ?? {}) };
      lane.grads = { ...(op.grads ?? {}) };
      return true;
    }
    case 'pv': {
      const lane = doc.lanes[op.l];
      if (!lane) return false;
      lane.prov ??= {};
      if (op.v === null) delete lane.prov[op.k];
      else lane.prov[op.k] = { end: op.v.end, by: String(op.v.by).slice(0, 40), color: String(op.v.color).slice(0, 20) };
      return true;
    }
    case 'm': {
      const v = op.v;
      if (typeof v.title === 'string') doc.meta.title = v.title.slice(0, 200);
      if (typeof v.subtitle === 'string') doc.meta.subtitle = v.subtitle.slice(0, 200);
      if (typeof v.demoStart === 'number' && Number.isFinite(v.demoStart)) doc.meta.demoStart = v.demoStart;
      if (Array.isArray(v.extra)) doc.meta.extra = v.extra.filter((x) => Array.isArray(x) && x.length === 2).map((x) => [String(x[0]), String(x[1])] as [string, string]).slice(0, 50);
      if (v.audio === null || (v.audio && typeof v.audio.hash === 'string')) doc.meta.audio = v.audio ? { hash: v.audio.hash, name: String(v.audio.name), size: Number(v.audio.size) || 0 } : null;
      return true;
    }
  }
}

/** 新しい空のプロジェクト */
export function emptyDoc(): CollabDoc {
  return { meta: { title: '', subtitle: '', demoStart: 0, extra: [], audio: null }, lanes: {}, members: {}, leader: '', trash: [], groups: {} };
}

/** 本譜面・レーンの並び（難易度の順 → 本譜面 → order） */
const COURSE_ORDER = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
export function sortedLanes(doc: CollabDoc, course?: string): Lane[] {
  return Object.values(doc.lanes)
    .filter((l) => course === undefined || l.course === course)
    .sort((a, b) => COURSE_ORDER.indexOf(a.course) - COURSE_ORDER.indexOf(b.course) || Number(b.main) - Number(a.main) || a.order - b.order || a.id.localeCompare(b.id));
}

export const newCollabId = (n = 10) => {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => A[x % A.length]).join('');
};

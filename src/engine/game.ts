import { isDon, isHitNote, type Course, type Note } from '../chart/types';

export type Judge = 'good' | 'ok' | 'bad';
export type HitKind = 'don' | 'ka';

/** 判定幅（秒）。片側の幅。良 ±32ms / 可 ±75ms / 不可 ±114ms（良を広げた分、可は 32〜75ms に狭まる。外側の 114ms は同じ） */
/** 浮動小数点の誤差の吸収（0.001ms） */
const EPS = 1e-6;

/** 大音符の両手打ちを待つ時間（秒）。TNDE の BigNotesWaitTime と同じ 50ms */
export const BIG_WAIT = 0.05;

export const WINDOW = { good: 0.032, ok: 0.075, bad: 0.114 } as const;

/**
 * 見逃し（不可）にするまでの猶予（秒）。
 * スマホではタッチの処理が次のフレームより後になることがあるので、114ms を過ぎたらすぐ見逃しにすると、
 * 実際には 114ms 以内に叩いていた打撃が「判定なし」になってしまう。判定そのものは叩いた瞬間の時刻で行う。
 */
const MISS_GRACE = 0.08;

/** 判定されなかった打撃のうち、近くの同じ色のノーツとのずれを記録する範囲（秒） */
const NEAR_RANGE = 0.6;

/** 打撃と見逃しの記録（結果画面の診断・ログ用） */
export type LogEntry =
  | { e: 'tap'; t: number; kind: HitKind; res: HitResult['type']; judge?: Judge; note?: number; ring?: number }
  | { e: 'miss'; t: number; type: string };

/** hit() の結果（画面のずれ表示や結果画面の集計に使う） */
export type HitResult =
  | { type: 'judged'; judge: Judge; delta: number }
  | { type: 'big' }
  | { type: 'roll' }
  /** 判定されなかった。nearest = 同じ色のいちばん近いノーツとのずれ（なければ null）、wrongColor = 判定幅の中に色違いのノーツがあった */
  | { type: 'none'; nearest: number | null; wrongColor: boolean };

export interface NoteState {
  note: Note;
  /** 普通ノーツ: 判定済みか。長いノーツ: 終了したか */
  done: boolean;
  judge?: Judge;
  /** 連打数・風船の打数 */
  count: number;
  /** 叩かずに見逃した（画面左まで流れ続ける） */
  missed?: boolean;
  /** 通らなかった分岐の音符（判定も表示もしない） */
  skip?: boolean;
}

/** 譜面分岐（toPlayable の branches・sections・holds）。fixed があれば、いつもその分岐 */
export type BranchInfo = Pick<Course, 'branches' | 'sections' | 'holds'> & { fixed?: number };

export interface JudgeEvent {
  judge: Judge;
  note: Note;
  delta: number; // 叩いた時刻 - ノーツ時刻（＋で遅い）
  missed: boolean;
}

export interface Stats {
  good: number;
  ok: number;
  bad: number;
  combo: number;
  maxCombo: number;
  rolls: number;
  score: number;
  /** 魂ゲージ 0〜100（80 でクリア） */
  gauge: number;
}

export const CLEAR_LINE = 80;
/** 全部「良」のとき、音符の何割を叩き終えたらゲージが満タンになるか（クリアは 0.75 × 0.8 = 6 割） */
const GAUGE_FULL_AT = 0.75;
/** 風船（くす玉も）1 打の点数 */
export const BALLOON_HIT_SCORE = 100;
/** 最大スコア（全部「良」・連打なし） */
export const MAX_SCORE = 1_000_000;

/**
 * 初項（「良」1 つの点数）。最大コンボ数 × 初項 ＋ 風船の総打数 × 100 ＝ 100 万点 になるように決め、10 の位で切り上げる
 */
export function scoreBase(maxCombo: number, balloonHits: number): number {
  if (maxCombo <= 0) return 0;
  return Math.ceil((MAX_SCORE - balloonHits * BALLOON_HIT_SCORE) / maxCombo / 10) * 10;
}

/**
 * 判定ロジック本体。描画や入力から独立しているのでテストしやすい。
 */
export class Game {
  readonly states: NoteState[];
  readonly stats: Stats = { good: 0, ok: 0, bad: 0, combo: 0, maxCombo: 0, rolls: 0, score: 0, gauge: 0 };
  /** 次に判定する普通ノーツのインデックス */
  private cursor = 0;
  private readonly hitIdx: number[];
  /** 叩いたノーツのずれ（秒、＋で遅い）。色が合っていたものだけ。結果画面で平均を出して判定調整に使う */
  readonly deltas: number[] = [];
  /** 判定幅の外だった打撃の、近くの同じ色のノーツとのずれ（秒）。端末の音の遅れが大きいときの調整に使う */
  readonly outside: number[] = [];
  /** 打撃と見逃しの記録 */
  readonly log: LogEntry[] = [];
  /** 打撃の集計（結果画面の診断用） */
  readonly taps = { total: 0, judged: 0, roll: 0, big: 0, none: 0, wrongColor: 0 };
  onJudge: (e: JudgeEvent) => void = () => {};
  /** 連打・風船を叩いたとき */
  onRoll: (s: NoteState) => void = () => {};
  /** 分岐が決まったとき（区間の番号・前の分岐・決まった分岐） */
  onBranch: (sec: number, from: number, to: number) => void = () => {};

  /** 今の分岐（0 = 普通・1 = 玄人・2 = 達人） */
  branch = 0;
  private readonly br: BranchInfo;
  /** 区間ごとに決まった分岐 */
  private readonly chosen: number[] = [];
  private brIdx = 0;
  private secIdx = 0;
  private holdIdx = 0;
  private held = false;
  /** #SECTION（無ければ最初）からの数を出すための、その時の値 */
  private mark = { good: 0, ok: 0, bad: 0, rolls: 0, score: 0 };
  /** 連打・風船を叩いた数（分岐の判定用） */
  private rollHits = 0;
  /** 判定の分母（音符の数）。分岐があるときは、区間ごとにいちばん多い分岐で数える */
  private readonly hitCount: number;

  constructor(notes: Note[], branch?: BranchInfo) {
    this.br = branch ?? {};
    this.states = notes
      .slice()
      .sort((a, b) => a.time - b.time)
      .map((note) => ({ note, done: false, count: 0 }));
    this.hitIdx = this.states.map((_, i) => i).filter((i) => isHitNote(this.states[i].note.type));
    // 分岐の情報が無いのに分岐の音符があるときは、普通譜面だけ
    const fixed = this.br.branches?.length ? this.br.fixed : 0;
    if (fixed !== undefined) this.branch = fixed;
    if (!this.br.branches?.length) for (const st of this.states) if ((st.note.br ?? 0) !== 0) { st.skip = true; st.done = true; }
    // #END の後ろの音符（飾り）: 判定しない。見逃した音符と同じく、そのまま流れていく
    for (const st of this.states) if (st.note.dummy) { st.done = true; st.missed = true; }
    const count = (pick: (n: Note) => boolean) => {
      const per = new Map<number, number[]>();
      let common = 0;
      let balloon = 0;
      for (const n of notes) {
        if (!pick(n) || n.dummy) continue;
        if (n.sec === undefined) {
          if (isHitNote(n.type)) common++;
          else if (n.type === 'balloon') balloon += Math.max(1, n.hits ?? 5);
          continue;
        }
        const a = per.get(n.sec) ?? [0, 0, 0];
        if (isHitNote(n.type)) a[n.br ?? 0]++;
        per.set(n.sec, a);
      }
      return { hits: common + [...per.values()].reduce((x, a) => x + Math.max(...a), 0), balloon };
    };
    const c = count((n) => n.br === undefined || !!this.br.branches?.length || n.br === 0);
    this.hitCount = c.hits;
    this.base = scoreBase(c.hits, c.balloon);
  }

  /** その音符を、今の分岐で叩く・描くか */
  active(n: Note): boolean {
    if (n.sec === undefined) return true;
    return (this.chosen[n.sec] ?? this.branch) === (n.br ?? 0);
  }

  /** 分岐を決める・#SECTION・#LEVELHOLD（時刻の順に） */
  private stepBranch(now: number) {
    const b = this.br;
    const secs = b.sections ?? [];
    const holds = b.holds ?? [];
    const list = b.branches ?? [];
    for (;;) {
      const tS = this.secIdx < secs.length ? secs[this.secIdx] : Infinity;
      const tH = this.holdIdx < holds.length ? holds[this.holdIdx].time : Infinity;
      // 曲の最初の小節からの分岐は、始まる少し前に決める
      const nb = list[this.brIdx];
      const tB = nb ? Math.min(nb.judge, nb.start - 0.3) : Infinity;
      const t = Math.min(tS, tH, tB);
      if (t > now || t === Infinity) return;
      if (t === tS) {
        const st = this.stats;
        this.mark = { good: st.good, ok: st.ok, bad: st.bad, rolls: this.rollHits, score: st.score };
        this.secIdx++;
      } else if (t === tH) {
        const h = holds[this.holdIdx++];
        if (h.br === undefined || h.br === this.branch) this.held = true;
      } else {
        const i = this.brIdx++;
        const from = this.branch;
        const to = b.fixed ?? (this.held ? this.branch : this.decide(nb));
        this.chosen[i] = to;
        this.branch = to;
        for (const s of this.states) if (s.note.sec === i && (s.note.br ?? 0) !== to) { s.skip = true; s.done = true; }
        this.onBranch(i, from, to);
      }
    }
  }

  private decide(nb: NonNullable<Course['branches']>[number]): number {
    const st = this.stats;
    const m = this.mark;
    let v: number;
    if (nb.type === 'r') v = this.rollHits - m.rolls;
    else if (nb.type === 's') v = st.score - m.score;
    else {
      const good = st.good - m.good;
      const ok = st.ok - m.ok;
      const all = good + ok + (st.bad - m.bad);
      v = all ? ((good + ok * 0.5) / all) * 100 : 0;
    }
    return v >= nb.y - 1e-9 ? 2 : v >= nb.x - 1e-9 ? 1 : 0;
  }

  /** 初項（「良」1 つの点数）。「可」はその半分（10 点未満は切り捨て） */
  readonly base: number;

  get totalHitNotes() {
    return this.hitCount;
  }

  get finished() {
    return this.states.every((s) => s.done);
  }

  /** 毎フレーム呼ぶ。見逃したノーツを「不可」にし、終わった連打を閉じる */
  update(now: number) {
    this.stepBranch(now);
    while (this.cursor < this.hitIdx.length) {
      const s = this.states[this.hitIdx[this.cursor]];
      if (s.done) { this.cursor++; continue; }
      if (now - s.note.time > WINDOW.bad + MISS_GRACE) {
        s.missed = true;
        this.log.push({ e: 'miss', t: s.note.time, type: s.note.type });
        this.apply(s, 'bad', now - s.note.time);
        this.cursor++;
      } else break;
    }
    for (const s of this.states) {
      if (!s.done && !isHitNote(s.note.type) && now > (s.note.endTime ?? s.note.time)) {
        s.done = true;
      }
    }
  }

  /** 大音符を叩いた直後の、両手打ちの 2 打目を待っている状態 */
  private bigWait: { kind: HitKind; at: number } | null = null;

  /** 叩いたときに呼ぶ */
  /** ring = タッチした場所が太鼓の面の中心からどれくらい離れていたか（1 が面と縁の境目）。キーボードのときはなし */
  hit(kind: HitKind, now: number, ring?: number): HitResult {
    this.stepBranch(now);
    this.taps.total++;
    const r = this.hitInner(kind, now);
    this.log.push({
      e: 'tap', t: now, kind, res: r.type, ring,
      judge: r.type === 'judged' ? r.judge : undefined,
      note: r.type === 'judged' ? now - r.delta : undefined,
    });
    this.taps[r.type === 'judged' ? 'judged' : r.type]++;
    if (r.type === 'none') {
      if (r.wrongColor) this.taps.wrongColor++;
      if (r.nearest !== null) this.outside.push(r.nearest);
    }
    return r;
  }

  /** 判定前の同じ色の普通ノーツのうち、now にいちばん近いものと、そのずれの大きさ */
  private nearestSame(kind: HitKind, now: number): { st: NoteState; ad: number } | null {
    let best: { st: NoteState; ad: number } | null = null;
    for (let i = this.cursor; i < this.hitIdx.length; i++) {
      const st = this.states[this.hitIdx[i]];
      const d = now - st.note.time;
      if (d < -WINDOW.bad - EPS) break;
      if (st.done || (kind === 'don') !== isDon(st.note.type)) continue;
      const ad = Math.abs(d);
      if (ad <= WINDOW.bad + EPS && (!best || ad < best.ad - 1e-9)) best = { st, ad };
    }
    return best;
  }

  /** 判定前の別の色の普通ノーツのうち、now にいちばん近いもの */
  private nearestOther(kind: HitKind, now: number): { st: NoteState; ad: number } | null {
    return this.nearestSame(kind === 'don' ? 'ka' : 'don', now);
  }

  private hitInner(kind: HitKind, now: number): HitResult {
    const near = this.nearestSame(kind, now);

    // 1) 大音符の両手打ち: 大音符を叩いてから 50ms 以内の同じ色の 2 打目は、次のノーツの判定に使わない
    //    （使うと次のノーツが「早い不可」になる。TNDE の BigNotesWaitTime=50ms と同じ考え方）
    //    ただし、次の音符のほうが時間的に近い打撃は、片手で叩いた後の次の音符への打撃とみなして判定する
    const bw = this.bigWait;
    if (bw && kind === bw.kind && now >= bw.at - EPS && now - bw.at <= BIG_WAIT + EPS) {
      this.bigWait = null;
      if (!near || now - bw.at < near.ad) {
        return { type: 'big' };
      }
    }

    // 2) 連打・風船の最中なら、そちらに入れる（次のノーツを早く叩いたことにしない）
    //    ただし、すぐ後の同じ色の音符が「可」の幅（75ms）以内なら、連打ではなく音符を判定する
    const noteFirst = near !== null && near.ad <= WINDOW.ok + EPS;
    for (const ls of noteFirst ? [] : this.states) {
      const n = ls.note;
      if (ls.done || isHitNote(n.type)) continue;
      if (now < n.time) break; // states は時刻順
      if (now > (n.endTime ?? n.time)) continue;
      if (n.type === 'balloon') {
        if (kind !== 'don') return { type: 'roll' }; // 風船はドンだけ。カッは何も起きない
        ls.count++;
        this.rollHits++;
        this.stats.score += BALLOON_HIT_SCORE;
        if (ls.count >= (n.hits ?? 5)) ls.done = true;
      } else {
        ls.count++;
        this.rollHits++;
        this.stats.rolls++;
        this.stats.score += n.type === 'bigRoll' ? 200 : 100;
      }
      this.onRoll(ls);
      return { type: 'roll' };
    }

    // 3) 判定幅の中で、叩いた色と同じ色のノーツのうち、叩いた時刻にいちばん近いものを判定する
    //    - 色違いのノーツは対象にしない（色違いで叩いても不可にはせず、ノーツは残る。TNDE/TJAPlayer3 と同じ）
    //    - いちばん古いノーツにすると、1つ見逃しただけで後のノーツが全部「遅い」扱いになってしまう
    // 叩いた時刻の近く（50ms 以内）に判定前の別の色の音符があり、同じ色の音符よりそちらのほうが近いときは、
    // 面と縁の境目を叩いて色を取り違えた打撃とみなし、離れた同じ色の音符を横取りして判定しない
    // （横取りすると、その音符を本当に叩いたときに「近くに音符なし」になり、狙った音符も見逃しになる）
    const other = this.nearestOther(kind, now);
    if (other && other.ad <= 0.05 + EPS && (!near || other.ad < near.ad)) {
      return { type: 'none', nearest: near ? now - near.st.note.time : null, wrongColor: true };
    }

    const best = near?.st;
    if (!best) {
      // 判定幅の中に同じ色のノーツがない: 音が鳴るだけ。原因を調べられるように近くのノーツを記録する
      let nearest: number | null = null;
      let wrongColor = false;
      for (let i = this.cursor; i < this.hitIdx.length; i++) {
        const st = this.states[this.hitIdx[i]];
        const d = now - st.note.time;
        if (d < -NEAR_RANGE) break;
        if (st.done) continue;
        const sameColor = (kind === 'don') === isDon(st.note.type);
        if (!sameColor && Math.abs(d) <= WINDOW.bad) wrongColor = true;
        if (sameColor && Math.abs(d) <= NEAR_RANGE && (nearest === null || Math.abs(d) < Math.abs(nearest))) nearest = d;
      }
      return { type: 'none', nearest, wrongColor };
    }

    const delta = now - best.note.time;
    // 境界ちょうど（例: 32ms）が浮動小数点の誤差で外れないよう、わずかに余裕を持たせる
    const ad = Math.abs(delta) - EPS;
    const judge: Judge = ad <= WINDOW.good ? 'good' : ad <= WINDOW.ok ? 'ok' : 'bad';
    this.deltas.push(delta);
    this.apply(best, judge, delta);
    const big = best.note.type === 'bigDon' || best.note.type === 'bigKa';
    this.bigWait = big && judge !== 'bad' ? { kind, at: now } : null;
    return { type: 'judged', judge, delta };
  }

  private apply(s: NoteState, judge: Judge, delta: number) {
    s.done = true;
    s.judge = judge;
    const st = this.stats;
    st[judge]++;
    if (judge === 'bad') {
      st.combo = 0;
    } else {
      st.combo++;
      st.maxCombo = Math.max(st.maxCombo, st.combo);
      // 大音符・ゴーゴータイムでも点数は同じ（初項だけ）
      st.score += judge === 'good' ? this.base : Math.floor(this.base / 2 / 10) * 10;
    }
    // 全部「良」なら音符の 6 割でクリア、7.5 割で満タン。「可」は半分、「不可」は 2 倍減る
    const unit = 100 / Math.max(1, this.hitCount * GAUGE_FULL_AT);
    const dg = judge === 'good' ? unit : judge === 'ok' ? unit * 0.5 : -unit * 2;
    st.gauge = Math.min(100, Math.max(0, st.gauge + dg));
    if (st.gauge > 100 - 1e-6) st.gauge = 100; // 小数の誤差で満タンにならないのを防ぐ
    this.onJudge({ judge, note: s.note, delta, missed: !!s.missed });
  }
}

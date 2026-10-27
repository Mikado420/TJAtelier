/**
 * 合作（リアルタイム共同編集）の画面と、エディタとのつなぎ。
 *
 * - プロジェクトを開く・作る（ふつうの曲から共有を始める）・リンクで入る
 * - 開いているレーンをエディタに入れ、編集のたびに差分を送る。ほかの人の変更はエディタに入れ直す
 * - 元に戻すは自分の変更だけ（ほかの人が同じ所を変えていたら戻さない）
 * - 波形の所に、ほかのレーンを時刻をそろえて並べる。ほかの人の見ている場所も出す
 * - レーン・メンバーと権限・チャット・版の記録・書き出しの画面
 */
import { measures, Timing, toPlayable, TPB, type EChart } from '../chart/model';
import type { Course } from '../chart/types';
import { putCachedAudio, getCachedAudio } from '../online/cache';
import { audioHash } from '../online/net';
import type { Editor } from '../editor/editor';
import type { EditorView, GhostRow } from '../editor/view';
import type { AudioFile } from '../io/load';
import { courseToLane, diff, laneToChart, stateOf, type LaneState } from './bridge';
import {
  canApply, canEditLane, COLORS, emptyHead, newCollabId, sortedLanes, TRASH_DAYS,
  type CollabDoc, type Lane, type Member, type NoteVal, type Op,
} from './protocol';
import { CollabSession, forgetJoined, joinedList, rememberJoined, type ChatMsg, type CollabLink, type JoinedProject } from './session';

export interface CollabHost {
  ed: Editor;
  view: EditorView;
  toast(msg: string): void;
  /** 音源を入れる（曲の一覧には保存しない） */
  setAudio(f: AudioFile | null): Promise<void>;
  /** エディタの画面を出す */
  showEditor(): void;
  /** 曲えらびへ */
  showHome(): Promise<void>;
  isPlaying(): boolean;
  startPlayback(): Promise<void>;
  stopPlayback(): void;
  updateHeader(): void;
  /** 再生中の打音を作り直す */
  rebuildHits(): void;
  saveTja(chart: EChart, name?: string): void;
  saveZip(chart: EChart): Promise<void>;
  startTest(fromStart: boolean): Promise<void>;
  busy(msg: string, p?: number): void;
  busyEnd(): void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COURSES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
const COURSE_JA: Record<string, string> = { Easy: 'かんたん', Normal: 'ふつう', Hard: 'むずかしい', Oni: 'おに', Edit: 'うら' };
const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];
const NAME_KEY = 'malody-web:collabName';
const hashOk = (h: string) => h.replace(/[^0-9a-z]/gi, '');
const fmtDate = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const linkOf = (id: string, key: string) => `${location.origin}${location.pathname}#collab=${id}.${key}`;

/** #collab=ID.KEY のリンクを読む */
export function parseCollabHash(h = location.hash): CollabLink | null {
  const m = h.match(/collab=([A-Z0-9]{10})\.([A-Za-z0-9]{8,40})/);
  return m ? { id: m[1], key: m[2] } : null;
}

type Panel = 'menu' | 'lanes' | 'members' | 'vers' | 'share' | 'newLane' | 'ranges';

export class Collab {
  s: CollabSession | null = null;
  laneId = '';
  /** 開いているレーンの、最後に送った（受け取った）状態 */
  private base: LaneState | null = null;
  private quiet = 0;
  private undoSt: { ops: Op[]; inv: Op[] }[] = [];
  private redoSt: { ops: Op[]; inv: Op[] }[] = [];
  /** 再生のしかた: 自分のレーンだけ / 見比べ（チェックしたレーンも鳴らす） */
  playMode: 'mine' | 'compare' = 'mine';
  compare = new Set<string>();
  /** ついていく人 */
  follow: string | null = null;
  private cursors = new Map<string, { l: string; tick: number; play: boolean; at: number }>();
  private unread = 0;
  private chatOpen = false;
  private chatAt: { l: string; tick: number } | null = null;
  private panel: Panel | null = null;
  private rangeFor = '';
  /** レーンの中身が変わった回数（再生用の譜面・タイミングを作り直すため） */
  private laneVer = new Map<string, number>();
  private cache = new Map<string, { v: number; chart: EChart; course: Course; timing: Timing }>();
  /** 読み込んだ音源の値 */
  private loadedHash = '';
  private pendingShift = 0;
  private seed: { lanes: Lane[]; meta: Op; audio: AudioFile | null } | null = null;
  private chip: HTMLElement;
  private panelEl: HTMLElement;
  private chatEl: HTMLElement;
  private playTimer = 0;

  constructor(private h: CollabHost) {
    const stage = document.querySelector('.stage')!;
    this.chip = document.createElement('div');
    this.chip.id = 'collabChip';
    this.chip.className = 'cchip hidden';
    stage.appendChild(this.chip);
    const root = document.getElementById('root') ?? document.body;
    this.panelEl = document.createElement('div');
    this.panelEl.id = 'cpanel';
    this.panelEl.className = 'sheet cpanel hidden';
    root.appendChild(this.panelEl);
    this.chatEl = document.createElement('div');
    this.chatEl.id = 'cchat';
    this.chatEl.className = 'cchat hidden';
    root.appendChild(this.chatEl);
    this.chip.addEventListener('click', (e) => this.onChip(e));
    this.panelEl.addEventListener('click', (e) => void this.onPanelClick(e));
    this.panelEl.addEventListener('change', (e) => this.onPanelChange(e));
    this.chatEl.addEventListener('click', (e) => this.onChatClick(e));
    this.chatEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && (e.target as HTMLElement).id === 'cchatIn') {
        e.preventDefault();
        this.sendChat();
      }
    });
    h.view.onGhostTap = (id) => this.openLane(id);
  }

  get active() {
    return !!this.s;
  }
  get doc(): CollabDoc | null {
    return this.s?.doc ?? null;
  }
  get me() {
    return this.s?.me ?? '';
  }
  get lane(): Lane | undefined {
    return this.doc?.lanes[this.laneId];
  }
  private get meM(): Member | undefined {
    return this.doc?.members[this.me];
  }
  get isLeader() {
    return !!this.doc && this.doc.leader === this.me;
  }
  /** 本譜面を自由に編集できる（リーダーか、本譜面＋範囲外の権限） */
  get free() {
    const m = this.meM;
    return this.isLeader || (!!m && m.perms.main && m.perms.any);
  }
  get canUndo() {
    return this.undoSt.length > 0;
  }
  get canRedo() {
    return this.redoSt.length > 0;
  }

  // ───── 開く・作る・抜ける ─────

  private profile() {
    let name = '';
    try { name = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* なし */ }
    if (!name) {
      name = (prompt('合作で表示する名前', '') ?? '').trim().slice(0, 24) || 'メンバー';
      try { localStorage.setItem(NAME_KEY, name); } catch { /* なし */ }
    }
    return { name, color: '' };
  }

  /** ふつうの曲から合作を始める（全部の難易度を本譜面にして、音源も置く） */
  async share(chart: EChart, audio: AudioFile | null, songId?: string) {
    const id = newCollabId(10);
    if (songId) markShared(songId, id);
    const key = newCollabId(16);
    const vkey = newCollabId(16);
    const lanes: Lane[] = chart.courses.map((c, i) => courseToLane(chart, c, { id: newCollabId(8), name: COURSE_JA[c.name] ?? c.name, owner: '', color: COLORS[i % COLORS.length], main: true, order: i }));
    // 同じ難易度が 2 つあるときは、2 つ目からは下書き
    const seen = new Set<string>();
    for (const l of lanes) {
      if (seen.has(l.course)) l.main = false;
      seen.add(l.course);
    }
    this.seed = { lanes, meta: { o: 'm', v: { title: chart.title, subtitle: chart.subtitle, demoStart: chart.demoStart, extra: chart.extra } }, audio };
    await this.open({ id, key }, vkey);
  }

  /** プロジェクトを開く（vkey を渡すと新しく作る） */
  async open(link: CollabLink, createVkey?: string) {
    this.close(false);
    const s = new CollabSession(link, this.profile(), createVkey ? { vkey: createVkey } : undefined);
    this.s = s;
    this.laneId = '';
    this.base = null;
    this.undoSt = [];
    this.redoSt = [];
    this.compare.clear();
    this.cursors.clear();
    this.unread = 0;
    this.loadedHash = '';
    this.laneVer.clear();
    this.cache.clear();
    s.handlers({
      reset: () => void this.onReset(),
      lanes: (ids, by) => this.onLanes(ids, by),
      meta: () => this.onMeta(),
      laneList: () => {
        if (this.laneId && !this.doc?.lanes[this.laneId]) {
          this.h.toast('開いていたレーンがごみ箱に入りました');
          this.openLane(this.defaultLane());
        }
        this.renderChip();
        this.refreshGhosts();
        this.rerenderPanel();
      },
      members: () => { this.renderChip(); this.rerenderPanel(); },
      online: () => { this.renderChip(); this.rerenderPanel(); },
      chat: (m) => this.onChat(m),
      cursor: (by, l, tick, play) => { this.cursors.set(by, { l, tick, play, at: Date.now() }); },
      playall: (m) => this.onPlayAll(m),
      stopall: () => { clearTimeout(this.playTimer); this.h.stopPlayback(); },
      trash: () => this.rerenderPanel(),
      vers: () => this.rerenderPanel(),
      status: (st, msg) => {
        this.renderChip();
        if (st === 'denied') {
          this.h.toast(msg ?? '入れませんでした');
          if (!this.doc) {
            this.close(false);
            void this.h.showHome();
          }
        }
      },
      error: (msg) => this.h.toast(msg),
      rejected: (n) => this.h.toast(`${n} 個の変更は、権限が無いので戻しました`),
      kicked: () => {
        this.h.toast('このプロジェクトから外されました');
        forgetJoined(link.id);
        this.close(false);
        void this.h.showHome();
      },
    });
    this.h.showEditor();
    this.chip.classList.remove('hidden');
    document.body.classList.add('collab');
    if (!createVkey && (await s.loadCache())) await this.onReset();
    this.renderChip();
    s.connect();
  }

  /** 合作を閉じる（ホームへ戻るとき） */
  close(toast = true) {
    if (!this.s) return;
    this.s.close();
    this.s = null;
    this.laneId = '';
    this.chip.classList.add('hidden');
    this.closePanel();
    this.closeChat();
    this.h.view.ghosts = [];
    this.h.view.cursors = [];
    document.body.classList.remove('collab');
    if (toast) this.h.toast('合作を閉じました（変更はサーバーに残っています）');
  }

  /** プロジェクトを受け取り直した */
  private async onReset() {
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc) return;
    // 作ったばかり: 曲の情報・本譜面・音源を入れる
    if (this.seed && s.status === 'online') {
      const seed = this.seed;
      this.seed = null;
      s.apply([seed.meta, ...seed.lanes.map((l) => ({ o: 'new', lane: { ...l, owner: this.me } }) as Op)]);
      if (seed.audio) await this.uploadAudio(seed.audio, 0, '');
      rememberJoined({ id: s.link.id, key: s.link.key, title: doc.meta.title, role: 'edit', at: Date.now() });
      this.h.toast('合作を始めました。メニューの「共有リンク」から仲間を呼べます');
    }
    for (const id of Object.keys(doc.lanes)) this.bump(id);
    rememberJoined({ id: s.link.id, key: s.link.key, title: doc.meta.title || '（無題）', role: s.role, at: Date.now() });
    if (!this.laneId || !doc.lanes[this.laneId]) this.openLane(this.defaultLane());
    else this.reloadLane();
    void this.syncAudio();
    this.renderChip();
    this.rerenderPanel();
  }

  private defaultLane(): string {
    const doc = this.doc;
    if (!doc) return '';
    const all = sortedLanes(doc);
    const mains = all.filter((l) => l.main);
    // いちばん難しい本譜面 → 自分のレーン → どれか
    return mains[mains.length - 1]?.id ?? all.find((l) => l.owner === this.me)?.id ?? all[0]?.id ?? '';
  }

  // ───── 音源 ─────

  /** プロジェクトの音源を読み込む（端末にあればそれ、無ければ受け取る） */
  private async syncAudio() {
    const s = this.s;
    const a = this.doc?.meta.audio;
    if (!s || !a) {
      if (!a && this.loadedHash) {
        this.loadedHash = '';
        await this.h.setAudio(null);
      }
      return;
    }
    if (a.hash === this.loadedHash) return;
    this.loadedHash = a.hash;
    let data = await getCachedAudio(a.hash);
    if (!data) {
      this.h.busy(`音源「${a.name}」を受け取っています…`);
      data = await s.downloadAudio(a.hash);
      this.h.busyEnd();
      if (!data) {
        this.loadedHash = '';
        this.h.toast('音源を受け取れませんでした（あとでもう一度試します）');
        return;
      }
      void putCachedAudio(a.hash, data);
    }
    if (this.s !== s) return;
    await this.h.setAudio({ name: a.name, data });
  }

  /** 音源を変えてよいか */
  canChangeAudio() {
    if (!this.active) return true;
    if (this.s?.role !== 'edit' || !this.free) {
      this.h.toast('音源を変えられるのは、リーダーと本譜面を自由に編集できる人だけです');
      return false;
    }
    return true;
  }

  /** 切り貼りで頭の位置が変わる（次に音源を変えたとき、ほかのレーンの OFFSET も同じだけずらす） */
  noteShift(delta: number) {
    this.pendingShift = delta;
  }

  /** エディタで音源を変えた（読み込み・切り貼り） */
  async audioChanged(f: AudioFile | null) {
    const shift = this.pendingShift;
    this.pendingShift = 0;
    if (!f) return;
    await this.uploadAudio(f, shift, this.laneId);
  }

  private async uploadAudio(f: AudioFile, shift: number, skip: string) {
    const s = this.s;
    if (!s) return;
    const hash = hashOk(await audioHash(f.data));
    this.loadedHash = hash;
    void putCachedAudio(hash, f.data);
    this.h.busy(`音源「${f.name}」を送っています…`);
    const ok = await s.uploadAudio(hash, f.data);
    this.h.busyEnd();
    if (!ok) {
      this.h.toast('音源を送れませんでした（大きすぎるか、つながっていません）');
      return;
    }
    s.cmd('audioSet', { audio: { hash, name: f.name, size: f.data.byteLength }, shift, skip });
  }

  // ───── レーンとエディタ ─────

  private bump(id: string) {
    this.laneVer.set(id, (this.laneVer.get(id) ?? 0) + 1);
  }

  /** レーンの譜面・再生用の譜面・タイミング（変わるまで使い回す） */
  laneData(id: string) {
    const doc = this.doc;
    const lane = doc?.lanes[id];
    if (!doc || !lane) return null;
    const v = this.laneVer.get(id) ?? 0;
    const c = this.cache.get(id);
    if (c && c.v === v) return c;
    const chart = laneToChart(doc, lane);
    const course = toPlayable(chart, chart.courses[0]);
    const n = { v, chart, course, timing: new Timing(chart, chart.courses[0]) };
    this.cache.set(id, n);
    return n;
  }

  /** レーンをエディタで開く（今見ている時刻のまま） */
  openLane(id: string) {
    const doc = this.doc;
    const lane = doc?.lanes[id];
    if (!doc || !lane) return;
    const { ed, view } = this.h;
    const t = this.laneId ? ed.timing.tickToTime(view.pos) : null;
    this.h.stopPlayback();
    this.laneId = id;
    this.compare.delete(id);
    const chart = laneToChart(doc, lane);
    this.quiet++;
    try {
      ed.load(chart, ed.audio, 0);
    } finally {
      this.quiet--;
    }
    this.base = stateOf(ed.chart, ed.course);
    view.pos = t === null ? 0 : Math.max(ed.minPos, ed.snapView(ed.timing.timeToTick(t)));
    view.invalidate();
    this.renderChip();
    this.refreshGhosts();
    this.h.updateHeader();
    this.rerenderPanel();
  }

  /** 開いているレーンを、プロジェクトの中身で入れ直す（ほかの人の変更が届いたとき） */
  private reloadLane() {
    const doc = this.doc;
    const lane = this.lane;
    if (!doc || !lane) return;
    const { ed } = this.h;
    const chart = laneToChart(doc, lane);
    this.quiet++;
    try {
      const c = chart.courses[0];
      ed.chart.title = chart.title;
      ed.chart.subtitle = chart.subtitle;
      ed.chart.demoStart = chart.demoStart;
      ed.chart.extra = chart.extra;
      ed.chart.bpm = chart.bpm;
      ed.chart.offset = chart.offset;
      ed.chart.wave = chart.wave || ed.chart.wave;
      const cur = ed.course;
      cur.notes = c.notes;
      cur.events = c.events;
      cur.grads = c.grads;
      cur.level = c.level;
      cur.extra = c.extra;
      cur.scrollMode = c.scrollMode;
      cur.name = c.name;
      ed.emit(true);
    } finally {
      this.quiet--;
    }
    this.base = stateOf(ed.chart, ed.course);
  }

  /** エディタで編集した（main.ts の ed.onChange から） */
  onEdit() {
    if (this.quiet || !this.s || !this.base || !this.lane) return;
    const { ed } = this.h;
    const next = stateOf(ed.chart, ed.course);
    const { ops, inverse } = diff(this.laneId, this.base, next, ed.chart);
    if (!ops.length) return;
    const doc = this.doc!;
    if (this.s.role !== 'edit' || ops.some((op) => !canApply(doc, this.me, op))) {
      this.h.toast(this.s.role !== 'edit' ? '見るだけのリンクで入っています' : 'ここは編集できません（権限がありません）');
      this.reloadLane();
      return;
    }
    this.s.apply(ops);
    this.bump(this.laneId);
    this.base = next;
    this.undoSt.push({ ops, inv: inverse });
    if (this.undoSt.length > 300) this.undoSt.shift();
    this.redoSt = [];
    if (ops.some((o) => o.o === 'm')) this.renderChip();
    this.h.updateHeader();
  }

  /** そこをタップして編集できるか（できなければ何もしない） */
  canTap(tick: number) {
    const doc = this.doc;
    if (!doc || !this.s) return true;
    if (this.h.ed.tool === 'select') return true;
    if (this.s.role !== 'edit') return false;
    return canEditLane(doc, this.me, this.laneId, [Math.round(tick)]);
  }

  /** 今のレーンを全部編集できるか（できなければ 🔒） */
  private get laneFree() {
    const doc = this.doc;
    if (!doc || !this.s || this.s.role !== 'edit') return false;
    return canEditLane(doc, this.me, this.laneId, null);
  }

  /** 値が今もその値か（自分の変更のあとに、ほかの人が変えていないか） */
  private still(op: Op) {
    const lane = op.o === 'm' || op.o === 'new' ? null : this.doc?.lanes[op.l];
    const cur = op.o === 'n' ? lane?.notes[op.k] : op.o === 'e' ? lane?.events[op.k] : op.o === 'g' ? lane?.grads[op.k] : undefined;
    if (op.o === 'n' || op.o === 'e' || op.o === 'g') {
      const want = op.v;
      if (want === null) return cur === undefined;
      if (op.o === 'g') return !!cur;
      return JSON.stringify(cur) === JSON.stringify(want);
    }
    return true;
  }

  private step(from: typeof this.undoSt, to: typeof this.undoSt, undo: boolean) {
    const u = from.pop();
    if (!u || !this.s) return;
    const doc = this.doc!;
    const a = undo ? u.ops : u.inv;
    const b = undo ? u.inv : u.ops;
    const ops = b.filter((_, i) => this.still(a[i]) && canApply(doc, this.me, b[i]));
    if (ops.length < b.length) this.h.toast('ほかの人が変えた所は戻しませんでした');
    if (ops.length) {
      this.s.apply(ops);
      for (const op of ops) if (op.o !== 'm' && op.o !== 'new') this.bump(op.l);
    }
    to.push(u);
    // 戻した変更が開いていないレーンなら、そのレーンを開く
    const l = ops.find((o) => o.o !== 'm' && o.o !== 'new') as { l: string } | undefined;
    if (l && l.l !== this.laneId) this.openLane(l.l);
    else this.reloadLane();
    this.h.updateHeader();
  }

  undo() {
    this.step(this.undoSt, this.redoSt, true);
  }
  redo() {
    this.step(this.redoSt, this.undoSt, false);
  }

  private onLanes(ids: Set<string>, by: string) {
    for (const id of ids) this.bump(id);
    if (ids.has(this.laneId)) {
      this.reloadLane();
      this.h.rebuildHits();
    }
    this.refreshGhosts();
    if (by && by !== this.me && this.h.isPlaying()) this.h.rebuildHits();
    if (this.panel === 'lanes') this.rerenderPanel();
  }

  private onMeta() {
    for (const id of Object.keys(this.doc?.lanes ?? {})) this.bump(id);
    this.reloadLane();
    void this.syncAudio();
    this.renderChip();
  }

  // ───── 波形の所のほかのレーン・ほかの人の場所 ─────

  /** 波形の所に並べるレーン（見比べでチェックしたもの。無ければ同じ難易度のほかのレーン） */
  private ghostIds(): string[] {
    const doc = this.doc;
    const cur = this.lane;
    if (!doc || !cur) return [];
    const checked = sortedLanes(doc).filter((l) => this.compare.has(l.id) && l.id !== this.laneId);
    const list = checked.length ? checked : sortedLanes(doc, cur.course).filter((l) => l.id !== this.laneId);
    return list.slice(0, 3).map((l) => l.id);
  }

  refreshGhosts() {
    const doc = this.doc;
    if (!doc) {
      this.h.view.ghosts = [];
      return;
    }
    const rows: GhostRow[] = [];
    for (const id of this.ghostIds()) {
      const d = this.laneData(id);
      const lane = doc.lanes[id];
      if (!d || !lane) continue;
      rows.push({
        id, name: `${lane.name || '無題'}・${doc.members[lane.owner]?.name ?? ''}`, color: lane.color, main: lane.main,
        notes: d.course.notes.map((n) => ({ t: n.time, e: n.endTime, type: n.type })), bars: d.course.bars.map((b) => b.time),
      });
    }
    this.h.view.ghosts = rows;
    this.h.view.invalidate();
  }

  /** 毎フレーム（main.ts の loop から）: 自分の場所を知らせ、ほかの人の場所を描く */
  frame(playing: boolean) {
    const s = this.s;
    if (!s || !this.laneId) return;
    const { ed, view } = this.h;
    if (s.status === 'online' && s.role === 'edit') s.cursor(this.laneId, view.pos, playing);
    const now = Date.now();
    const marks: { color: string; name: string; t: number }[] = [];
    for (const [mid, c] of this.cursors) {
      if (now - c.at > 60000 || !s.online.ids.includes(mid)) continue;
      const m = this.doc?.members[mid];
      const d = this.laneData(c.l);
      if (!m || !d) continue;
      const t = d.timing.tickToTime(c.tick);
      marks.push({ color: m.color, name: m.name, t });
      // ついていく
      if (this.follow === mid && !playing) {
        const tick = ed.timing.timeToTick(t);
        if (Math.abs(tick - view.pos) > 1) view.pos = tick;
      }
    }
    // 送っていない変更の数が変わったら帯を描き直す
    if (s.pendingCount !== this.lastPend) {
      this.lastPend = s.pendingCount;
      this.renderChip();
    }
    const key = JSON.stringify(marks);
    if (key !== this.lastMarks) {
      this.lastMarks = key;
      view.cursors = marks;
      view.invalidate();
    }
  }
  private lastMarks = '';
  private lastPend = 0;

  // ───── 再生 ─────

  /** 再生で鳴らすほかのレーン（見比べのとき）と、左右の位置 */
  mix(): { own: number; others: { course: Course; pan: number }[] } {
    const doc = this.doc;
    if (!doc || this.playMode !== 'compare') return { own: 0, others: [] };
    const ids = sortedLanes(doc).map((l) => l.id).filter((id) => id === this.laneId || this.compare.has(id));
    if (ids.length < 2) return { own: 0, others: [] };
    // 上のレーンほど左。2 つなら左右、3 つ以上は左 → 真ん中 → 右
    const pans = ids.length === 2 ? [-0.7, 0.7] : ids.map((_, i) => -0.8 + (1.6 * i) / (ids.length - 1));
    const others: { course: Course; pan: number }[] = [];
    let own = 0;
    ids.forEach((id, i) => {
      if (id === this.laneId) own = pans[i];
      else {
        const d = this.laneData(id);
        if (d) others.push({ course: d.course, pan: pans[i] });
      }
    });
    return { own, others };
  }

  /** 見比べのテストプレイ（ほかのレーンを 2 つまで） */
  compareCourses(): { list: { name: string; course: Course; pan: number }[]; own: number } | null {
    const doc = this.doc;
    if (!doc || this.playMode !== 'compare') return null;
    const mix = this.mix();
    if (!mix.others.length) return null;
    const ids = sortedLanes(doc).map((l) => l.id).filter((id) => id !== this.laneId && this.compare.has(id)).slice(0, 2);
    return {
      own: mix.own,
      list: ids.map((id) => {
        const d = this.laneData(id)!;
        const l = doc.lanes[id];
        return { name: `${l.main ? '★' : ''}${l.name}`, course: d.course, pan: mix.others.find((o) => o.course === d.course)?.pan ?? 0 };
      }),
    };
  }

  private onPlayAll(m: { by: string; at: number; from: number }) {
    const s = this.s;
    if (!s) return;
    const { ed, view } = this.h;
    this.h.stopPlayback();
    clearTimeout(this.playTimer);
    view.pos = ed.timing.timeToTick(m.from);
    view.invalidate();
    const wait = Math.max(0, m.at - s.serverNow());
    const who = this.doc?.members[m.by]?.name ?? '';
    this.h.toast(`${who} さんの合図で、みんなで再生します`);
    this.playTimer = window.setTimeout(() => void this.h.startPlayback(), wait);
  }

  // ───── 帯（波形の左上） ─────

  renderChip() {
    const s = this.s;
    if (!s) return;
    const doc = this.doc;
    const lane = this.lane;
    const dot = s.status === 'online' ? 'on' : s.status === 'connecting' ? 'wait' : 'off';
    const pend = s.pendingCount;
    const lock = lane && !this.laneFree;
    this.chip.innerHTML = `
      <button data-cc="menu" class="cc-menu" aria-label="合作のメニュー"><i class="cc-dot ${dot}"></i><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
      <button data-cc="lanes" class="cc-lane" style="--lc:${lane?.color ?? '#888'}">${lane ? `${lane.main ? '★' : ''}<b>${esc(lane.name || '無題')}</b><small>${esc(lane.course)}</small>${lock ? '<span class="cc-lock">🔒</span>' : ''}` : '<b>読み込み中…</b>'}</button>
      <button data-cc="members" class="cc-mem"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2c2.6.2 4.6 2 5.3 5"/></svg><b>${s.online.ids.length}</b></button>
      <button data-cc="chat" class="cc-chat"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>${this.unread ? `<em>${this.unread > 99 ? '99+' : this.unread}</em>` : ''}</button>
      ${pend ? `<span class="cc-pend" title="まだ送っていない変更">↑${pend}</span>` : ''}
      ${doc && s.status !== 'online' ? `<span class="cc-off">${s.status === 'connecting' ? 'つないでいます' : 'オフライン'}</span>` : ''}`;
  }

  private onChip(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cc]');
    if (!b) return;
    const k = b.dataset.cc!;
    if (k === 'chat') this.toggleChat();
    else this.openPanel(k as Panel);
  }

  // ───── 画面（パネル） ─────

  openPanel(p: Panel) {
    this.h.stopPlayback();
    this.panel = p;
    if (p === 'vers') this.s?.cmd('vers');
    this.panelEl.classList.remove('hidden');
    this.renderPanel();
  }

  closePanel() {
    this.panel = null;
    this.panelEl.classList.add('hidden');
    this.panelEl.innerHTML = '';
  }

  private rerenderPanel() {
    if (!this.panel) return;
    // 入力中は描き直さない
    const a = document.activeElement;
    if (this.panelEl.contains(a) && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement)) return;
    this.renderPanel();
  }

  private renderPanel() {
    const p = this.panel;
    const doc = this.doc;
    if (!p || !doc || !this.s) return;
    const titles: Record<Panel, string> = { menu: '合作', lanes: 'レーン', members: 'メンバーと権限', vers: '版の記録', share: '共有リンク', newLane: 'レーンを足す', ranges: '担当範囲' };
    const scroll = this.panelEl.querySelector('.sheet-body')?.scrollTop ?? 0;
    this.panelEl.innerHTML = `<div class="sheet-panel"><div class="sheet-head"><div class="sheet-title">${p !== 'menu' ? '<button data-cp="back" class="icon cp-back" aria-label="戻る">‹</button>' : ''}<h2>${titles[p]}</h2></div><button data-cp="close" class="icon" aria-label="閉じる">×</button></div><div class="sheet-body">${this.panelBody(p, doc)}</div></div>`;
    const body = this.panelEl.querySelector('.sheet-body');
    if (body) body.scrollTop = scroll;
  }

  private memberName(id: string) {
    return this.doc?.members[id]?.name ?? '（外れた人）';
  }

  private panelBody(p: Panel, doc: CollabDoc): string {
    const s = this.s!;
    const edit = s.role === 'edit';
    if (p === 'menu') {
      const lane = this.lane;
      return `
        <p class="note">${esc(doc.meta.title || '（無題）')} ・ ${Object.keys(doc.members).length} 人（つながっている ${s.online.ids.length} 人${s.online.viewers ? `・見ている ${s.online.viewers} 人` : ''}）${s.role === 'view' ? ' ・ 見るだけ' : ''}</p>
        <div class="cp-grid">
          <button data-cp="lanes">レーン</button>
          <button data-cp="members">メンバー・権限</button>
          <button data-cp="chat">チャット${this.unread ? `（${this.unread}）` : ''}</button>
          <button data-cp="vers">版の記録</button>
          <button data-cp="share">共有リンク</button>
          <button data-cp="follow">${this.follow ? `ついていくのをやめる（${esc(this.memberName(this.follow))}）` : 'ついていく…'}</button>
        </div>
        <h3>再生</h3>
        <div class="st-seg two cp-seg"><button data-cp="pmine" class="${this.playMode === 'mine' ? 'on' : ''}">このレーンだけ</button><button data-cp="pcmp" class="${this.playMode === 'compare' ? 'on' : ''}">見比べ（${this.compare.size}）</button></div>
        <p class="note">見比べ: 「レーン」でチェックしたレーンの打音もいっしょに鳴らします（上のレーンほど左に聞こえます）。テストプレイでは 2 つまで下に並べます。</p>
        <div class="btns"><button data-cp="playall">みんなで同時に再生</button><button data-cp="stopall">みんなの再生を止める</button></div>
        <h3>書き出し</h3>
        <div class="btns">
          <button data-cp="expLane">このレーンを .tja</button>
          <button data-cp="expMainTja">本譜面をまとめて .tja</button>
          <button data-cp="expMainZip">本譜面をまとめて .zip</button>
          ${lane && !lane.main ? '<button data-cp="adoptSel">選んだ範囲を本譜面へ</button>' : ''}
        </div>
        <h3>このプロジェクト</h3>
        <div class="btns">
          ${edit ? '<button data-cp="rename">名前（自分）を変える</button>' : ''}
          <button data-cp="leave">閉じる（ホームへ）</button>
          <button data-cp="forget" class="danger">一覧から外す</button>
        </div>`;
    }
    if (p === 'lanes') {
      const rows = COURSES.map((c) => {
        const ls = sortedLanes(doc, c);
        if (!ls.length) return '';
        return `<h3>${c}（${COURSE_JA[c]}）</h3><div class="list">${ls.map((l) => this.laneRow(l, doc)).join('')}</div>`;
      }).join('');
      const trash = doc.trash.length
        ? `<h3>ごみ箱（${TRASH_DAYS} 日で消えます）</h3><div class="list">${doc.trash.map((t) => `<div class="item"><div class="grow">${esc(t.name)} <small>${t.course}</small><div class="pos">${esc(this.memberName(t.by))} ・ ${fmtDate(t.at)}</div></div><button data-cp="tview" data-id="${t.id}">見る</button>${edit ? `<button data-cp="restore" data-id="${t.id}">戻す</button>` : ''}${this.isLeader ? `<button data-cp="purge" data-id="${t.id}" class="danger">消す</button>` : ''}</div>`).join('')}</div>`
        : '';
      return `${edit ? '<div class="btns"><button data-cp="newLane">＋ レーンを足す</button></div>' : ''}${rows || '<p class="note">まだレーンがありません</p>'}${trash}`;
    }
    if (p === 'newLane') {
      const cur = this.lane;
      return `
        <label class="field"><span>難易度</span><select id="cpNlCourse">${COURSES.map((c) => `<option ${c === (cur?.course ?? 'Oni') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field"><span>名前</span><input id="cpNlName" type="text" value="${esc(this.memberName(this.me))}の案" autocomplete="off"></label>
        <label class="field"><span>中身</span><select id="cpNlFrom"><option value="main">その難易度の本譜面をコピー</option><option value="cur">今のレーンをコピー</option><option value="empty">空（BPM・OFFSET は本譜面と同じ）</option></select></label>
        ${this.free ? '<label class="field"><span>本譜面</span><select id="cpNlMain"><option value="0">下書き（自分のレーン）</option><option value="1">本譜面にする（その難易度に無いとき）</option></select></label>' : ''}
        <div class="btns"><button data-cp="newLaneGo">足す</button></div>`;
    }
    if (p === 'members') {
      const list = Object.values(doc.members).sort((a, b) => Number(b.id === doc.leader) - Number(a.id === doc.leader) || a.name.localeCompare(b.name, 'ja'));
      const rows = list.map((m) => {
        const on = s.online.ids.includes(m.id);
        const lead = m.id === doc.leader;
        const me = m.id === this.me;
        const perm = lead ? 'リーダー（全部編集できる）' : `${m.perms.main ? '本譜面を編集できる' : '自分のレーンだけ'}${m.perms.main ? (m.perms.any ? '・範囲外も' : `・担当範囲 ${m.ranges.length} か所`) : ''}`;
        const ctl = this.isLeader && !lead
          ? `<div class="cp-perm">
              <label><input type="checkbox" data-perm="main" data-mid="${m.id}" ${m.perms.main ? 'checked' : ''}> 本譜面を編集</label>
              <label><input type="checkbox" data-perm="any" data-mid="${m.id}" ${m.perms.any ? 'checked' : ''} ${m.perms.main ? '' : 'disabled'}> 範囲外も（確認なし）</label>
              <button data-cp="ranges" data-mid="${m.id}" ${m.perms.main ? '' : 'disabled'}>担当範囲</button>
              <button data-cp="leader" data-mid="${m.id}">リーダーを渡す</button>
              <button data-cp="kick" data-mid="${m.id}" class="danger">外す</button>
            </div>`
          : '';
        return `<div class="item cp-mem"><i class="cp-mdot ${on ? 'on' : ''}" style="--mc:${m.color}"></i><div class="grow"><b>${esc(m.name)}</b>${me ? ' <small>（自分）</small>' : ''}<div class="pos">${perm}${on ? '' : ` ・ ${fmtDate(m.lastSeen)}`}</div>${ctl}</div>${!me && on ? `<button data-cp="followOne" data-mid="${m.id}">${this.follow === m.id ? 'やめる' : 'ついていく'}</button>` : ''}</div>`;
      }).join('');
      return `<div class="list">${rows}</div>
        ${s.online.viewers ? `<p class="note">見るだけのリンクで ${s.online.viewers} 人が見ています</p>` : ''}
        <p class="note">本譜面: リーダーと、リーダーが権限を渡した人が編集できます。「範囲外も」が無い人は、担当範囲の外をタップしても何も起きません（レーン名に 🔒）。自分のレーンは本人だけが編集でき、ほかの人は見る・取り込むことができます。最大 8 人。</p>`;
    }
    if (p === 'ranges') {
      const m = doc.members[this.rangeFor];
      if (!m) return '<p class="note">メンバーがいません</p>';
      const mains = sortedLanes(doc).filter((l) => l.main);
      const barOf = (laneId: string, tick: number) => {
        const d = this.laneData(laneId);
        if (!d) return 0;
        const ms = measures(d.chart.courses[0], tick + 1);
        let i = 0;
        while (i + 1 < ms.length && ms[i + 1].start <= tick) i++;
        return i + 1;
      };
      const rows = m.ranges.map((r, i) => {
        const l = doc.lanes[r.lane];
        return `<div class="item"><div class="grow">${esc(l?.course ?? '?')} ${esc(l?.name ?? '')} ・ ${barOf(r.lane, r.from)} 〜 ${barOf(r.lane, r.to - 1)} 小節</div><button data-cp="rangeDel" data-i="${i}" class="danger">外す</button></div>`;
      }).join('');
      return `<p class="note">${esc(m.name)} さんが編集できる、本譜面の範囲（小節）</p>
        <div class="list">${rows || '<p class="note">まだありません</p>'}</div>
        <h3>範囲を足す</h3>
        <label class="field"><span>本譜面</span><select id="cpRgLane">${mains.map((l) => `<option value="${l.id}" ${l.id === this.laneId ? 'selected' : ''}>${l.course} ${esc(l.name)}</option>`).join('')}</select></label>
        <label class="field"><span>何小節目から</span><input id="cpRgFrom" type="number" min="1" inputmode="numeric" value="1"></label>
        <label class="field"><span>何小節目まで</span><input id="cpRgTo" type="number" min="1" inputmode="numeric" value="16"></label>
        <div class="btns"><button data-cp="rangeAdd">足す</button><button data-cp="rangeHere">今の位置の小節を足す</button></div>`;
    }
    if (p === 'vers') {
      const rows = [...s.vers].reverse().map((v) => `<div class="item"><div class="grow">${esc(v.name)}${v.auto ? ' <small>（自動）</small>' : ''}<div class="pos">${fmtDate(v.at)}${v.by ? ` ・ ${esc(this.memberName(v.by))}` : ''}</div></div>${this.isLeader ? `<button data-cp="verRestore" data-id="${v.id}">この版に戻す</button>` : ''}</div>`).join('');
      return `${edit ? `<label class="field"><span>名前</span><input id="cpVerName" type="text" placeholder="例: サビまで完成" autocomplete="off"></label><div class="btns"><button data-cp="verSave">今の状態を版として残す</button></div>` : ''}
        <p class="note">10 分ごとに、変わっていれば自動で残します（30 個まで。古い自動のものから消えます）。戻せるのはリーダーだけで、戻す前の状態も版として残ります。</p>
        <div class="list">${rows || '<p class="note">まだありません</p>'}</div>`;
    }
    if (p === 'share') {
      const e = linkOf(s.link.id, s.link.key);
      const v = s.vkey ? linkOf(s.link.id, s.vkey) : '';
      return `<p class="note">リンクを送った相手は、開くとこのプロジェクトに入れます（アプリの中で開いてください）。</p>
        <h3>編集できるリンク</h3>
        <div class="cp-link"><input type="text" readonly value="${esc(e)}"><button data-cp="copy" data-v="${esc(e)}">コピー</button></div>
        ${v ? `<h3>見るだけのリンク</h3><div class="cp-link"><input type="text" readonly value="${esc(v)}"><button data-cp="copy" data-v="${esc(v)}">コピー</button></div>` : ''}
        ${typeof navigator.share === 'function' ? `<div class="btns"><button data-cp="nshare" data-v="${esc(e)}">ほかのアプリで送る</button></div>` : ''}`;
    }
    return '';
  }

  private laneRow(l: Lane, doc: CollabDoc) {
    const s = this.s!;
    const mine = l.owner === this.me;
    const cur = l.id === this.laneId;
    const notes = Object.keys(l.notes).length;
    const btns: string[] = [];
    if (!cur) btns.push(`<button data-cp="open" data-id="${l.id}">開く</button>`);
    if (s.role === 'edit') {
      if (mine || this.isLeader) btns.push(`<button data-cp="renameLane" data-id="${l.id}">名前</button>`);
      if (!l.main && this.free) {
        const main = sortedLanes(doc, l.course).find((x) => x.main);
        if (main) btns.push(`<button data-cp="adoptAll" data-id="${l.id}">本譜面と入れ替え</button>`);
        else btns.push(`<button data-cp="makeMain" data-id="${l.id}">本譜面にする</button>`);
      }
      if ((l.main && this.isLeader) || (!l.main && (mine || this.isLeader))) btns.push(`<button data-cp="del" data-id="${l.id}" class="danger">ごみ箱</button>`);
    }
    return `<div class="item cp-lane ${cur ? 'current' : ''}" style="--lc:${l.color}">
      ${cur ? '<i class="cp-cur">編集中</i>' : `<label class="cp-ck"><input type="checkbox" data-cmp="${l.id}" ${this.compare.has(l.id) ? 'checked' : ''}><small>見比べ</small></label>`}
      <div class="grow">${l.main ? '★ ' : ''}<b>${esc(l.name || '無題')}</b><div class="pos">${esc(this.memberName(l.owner))} ・ ${notes} ノーツ ・ BPM ${Number(l.head.bpm.toFixed(3))} ・ OFFSET ${l.head.offset}</div></div>
      ${btns.join('')}</div>`;
  }

  private onPanelChange(e: Event) {
    const t = e.target as HTMLInputElement;
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc) return;
    if (t.dataset.cmp) {
      if (t.checked) this.compare.add(t.dataset.cmp);
      else this.compare.delete(t.dataset.cmp);
      if (this.compare.size && this.playMode === 'mine') this.playMode = 'compare';
      this.refreshGhosts();
      return;
    }
    if (t.dataset.perm && t.dataset.mid) {
      const m = doc.members[t.dataset.mid];
      if (!m) return;
      const perms = { ...m.perms, [t.dataset.perm]: t.checked };
      if (!perms.main) perms.any = false;
      s.cmd('perm', { mid: m.id, perms });
    }
  }

  private async onPanelClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (t === this.panelEl) { this.closePanel(); return; }
    const b = t.closest<HTMLElement>('[data-cp]');
    if (!b) return;
    const k = b.dataset.cp!;
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc) return;
    const id = b.dataset.id ?? '';
    const mid = b.dataset.mid ?? '';
    const go = (p: Panel) => { this.panel = p; this.renderPanel(); };
    switch (k) {
      case 'close': this.closePanel(); return;
      case 'back': go(this.panel === 'ranges' ? 'members' : this.panel === 'newLane' ? 'lanes' : 'menu'); return;
      case 'lanes': case 'members': case 'share': go(k); return;
      case 'vers': s.cmd('vers'); go('vers'); return;
      case 'chat': this.closePanel(); this.toggleChat(true); return;
      case 'newLane': go('newLane'); return;
      case 'pmine': this.playMode = 'mine'; this.renderPanel(); return;
      case 'pcmp':
        this.playMode = 'compare';
        if (!this.compare.size) this.h.toast('「レーン」で見比べるレーンにチェックを入れてください');
        this.renderPanel();
        return;
      case 'playall': {
        const from = this.h.ed.timing.tickToTime(this.h.view.pos);
        s.playAll(from, this.playMode, [...this.compare]);
        this.closePanel();
        return;
      }
      case 'stopall': s.stopAll(); return;
      case 'follow': {
        if (this.follow) { this.follow = null; this.renderPanel(); return; }
        go('members');
        this.h.toast('ついていく人の「ついていく」を押してください');
        return;
      }
      case 'followOne':
        this.follow = this.follow === mid ? null : mid;
        this.renderPanel();
        if (this.follow) {
          const c = this.cursors.get(mid);
          if (c && c.l !== this.laneId && doc.lanes[c.l]) this.openLane(c.l);
          this.h.toast(`${this.memberName(mid)} さんの見ている場所についていきます`);
        }
        return;
      case 'open': this.openLane(id); this.closePanel(); return;
      case 'renameLane': {
        const l = doc.lanes[id];
        const name = prompt('レーンの名前', l?.name ?? '');
        if (name === null || !l) return;
        s.apply([{ o: 'lm', l: id, v: { name: name.trim().slice(0, 40) } }]);
        this.renderPanel();
        this.renderChip();
        this.refreshGhosts();
        return;
      }
      case 'del': {
        const l = doc.lanes[id];
        if (!l || !confirm(`レーン「${l.name}」をごみ箱に入れますか？（${TRASH_DAYS} 日の間は戻せます）`)) return;
        s.cmd('del', { l: id });
        return;
      }
      case 'restore': s.cmd('restore', { id }); return;
      case 'purge': if (confirm('ごみ箱から完全に消しますか？')) s.cmd('purge', { id }); return;
      case 'tview': {
        const lane = await s.trashLane(id);
        if (!lane) { this.h.toast('読み込めませんでした'); return; }
        const chart = laneToChart(doc, lane);
        this.h.saveTja(chart, `${lane.name}（ごみ箱）`);
        return;
      }
      case 'adoptAll': {
        const l = doc.lanes[id];
        const main = l && sortedLanes(doc, l.course).find((x) => x.main);
        if (!l || !main || !confirm(`「${l.name}」を ${l.course} の本譜面と丸ごと入れ替えますか？（今の本譜面はごみ箱に入ります）`)) return;
        s.cmd('adoptAll', { src: id, dst: main.id });
        return;
      }
      case 'makeMain': s.cmd('main', { l: id }); return;
      case 'newLaneGo': this.newLane(); return;
      case 'ranges': this.rangeFor = mid; go('ranges'); return;
      case 'rangeDel': {
        const m = doc.members[this.rangeFor];
        if (!m) return;
        const ranges = m.ranges.filter((_, i) => i !== Number(b.dataset.i));
        s.cmd('ranges', { mid: m.id, ranges });
        return;
      }
      case 'rangeAdd': case 'rangeHere': {
        const m = doc.members[this.rangeFor];
        if (!m) return;
        const laneId = (this.panelEl.querySelector('#cpRgLane') as HTMLSelectElement | null)?.value ?? '';
        const d = this.laneData(laneId);
        if (!d) return;
        let a: number;
        let z: number;
        if (k === 'rangeHere') {
          const tick = d.timing.timeToTick(this.h.ed.timing.tickToTime(this.h.view.pos));
          a = z = this.barIndexAt(laneId, tick);
        } else {
          a = Math.max(1, Number((this.panelEl.querySelector('#cpRgFrom') as HTMLInputElement).value) || 1);
          z = Math.max(a, Number((this.panelEl.querySelector('#cpRgTo') as HTMLInputElement).value) || a);
        }
        const r = this.barRange(laneId, a, z);
        s.cmd('ranges', { mid: m.id, ranges: [...m.ranges, { lane: laneId, from: r[0], to: r[1] }] });
        return;
      }
      case 'leader': if (confirm(`${this.memberName(mid)} さんにリーダーを渡しますか？`)) s.cmd('leader', { mid }); return;
      case 'kick': if (confirm(`${this.memberName(mid)} さんをプロジェクトから外しますか？（作ったレーンは残ります）`)) s.cmd('kick', { mid }); return;
      case 'verSave': {
        const name = (this.panelEl.querySelector('#cpVerName') as HTMLInputElement | null)?.value.trim() ?? '';
        s.cmd('saveVer', { name: name || '手動で保存' });
        this.h.toast('版を残しました');
        return;
      }
      case 'verRestore': {
        const v = s.vers.find((x) => x.id === id);
        if (!v || !confirm(`版「${v.name}」（${fmtDate(v.at)}）に戻しますか？（全員の画面が戻ります。今の状態も版として残ります）`)) return;
        s.cmd('restoreVer', { id });
        this.closePanel();
        return;
      }
      case 'copy': {
        try {
          await navigator.clipboard.writeText(b.dataset.v ?? '');
          this.h.toast('リンクをコピーしました');
        } catch {
          (b.previousElementSibling as HTMLInputElement | null)?.select();
          this.h.toast('選んでコピーしてください');
        }
        return;
      }
      case 'nshare': {
        try { await navigator.share({ title: `合作: ${doc.meta.title}`, url: b.dataset.v }); } catch { /* やめた */ }
        return;
      }
      case 'expLane': {
        const lane = this.lane;
        if (lane) this.h.saveTja(this.h.ed.chart, `${doc.meta.title || 'chart'}_${lane.name}`);
        return;
      }
      case 'expMainTja': case 'expMainZip': {
        const r = this.mainChart();
        if (!r) { this.h.toast('本譜面がありません'); return; }
        if (r.note) this.h.toast(r.note);
        if (k === 'expMainTja') this.h.saveTja(r.chart);
        else await this.h.saveZip(r.chart);
        return;
      }
      case 'adoptSel': this.closePanel(); this.adoptSelection(); return;
      case 'rename': {
        const name = prompt('合作で表示する名前', this.memberName(this.me));
        if (!name?.trim()) return;
        try { localStorage.setItem(NAME_KEY, name.trim().slice(0, 24)); } catch { /* なし */ }
        s.cmd('profile', { name: name.trim() });
        return;
      }
      case 'leave':
        this.closePanel();
        this.close();
        await this.h.showHome();
        return;
      case 'forget':
        if (!confirm('このプロジェクトを一覧から外しますか？（サーバーには残ります。リンクがあればまた入れます）')) return;
        forgetJoined(s.link.id);
        this.closePanel();
        this.close(false);
        await this.h.showHome();
        return;
    }
  }

  /** 本譜面の n 小節目（1 から）の tick 範囲 [a 小節目の頭, z 小節目の終わり) */
  private barRange(laneId: string, a: number, z: number): [number, number] {
    const d = this.laneData(laneId)!;
    const c = d.chart.courses[0];
    let until = TPB * 4 * (z + 2);
    let ms = measures(c, until);
    while (ms.length < z + 1 && until < TPB * 4 * 100000) {
      until *= 2;
      ms = measures(c, until);
    }
    const from = ms[a - 1]?.start ?? 0;
    const to = ms[z - 1] ? ms[z - 1].start + ms[z - 1].length : from + TPB * 4;
    return [from, to];
  }

  private barIndexAt(laneId: string, tick: number) {
    const d = this.laneData(laneId)!;
    const ms = measures(d.chart.courses[0], tick + 1);
    let i = 0;
    while (i + 1 < ms.length && ms[i + 1].start <= tick) i++;
    return i + 1;
  }

  private newLane() {
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc) return;
    const q = (id: string) => this.panelEl.querySelector<HTMLInputElement & HTMLSelectElement>(`#${id}`);
    const course = q('cpNlCourse')?.value ?? 'Oni';
    const name = (q('cpNlName')?.value ?? '').trim().slice(0, 40) || '案';
    const from = q('cpNlFrom')?.value ?? 'main';
    const asMain = q('cpNlMain')?.value === '1';
    if (asMain && sortedLanes(doc, course).some((l) => l.main)) { this.h.toast('この難易度にはもう本譜面があります'); return; }
    const main = sortedLanes(doc, course).find((l) => l.main);
    const src = from === 'cur' ? this.lane : from === 'main' ? main : undefined;
    const ref = src ?? main ?? this.lane;
    const used = new Set(Object.values(doc.lanes).map((l) => l.color));
    const lane: Lane = {
      id: newCollabId(8), course, name, owner: this.me, color: this.meM?.color && !used.has(this.meM.color) ? this.meM.color : COLORS.find((c) => !used.has(c)) ?? COLORS[0],
      main: asMain, order: Date.now() % 1e9,
      head: src ? structuredClone(src.head) : ref ? { ...emptyHead(ref.head.bpm, ref.head.offset), level: ref.head.level } : emptyHead(),
      notes: src ? structuredClone(src.notes) : {}, events: src ? structuredClone(src.events) : {}, grads: src ? structuredClone(src.grads) : {},
    };
    if (src && src.course !== course) lane.head.level = ref?.head.level ?? lane.head.level;
    if (!canApply(doc, this.me, { o: 'new', lane })) { this.h.toast('このレーンは足せません（権限がありません）'); return; }
    s.apply([{ o: 'new', lane }]);
    this.bump(lane.id);
    this.closePanel();
    this.openLane(lane.id);
    this.h.toast(`レーン「${name}」を足しました`);
  }

  /**
   * 選んだ範囲（自分のレーン）を、同じ難易度の本譜面へ採用する。
   * 位置は時刻で合わせる（BPM・OFFSET が違っても同じ時刻に置く）。本譜面のグリッドに合わない音符は一番近い 1/192 に置いて知らせる
   */
  adoptSelection() {
    const s = this.s;
    const doc = this.doc;
    const src = this.lane;
    const { ed } = this.h;
    if (!s || !doc || !src) return;
    if (!ed.sel) { this.h.toast('先に選択ツールで範囲を選んでください'); return; }
    const main = sortedLanes(doc, src.course).find((l) => l.main);
    if (!main) { this.h.toast(`${src.course} に本譜面がありません`); return; }
    if (main.id === src.id) { this.h.toast('本譜面を開いています（自分のレーンを開いて範囲を選んでください）'); return; }
    const dst = this.laneData(main.id)!;
    const ta = ed.timing.tickToTime(ed.sel.start);
    const tb = ed.timing.tickToTime(ed.sel.end);
    const G = TPB / 48; // 1/192
    const toDst = (tick: number) => {
      const exact = dst.timing.timeToTick(ed.timing.tickToTime(tick));
      const r = Math.round(exact / G) * G;
      return { tick: Math.max(0, Math.round(r)), off: Math.abs(exact - r) > 2 };
    };
    const a = dst.timing.timeToTick(ta) - 1;
    const z = dst.timing.timeToTick(tb) + 1;
    const ops: Op[] = [];
    for (const k of Object.keys(main.notes)) {
      const t = Number(k);
      if (t >= a && t <= z) ops.push({ o: 'n', l: main.id, k, v: null });
    }
    let off = 0;
    for (const n of ed.selectedNotes()) {
      const p = toDst(n.tick);
      if (p.off) off++;
      const v: NoteVal = { type: n.type };
      if (n.endTick !== undefined) v.endTick = toDst(n.endTick).tick;
      if (n.hits !== undefined) v.hits = n.hits;
      ops.push({ o: 'n', l: main.id, k: String(p.tick), v });
    }
    if (ops.some((op) => !canApply(doc, this.me, op))) { this.h.toast('本譜面のその範囲を編集する権限がありません'); return; }
    // 同じ所に消すと置くが両方あるときは、置く方だけ残す
    const last = new Map<string, Op>();
    for (const op of ops) last.set((op as { k: string }).k, op);
    const list = [...last.values()];
    const inv: Op[] = list.map((op) => ({ o: 'n', l: main.id, k: (op as { k: string }).k, v: main.notes[(op as { k: string }).k] ?? null }));
    s.apply(list);
    this.bump(main.id);
    this.undoSt.push({ ops: list, inv });
    this.redoSt = [];
    const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    s.cmd('adoptNote', { src: src.id, dst: main.id, range: `${fmt(ta)}〜${fmt(tb)}` });
    this.refreshGhosts();
    this.h.updateHeader();
    this.h.toast(off ? `本譜面へ採用しました（${off} 個の音符が本譜面のグリッドに合わず、一番近い 1/192 に置きました）` : '本譜面へ採用しました（音符だけ。命令はそのままです）');
  }

  /**
   * 本譜面をまとめた 1 つの TJA。難易度ごとに BPM・OFFSET が違うときは、
   * いちばん遅く始まる（OFFSET が大きい）レーンの OFFSET を全体の OFFSET にし、ほかは頭に #DELAY を入れて合わせる
   */
  mainChart(): { chart: EChart; note: string } | null {
    const doc = this.doc;
    if (!doc) return null;
    const mains = COURSES.map((c) => sortedLanes(doc, c).find((l) => l.main)).filter((l): l is Lane => !!l);
    if (!mains.length) return null;
    const base = mains.reduce((a, b) => (b.head.offset > a.head.offset ? b : a));
    const chart = laneToChart(doc, base);
    chart.courses = [];
    let delayed = 0;
    let bpmd = 0;
    for (const l of mains) {
      const c = laneToChart(doc, l).courses[0];
      const d = Math.round((base.head.offset - l.head.offset) * 1e6) / 1e6;
      if (l.head.bpm !== chart.bpm && !c.events.some((e) => e.tick === 0 && e.kind === 'bpm')) {
        c.events.unshift({ tick: 0, kind: 'bpm', value: l.head.bpm });
        bpmd++;
      }
      if (d > 0.0005) {
        const ex = c.events.find((e) => e.tick === 0 && e.kind === 'delay') as { value: number } | undefined;
        if (ex) ex.value = Math.round((ex.value + d) * 1e6) / 1e6;
        else c.events.push({ tick: 0, kind: 'delay', value: d });
        delayed++;
      }
      chart.courses.push(c);
    }
    for (const c of chart.courses) c.events.sort((a, b) => a.tick - b.tick);
    const note = delayed || bpmd ? `難易度ごとの OFFSET・BPM の違いを、頭の #DELAY${bpmd ? '・#BPMCHANGE' : ''} で合わせました` : '';
    return { chart, note };
  }

  // ───── チャット ─────

  toggleChat(open = !this.chatOpen) {
    this.chatOpen = open;
    this.chatEl.classList.toggle('hidden', !open);
    if (open) {
      this.unread = 0;
      this.renderChip();
      this.renderChat(true);
    }
  }

  private closeChat() {
    this.chatOpen = false;
    this.chatEl.classList.add('hidden');
  }

  private onChat(m: ChatMsg | null) {
    if (m && !this.chatOpen && m.by !== this.me && !m.sys) {
      this.unread++;
      this.renderChip();
    }
    if (m?.sys && !this.chatOpen && m.by !== this.me) this.h.toast(m.x);
    if (this.chatOpen) this.renderChat(!!m);
  }

  private renderChat(toBottom = false) {
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc || !this.chatOpen) return;
    const listEl = this.chatEl.querySelector('.cc-list');
    const keepDraft = (this.chatEl.querySelector('#cchatIn') as HTMLInputElement | null)?.value ?? '';
    const prevScroll = listEl ? listEl.scrollHeight - listEl.scrollTop : 0;
    const more = s.chatAll > s.chat.length ? '<button data-ch="more" class="cc-more">前のメッセージ</button>' : '';
    const msgs = s.chat.map((m) => {
      if (m.sys) return `<div class="cm sys">${esc(m.x)}<small>${fmtDate(m.ts)}</small></div>`;
      const who = doc.members[m.by];
      const re = Object.entries(m.re ?? {}).map(([e, ids]) => `<button data-ch="re" data-id="${m.id}" data-e="${e}" class="${ids.includes(this.me) ? 'on' : ''}">${e}${ids.length}</button>`).join('');
      const at = m.at ? `<button data-ch="at" data-l="${esc(m.at.l)}" data-t="${m.at.tick}" class="cm-at">📍 ${esc(this.placeText(m.at))}</button>` : '';
      return `<div class="cm ${m.by === this.me ? 'me' : ''}" data-mid="${m.id}"><b style="color:${who?.color ?? '#ccc'}">${esc(who?.name ?? '（外れた人）')}</b><small>${fmtDate(m.ts)}</small><p>${esc(m.x)}</p>${at}<div class="cm-re">${re}<button data-ch="pick" data-id="${m.id}" class="cm-add">＋</button></div></div>`;
    }).join('');
    this.chatEl.innerHTML = `
      <div class="cc-head"><b>チャット</b><button data-ch="close" aria-label="閉じる">×</button></div>
      <div class="cc-list">${more}${msgs || '<p class="cc-empty">まだメッセージはありません</p>'}</div>
      <div class="cc-pick hidden">${REACTIONS.map((e) => `<button data-ch="react" data-e="${e}">${e}</button>`).join('')}</div>
      ${s.role === 'edit' ? `<div class="cc-in">
        <button data-ch="pin" class="${this.chatAt ? 'on' : ''}" title="今の場所を付ける">📍</button>
        <input id="cchatIn" type="text" placeholder="${this.chatAt ? `📍 ${esc(this.placeText(this.chatAt))}` : 'メッセージ'}" autocomplete="off" enterkeyhint="send">
        <button data-ch="send">送信</button>
      </div>` : ''}`;
    const inp = this.chatEl.querySelector('#cchatIn') as HTMLInputElement | null;
    if (inp) inp.value = keepDraft;
    const list = this.chatEl.querySelector('.cc-list')!;
    list.scrollTop = toBottom ? list.scrollHeight : list.scrollHeight - prevScroll;
  }

  private placeText(at: { l: string; tick: number }) {
    const l = this.doc?.lanes[at.l];
    if (!l) return '消えたレーン';
    return `${l.name} ${this.barIndexAt(at.l, at.tick)} 小節`;
  }

  private pickFor = '';
  private onChatClick(e: MouseEvent) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ch]');
    const s = this.s;
    if (!b || !s) return;
    const k = b.dataset.ch!;
    if (k === 'close') this.closeChat();
    else if (k === 'send') this.sendChat();
    else if (k === 'more') s.moreChat();
    else if (k === 'pin') {
      this.chatAt = this.chatAt ? null : { l: this.laneId, tick: Math.round(this.h.view.pos) };
      this.renderChat();
    } else if (k === 'at') {
      const l = b.dataset.l!;
      const tick = Number(b.dataset.t);
      if (!this.doc?.lanes[l]) { this.h.toast('そのレーンはもうありません'); return; }
      if (l !== this.laneId) this.openLane(l);
      this.h.view.pos = tick;
      this.h.view.invalidate();
      this.closeChat();
    } else if (k === 're') s.react(b.dataset.id!, b.dataset.e!);
    else if (k === 'pick') {
      this.pickFor = b.dataset.id!;
      const p = this.chatEl.querySelector('.cc-pick') as HTMLElement;
      p.classList.remove('hidden');
      const r = b.getBoundingClientRect();
      const pr = this.chatEl.getBoundingClientRect();
      p.style.top = `${Math.max(40, r.top - pr.top - 44)}px`;
    } else if (k === 'react') {
      if (this.pickFor) s.react(this.pickFor, b.dataset.e!);
      this.pickFor = '';
      this.chatEl.querySelector('.cc-pick')?.classList.add('hidden');
    }
  }

  private sendChat() {
    const inp = this.chatEl.querySelector('#cchatIn') as HTMLInputElement | null;
    const s = this.s;
    if (!inp || !s) return;
    const x = inp.value.trim();
    if (!x) return;
    if (s.status !== 'online') { this.h.toast('つながっていないので送れません'); return; }
    s.sendChat(x, this.chatAt ?? undefined);
    inp.value = '';
    this.chatAt = null;
  }
}

/** ホームに出す、参加しているプロジェクト */
export const collabProjects = (): JoinedProject[] => joinedList();

const SHARED_KEY = 'malody-web:collabSongs';
/** 曲の一覧の曲 → 共有したプロジェクト */
export function sharedMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(SHARED_KEY) ?? '{}'); } catch { return {}; }
}
function markShared(songId: string, projectId: string) {
  const m = sharedMap();
  m[songId] = projectId;
  try { localStorage.setItem(SHARED_KEY, JSON.stringify(m)); } catch { /* なし */ }
}

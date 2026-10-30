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
import { uiScale } from '../orient';
import { courseToLane, diff, laneToChart, stateOf, type LaneState } from './bridge';
import {
  canApply, canEditLane, COLORS, emptyHead, newCollabId, sortedLanes,
  COMPARE_MAX, type CollabDoc, type Group, type Lane, type Member, type NoteVal, type Op, type RoomSettings,
} from './protocol';
import { CollabSession, forgetJoined, joinedList, rememberJoined, resetOnce, type ChatMsg, type CollabLink, type JoinedProject, type JoinOpts } from './session';

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
  /** 入れなかった（あいことばが違う・部屋が無いなど） */
  onDenied(id: string, msg: string): void;
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

type Panel = 'menu' | 'lanes' | 'members' | 'vers' | 'room' | 'newLane' | 'groups';

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
  private adoptEl: HTMLElement;
  private lastAdopt = '';
  private playTimer = 0;

  constructor(private h: CollabHost) {
    const stage = document.querySelector('.stage')!;
    this.chip = document.createElement('div');
    this.chip.id = 'collabChip';
    this.chip.className = 'cchip hidden';
    stage.appendChild(this.chip);
    this.adoptEl = document.createElement('div');
    this.adoptEl.className = 'cadopt hidden';
    stage.appendChild(this.adoptEl);
    this.adoptEl.addEventListener('click', (e) => this.onAdoptClick(e));
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
    return this.isLeader || (!!m && m.perms.any);
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

  /** ふつうの曲から部屋を作る（全部の難易度を本譜面にして、音源も置く） */
  async share(chart: EChart, audio: AudioFile | null, songId: string | undefined, room: RoomSettings) {
    const id = newCollabId(6);
    if (songId) markShared(songId, id);
    const lanes: Lane[] = chart.courses.map((c, i) => courseToLane(chart, c, { id: newCollabId(8), name: COURSE_JA[c.name] ?? c.name, owner: '', color: COLORS[i % COLORS.length], main: true, order: i }));
    // 同じ難易度が 2 つあるときは、2 つ目からは下書き
    const seen = new Set<string>();
    for (const l of lanes) {
      if (seen.has(l.course)) l.main = false;
      seen.add(l.course);
    }
    this.seed = { lanes, meta: { o: 'm', v: { title: chart.title, subtitle: chart.subtitle, demoStart: chart.demoStart, extra: chart.extra } }, audio };
    await this.open(id, { create: room });
  }

  /** 部屋に入る（メンバーの端末はあいことばなし。join.create を渡すと新しく作る） */
  async open(id: string, join: JoinOpts = {}) {
    this.close(false);
    const link: CollabLink = { id };
    const createVkey = !!join.create;
    const s = new CollabSession(link, this.profile(), join);
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
      members: () => { this.ensureOwnLanes(); this.renderChip(); this.refreshGhosts(); this.rerenderPanel(); this.h.updateHeader(); },
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
          this.close(false);
          this.h.onDenied(id, msg ?? '入れませんでした');
        }
      },
      room: () => { this.renderChip(); this.rerenderPanel(); },
      error: (msg) => this.h.toast(msg),
      rejected: (n) => this.h.toast(`${n} 個の変更は、編集できない所だったので戻しました`),
      conflicts: (n) => this.h.toast(`${n} 個の変更は、つながっていない間にほかの人が同じ所を変えていたので取り消しました`),
      dropped: (n) => this.h.toast(`版が戻されたので、送っていなかった ${n} 個の変更を取り消しました`),
      left: () => {
        this.h.toast('部屋を抜けました');
        forgetJoined(link.id);
        this.close(false);
        void this.h.showHome();
      },
      kicked: () => {
        this.h.toast('この部屋から外されました');
        forgetJoined(link.id);
        this.close(false);
        void this.h.showHome();
      },
    });
    // iPhone の Safari が、しばらく使わないサイトの保存を消さないように頼む（メンバーの印と送っていない変更を守る）
    void navigator.storage?.persist?.().catch(() => {});
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
    this.adoptEl.classList.add('hidden');
    this.lastAdopt = '';
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
      this.h.toast(`部屋 ${s.link.id} を作りました。部屋番号とあいことばを仲間に伝えてください`);
    }
    this.ensureOwnLanes();
    for (const id of Object.keys(doc.lanes)) this.bump(id);
    rememberJoined({ id: s.link.id, title: s.room.name || doc.meta.title || '（無題）', role: s.role, at: Date.now() });
    if (!this.laneId || !doc.lanes[this.laneId]) this.openLane(this.defaultLane());
    else this.reloadLane();
    void this.syncAudio();
    this.renderChip();
    this.rerenderPanel();
  }

  /** 本譜面を編集できない人には、難易度ごとに自分の案（本譜面のコピー）を作っておく */
  private ensureOwnLanes() {
    const s = this.s;
    const doc = this.doc;
    if (!s || !doc || s.role !== 'edit' || s.status !== 'online' || this.free || !doc.members[this.me]) return;
    const used = new Set(Object.values(doc.lanes).map((l) => l.color));
    const color = this.meM?.color ?? COLORS.find((c) => !used.has(c)) ?? COLORS[0];
    const ops: Op[] = [];
    for (const main of sortedLanes(doc).filter((l) => l.main)) {
      if (Object.values(doc.lanes).some((l) => !l.main && l.owner === this.me && l.course === main.course)) continue;
      const lane: Lane = {
        id: newCollabId(8), course: main.course, name: `${this.memberName(this.me)} の案`, owner: this.me, color, main: false, order: Date.now() % 1e9,
        head: structuredClone(main.head), notes: structuredClone(main.notes), events: structuredClone(main.events), grads: structuredClone(main.grads), prov: {},
      };
      if (canApply(doc, this.me, { o: 'new', lane })) ops.push({ o: 'new', lane });
    }
    if (ops.length) s.apply(ops);
  }

  private defaultLane(): string {
    const doc = this.doc;
    if (!doc) return '';
    const all = sortedLanes(doc);
    const mains = all.filter((l) => l.main);
    // 本譜面を編集できる人: いちばん難しい本譜面。ほかの人: その難易度の自分の案
    const top = mains[mains.length - 1];
    const own = all.filter((l) => !l.main && l.owner === this.me);
    if (!this.free) return (own.find((l) => l.course === top?.course) ?? own[own.length - 1] ?? top ?? all[0])?.id ?? '';
    return top?.id ?? own[0]?.id ?? all[0]?.id ?? '';
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
        this.h.toast('音源を受け取れませんでした');
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
      this.h.toast('音源を送れませんでした');
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
      this.h.toast(this.s.role !== 'edit' ? '見るだけのリンクで入っています' : 'ここは編集できません');
      this.reloadLane();
      return;
    }
    this.s.apply(ops, inverse);
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
    // 置く位置はグリッドに寄せた位置（範囲の端の近くをタップしたとき、外に置かないように）
    const t = this.h.ed.snap(tick);
    return canEditLane(doc, this.me, this.laneId, [Math.round(t)]);
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
    // ほかのレーンを全部（同じ難易度を先に。本譜面 → 下書きの順）。自分のレーンの下に縦に並べる
    const same = sortedLanes(doc, cur.course).filter((l) => l.id !== this.laneId);
    const rest = sortedLanes(doc).filter((l) => l.course !== cur.course);
    return [...same, ...rest].slice(0, 24).map((l) => l.id);
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
        id, name: `${lane.course !== this.lane?.course && lane.name !== (COURSE_JA[lane.course] ?? lane.course) ? `${COURSE_JA[lane.course] ?? lane.course}・` : ''}${lane.name || '無題'}・${doc.members[lane.owner]?.name ?? ''}`, color: lane.color, main: lane.main,
        notes: d.course.notes.map((n) => ({ t: n.time, e: n.endTime, type: n.type })), bars: d.course.bars.map((b) => b.time), chart: d.chart,
        bands: this.provBands(lane),
      });
    }
    this.h.view.ghosts = rows;
    this.refreshBands();
    this.h.view.invalidate();
  }

  /** 本譜面の小節が、だれの案から来たか（レーンの上の縁に色の帯と名前） */
  private provBands(lane: Lane | undefined) {
    const doc = this.doc;
    if (!doc || !lane?.main) return [];
    const out: { a: number; b: number; color: string; label: string; mine: boolean }[] = [];
    const list = Object.entries(lane.prov ?? {}).map(([k, p]) => ({ a: Number(k), b: p.end, color: p.color, label: this.memberName(p.by), mine: p.by === this.me })).sort((x, y) => x.a - y.a);
    // 続いている同じ人の小節はまとめる（名前は頭に 1 つ）
    for (const p of list) {
      const l = out[out.length - 1];
      if (l && l.b === p.a && l.label === p.label && l.color === p.color) l.b = p.b;
      else out.push({ ...p });
    }
    return out;
  }

  private refreshBands() {
    this.h.view.bands = this.provBands(this.lane);
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
    this.renderAdoptBar();
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

  /** 案のレーンで範囲を選んでいる間、そのすぐ下に「本譜面へ」を出す（本譜面を編集できる人だけ） */
  private renderAdoptBar() {
    const doc = this.doc;
    const lane = this.lane;
    const { ed, view } = this.h;
    const sel = ed.sel;
    const show = !!(this.s && doc && lane && sel && sel.end > sel.start && !lane.main && this.free && this.s.role === 'edit'
      && sortedLanes(doc, lane.course).some((l) => l.main) && !this.h.isPlaying());
    if (!show) {
      if (this.lastAdopt) { this.lastAdopt = ''; this.adoptEl.classList.add('hidden'); }
      return;
    }
    const L = view.L;
    const cv = (document.getElementById('editor') as HTMLElement).getBoundingClientRect();
    const st = (this.adoptEl.parentElement as HTMLElement).getBoundingClientRect();
    const k = cv.width / Math.max(1, view.w);
    const top = Math.round(cv.top - st.top + (view.rowGeom(0).y + L.laneH) * k + 6);
    const left = Math.round(cv.left - st.left + L.colW * k + 12);
    const a = this.barIndexAt(lane.id, sel!.start);
    const b = this.barIndexAt(lane.id, Math.max(sel!.start, sel!.end - 1));
    const key = `${lane.id}:${a}:${b}:${top}:${left}:${lane.name}`;
    if (key === this.lastAdopt) return;
    this.lastAdopt = key;
    this.adoptEl.style.cssText = `top:${top}px;left:${left}px;--lc:${lane.color}`;
    this.adoptEl.innerHTML = `<span class="ca-t">${esc(lane.name || '案')} ・ ${a === b ? a : `${a}〜${b}`}</span><button data-ca="go" class="pri">本譜面へ</button><button data-ca="hear">▶ 聴く</button><button data-ca="x" aria-label="閉じる">×</button>`;
    this.adoptEl.classList.remove('hidden');
  }

  private onAdoptClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ca]');
    if (!b) return;
    const { ed, view } = this.h;
    switch (b.dataset.ca) {
      case 'go': this.adoptSelection(); ed.clearSelection(); break;
      case 'hear': if (ed.sel) { view.pos = ed.sel.start; void this.h.startPlayback(); } break;
      case 'x': ed.clearSelection(); break;
    }
    view.invalidate();
    this.renderAdoptBar();
  }

  // ───── 再生 ─────

  /** 再生で鳴らすほかのレーン（見比べのとき）と、左右の位置 */
  mix(): { own: number; others: { course: Course; pan: number }[] } {
    const doc = this.doc;
    if (!doc || this.playMode !== 'compare') return { own: 0, others: [] };
    const picked = sortedLanes(doc).map((l) => l.id).filter((id) => id !== this.laneId && this.compare.has(id)).slice(0, COMPARE_MAX - 1);
    const ids = sortedLanes(doc).map((l) => l.id).filter((id) => id === this.laneId || picked.includes(id));
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

  /** 見比べのテストプレイ（ほかのレーンを 3 つまで） */
  compareCourses(): { list: { name: string; course: Course; pan: number }[]; own: number } | null {
    const doc = this.doc;
    if (!doc || this.playMode !== 'compare') return null;
    const mix = this.mix();
    if (!mix.others.length) return null;
    const ids = sortedLanes(doc).map((l) => l.id).filter((id) => id !== this.laneId && this.compare.has(id)).slice(0, COMPARE_MAX - 1);
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
    const titles: Record<Panel, string> = { menu: 'オンライン作業', lanes: 'レーン', members: 'メンバーと権限', vers: '版の記録', room: '部屋', newLane: 'レーンを足す', groups: '担当' };
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
          <button data-cp="room">部屋</button>
          <button data-cp="follow">${this.follow ? `ついていくのをやめる（${esc(this.memberName(this.follow))}）` : 'ついていく…'}</button>
        </div>
        <h3>再生</h3>
        <div class="st-seg two cp-seg"><button data-cp="pmine" class="${this.playMode === 'mine' ? 'on' : ''}">このレーンだけ</button><button data-cp="pcmp" class="${this.playMode === 'compare' ? 'on' : ''}">見比べ（${this.compare.size}）</button></div>
        <div class="btns"><button data-cp="playall">みんなで同時に再生</button><button data-cp="stopall">みんなの再生を止める</button></div>
        <h3>書き出し</h3>
        <div class="btns">
          <button data-cp="expLane">このレーンを .tja</button>
          <button data-cp="expMainTja">本譜面をまとめて .tja</button>
          <button data-cp="expMainZip">本譜面をまとめて .zip</button>
          ${lane && !lane.main && this.free ? '<button data-cp="adoptSel">選んだ範囲を本譜面へ</button>' : ''}
        </div>
        <h3>この部屋</h3>
        <div class="btns">
          ${edit ? '<button data-cp="rename">名前を変える</button>' : ''}
          <button data-cp="leave">閉じる</button>
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
        ? `<h3>ごみ箱</h3><div class="list">${doc.trash.map((t) => `<div class="item"><div class="grow">${esc(t.name)} <small>${t.course}</small><div class="pos">${esc(this.memberName(t.by))} ・ ${fmtDate(t.at)}</div></div><button data-cp="tview" data-id="${t.id}">見る</button>${edit ? `<button data-cp="restore" data-id="${t.id}">戻す</button>` : ''}${this.isLeader ? `<button data-cp="purge" data-id="${t.id}" class="danger">消す</button>` : ''}</div>`).join('')}</div>`
        : '';
      return `${edit ? '<div class="btns"><button data-cp="newLane">＋ レーンを足す</button></div>' : ''}${rows || '<p class="note">まだレーンがありません</p>'}${trash}`;
    }
    if (p === 'newLane') {
      const cur = this.lane;
      return `
        <label class="field"><span>難易度</span><select id="cpNlCourse">${COURSES.map((c) => `<option ${c === (cur?.course ?? 'Oni') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <label class="field"><span>名前</span><input id="cpNlName" type="text" value="${esc(this.memberName(this.me))}の案" autocomplete="off"></label>
        <label class="field"><span>中身</span><select id="cpNlFrom"><option value="main">その難易度の本譜面をコピー</option><option value="cur">今のレーンをコピー</option><option value="empty">空</option></select></label>
        ${this.free ? '<label class="field"><span>本譜面</span><select id="cpNlMain"><option value="0">下書き</option><option value="1">本譜面</option></select></label>' : ''}
        <div class="btns"><button data-cp="newLaneGo">足す</button></div>`;
    }
    if (p === 'members') {
      const list = Object.values(doc.members).sort((a, b) => Number(b.id === doc.leader) - Number(a.id === doc.leader) || a.name.localeCompare(b.name, 'ja'));
      const lanesOf = (mid: string) => Object.values(doc.lanes).filter((l) => !l.main && l.owner === mid).length;
      const barsOf = (mid: string) => Object.values(doc.lanes).reduce((n, l) => n + (l.main ? Object.values(l.prov ?? {}).filter((p) => p.by === mid).length : 0), 0);
      const rows = list.map((m) => {
        const on = s.online.ids.includes(m.id);
        const lead = m.id === doc.leader;
        const me = m.id === this.me;
        const nb = barsOf(m.id);
        const perm = `${lead ? 'リーダー ・ ' : ''}案 ${lanesOf(m.id)}${nb ? ` ・ 本譜面 ${nb} 小節` : ''}`;
        const ctl = this.isLeader && !lead
          ? `<div class="cp-perm">
              <label class="cp-sw"><input type="checkbox" data-perm="any" data-mid="${m.id}" ${m.perms.any ? 'checked' : ''}><i></i> 本譜面</label>
              <button data-cp="leader" data-mid="${m.id}">リーダーを渡す</button>
              <button data-cp="kick" data-mid="${m.id}" class="danger">外す</button>
            </div>`
          : '';
        return `<div class="item cp-mem"><i class="cp-mdot ${on ? 'on' : ''}" style="--mc:${m.color}"></i><div class="grow"><b>${esc(m.name)}</b>${me ? ' <small>（自分）</small>' : ''}<div class="pos">${perm}${on ? '' : ` ・ ${fmtDate(m.lastSeen)}`}</div>${ctl}</div>${!me && on ? `<button data-cp="followOne" data-mid="${m.id}">${this.follow === m.id ? 'やめる' : 'ついていく'}</button>` : ''}</div>`;
      }).join('');
      return `<div class="btns"><button data-cp="leave" class="danger">部屋を抜ける</button></div>
        <div class="list">${rows}</div>
        ${s.online.viewers ? `<p class="note">見学 ${s.online.viewers} 人</p>` : ''}`;
    }
    if (p === 'groups') {
      const lead = this.isLeader;
      const mains = sortedLanes(doc).filter((l) => l.main);
      const laneName = (id: string) => {
        const l = doc.lanes[id];
        return l ? `${l.course}` : '（消えたレーン）';
      };
      const groups = Object.values(doc.groups ?? {}).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
      const others = Object.values(doc.members).filter((m) => m.id !== doc.leader);
      const blocks = groups.map((g) => {
        const ranges = g.ranges.map((r, i) => `<span class="cp-rg">${esc(laneName(r.lane))} ${r.from}〜${r.to} 小節${lead ? `<button data-cp="grDel" data-g="${g.id}" data-i="${i}" aria-label="外す">×</button>` : ''}</span>`).join('');
        const mem = lead
          ? others.map((m) => `<label class="cp-gm"><input type="checkbox" data-gmem="${g.id}" data-mid="${m.id}" ${g.members.includes(m.id) ? 'checked' : ''}><i style="background:${m.color}"></i>${esc(m.name)}</label>`).join('') || ''
          : g.members.map((x) => esc(this.memberName(x))).join('・') || '—';
        const add = lead
          ? `<div class="cp-gadd">
              <select id="cpGl-${g.id}"><option value="*">全部の本譜面</option>${mains.map((l) => `<option value="${l.id}" ${l.id === this.laneId ? 'selected' : ''}>${l.course}</option>`).join('')}</select>
              <input id="cpGf-${g.id}" type="number" min="1" inputmode="numeric" placeholder="から" aria-label="何小節目から">
              <span>〜</span>
              <input id="cpGt-${g.id}" type="number" min="1" inputmode="numeric" placeholder="まで" aria-label="何小節目まで">
              <button data-cp="grAdd" data-g="${g.id}">小節を足す</button>
              <button data-cp="grHere" data-g="${g.id}">今の小節</button>
            </div>`
          : '';
        return `<div class="item cp-group" style="--gc:${g.color}">
          <div class="cp-ghead"><b class="cp-gname">${esc(g.name)}</b>${lead ? `<button data-cp="grRename" data-g="${g.id}">名前</button><button data-cp="grRemove" data-g="${g.id}" class="danger">消す</button>` : ''}</div>
          <div class="cp-granges">${ranges || '<small>小節がまだありません</small>'}</div>
          ${add}
          <div class="cp-gmems">${mem}</div>
        </div>`;
      }).join('');
      return `${lead ? '<div class="btns"><button data-cp="grNew">＋ 担当を足す</button></div>' : ''}
        <div class="list">${blocks || '<p class="note">まだ担当はありません</p>'}</div>`;
    }
    if (p === 'vers') {
      const rows = [...s.vers].reverse().map((v) => `<div class="item"><div class="grow">${esc(v.name)}${v.auto ? ' <small>（自動）</small>' : ''}<div class="pos">${fmtDate(v.at)}${v.by ? ` ・ ${esc(this.memberName(v.by))}` : ''}</div></div>${this.isLeader ? `<button data-cp="verRestore" data-id="${v.id}">この版に戻す</button>` : ''}</div>`).join('');
      return `${edit ? `<label class="field"><span>名前</span><input id="cpVerName" type="text" autocomplete="off"></label><div class="btns"><button data-cp="verSave">今の状態を版として残す</button></div>` : ''}
        <div class="list">${rows || '<p class="note">まだありません</p>'}</div>`;
    }
    if (p === 'room') {
      const r = s.room;
      const head = `<div class="cp-roomid"><small>部屋番号</small><b>${s.link.id}</b>${edit && r.pass ? `<small>あいことば</small><b>${esc(r.pass)}</b>` : ''}</div>
        ${edit ? '<div class="btns"><button data-cp="copyRoom">部屋番号とあいことばをコピー</button></div>' : ''}`;
      if (!this.isLeader) return `${head}<p class="note">部屋の名前: ${esc(r.name)} ・ ${r.unlisted ? '一覧に出さない' : '一覧に出す'} ・ 見学 ${r.watch ? 'できる' : 'できない'}</p>`;
      return `${head}
        <h3>部屋の設定</h3>
        <label class="field"><span>部屋の名前</span><input id="cpRmName" type="text" value="${esc(r.name)}" autocomplete="off"></label>
        <label class="field"><span>あいことば</span><input id="cpRmPass" type="text" value="${esc(r.pass)}" autocomplete="off"></label>
        <label class="field cp-ck2"><input id="cpRmUnl" type="checkbox" ${r.unlisted ? 'checked' : ''}><span>一覧に出さない</span></label>
        <label class="field cp-ck2"><input id="cpRmWatch" type="checkbox" ${r.watch ? 'checked' : ''}><span>見学できる</span></label>
        <div class="btns"><button data-cp="roomSave">設定を保存</button></div>`;
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
      if (t.checked && this.compare.size + 1 >= COMPARE_MAX) {
        t.checked = false;
        this.h.toast(`見比べは自分のレーンも入れて ${COMPARE_MAX} 本までです`);
        return;
      }
      if (t.checked) this.compare.add(t.dataset.cmp);
      else this.compare.delete(t.dataset.cmp);
      if (this.compare.size && this.playMode === 'mine') this.playMode = 'compare';
      this.refreshGhosts();
      return;
    }
    if (t.dataset.perm && t.dataset.mid) {
      const m = doc.members[t.dataset.mid];
      if (!m) return;
      s.cmd('perm', { mid: m.id, perms: { main: t.checked, any: t.checked } });
      return;
    }
    if (t.dataset.gmem && t.dataset.mid) {
      const mid = t.dataset.mid;
      this.editGroup(t.dataset.gmem, (g) => { g.members = t.checked ? [...new Set([...g.members, mid])] : g.members.filter((x) => x !== mid); });
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
      case 'back': go(this.panel === 'newLane' ? 'lanes' : 'menu'); return;
      case 'lanes': case 'members': case 'room': case 'groups': go(k); return;
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
        if (!l || !confirm(`レーン「${l.name}」をごみ箱に入れますか？`)) return;
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
        if (!l || !main || !confirm(`「${l.name}」を ${l.course} の本譜面と丸ごと入れ替えますか？`)) return;
        s.cmd('adoptAll', { src: id, dst: main.id });
        return;
      }
      case 'makeMain': s.cmd('main', { l: id }); return;
      case 'newLaneGo': this.newLane(); return;
      case 'grNew': {
        const used = new Set(Object.values(doc.groups ?? {}).map((g) => g.name));
        const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((c) => !used.has(c)) ?? '?';
        const color = COLORS[Object.keys(doc.groups ?? {}).length % COLORS.length];
        const id = newCollabId(6);
        this.sendGroups({ ...(doc.groups ?? {}), [id]: { id, name, color, ranges: [], members: [] } });
        return;
      }
      case 'grRename': {
        const g = doc.groups[b.dataset.g!];
        const name = g && prompt('担当の名前', g.name);
        if (!g || !name?.trim()) return;
        this.editGroup(g.id, (x) => { x.name = name.trim().slice(0, 20); });
        return;
      }
      case 'grRemove': {
        const g = doc.groups[b.dataset.g!];
        if (!g || !confirm(`担当「${g.name}」を消しますか？`)) return;
        const next = { ...doc.groups };
        delete next[g.id];
        this.sendGroups(next);
        return;
      }
      case 'grDel': this.editGroup(b.dataset.g!, (x) => { x.ranges.splice(Number(b.dataset.i), 1); }); return;
      case 'grAdd': case 'grHere': {
        const gid = b.dataset.g!;
        const q = (pre: string) => this.panelEl.querySelector<HTMLInputElement & HTMLSelectElement>(`#${pre}-${gid}`);
        const sel = q('cpGl')?.value ?? '*';
        const lanes = sel === '*' ? sortedLanes(doc).filter((l) => l.main).map((l) => l.id) : [sel];
        let a: number;
        let z: number;
        if (k === 'grHere') {
          // 今見ている時刻の小節（それぞれの本譜面で）
          const t = this.h.ed.timing.tickToTime(this.h.view.pos);
          const add = lanes.map((l) => {
            const d = this.laneData(l)!;
            const bar = this.barIndexAt(l, d.timing.timeToTick(t));
            return { lane: l, from: bar, to: bar };
          });
          this.editGroup(gid, (x) => { x.ranges.push(...add); });
          return;
        }
        a = Math.max(1, Math.round(Number(q('cpGf')?.value)) || 0);
        z = Math.max(1, Math.round(Number(q('cpGt')?.value)) || 0);
        if (!a || !z) { this.h.toast('何小節目から・まで を入れてください'); return; }
        if (z < a) [a, z] = [z, a];
        this.editGroup(gid, (x) => { x.ranges.push(...lanes.map((l) => ({ lane: l, from: a, to: z }))); });
        return;
      }
      case 'roomSave': {
        const v = (id: string) => this.panelEl.querySelector<HTMLInputElement>(`#${id}`);
        const pass = v('cpRmPass')?.value.trim() ?? '';
        if (!pass) { this.h.toast('あいことばを入れてください'); return; }
        s.cmd('room', { name: v('cpRmName')?.value.trim(), pass, unlisted: !!v('cpRmUnl')?.checked, watch: !!v('cpRmWatch')?.checked });
        this.h.toast('部屋の設定を保存しました');
        return;
      }
      case 'copyRoom': {
        const text = `TJAtelier オンライン作業\n部屋番号: ${s.link.id}\nあいことば: ${s.room.pass}`;
        try {
          await navigator.clipboard.writeText(text);
          this.h.toast('部屋番号とあいことばをコピーしました');
        } catch {
          this.h.toast(`部屋番号 ${s.link.id} ・ あいことば ${s.room.pass}`);
        }
        return;
      }
      case 'leader': if (confirm(`${this.memberName(mid)} さんにリーダーを渡しますか？`)) s.cmd('leader', { mid }); return;
      case 'leave': {
        if (confirm('部屋を抜けますか？')) s.cmd('leave');
        return;
      }
      case 'kick': if (confirm(`${this.memberName(mid)} さんをプロジェクトから外しますか？`)) s.cmd('kick', { mid }); return;
      case 'verSave': {
        const name = (this.panelEl.querySelector('#cpVerName') as HTMLInputElement | null)?.value.trim() ?? '';
        s.cmd('saveVer', { name: name || '手動で保存' });
        this.h.toast('版を残しました');
        return;
      }
      case 'verRestore': {
        const v = s.vers.find((x) => x.id === id);
        if (!v || !confirm(`版「${v.name}」（${fmtDate(v.at)}）に戻しますか？`)) return;
        s.cmd('restoreVer', { id });
        this.closePanel();
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
        if (!confirm('この部屋を自分の一覧から外しますか？')) return;
        forgetJoined(s.link.id);
        this.closePanel();
        this.close(false);
        await this.h.showHome();
        return;
    }
  }

  private sendGroups(groups: Record<string, Group>) {
    this.s?.cmd('groups', { groups });
  }

  /** 担当を 1 つ変えて送る */
  private editGroup(id: string, fn: (g: Group) => void) {
    const doc = this.doc;
    const g = doc?.groups?.[id];
    if (!doc || !g) return;
    const next = structuredClone(doc.groups);
    fn(next[id]);
    this.sendGroups(next);
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
    if (!canApply(doc, this.me, { o: 'new', lane })) { this.h.toast('このレーンは足せません'); return; }
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
    // 同じ所に消すと置くが両方あるときは、置く方だけ残す
    const last = new Map<string, Op>();
    for (const op of ops) last.set((op as { k: string }).k, op);
    const list = [...last.values()];
    const inv: Op[] = list.map((op) => ({ o: 'n', l: main.id, k: (op as { k: string }).k, v: main.notes[(op as { k: string }).k] ?? null }));
    // 出どころ: 選んだ範囲が半分より多くかかっている本譜面の小節
    for (const m of measures(dst.chart.courses[0], z + 1)) {
      const lap = Math.min(z - 1, m.start + m.length) - Math.max(a + 1, m.start);
      if (lap * 2 <= m.length) continue;
      const k = String(Math.round(m.start));
      list.push({ o: 'pv', l: main.id, k, v: { end: Math.round(m.start + m.length), by: src.owner, color: src.color } });
      inv.push({ o: 'pv', l: main.id, k, v: main.prov?.[k] ?? null });
    }
    if (list.some((op) => !canApply(doc, this.me, op))) { this.h.toast('本譜面を編集する権限がありません'); return; }
    s.apply(list, inv);
    this.bump(main.id);
    this.undoSt.push({ ops: list, inv });
    this.redoSt = [];
    const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
    s.cmd('adoptNote', { src: src.id, dst: main.id, range: `${fmt(ta)}〜${fmt(tb)}` });
    this.refreshGhosts();
    this.h.updateHeader();
    this.h.toast(off ? `本譜面へ採用しました（${off} 個の音符は本譜面のグリッドに合わず、近い位置に置きました）` : '本譜面へ採用しました');
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
      p.style.top = `${Math.max(40, (r.top - pr.top) / uiScale() - 44)}px`;
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
  resetOnce();
  try { return JSON.parse(localStorage.getItem(SHARED_KEY) ?? '{}'); } catch { return {}; }
}
function markShared(songId: string, projectId: string) {
  const m = sharedMap();
  m[songId] = projectId;
  try { localStorage.setItem(SHARED_KEY, JSON.stringify(m)); } catch { /* なし */ }
}

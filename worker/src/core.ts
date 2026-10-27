/**
 * オンライン対戦の部屋（Cloudflare の Durable Object とローカルの確認用サーバーの両方で使う中身）。
 *
 * 部屋に入った人（最大 4 人）のつながりを持ち、
 * - 予約された曲を、部屋の設定（部屋主だけ・全員・順番・ランダム）に従って 1 曲ずつ「今の曲」にする
 * - 今の曲の音源を持っていない人がいれば、予約した人に送ってもらって配る（持っている人には送らない）
 * - 全員が受け取って「準備OK」なら、カウントダウンして同じ時刻に始める（部屋主はすぐ始めることもできる）
 * - プレイ中は、それぞれの判定・点数をほかの人へ中継する
 * - 全員が終わったら（または時間切れで）順位を配り、部屋の通算成績に足す
 * - 通信が切れても 20 秒は席を残し、同じ端末（cid）が入り直したら元の席に戻す
 *
 * Cloudflare では、だれも何も送らない間はサーバーを眠らせる（動いている時間だけ数えられるので）。
 * 眠ると中身が消えるため、様子が変わるたびに snapshot() を保存し、起きたら restore() で戻す。
 */

export interface Conn {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export interface LobbyInfo {
  id: string;
  title: string;
  host: string;
  players: number;
  max: number;
  playing: boolean;
  locked: boolean;
  song: string;
  updatedAt: number;
}

interface Player {
  id: string;
  /** 端末ごとの値（入り直したときに同じ人だと分かるように） */
  cid: string;
  name: string;
  /** つながり（切れて入り直しを待っているあいだは null） */
  conn: Conn | null;
  /** 切れてから席を消すまでのタイマー */
  awayTimer?: ReturnType<typeof setTimeout>;
  /** 今の曲を受け取って、遊べる状態か */
  ready: boolean;
  /** 準備OK を押したか */
  ok: boolean;
  /** 遊ぶ難易度（今の曲の中から各自で選ぶ） */
  course: string;
  /** 今のプレイに参加しているか */
  inGame: boolean;
  /** 届いたメッセージの数（荒らし対策: 1 秒ごとに数え直す） */
  rate: number;
  rateAt: number;
  /** 最後にチャットを送った時刻（連投を防ぐ） */
  chatAt?: number;
  /** プレイ中の様子が最後に届いた時刻 */
  lastSt?: number;
}

export interface SongMeta {
  /** 今の曲を見分ける値（サーバーが決める） */
  key: string;
  title: string;
  subtitle: string;
  /** 予約した人が選んだ難易度（各自で変えられる） */
  course: string;
  level: number;
  /** 譜面（TJA の文字） */
  tja: string;
  /** 音源のバイト数（0 = 音源なし） */
  size: number;
  /** 音源のファイル名 */
  audioName: string;
  /** 音源の中身から作った値（同じ音源を持っている人には送らない） */
  hash: string;
  /** 予約した人の曲の一覧での番号（予約した人だけが使う） */
  lib: string;
  /** 背景の動画のファイル名（無ければ ''）・バイト数（音源と同じファイルなら 0）・中身から作った値・ずれ（秒） */
  vname: string;
  vsize: number;
  vhash: string;
  voff: number;
  /** 動画が音源と同じファイル（mp4 だけの曲。音源を受け取れば動画にも使う） */
  vfromAudio: boolean;
}

export interface QItem { qid: string; by: string; byName: string; meta: Omit<SongMeta, 'key'> }

/** 保存する部屋の様子 */
export interface RoomState {
  players: { id: string; cid: string; name: string; ready: boolean; ok: boolean; course: string }[];
  hostId: string;
  title: string;
  pass: string;
  settings: RoomSettings;
  queue: QItem[];
  current: { item: QItem; key: string } | null;
  last: QItem | null;
  lastBy: string;
  seq: number;
  qseq: number;
  chatLog: { p: string; name: string; x: string; at: number }[];
  standings: [string, { name: string; total: number; wins: number; plays: number }][];
  history: { title: string; course: string; level: number; at: number; list: (Result & { p: string })[] }[];
}

export interface RoomSettings {
  /** 曲を選べる人: 部屋主だけ・全員・全員（順番に）・全員（ランダム） */
  pick: 'host' | 'all' | 'turn' | 'random';
  /** 1 人が予約できる曲の数 */
  limit: number;
  /** 全員が準備OK なら自動で始める */
  auto: boolean;
}

export interface Result { name: string; course: string; score: number; good: number; ok: number; bad: number; maxCombo: number; rolls: number }

export const MAX_PLAYERS = 4;
/** 音源の上限（バイト） */
export const MAX_AUDIO = 40 * 1024 * 1024;
/** 譜面の上限（文字数） */
const MAX_TJA = 2 * 1024 * 1024;
/** 1 秒に受け付けるメッセージの数（音源のかけらは数えない） */
const RATE = 240;
/** スタートの合図から曲の 0 秒までの時間（ms）。そのあいだに各端末が準備する */
const LEAD_MS = 4500;
/** 全員が準備OK になってから始めるまで（ms） */
const COUNTDOWN_MS = 3000;
/** 通信が切れてから席を消すまで（ms） */
const AWAY_MS = 20000;
/** ロビー: この間知らせが無い部屋は一覧から消す。部屋はその半分ごとに知らせ直す */
export const LOBBY_STALE_MS = 30 * 60 * 1000;
/** 背景の動画の上限（バイト。サーバーにはためずに、持っていない人へそのまま流す） */
export const MAX_VIDEO = 300 * 1024 * 1024;
/** 予約できる曲の数（部屋全体） */
const MAX_QUEUE = 30;

/** 名前・部屋名から、制御文字などを取り除いて長さを決める */
export function clean(s: unknown, max: number) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max);
}

export class RoomCore {
  private players = new Map<string, Player>();
  private hostId = '';
  private title = '';
  private pass = '';
  private settings: RoomSettings = { pick: 'all', limit: 2, auto: true };
  private queue: QItem[] = [];
  /** 今の曲（予約から 1 曲ずつ。音源は持っていない人にだけ配る） */
  private current: {
    item: QItem; key: string; uploading: boolean; done: boolean; chunks: ArrayBuffer[]; received: number; need: Set<string>;
    /** 背景の動画（ためずに流すだけ。欲しい人がいるときだけ、予約した人に送ってもらう） */
    vuploading: boolean; vreceived: number; vneed: Set<string>;
  } | null = null;
  /** 最後に遊んだ曲（「もう一回」用） */
  private last: QItem | null = null;
  /** 順番に選ぶとき: 最後に選ばれた人 */
  private lastBy = '';
  private countdown: { at: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private phase: 'wait' | 'play' = 'wait';
  private zero = 0;
  private results = new Map<string, Result>();
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  /** 今のプレイに参加した人の様子（途中から入った人が観戦できるように、判定をためておく） */
  private round = new Map<string, { name: string; course: string; s: number; c: number; g: number; j: [number, number][]; status: '' | 'fin' | 'quit' | 'lost' }>();
  private seq = 0;
  private qseq = 0;
  /** チャット（新しい 40 件。後から入った人にも送る） */
  private chatLog: { p: string; name: string; x: string; at: number }[] = [];
  /** 部屋の通算成績（端末ごと） */
  private standings = new Map<string, { name: string; total: number; wins: number; plays: number }>();
  /** 遊んだ曲と順位（新しい 20 曲） */
  private history: { title: string; course: string; level: number; at: number; list: (Result & { p: string })[] }[] = [];
  /** 最後にロビーへ知らせた内容（変わったときだけ知らせる） */
  private lobbySig = '';
  /** 部屋の様子が変わった（保存する合図） */
  onChange: () => void = () => {};

  constructor(
    readonly id: string,
    /** ロビーに部屋の様子を知らせる（null = 部屋が無くなった） */
    private readonly report: (info: LobbyInfo | null) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get empty() {
    return this.players.size === 0;
  }

  player(id: string) {
    return this.players.get(id);
  }

  /** ロビーに知らせ直す（しばらく知らせが無い部屋は一覧から消えるので、ときどき） */
  heartbeat() {
    this.lobbySig = '';
    this.lobby();
  }

  /** 保存する中身（譜面の文字は大きいので items で別に渡す。音源のかけら・プレイ中の様子は入れない） */
  snapshot(): { state: RoomState; items: QItem[] } {
    const strip = (x: QItem) => ({ ...x, meta: { ...x.meta, tja: '' } });
    const cur = this.current;
    const items = [...this.queue];
    if (cur) items.push(cur.item);
    if (this.last) items.push(this.last);
    return {
      items,
      state: {
        players: [...this.players.values()].map((o) => ({ id: o.id, cid: o.cid, name: o.name, ready: o.ready, ok: o.ok, course: o.course })),
        hostId: this.hostId,
        title: this.title,
        pass: this.pass,
        settings: this.settings,
        queue: this.queue.map(strip),
        current: cur ? { item: strip(cur.item), key: cur.key } : null,
        last: this.last ? strip(this.last) : null,
        lastBy: this.lastBy,
        seq: this.seq,
        qseq: this.qseq,
        chatLog: this.chatLog,
        standings: [...this.standings.entries()],
        history: this.history,
      },
    };
  }

  /** 保存した中身から戻す。conns: 席の番号 → つながり（つながりが無い人は抜けたことにする） */
  restore(st: RoomState, tja: (qid: string) => string, conns: Map<string, Conn>) {
    const fill = (x: QItem): QItem => ({ ...x, meta: { ...x.meta, tja: tja(x.qid) } });
    this.hostId = st.hostId;
    this.title = st.title;
    this.pass = st.pass;
    this.settings = st.settings;
    this.queue = st.queue.map(fill);
    this.last = st.last ? fill(st.last) : null;
    this.lastBy = st.lastBy;
    this.seq = st.seq;
    this.qseq = st.qseq;
    this.chatLog = st.chatLog;
    this.standings = new Map(st.standings);
    this.history = st.history;
    this.phase = 'wait';
    // 音源のかけらは残っていないので、必要になったらもう一度送ってもらう
    this.current = st.current ? { item: fill(st.current.item), key: st.current.key, uploading: false, done: st.current.item.meta.size === 0, chunks: [], received: 0, need: new Set(), vuploading: false, vreceived: 0, vneed: new Set() } : null;
    this.players.clear();
    for (const o of st.players) {
      const conn = conns.get(o.id);
      if (!conn) continue;
      this.players.set(o.id, { ...o, conn, inGame: false, rate: 0, rateAt: this.now() });
    }
    if (!this.players.has(this.hostId)) this.hostId = this.players.keys().next().value ?? '';
    if (!this.players.size) this.reset();
  }

  /** 入る。だめなら理由（文字）を返す。cid が同じ人が席にいれば、その席に戻る */
  join(conn: Conn, q: { name: string; create: boolean; title: string; pass: string; cid?: string }): Player | string {
    const name = clean(q.name, 12) || 'ななし';
    const cid = clean(q.cid, 40) || `x${++this.seq}`;
    const back = [...this.players.values()].find((o) => o.cid === cid);
    if (back) {
      // 入り直し: 前のつながりは閉じて、同じ席に戻す
      if (this.pass && q.pass !== this.pass) return 'あいことばが違います';
      if (back.awayTimer) clearTimeout(back.awayTimer);
      back.awayTimer = undefined;
      try { back.conn?.close(4002, 'replaced'); } catch { /* 閉じ済み */ }
      back.conn = conn;
      back.name = name;
      this.welcome(back);
      return back;
    }
    if (this.players.size === 0) {
      if (!q.create) return 'この部屋はもうありません';
      this.title = clean(q.title, 24) || `${name} の部屋`;
      this.pass = clean(q.pass, 16);
      this.reset();
    } else {
      if (q.create) return '同じ部屋がすでにあります';
      if (this.pass && q.pass !== this.pass) return 'あいことばが違います';
      if (this.players.size >= MAX_PLAYERS) return '満員です';
    }
    const p: Player = { id: `p${++this.seq}`, cid, name, conn, ready: false, ok: false, course: '', inGame: false, rate: 0, rateAt: this.now() };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.welcome(p);
    this.cancelCountdown();
    return p;
  }

  private reset() {
    this.queue = [];
    this.current = null;
    this.last = null;
    this.phase = 'wait';
    this.standings.clear();
    this.history = [];
    this.chatLog = [];
  }

  /** 入った（入り直した）人に、部屋の今の様子を送る */
  private welcome(p: Player) {
    this.sendTo(p, { t: 'hello', you: p.id, room: { id: this.id, title: this.title, locked: !!this.pass }, max: MAX_PLAYERS });
    if (this.chatLog.length) this.sendTo(p, { t: 'chatlog', list: this.chatLog });
    if (this.history.length) this.sendTo(p, { t: 'history', list: this.history });
    // 今の曲: 持っているか聞く
    if (this.current) {
      p.ready = false;
      if (!p.course) p.course = this.current.item.meta.course;
      this.sendTo(p, { t: 'next', meta: { ...this.current.item.meta, key: this.current.key }, by: this.current.item.by });
    }
    this.roster();
  }

  /** つながりが切れた。少しのあいだ席を残して、入り直しを待つ */
  disconnect(p: Player, conn: Conn) {
    if (p.conn !== conn || !this.players.has(p.id)) return;
    p.conn = null;
    p.awayTimer = setTimeout(() => this.leave(p), AWAY_MS);
    this.cancelCountdown();
    this.roster();
  }

  leave(p: Player) {
    if (p.awayTimer) clearTimeout(p.awayTimer);
    if (!this.players.delete(p.id)) return;
    { const r = this.round.get(p.id); if (r && !r.status) r.status = 'lost'; }
    // この人の予約は消す（音源を送れないので）
    this.queue = this.queue.filter((x) => x.by !== p.id);
    if (this.hostId === p.id) {
      // 部屋主が抜けたら、次に古い人が部屋主になる
      this.hostId = this.players.keys().next().value ?? '';
    }
    if (this.players.size === 0) {
      this.reset();
      this.cancelCountdown();
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.report(null);
      return;
    }
    // 今の曲を予約した人が、音源を送りきる前に抜けた: その曲は飛ばす
    if (this.current && this.current.item.by === p.id && !this.current.done && this.phase === 'wait') {
      this.current = null;
      this.advance();
    }
    if (this.phase === 'play') this.maybeFinish();
    this.maybeCountdown();
    this.roster();
  }

  message(p: Player, data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      this.audioChunk(p, data);
      return;
    }
    // つながっているかの確認（Cloudflare では眠ったまま自動で返す）
    if (data === 'ping') {
      try { p.conn?.send('pong'); } catch { /* 切れている */ }
      return;
    }
    const t = this.now();
    if (t - p.rateAt > 1000) { p.rate = 0; p.rateAt = t; }
    if (++p.rate > RATE) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    const host = p.id === this.hostId;
    const cur = this.current;
    switch (m.t) {
      case 'ping':
        this.sendTo(p, { t: 'pong', c: m.c, s: this.now() });
        break;
      case 'reserve': {
        // 曲を予約する
        if (this.settings.pick === 'host' && !host) return this.sendTo(p, { t: 'err', msg: 'この部屋では、部屋主だけが曲を選べます' });
        const mine = this.queue.filter((x) => x.by === p.id).length;
        if (mine >= this.settings.limit) return this.sendTo(p, { t: 'err', msg: `予約できるのは 1 人 ${this.settings.limit} 曲までです` });
        if (this.queue.length >= MAX_QUEUE) return this.sendTo(p, { t: 'err', msg: '予約がいっぱいです' });
        const meta = m.meta as SongMeta;
        if (!meta || typeof meta.tja !== 'string' || meta.tja.length > MAX_TJA) return this.sendTo(p, { t: 'err', msg: '譜面が大きすぎます' });
        const size = Math.max(0, Math.floor(Number(meta.size) || 0));
        if (size > MAX_AUDIO) return this.sendTo(p, { t: 'err', msg: '音源が大きすぎます（40MB まで）' });
        this.queue.push({
          qid: `q${++this.qseq}`,
          by: p.id,
          byName: p.name,
          meta: {
            title: clean(meta.title, 80),
            subtitle: clean(meta.subtitle, 80),
            course: clean(meta.course, 12),
            level: Math.max(0, Math.min(20, Number(meta.level) || 0)),
            tja: meta.tja,
            size,
            audioName: clean(meta.audioName, 80),
            hash: clean(meta.hash, 80),
            lib: clean(meta.lib, 40),
            vname: clean(meta.vname, 80),
            vsize: Math.max(0, Math.min(MAX_VIDEO, Math.floor(Number(meta.vsize) || 0))),
            vhash: clean(meta.vhash, 80),
            voff: Math.max(-60, Math.min(60, Number(meta.voff) || 0)),
            vfromAudio: !!meta.vfromAudio,
          },
        });
        this.advance();
        this.roster();
        break;
      }
      case 'unreserve': {
        const i = this.queue.findIndex((x) => x.qid === m.qid);
        if (i < 0 || (!host && this.queue[i].by !== p.id)) return;
        this.queue.splice(i, 1);
        this.roster();
        break;
      }
      case 'move': {
        // 部屋主: 予約の順番を変える
        if (!host) return;
        const i = this.queue.findIndex((x) => x.qid === m.qid);
        const j = i + (Number(m.d) < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= this.queue.length) return;
        [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        this.roster();
        break;
      }
      case 'settings': {
        if (!host) return;
        const s = (m.s ?? {}) as Partial<RoomSettings>;
        if (s.pick === 'host' || s.pick === 'all' || s.pick === 'turn' || s.pick === 'random') this.settings.pick = s.pick;
        if (s.limit !== undefined) this.settings.limit = Math.max(1, Math.min(5, Math.floor(Number(s.limit) || 1)));
        if (s.auto !== undefined) this.settings.auto = !!s.auto;
        this.maybeCountdown();
        this.roster();
        break;
      }
      case 'skip':
        // 部屋主: 今の曲を飛ばす
        if (!host || this.phase !== 'wait' || !cur) return;
        this.current = null;
        this.cancelCountdown();
        this.advance();
        this.roster();
        break;
      case 'again': {
        // もう一回（部屋主か、その曲を予約した人）
        const last = this.last;
        if (this.phase !== 'wait' || !last || (!host && last.by !== p.id)) return;
        if (cur && cur.item !== last) this.queue.unshift(cur.item);
        this.current = null;
        this.cancelCountdown();
        this.advance({ ...last, qid: `q${++this.qseq}` });
        this.roster();
        break;
      }
      case 'have':
        // 今の曲を読み込めた（音源を持っていた・受け取った）
        if (cur && m.key === cur.key) {
          p.ready = true;
          cur.need.delete(p.id);
          this.maybeCountdown();
          this.roster();
        }
        break;
      case 'need':
        // 今の曲の音源を持っていない: 予約した人に送ってもらう（もう届いていれば、ためてある分を送る）
        if (!cur || m.key !== cur.key) return;
        cur.need.add(p.id);
        for (const c of cur.chunks) this.sendRaw(p, c);
        if (cur.done) this.sendTo(p, { t: 'songEnd', key: cur.key });
        else if (!cur.uploading) {
          const by = this.players.get(cur.item.by);
          if (!by) return;
          cur.uploading = true;
          this.sendTo(by, { t: 'upload', key: cur.key, lib: cur.item.meta.lib });
        }
        break;
      case 'songEnd':
        if (!cur || p.id !== cur.item.by || cur.done || m.key !== cur.key) return;
        if (cur.received !== cur.item.meta.size) return this.sendTo(p, { t: 'err', msg: '音源を送りきれませんでした' });
        cur.done = true;
        for (const id of cur.need) { const o = this.players.get(id); if (o) this.sendTo(o, { t: 'songEnd', key: cur.key }); }
        this.maybeVideoUpload();
        break;
      case 'vneed':
        // 背景の動画を持っていない（欲しい）: 予約した人に送ってもらう（音源を送り終えてから）
        if (!cur || m.key !== cur.key || !cur.item.meta.vsize) return;
        cur.vneed.add(p.id);
        this.maybeVideoUpload();
        break;
      case 'vend':
        if (!cur || p.id !== cur.item.by || !cur.vuploading || m.key !== cur.key) return;
        cur.vuploading = false;
        for (const id of cur.vneed) { const o = this.players.get(id); if (o) this.sendTo(o, { t: 'vend', key: cur.key }); }
        cur.vneed.clear();
        break;
      case 'ok':
        p.ok = !!m.on;
        this.maybeCountdown();
        this.roster();
        break;
      case 'course':
        p.course = clean(m.c, 12);
        this.roster();
        break;
      case 'start': {
        // 部屋主: 準備OK を待たずに始める（全員が曲を受け取っていれば）
        if (!host || this.phase !== 'wait' || !cur) return;
        if ([...this.players.values()].some((o) => o.conn && !o.ready)) return this.sendTo(p, { t: 'err', msg: '曲を受け取っていない人がいます' });
        this.startGame();
        break;
      }
      case 'host': {
        // 部屋主を渡す
        const o = this.players.get(String(m.p));
        if (!host || !o || o === p) return;
        this.hostId = o.id;
        this.roster();
        break;
      }
      case 'st':
        // プレイ中の様子（点数・コンボ・ゲージと、新しく判定した音符）を中継する
        if (this.phase !== 'play' || !p.inGame) return;
        {
          // 判定 [音符の番号, 判定, 判定した曲の時刻（ms・無いこともある）] と、叩いた入力 [曲の時刻（ms）, 種類]
          const j = Array.isArray(m.j)
            ? (m.j.slice(0, 300) as unknown[])
              .filter((x): x is number[] => Array.isArray(x) && (x.length === 2 || x.length === 3))
              .map((x) => (x.length === 3 ? [Math.floor(Number(x[0])) || 0, Math.floor(Number(x[1])) || 0, Math.round(Number(x[2])) || 0] : [Math.floor(Number(x[0])) || 0, Math.floor(Number(x[1])) || 0]))
            : [];
          const h = Array.isArray(m.h)
            ? (m.h.slice(0, 120) as unknown[]).filter((x): x is number[] => Array.isArray(x) && x.length === 2).map((x) => [Math.round(Number(x[0])) || 0, Math.floor(Number(x[1])) & 3])
            : [];
          const r = this.round.get(p.id);
          if (r) {
            r.s = Number(m.s) || 0;
            r.c = Number(m.c) || 0;
            r.g = Number(m.g) || 0;
            if (r.j.length < 20000) r.j.push(...j.map((x) => [x[0], x[1]] as [number, number]));
          }
          p.lastSt = this.now();
          this.broadcast({ t: 'st', p: p.id, s: r?.s ?? 0, c: r?.c ?? 0, g: r?.g ?? 0, j, h }, p);
        }
        break;
      case 'watch': {
        // 途中から入った人: 今のプレイを観戦する（曲の 0 秒の時刻と、ここまでの判定）
        if (this.phase !== 'play' || !cur || p.inGame) return;
        const players = [...this.round.entries()].map(([id, r]) => ({ p: id, name: r.name, course: r.course, s: r.s, c: r.c, g: r.g, j: r.j, status: r.status }));
        this.sendTo(p, { t: 'watch', zero: this.zero, key: cur.key, players });
        break;
      }
      case 'fin': {
        if (this.phase !== 'play' || !p.inGame) return;
        const r = (m.r ?? {}) as Record<string, number>;
        const n = (k: string) => Math.max(0, Math.floor(Number(r[k]) || 0));
        this.results.set(p.id, { name: p.name, course: p.course, score: n('score'), good: n('good'), ok: n('ok'), bad: n('bad'), maxCombo: n('maxCombo'), rolls: n('rolls') });
        p.inGame = false;
        { const x = this.round.get(p.id); if (x) x.status = 'fin'; }
        this.broadcast({ t: 'fin', p: p.id }, p);
        this.maybeFinish();
        break;
      }
      case 'quit':
        // プレイの途中でやめた
        if (this.phase !== 'play' || !p.inGame) return;
        p.inGame = false;
        { const x = this.round.get(p.id); if (x) x.status = 'quit'; }
        this.broadcast({ t: 'quit', p: p.id }, p);
        this.maybeFinish();
        break;
      case 'kick': {
        if (!host) return;
        const o = this.players.get(String(m.p));
        if (!o || o.id === p.id) return;
        this.sendTo(o, { t: 'kicked' });
        o.conn?.close(4001, 'kicked');
        this.leave(o);
        break;
      }
      case 'chat': {
        // 自由な文字（80 文字まで・制御文字は除く・0.4 秒に 1 回まで）
        const x = clean(m.x, 80);
        if (!x) return;
        const now = this.now();
        if (p.chatAt && now - p.chatAt < 400) return this.sendTo(p, { t: 'err', msg: 'チャットは少し間をあけて送ってください' });
        p.chatAt = now;
        const c = { p: p.id, name: p.name, x, at: now };
        this.chatLog.push(c);
        if (this.chatLog.length > 40) this.chatLog.shift();
        this.broadcast({ t: 'chat', ...c });
        this.onChange();
        break;
      }
    }
  }

  /** 予約から次の曲を決めて、全員に「持っているか」聞く */
  private advance(force?: QItem) {
    if (this.phase !== 'wait' || this.current) return;
    let item = force;
    if (!item) {
      if (!this.queue.length) return;
      let i = 0;
      if (this.settings.pick === 'random') i = Math.floor(Math.random() * this.queue.length);
      else if (this.settings.pick === 'turn') {
        // 前に選ばれた人の次の人から順に、予約がある人
        const ids = [...this.players.keys()];
        const start = ids.indexOf(this.lastBy);
        for (let k = 1; k <= ids.length; k++) {
          const id = ids[(start + k + ids.length) % ids.length];
          const j = this.queue.findIndex((x) => x.by === id);
          if (j >= 0) { i = j; break; }
        }
      }
      item = this.queue.splice(i, 1)[0];
    } else this.queue = this.queue.filter((x) => x.qid !== item!.qid);
    this.lastBy = item.by;
    const key = `${item.qid}-${this.now().toString(36)}`;
    this.current = { item, key, uploading: false, done: item.meta.size === 0, chunks: [], received: 0, need: new Set(), vuploading: false, vreceived: 0, vneed: new Set() };
    for (const o of this.players.values()) { o.ready = false; o.ok = false; o.course = item.meta.course; }
    this.broadcast({ t: 'next', meta: { ...item.meta, key }, by: item.by });
    this.roster();
  }

  /** 動画を欲しい人がいて、音源を送っている途中でなければ、予約した人に動画を送ってもらう */
  private maybeVideoUpload() {
    const cur = this.current;
    if (!cur || cur.vuploading || !cur.vneed.size || (cur.uploading && !cur.done)) return;
    const by = this.players.get(cur.item.by);
    if (!by) return;
    cur.vuploading = true;
    cur.vreceived = 0;
    this.sendTo(by, { t: 'vupload', key: cur.key, lib: cur.item.meta.lib });
  }

  /** 予約した人から届いた音源・動画のかけら（音源は持っていない人に配ってためておく。動画は欲しい人へ流すだけ） */
  private audioChunk(p: Player, data: ArrayBuffer) {
    const cur = this.current;
    if (!cur || p.id !== cur.item.by) return;
    if (!(cur.uploading && !cur.done && this.phase === 'wait')) {
      // 動画（プレイ中も流してよい。終わってから使う）
      if (!cur.vuploading || cur.vreceived + data.byteLength > cur.item.meta.vsize) return;
      cur.vreceived += data.byteLength;
      for (const id of cur.vneed) { const o = this.players.get(id); if (o) this.sendRaw(o, data); }
      return;
    }
    if (cur.received + data.byteLength > cur.item.meta.size) {
      this.sendTo(p, { t: 'err', msg: '音源の大きさが合いません' });
      return;
    }
    cur.chunks.push(data);
    cur.received += data.byteLength;
    for (const id of cur.need) { const o = this.players.get(id); if (o) this.sendRaw(o, data); }
  }

  /** 全員が曲を受け取って準備OK なら、カウントダウンして始める（だれかが取り消したらやめる） */
  private maybeCountdown() {
    const ps = [...this.players.values()].filter((o) => o.conn);
    const go = this.settings.auto && this.phase === 'wait' && !!this.current && ps.length > 0 && ps.every((o) => o.ready && o.ok);
    if (go && !this.countdown) {
      const at = this.now() + COUNTDOWN_MS;
      this.countdown = { at, timer: setTimeout(() => { this.countdown = null; this.startGame(); }, COUNTDOWN_MS) };
    } else if (!go) this.cancelCountdown();
  }

  private cancelCountdown() {
    if (!this.countdown) return;
    clearTimeout(this.countdown.timer);
    this.countdown = null;
  }

  private startGame() {
    const cur = this.current;
    if (this.phase !== 'wait' || !cur) return;
    this.cancelCountdown();
    this.phase = 'play';
    this.zero = this.now() + LEAD_MS;
    this.results.clear();
    this.round.clear();
    const ps = [...this.players.values()].filter((o) => o.conn && o.ready);
    for (const o of ps) this.round.set(o.id, { name: o.name, course: o.course, s: 0, c: 0, g: 0, j: [], status: '' });
    for (const o of ps) { o.inGame = true; o.lastSt = this.zero; }
    this.startWatchdog();
    const list = ps.map((o) => ({ p: o.id, name: o.name, course: o.course }));
    this.broadcast({ t: 'start', zero: this.zero, key: cur.key, players: list });
    this.roster();
  }

  private maybeFinish() {
    const playing = [...this.players.values()].filter((o) => o.inGame);
    if (playing.length === 0) {
      this.endGame();
      return;
    }
    // 終わった人がいるのに、残りの人がいつまでも終わらないとき（通信が切れたなど）は 20 秒で締め切る
    if (this.results.size > 0 && !this.finishTimer) this.finishTimer = setTimeout(() => this.endGame(), 20000);
  }

  private watchdog: ReturnType<typeof setInterval> | null = null;

  /**
   * プレイ中に様子が 15 秒届かない人（アプリを閉じた・画面が止まったなど）は、抜けたことにする。
   * 全員そうなっても部屋が「プレイ中」のまま止まらないように
   */
  private startWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (this.phase !== 'play') { if (this.watchdog) clearInterval(this.watchdog); this.watchdog = null; return; }
      const now = this.now();
      let changed = false;
      for (const o of this.players.values()) {
        if (!o.inGame || now - (o.lastSt ?? this.zero) < 15000) continue;
        o.inGame = false;
        const r = this.round.get(o.id);
        if (r && !r.status) r.status = 'lost';
        this.broadcast({ t: 'quit', p: o.id });
        changed = true;
      }
      if (changed) { this.maybeFinish(); this.roster(); }
    }, 3000);
  }

  private endGame() {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    if (this.phase !== 'play') return;
    this.phase = 'wait';
    for (const o of this.players.values()) { o.inGame = false; o.ready = false; o.ok = false; }
    const list = [...this.results.entries()].map(([p, r]) => ({ p, ...r })).sort((a, b) => b.score - a.score);
    // 通算成績（1 位は 1 回ずつ。同点はどちらも 1 位）
    const top = list[0]?.score ?? -1;
    for (const r of list) {
      const o = this.players.get(r.p);
      const key = o?.cid ?? r.p;
      const s = this.standings.get(key) ?? { name: r.name, total: 0, wins: 0, plays: 0 };
      s.name = r.name;
      s.total += r.score;
      s.plays++;
      if (r.score === top && list.length > 1) s.wins++;
      this.standings.set(key, s);
    }
    const cur = this.current;
    if (cur) {
      this.history.unshift({ title: cur.item.meta.title, course: cur.item.meta.course, level: cur.item.meta.level, at: this.now(), list });
      if (this.history.length > 20) this.history.pop();
      this.last = cur.item;
    }
    this.broadcast({ t: 'results', list, history: this.history });
    this.current = null;
    // 次の予約があれば、すぐに準備を始める（受け取りを待つ時間を減らす）
    this.advance();
    this.roster();
  }

  private roster() {
    const players = [...this.players.values()].map((o) => ({ p: o.id, name: o.name, ready: o.ready, ok: o.ok, inGame: o.inGame, course: o.course, away: !o.conn }));
    const cur = this.current;
    this.broadcast({
      t: 'roster',
      host: this.hostId,
      players,
      phase: this.phase,
      settings: this.settings,
      queue: this.queue.map((x) => ({ qid: x.qid, by: x.by, byName: x.byName, title: x.meta.title, subtitle: x.meta.subtitle, course: x.meta.course, level: x.meta.level })),
      song: cur ? { key: cur.key, title: cur.item.meta.title, subtitle: cur.item.meta.subtitle, course: cur.item.meta.course, level: cur.item.meta.level, by: cur.item.by, byName: cur.item.byName } : null,
      last: this.last ? { title: this.last.meta.title, by: this.last.by } : null,
      countdown: this.countdown ? this.countdown.at : 0,
      standings: [...this.standings.values()].sort((a, b) => b.total - a.total),
    });
    this.lobby();
    this.onChange();
  }

  private lobby() {
    if (!this.players.size) return;
    const info = {
      id: this.id,
      title: this.title,
      host: this.players.get(this.hostId)?.name ?? '',
      players: this.players.size,
      max: MAX_PLAYERS,
      playing: this.phase === 'play',
      locked: !!this.pass,
      song: this.current?.item.meta.title ?? '',
      updatedAt: this.now(),
    };
    // 中身が変わったときだけ知らせる（ロビーへの知らせも数に入るので）
    const sig = JSON.stringify({ ...info, updatedAt: 0 });
    if (sig === this.lobbySig) return;
    this.lobbySig = sig;
    this.report(info);
  }

  private sendTo(p: Player, m: object) {
    try {
      p.conn?.send(JSON.stringify(m));
    } catch {
      // 切れている
    }
  }

  private sendRaw(p: Player, d: ArrayBuffer) {
    try {
      p.conn?.send(d);
    } catch {
      // 切れている
    }
  }

  private broadcast(m: object, except?: Player) {
    const s = JSON.stringify(m);
    for (const o of this.players.values()) {
      if (o === except) continue;
      try {
        o.conn?.send(s);
      } catch {
        // 切れている
      }
    }
  }
}

/** ロビー（公開している部屋の一覧） */
export class LobbyCore {
  rooms = new Map<string, LobbyInfo>();
  constructor(private readonly now: () => number = () => Date.now()) {}
  update(info: LobbyInfo | { id: string; gone: true }) {
    if ('gone' in info) this.rooms.delete(info.id);
    else this.rooms.set(info.id, info);
  }
  list(): LobbyInfo[] {
    const t = this.now();
    // しばらく知らせが無い部屋は消す（部屋のサーバーが止まったなど）
    for (const [id, r] of this.rooms) if (t - r.updatedAt > LOBBY_STALE_MS) this.rooms.delete(id);
    return [...this.rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 60);
  }
}

/** 部屋の番号（6 文字。見間違えやすい文字は使わない） */
export function newRoomId() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}

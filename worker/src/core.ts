/**
 * オンライン対戦の部屋（Cloudflare の Durable Object とローカルの確認用サーバーの両方で使う中身）。
 *
 * 部屋に入った人（最大 4 人）のつながりを持ち、
 * - 部屋主が送った曲（譜面の TJA と音源）を預かって、ほかの人へ配る（後から入った人にも）
 * - 全員が曲を受け取ったら、部屋主の「スタート」で同じ時刻に始める（時刻はサーバーの時計）
 * - プレイ中は、それぞれの判定・点数をほかの人へ中継する
 * - 全員が終わったら（または時間切れで）順位を配る
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
  name: string;
  conn: Conn;
  /** 今の曲を受け取って、遊べる状態か */
  ready: boolean;
  /** 今のプレイに参加しているか */
  inGame: boolean;
  /** 届いたメッセージの数（荒らし対策: 1 秒ごとに数え直す） */
  rate: number;
  rateAt: number;
}

export interface SongMeta {
  /** 曲を見分ける値（部屋主が決める） */
  key: string;
  title: string;
  subtitle: string;
  course: string;
  level: number;
  /** 譜面（TJA の文字） */
  tja: string;
  /** 音源のバイト数（0 = 音源なし） */
  size: number;
  /** 音源のファイル名 */
  audioName: string;
}

export const MAX_PLAYERS = 4;
/** 音源の上限（バイト） */
export const MAX_AUDIO = 40 * 1024 * 1024;
/** 譜面の上限（文字数） */
const MAX_TJA = 2 * 1024 * 1024;
/** 1 秒に受け付けるメッセージの数（音源のかけらは数えない） */
const RATE = 60;
/** スタートの合図から曲の 0 秒までの時間（ms）。そのあいだに各端末が準備する */
const LEAD_MS = 4500;

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
  private song: SongMeta | null = null;
  private chunks: ArrayBuffer[] = [];
  private received = 0;
  private songDone = false;
  private phase: 'wait' | 'play' = 'wait';
  private zero = 0;
  private results = new Map<string, { name: string; score: number; good: number; ok: number; bad: number; maxCombo: number; rolls: number }>();
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  /** 今のプレイに参加した人の様子（途中から入った人が観戦できるように、判定をためておく） */
  private round = new Map<string, { name: string; s: number; c: number; g: number; j: [number, number][]; status: '' | 'fin' | 'quit' | 'lost' }>();
  private seq = 0;

  constructor(
    readonly id: string,
    /** ロビーに部屋の様子を知らせる（null = 部屋が無くなった） */
    private readonly report: (info: LobbyInfo | null) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get empty() {
    return this.players.size === 0;
  }

  /** 入る。だめなら理由（文字）を返す */
  join(conn: Conn, q: { name: string; create: boolean; title: string; pass: string }): Player | string {
    const name = clean(q.name, 12) || 'ななし';
    if (this.players.size === 0) {
      if (!q.create) return 'この部屋はもうありません';
      this.title = clean(q.title, 24) || `${name} の部屋`;
      this.pass = clean(q.pass, 16);
      this.song = null;
      this.chunks = [];
      this.songDone = false;
      this.phase = 'wait';
    } else {
      if (q.create) return '同じ部屋がすでにあります';
      if (this.pass && q.pass !== this.pass) return 'あいことばが違います';
      if (this.players.size >= MAX_PLAYERS) return '満員です';
    }
    const p: Player = { id: `p${++this.seq}`, name, conn, ready: false, inGame: false, rate: 0, rateAt: this.now() };
    this.players.set(p.id, p);
    if (!this.hostId) this.hostId = p.id;
    this.sendTo(p, { t: 'hello', you: p.id, room: { id: this.id, title: this.title, locked: !!this.pass }, max: MAX_PLAYERS });
    // 曲があれば、後から入った人にも送る
    if (this.song) {
      this.sendTo(p, { t: 'song', meta: this.song, from: this.hostId });
      if (this.songDone) {
        for (const c of this.chunks) p.conn.send(c);
        this.sendTo(p, { t: 'songEnd', key: this.song.key });
      } else {
        for (const c of this.chunks) p.conn.send(c);
      }
    }
    if (p.id === this.hostId) p.ready = !!this.song;
    this.roster();
    return p;
  }

  leave(p: Player) {
    if (!this.players.delete(p.id)) return;
    { const r = this.round.get(p.id); if (r && !r.status) r.status = 'lost'; }
    this.results.delete(p.id);
    if (this.hostId === p.id) {
      // 部屋主が抜けたら、次に古い人が部屋主になる（曲はそのまま）
      this.hostId = this.players.keys().next().value ?? '';
      const h = this.players.get(this.hostId);
      if (h) h.ready = true;
    }
    if (this.players.size === 0) {
      this.song = null;
      this.chunks = [];
      this.phase = 'wait';
      if (this.finishTimer) clearTimeout(this.finishTimer);
      this.report(null);
      return;
    }
    if (this.phase === 'play') this.maybeFinish();
    this.roster();
  }

  message(p: Player, data: string | ArrayBuffer) {
    if (typeof data !== 'string') {
      this.audioChunk(p, data);
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
    switch (m.t) {
      case 'ping':
        this.sendTo(p, { t: 'pong', c: m.c, s: this.now() });
        break;
      case 'song': {
        if (!host || this.phase !== 'wait') return;
        const meta = m.meta as SongMeta;
        if (!meta || typeof meta.tja !== 'string' || meta.tja.length > MAX_TJA) return this.sendTo(p, { t: 'err', msg: '譜面が大きすぎます' });
        const size = Math.max(0, Math.floor(Number(meta.size) || 0));
        if (size > MAX_AUDIO) return this.sendTo(p, { t: 'err', msg: '音源が大きすぎます（40MB まで）' });
        this.song = {
          key: clean(meta.key, 64),
          title: clean(meta.title, 80),
          subtitle: clean(meta.subtitle, 80),
          course: clean(meta.course, 12),
          level: Math.max(0, Math.min(20, Number(meta.level) || 0)),
          tja: meta.tja,
          size,
          audioName: clean(meta.audioName, 80),
        };
        this.chunks = [];
        this.received = 0;
        this.songDone = size === 0;
        for (const o of this.players.values()) o.ready = o.id === this.hostId;
        this.broadcast({ t: 'song', meta: this.song, from: this.hostId }, p);
        if (this.songDone) this.broadcast({ t: 'songEnd', key: this.song.key }, p);
        this.roster();
        this.lobby();
        break;
      }
      case 'songEnd':
        if (!host || !this.song || this.songDone) return;
        if (this.received !== this.song.size) return this.sendTo(p, { t: 'err', msg: '音源を送りきれませんでした' });
        this.songDone = true;
        this.broadcast({ t: 'songEnd', key: this.song.key }, p);
        break;
      case 'have':
        // 曲を受け取って読み込めた
        if (this.song && m.key === this.song.key) {
          p.ready = true;
          this.roster();
        }
        break;
      case 'start': {
        if (!host || this.phase !== 'wait' || !this.song || !this.songDone) return;
        const ready = [...this.players.values()].filter((o) => o.ready);
        if (ready.length < this.players.size) return this.sendTo(p, { t: 'err', msg: '曲を受け取っていない人がいます' });
        this.phase = 'play';
        this.zero = this.now() + LEAD_MS;
        this.results.clear();
        this.round.clear();
        for (const o of this.players.values()) this.round.set(o.id, { name: o.name, s: 0, c: 0, g: 0, j: [], status: '' });
        for (const o of this.players.values()) o.inGame = true;
        const list = [...this.players.values()].map((o) => ({ p: o.id, name: o.name }));
        this.broadcast({ t: 'start', zero: this.zero, key: this.song.key, players: list });
        this.roster();
        this.lobby();
        break;
      }
      case 'st':
        // プレイ中の様子（点数・コンボ・ゲージと、新しく判定した音符）を中継する
        if (this.phase !== 'play' || !p.inGame) return;
        {
          const j = Array.isArray(m.j) ? (m.j.slice(0, 200) as unknown[]).filter((x): x is [number, number] => Array.isArray(x) && x.length === 2).map(([a, b]) => [Math.floor(Number(a)) || 0, Math.floor(Number(b)) || 0] as [number, number]) : [];
          const r = this.round.get(p.id);
          if (r) {
            r.s = Number(m.s) || 0;
            r.c = Number(m.c) || 0;
            r.g = Number(m.g) || 0;
            if (r.j.length < 20000) r.j.push(...j);
          }
          this.broadcast({ t: 'st', p: p.id, s: r?.s ?? 0, c: r?.c ?? 0, g: r?.g ?? 0, j }, p);
        }
        break;
      case 'watch': {
        // 途中から入った人: 今のプレイを観戦する（曲の 0 秒の時刻と、ここまでの判定）
        if (this.phase !== 'play' || !this.song || !this.songDone || p.inGame) return;
        const players = [...this.round.entries()].map(([id, r]) => ({ p: id, name: r.name, s: r.s, c: r.c, g: r.g, j: r.j, status: r.status }));
        this.sendTo(p, { t: 'watch', zero: this.zero, key: this.song.key, players });
        break;
      }
      case 'fin': {
        if (this.phase !== 'play' || !p.inGame) return;
        const r = (m.r ?? {}) as Record<string, number>;
        const n = (k: string) => Math.max(0, Math.floor(Number(r[k]) || 0));
        this.results.set(p.id, { name: p.name, score: n('score'), good: n('good'), ok: n('ok'), bad: n('bad'), maxCombo: n('maxCombo'), rolls: n('rolls') });
        p.inGame = false;
        { const r = this.round.get(p.id); if (r) r.status = 'fin'; }
        this.broadcast({ t: 'fin', p: p.id }, p);
        this.maybeFinish();
        break;
      }
      case 'quit':
        // プレイの途中でやめた
        if (this.phase !== 'play' || !p.inGame) return;
        p.inGame = false;
        { const r = this.round.get(p.id); if (r) r.status = 'quit'; }
        this.broadcast({ t: 'quit', p: p.id }, p);
        this.maybeFinish();
        break;
      case 'kick': {
        if (!host) return;
        const o = this.players.get(String(m.p));
        if (!o || o.id === p.id) return;
        this.sendTo(o, { t: 'kicked' });
        o.conn.close(4001, 'kicked');
        this.leave(o);
        break;
      }
      case 'chat': {
        // 定型のスタンプだけ（自由な文字は送れない）
        const k = Math.floor(Number(m.k));
        if (k >= 0 && k < 16) this.broadcast({ t: 'chat', p: p.id, k });
        break;
      }
    }
  }

  /** 部屋主から届いた音源のかけら */
  private audioChunk(p: Player, data: ArrayBuffer) {
    if (p.id !== this.hostId || !this.song || this.songDone || this.phase !== 'wait') return;
    if (this.received + data.byteLength > this.song.size) {
      this.sendTo(p, { t: 'err', msg: '音源の大きさが合いません' });
      return;
    }
    this.chunks.push(data);
    this.received += data.byteLength;
    for (const o of this.players.values()) if (o !== p) o.conn.send(data);
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

  private endGame() {
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = null;
    if (this.phase !== 'play') return;
    this.phase = 'wait';
    for (const o of this.players.values()) o.inGame = false;
    const list = [...this.results.entries()].map(([p, r]) => ({ p, ...r })).sort((a, b) => b.score - a.score);
    this.broadcast({ t: 'results', list });
    this.roster();
    this.lobby();
  }

  private roster() {
    const players = [...this.players.values()].map((o) => ({ p: o.id, name: o.name, ready: o.ready, inGame: o.inGame }));
    this.broadcast({ t: 'roster', host: this.hostId, players, phase: this.phase, song: this.song ? { key: this.song.key, title: this.song.title, course: this.song.course, level: this.song.level } : null });
    this.lobby();
  }

  private lobby() {
    if (!this.players.size) return;
    this.report({
      id: this.id,
      title: this.title,
      host: this.players.get(this.hostId)?.name ?? '',
      players: this.players.size,
      max: MAX_PLAYERS,
      playing: this.phase === 'play',
      locked: !!this.pass,
      song: this.song?.title ?? '',
      updatedAt: this.now(),
    });
  }

  private sendTo(p: Player, m: object) {
    try {
      p.conn.send(JSON.stringify(m));
    } catch {
      // 切れている
    }
  }

  private broadcast(m: object, except?: Player) {
    const s = JSON.stringify(m);
    for (const o of this.players.values()) {
      if (o === except) continue;
      try {
        o.conn.send(s);
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
    for (const [id, r] of this.rooms) if (t - r.updatedAt > 10 * 60 * 1000) this.rooms.delete(id);
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

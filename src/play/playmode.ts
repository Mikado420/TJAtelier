import type { AudioEngine } from '../audio/audio';
import type { Course } from '../chart/types';
import { CLEAR_LINE, Game } from '../engine/game';
import { bindInput, resetTouchStats, touchStats } from '../input';
import { Renderer, type Opponent } from '../render/renderer';
import { BUILD_ID } from '../update';
import { suggestDonWidth, zoneSamples } from './zone';
import { buildAutoEvents, type AutoEvent } from './auto';

/** Expo Go のアプリ（expo/App.js）の中で動いているか */
export function isNativeHost() {
  return !!(window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
}

/** アプリへ知らせる（プレイ中だけアプリが指を受け取る） */
function postNative(msg: object) {
  const rn = (window as unknown as { ReactNativeWebView?: { postMessage(s: string): void } }).ReactNativeWebView;
  rn?.postMessage(JSON.stringify(msg));
}

export interface PlaySettings {
  speed: number;
  /** 判定オフセット（ms）。＋で判定を遅らせる */
  offset: number;
  /** オート（譜面確認用に自動で叩く） */
  auto?: boolean;
  /** タッチ用: 中央のドンの帯の幅（画面の幅に対する割合） */
  donWidth?: number;
  /** 叩くたびにずれ（ms）を表示する */
  showTiming?: boolean;
  /** 打音を鳴らす */
  hitSound?: boolean;
  /** 打音: on = 鳴らす、playOff・off = プレイでは鳴らさない */
  hitMode?: 'on' | 'playOff' | 'off';
  /** タッチを passive で受け取る（iPhone が指を待たずに次へ進むように） */
  passiveTouch?: boolean;
  /** プレイ中のポーズボタンを出す（出さないときは上の真ん中に触れるとポーズ） */
  pauseButton?: boolean;
  /** タッチ用の太鼓を半透明で表示する（false で隠す。隠しても叩ける） */
  padVisible?: boolean;
  /** 画面上部を指置きにする（叩いても反応しない） */
  restZone?: boolean;
  /** 指のタッチをポインターイベントで受け取る（iPhone の取りこぼし対策の切り替え） */
  pointerInput?: boolean;
  /** 背景の動画: 全面・上だけ・出さない */
  videoMode?: 'full' | 'top' | 'off';
  /** 動画の形: 16:9（縦をいっぱいに出し、左右は黒帯。16:9 でない動画は 16:9 に切り抜く）・画面いっぱい */
  videoFit?: 'wide' | 'fill';
  /** 背景の動画の明るさ（0.1〜1） */
  videoDim?: number;
}

/** オンライン対戦のプレイ（PlayMode.startOnline に渡す） */
type Crown = 'allgood' | 'fc' | 'clear' | 'fail';

export interface OnlineHooks {
  /** 自分の様子をサーバーへ送る */
  send(m: object): void;
  /** 相手（届いた様子で書き換わる） */
  opponents: Opponent[];
  /** 曲が終わった（成績） */
  onFinish(stats: { score: number; good: number; ok: number; bad: number; maxCombo: number; rolls: number; crown?: Crown }): void;
  /** 途中でやめた */
  onQuit(): void;
  /** 観戦（自分は叩かず、参加している人のレーンだけを見る） */
  spectate?: boolean;
}

/**
 * テストプレイ画面。エディタの上に重ねて表示する。
 */
export class PlayMode {
  private readonly renderer: Renderer;
  private readonly input: { refresh: () => void; dispose: () => void };
  private game: Game | null = null;
  private raf = 0;
  private active = false;
  onExit: () => void = () => {};
  /** ポーズ画面で設定（オート）を変えたとき（保存用） */
  onSettingsChange: () => void = () => {};
  /** 結果が出たとき（自己ベストを残す）。オート・タイミング調整のときは呼ばない */
  onFinished: (r: { score: number; crown: 'allgood' | 'fc' | 'clear' | 'fail' }) => void = () => {};
  /** ポーズの画面を出したとき（設定の欄を作る） */
  onPauseOpen: () => void = () => {};
  /** いちばん最後に始めたときの引数（「やりなおす」で同じ所から） */
  private lastArgs: Parameters<PlayMode['start']> | null = null;

  constructor(
    private readonly root: HTMLElement,
    canvas: HTMLCanvasElement,
    private readonly result: HTMLElement,
    private readonly audio: AudioEngine,
    private readonly settings: PlaySettings,
  ) {
    this.renderer = new Renderer(canvas);
    // 画面の大きさ・向きが変わったら動画を置き直す（レーンの位置が決まってから）
    new ResizeObserver(() => requestAnimationFrame(() => this.placeVideo())).observe(root);
    this.input = bindInput(
      root,
      canvas,
      () => {
        const L = this.renderer.layout;
        // ポーズボタンを出さないときは、上の真ん中（レーンより上・横幅の 4 割）に触れるとポーズ
        const pause = this.settings.pauseButton === false ? { bottom: L.laneY, half: L.w * 0.2, go: () => this.pause() } : undefined;
        return { x: L.drumX, half: L.drumHalf, y: L.drumY, ry: L.drumRY, restBottom: L.restBottom, pause };
      },
      (kind, side, at, pt) => {
        // オートのときは叩いた入力を受け付けない
        if (!this.active || this.paused || !this.game || this.auto || this.spectating) return;
        // 打音をいちばん先に鳴らす（判定や絵の処理で遅れないように）
        if (this.hitOn) this.audio.playHit(kind);
        this.renderer.pushHit(kind, side);
        if (pt) this.renderer.pushTouch(kind, pt.x, pt.y);
        // 叩いた瞬間の時刻で判定（処理が遅れてもずれない）
        const hitT = this.time(at);
        this.pushTap(kind, side, hitT);
        const r = this.game.hit(kind, hitT, pt?.ring);
        if (this.settings.showTiming) {
          const ms = (d: number) => `${d > 0 ? '+' : ''}${Math.round(d * 1000)}ms`;
          if (r.type === 'judged') this.renderer.pushTiming(ms(r.delta), r.delta > 0 ? '#ffb070' : '#8fd0ff');
          else if (r.type === 'big') this.renderer.pushTiming('大音符の2打目', '#ffe25a');
          else if (r.type === 'roll') this.renderer.pushTiming('連打', '#ffe25a');
          else if (r.type === 'none') {
            if (r.wrongColor && r.nearest === null) this.renderer.pushTiming('色違い', '#c0c0c0');
            else if (r.nearest !== null) this.renderer.pushTiming(`判定なし ${ms(r.nearest)}`, '#ff6b6b');
            else this.renderer.pushTiming('近くに音符なし', '#c0c0c0');
          }
        }
      },
      () => !!this.settings.pointerInput,
      (line, at) => {
        if (this.active && this.raw.length < 5000) this.raw.push({ t: this.time(at), s: line });
      },
      () => !!this.settings.passiveTouch,
    );
    window.addEventListener('keydown', (e) => {
      if (this.active && e.code === 'Escape' && !this.online) {
        if (this.paused) void this.resume();
        else this.pause();
      }
    });
    // 別のタブ・アプリへ移ったら、裏で流し続けずにポーズする
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.online) this.pause();
    });
  }

  /** オートで叩くか（オンライン対戦では自分で叩く） */
  private get auto() {
    return !!this.settings.auto && !this.online;
  }

  /** オンライン対戦中なら、そのやりとり */
  private online: OnlineHooks | null = null;
  /** オンライン: まだ送っていない判定 [音符の番号, 0 良 / 1 可 / 2 不可, 判定した曲の時刻（ms）] */
  private outbox: [number, number, number][] = [];
  /** オンライン: まだ送っていない入力（何もない所を叩いたものも） [曲の時刻（ms）, 0 ドン左 / 1 ドン右 / 2 カッ左 / 3 カッ右] */
  private tapbox: [number, number][] = [];
  private lastSent = 0;
  private lastSentKey = '';

  /** オンライン対戦を観戦している */
  private get spectating() {
    return !!this.online?.spectate;
  }

  get isOnline() {
    return !!this.online;
  }

  /**
   * オンライン対戦: 曲の 0 秒が performance.now() の zeroPerf（ms）になるように始める（全員が同じ時刻に始まる）。
   * 途中から入っても、その時刻の位置から流れる
   */
  async startOnline(course: Course, info: { title: string; course: string; level: number; genre?: string }, zeroPerf: number, hooks: OnlineHooks) {
    this.online = hooks;
    this.outbox = [];
    this.tapbox = [];
    this.lastSent = 0;
    this.lastSentKey = '';
    this.calibrating = false;
    this.lastArgs = null;
    this.hidePause();
    const game = new Game(course.notes);
    const index = new Map(game.states.map((st, i) => [st.note, i]));
    const CODE = { good: 0, ok: 1, bad: 2 } as const;
    game.onJudge = (e) => {
      this.renderer.pushJudge(e);
      const i = index.get(e.note);
      // 判定した時刻（叩いた時刻。見逃しは判定が終わった時刻）もいっしょに送る（相手の画面で、音符とずれずに出す）
      if (i !== undefined) this.outbox.push([i, CODE[e.judge], Math.round((e.note.time + e.delta) * 1000)]);
    };
    game.onRoll = (st) => this.renderer.pushRoll(st);
    this.renderer.reset();
    this.renderer.spectate = !!hooks.spectate;
    this.renderer.setOpponents(hooks.opponents);
    this.renderer.donWidth = this.settings.donWidth ?? 0.6;
    this.applyInputMode();
    this.input.refresh();
    resetTouchStats();
    this.raw = [];
    this.game = game;
    this.root.classList.remove('hidden');
    this.root.classList.add('online');
    document.body.classList.add('playing');
    this.result.classList.add('hidden');
    this.stopVideo();
    this.applyVideo(false);
    this.renderer.resize();
    this.placeVideo();
    this.renderer.speed = this.settings.speed;
    this.active = true;
    postNative({ type: 'play', active: true });
    // 先に音を出せる状態にしてから位置を決める（待った時間のぶん、ほかの人より遅れて始まらないように）
    await this.audio.resume();
    // 音が出るまでの 30ms を足して、今の再生位置から始める
    const pos = (performance.now() + 30 - zeroPerf) / 1000;
    await this.audio.startAt(pos, 1);
    const lastTime = Math.max(0, ...course.notes.map((n) => n.endTime ?? n.time));
    const music = this.audio.musicDuration;
    const endAt = music > 0 ? Math.max(music + 1, lastTime + 1.5) : lastTime + 2;
    this.autoEvents = [];
    this.autoIdx = 0;
    this.soundIdx = 0;
    this.perf = { frames: 0, work: 0, workMax: 0, gapMax: 0, slow: 0, last: 0 };
    (window as unknown as { __playPerf?: unknown }).__playPerf = this.perf;
    // 終わりの帯は、音源と譜面がどちらも終わってから
    this.cur = { course, info, endAt, clicks: [], lastNote: Math.max(lastTime, music > 0 ? music : 0) };
    this.endWall = 0;
    this.timeFloor = -Infinity;
    this.runLoop();
  }

  /**
   * オンライン: 自分の様子を送る（毎フレーム呼ぶ）。判定・入力があれば 25ms ごと（1 秒に 40 回まで）にまとめて、
   * 点数などの変化だけなら 50ms ごと。送りすぎてサーバーに捨てられないよう、1 回にまとめる
   */
  private sendOnline(game: Game, force = false) {
    const o = this.online;
    if (!o) return;
    const t = performance.now();
    const has = this.outbox.length > 0 || this.tapbox.length > 0;
    if (!force && t - this.lastSent < (has ? 15 : 50)) return;
    const st = game.stats;
    const key = `${st.score}|${st.combo}|${Math.round(st.gauge)}`;
    if (!force && !has && key === this.lastSentKey && t - this.lastSent < 2000) return;
    this.lastSent = t;
    this.lastSentKey = key;
    o.send({ t: 'st', s: st.score, c: st.combo, g: Math.round(st.gauge * 10) / 10, j: this.outbox.splice(0, 300), h: this.tapbox.splice(0, 120) });
  }

  /** オンライン: 叩いた入力を送る準備（何もない所を叩いたものも） */
  private pushTap(kind: 'don' | 'ka', side: 'L' | 'R', t: number) {
    if (!this.online || this.spectating) return;
    this.tapbox.push([Math.round(t * 1000), (kind === 'ka' ? 2 : 0) + (side === 'R' ? 1 : 0)]);
    if (this.tapbox.length > 400) this.tapbox.shift();
  }

  /** オンライン: 途中でやめる */
  quitOnline() {
    const o = this.online;
    if (!o) return;
    this.online = null;
    this.hidePause();
    this.active = false;
    postNative({ type: 'play', active: false });
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    this.renderer.spectate = false;
    this.renderer.setOpponents([]);
    this.leaveScreen();
    o.onQuit();
  }

  /** プレイ画面を閉じる（結果画面は出さない） */
  private leaveScreen() {
    this.stopVideo();
    this.root.classList.add('hidden');
    this.root.classList.remove('online');
    document.body.classList.remove('playing');
    this.result.classList.add('hidden');
  }

  /** プレイで打音を鳴らすか */
  private get hitOn() {
    return (this.settings.hitMode ?? 'on') === 'on' && this.settings.hitSound !== false;
  }

  get isActive() {
    return this.active;
  }

  private time(perfMs = performance.now()) {
    return this.audio.now(perfMs) - this.settings.offset / 1000;
  }

  /** タイミング調整の測定中か */
  private calibrating = false;

  /**
   * タイミング調整: 0.6 秒おきのドンに合わせてクリック音を鳴らし、叩いたずれを測る。
   * 音符の間隔が広いので、端末の音の遅れが ±300ms あっても別の音符と取り違えずに測れる。
   */
  async startCalibration() {
    const N = 24;
    const notes = Array.from({ length: N }, (_, i) => ({
      type: 'don' as const, time: 1 + i * 0.6, bpm: 100, scroll: 1, gogo: false,
    }));
    const bars = Array.from({ length: Math.ceil(N / 4) + 1 }, (_, i) => ({ time: 1 + i * 2.4, bpm: 100, scroll: 1 }));
    this.calibrating = true;
    await this.start(
      { name: 'Oni', level: 0, notes, bars, gogo: [] },
      1,
      { title: 'タイミング調整', course: 'Oni', level: 0 },
      notes.map((n) => n.time),
    );
  }

  /** fromTime 秒の位置から（2秒前から助走して）開始。clicks を渡すとその時刻にクリック音を鳴らす */
  async start(course: Course, fromTime: number, info: { title: string; course: string; level: number; genre?: string }, clicks?: number[]) {
    this.lastArgs = [course, fromTime, info, clicks];
    if (!clicks) this.calibrating = false;
    this.hidePause();
    // fromTime が 0 以下なら曲の最初から（最初の音符が 1 秒より前なら、その 1 秒前から）
    const first = (course.notes[0]?.time ?? 0) - 1;
    const from = fromTime <= 0 ? Math.min(0, first) : Math.max(fromTime, first);
    const notes = course.notes.filter((n) => (n.endTime ?? n.time) >= from - 0.05);
    // 判定・点数・ゲージは譜面全体で数える。途中から始めたときは、そこまでをオートで叩いた状態にしておく
    // （最初から通したときと、最後のコンボ数・点数・ゲージが一致する）
    const game = new Game(course.notes);
    const split = from - 0.05;
    const allAuto = buildAutoEvents(course.notes);
    for (const e of allAuto) {
      if (e.t >= split) break;
      game.update(e.t);
      game.hit(e.kind, e.t);
    }
    game.update(split);
    game.onJudge = (e) => this.renderer.pushJudge(e);
    game.onRoll = (st) => this.renderer.pushRoll(st);
    this.renderer.reset();
    this.renderer.donWidth = this.settings.donWidth ?? 0.6;
    // 合作の見比べ: ほかのレーンを下に並べる（タイミング調整のときは出さない）
    const cmp = !this.calibrating && this.compare.length > 0;
    this.renderer.setOpponents(cmp ? this.compare.map((c) => c.o) : []);
    if (cmp) this.resetCompare(from - 2);
    this.applyInputMode();
    this.input.refresh();
    resetTouchStats();
    this.raw = [];
    this.game = game;

    this.root.classList.remove('hidden');
    // プレイ中は後ろのエディタを描かない・重ねて表示しない（プレイ画面に全部の力を使う）
    document.body.classList.add('playing');
    this.result.classList.add('hidden');
    this.stopVideo();
    this.applyVideo(false);
    this.renderer.resize();
    this.placeVideo();
    this.renderer.speed = this.settings.speed;
    this.active = true;
    postNative({ type: 'play', active: true });
    await this.audio.startAt(from - 2, 1);
    for (const t of clicks ?? []) this.audio.scheduleTick(t);

    const lastTime = Math.max(from, ...notes.map((n) => n.endTime ?? n.time));
    // 音源があるときは、音源が完全に終わってから 1 秒後に終える。ないときは最後の音符の 2 秒後
    const music = this.audio.musicDuration;
    const endAt = music > 0 && !this.calibrating ? Math.max(music + 1, lastTime + 1.5) : lastTime + 2;

    this.autoEvents = allAuto.filter((e) => e.t >= split);
    this.autoIdx = 0;
    this.soundIdx = 0;
    this.perf = { frames: 0, work: 0, workMax: 0, gapMax: 0, slow: 0, last: 0 };
    // 終わりの帯は、音源と譜面がどちらも終わってから
    this.cur = { course, info, endAt, clicks: clicks ?? [], lastNote: Math.max(lastTime, music > 0 && !this.calibrating ? music : 0) };
    this.endWall = 0;
    this.timeFloor = -Infinity;
    this.runLoop();
  }

  /** 今のプレイの内容（ポーズから続けるときに使う） */
  private cur: { course: Course; info: { title: string; course: string; level: number; genre?: string }; endAt: number; clicks: number[]; /** 音源と譜面の、遅いほうの終わり（秒） */ lastNote?: number } | null = null;
  /** 曲の終わりの帯を出した時刻（performance.now()。0 = まだ） */
  private endWall = 0;
  private endHold = 3000;
  private paused = false;
  private pausedAt = 0;
  private timeFloor = -Infinity;

  /** 続けて起きたエラーの数 */
  private loopErrors = 0;
  /** エラーを知らせる（画面の下に出す） */
  onError: (msg: string) => void = () => {};

  private runLoop() {
    this.loopErrors = 0;
    const game = this.game!;
    const { course, info, endAt } = this.cur!;
    cancelAnimationFrame(this.raf);
    this.perf.last = 0;
    const loop = () => {
      // 描くところなどで失敗しても、画面が止まったままにならないようにする（オンラインは結果へ進める）
      try {
        step();
      } catch (err) {
        console.error(err);
        this.loopErrors++;
        if (this.loopErrors === 1) this.onError(`プレイ中にエラー: ${(err as Error)?.message ?? err}`);
        if (this.loopErrors > 30 || this.online) { this.finish(); return; }
        this.raf = requestAnimationFrame(loop);
      }
    };
    const step = () => {
      if (!this.active || this.paused) return;
      const t0 = performance.now();
      const P = this.perf;
      if (P.last) {
        const gap = t0 - P.last;
        if (gap > P.gapMax) P.gapMax = gap;
        if (gap > 34) P.slow++;
      }
      P.last = t0;
      // 続けた直後は音が出るまで時計が少し戻ることがあるので、止めた時刻より前には戻さない
      const now = Math.max(this.time(), this.timeFloor);
      this.syncVideo();
      if (this.auto && !this.calibrating) {
        this.scheduleSounds(now);
        this.autoPlay(game, now);
      }
      game.update(now);
      if (this.compare.length && !this.online && !this.calibrating) this.stepCompare(now);
      if (this.online && !this.spectating) this.sendOnline(game);
      this.renderer.draw(game, course, now, info);
      const w = performance.now() - t0;
      P.frames++;
      P.work += w;
      if (w > P.workMax) P.workMax = w;
      // 最後の音符が終わったら、クリア・フルコンボなどの帯を出し、少し見せてから結果へ
      if (!this.calibrating && !this.spectating && !this.endWall && now > (this.cur?.lastNote ?? Infinity) + 0.4) {
        this.endWall = performance.now();
        const st = game.stats;
        const fc = st.bad === 0 && game.totalHitNotes > 0;
        this.endHold = this.renderer.showEnd(fc && st.ok === 0 ? 'allgood' : fc ? 'fc' : st.gauge >= CLEAR_LINE ? 'clear' : 'fail');
      }
      // 帯を出したら、曲が終わっても帯を見せきってから結果へ
      if (this.endWall ? performance.now() - this.endWall > this.endHold : now > endAt) {
        this.finish();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** オート・太鼓の表示・指置きを、設定に合わせる（描き直しが要るときは true） */
  private applyInputMode() {
    // Expo Go のアプリの中ではアプリが指を受け取るので、指置きはいらない（Safari などでは設定のとおり）
    const coarse = isNativeHost() || matchMedia('(pointer: coarse)').matches;
    const restZone = !isNativeHost() && coarse && !!this.settings.restZone && !this.auto && !this.spectating;
    // オートのときは叩かないので、タッチ用の太鼓も出さない
    const touch = coarse && !this.auto && !this.spectating;
    const padVisible = this.settings.padVisible !== false;
    this.root.classList.toggle('no-pause-btn', this.settings.pauseButton === false);
    const R = this.renderer;
    const changed = R.restZone !== restZone || R.touch !== touch || R.padVisible !== padVisible;
    R.restZone = restZone;
    R.touch = touch;
    R.padVisible = padVisible;
    return changed;
  }

  /** ポーズ画面の「プレイ / オート」の表示 */
  private paintPauseMode() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-pmode]').forEach((b) => {
      const on = (b.dataset.pmode === 'auto') === !!this.settings.auto;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  /** ポーズ画面で、プレイ（自分で叩く）とオートを切り替える。続けたところから切り替わる */
  setAuto(auto: boolean) {
    if (!!this.settings.auto === auto) return;
    this.settings.auto = auto;
    this.onSettingsChange();
    if (this.applyInputMode()) this.renderer.resize();
    this.paintPauseMode();
  }

  /** 前に始めた所から、もう一度始める */
  async retry() {
    if (!this.lastArgs) return;
    const [c, from, info, clicks] = this.lastArgs;
    if (clicks) this.calibrating = true;
    await this.start(c, from, info, clicks);
  }

  /** 設定（ハイスピード・ドンの幅・太鼓の表示など）を今のプレイに反映する */
  applySettings() {
    const R = this.renderer;
    R.speed = this.settings.speed;
    R.donWidth = this.settings.donWidth ?? 0.6;
    this.applyInputMode();
    this.applyVideo(false);
    R.resize();
    this.placeVideo();
  }

  // ---------- 背景の動画 ----------

  private video: HTMLVideoElement | null = null;
  private vdim: HTMLElement | null = null;
  private videoUrl = '';
  private videoOffset = 0;
  private videoCheck = 0;

  /** 背景の動画を決める（null で無し）。offset = 動画のずれ（秒。+ で動画を先へ） */
  setVideo(src: Blob | null, offset = 0) {
    this.videoOffset = offset;
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = '';
    if (!src) {
      if (this.video) {
        this.video.pause();
        this.video.removeAttribute('src');
        this.video.load();
      }
    } else {
      if (!this.video) {
        const v = document.createElement('video');
        v.className = 'play-video';
        v.muted = true;
        v.playsInline = true;
        v.setAttribute('playsinline', '');
        v.setAttribute('aria-hidden', 'true');
        v.preload = 'auto';
        // 暗くするのは動画のフィルターではなく、上に重ねた黒い板で（iPhone ではフィルターが重い）
        const dim = document.createElement('div');
        dim.className = 'play-vdim';
        this.root.prepend(dim);
        this.root.prepend(v);
        this.video = v;
        this.vdim = dim;
        // コマが出るたびに、その位置と時刻を覚える（ずれを正確に測るため）
        type RVFC = (cb: (now: number, m: { mediaTime: number }) => void) => number;
        const rvfc = (v as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(v);
        if (rvfc) {
          const onFrame = (_n: number, m: { mediaTime: number }) => {
            this.vFrame = { media: m.mediaTime, at: performance.now() };
            rvfc(onFrame);
          };
          rvfc(onFrame);
        }
      }
      this.vFrame = null;
      this.vPrimed = false;
      this.videoUrl = URL.createObjectURL(src);
      this.video.src = this.videoUrl;
    }
    if (this.active) this.applySettings();
  }

  setVideoOffset(sec: number) {
    this.videoOffset = sec;
  }

  /** 今の動画の出し方（'' = 出さない） */
  private get videoMode(): '' | 'full' | 'top' {
    const m = this.settings.videoMode ?? 'full';
    return this.videoUrl && m !== 'off' && !this.calibrating ? m : '';
  }

  /** 動画の出し方を背景・動画の要素に反映する（resize = 背景を描き直す） */
  private applyVideo(resize = true) {
    const mode = this.videoMode;
    const R = this.renderer;
    const v = this.video;
    if (v) {
      v.classList.toggle('hidden', !mode);
      this.vdim?.classList.toggle('hidden', !mode);
      if (this.vdim) this.vdim.style.opacity = String(1 - Math.max(0.1, Math.min(1, this.settings.videoDim ?? 0.5)));
      if (!mode) v.pause();
    }
    if (R.videoMode !== mode) {
      R.videoMode = mode;
      if (resize) R.resize();
    }
    this.placeVideo();
  }

  /**
   * 動画を置く。上だけに出すときは、レーンより上の範囲に置く。
   * 16:9 のときは、その範囲の縦をいっぱいに使う 16:9 の枠を真ん中に置き（左右は黒帯）、動画は枠に合わせて切り抜く
   */
  private placeVideo() {
    const v = this.video;
    if (!v) return;
    const t = this.videoMode === 'top' ? this.renderer.layout?.top : null;
    let r = t ? { x: t.x, y: t.y, w: t.w, h: t.h } : { x: 0, y: 0, w: this.root.clientWidth, h: this.root.clientHeight };
    if ((this.settings.videoFit ?? 'wide') === 'wide' && r.w > 0 && r.h > 0) {
      let h = r.h;
      let w = (h * 16) / 9;
      // 縦長の画面では横をいっぱいにして、上下を黒帯にする
      if (w > r.w) {
        w = r.w;
        h = (w * 9) / 16;
      }
      r = { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
    }
    for (const el of [v, this.vdim]) {
      if (!el) continue;
      Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    }
  }

  /** 動画が最後にコマを出したときの位置（requestVideoFrameCallback。currentTime より正確） */
  private vFrame: { media: number; at: number } | null = null;
  /** 曲の前に、動画を最初のコマまで用意したか */
  private vPrimed = false;
  /** 大きくずれ始めた時刻（0 = ずれていない） */
  private vDriftSince = 0;

  /** 今の動画の位置（秒）の見積もり */
  private videoPos(v: HTMLVideoElement) {
    const f = this.vFrame;
    if (f && !v.paused) return f.media + (performance.now() - f.at) / 1000;
    return v.currentTime;
  }

  /**
   * 動画を曲に合わせる。iPhone では速さを変えたり位置を飛ばしたりすると止まりやすいので、
   * 最初に合わせたあとは、大きなずれ（0.4 秒）が 1 秒続いたときだけ位置を合わせ直す
   */
  private syncVideo() {
    const v = this.video;
    if (!v || !this.videoMode) return;
    const t = this.audio.now() + this.videoOffset;
    const dur = Number.isFinite(v.duration) ? v.duration : Infinity;
    if (t >= dur) {
      if (!v.paused) v.pause();
      return;
    }
    const wall = performance.now();
    if (t < 0) {
      // 曲が始まる前: 最初のコマまで用意しておき、再生にかかる時間のぶん少し早めに流し始める
      if (!this.vPrimed && v.readyState >= 1) {
        this.vPrimed = true;
        try { v.currentTime = Math.max(0, t); } catch { /* まだ読み込み中 */ }
      }
      if (t >= -0.08 && v.paused) void v.play().catch(() => {});
      else if (t < -0.2 && !v.paused) v.pause();
      return;
    }
    if (v.paused) {
      // 止まっていた（ポーズから戻った・途中から）: 位置を合わせてから流す
      if (wall < this.videoCheck) return;
      this.videoCheck = wall + 400;
      if (Math.abs(v.currentTime - t) > 0.15) { try { v.currentTime = t; } catch { /* まだ読み込み中 */ } }
      if (v.playbackRate !== 1) v.playbackRate = 1;
      void v.play().catch(() => {});
      return;
    }
    if (wall < this.videoCheck) return;
    const d = this.videoPos(v) - t;
    if (Math.abs(d) <= 0.4) { this.vDriftSince = 0; return; }
    if (!this.vDriftSince) { this.vDriftSince = wall; return; }
    if (wall - this.vDriftSince < 1000) return;
    // 1 秒続けてずれている: 位置を合わせ直す（飛んだ先で動き出すまでの分だけ先へ）
    this.vDriftSince = 0;
    this.videoCheck = wall + 1500;
    try { v.currentTime = t + 0.1; } catch { /* まだ読み込み中 */ }
  }

  private stopVideo() {
    this.video?.pause();
    this.videoCheck = 0;
    this.vPrimed = false;
    this.vDriftSince = 0;
  }

  /** ポーズ（曲を止めて、ポーズのメニューを出す） */
  pause() {
    if (!this.active || this.paused) return;
    if (this.online) {
      // オンライン対戦は止められない（メニューだけ出す。曲は流れ続ける）
      this.onPauseOpen();
      this.root.querySelector('#pauseMenu')?.classList.remove('hidden');
      // メニューの間は、アプリ（Expo Go）が指を横取りしないようにする（スライダーなどを触れるように）
      postNative({ type: 'play', active: false });
      return;
    }
    this.paused = true;
    this.stopVideo();
    this.pausedAt = this.audio.now();
    this.timeFloor = this.time();
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    // メニューの間は、アプリ（Expo Go）が指を横取りしないようにする（スライダー・数字の欄・スイッチを触れるように）
    postNative({ type: 'play', active: false });
    this.onPauseOpen();
    this.paintPauseMode();
    this.root.querySelector('#pauseMenu')?.classList.remove('hidden');
  }

  /** 止めた所から続ける */
  async resume() {
    if (this.online) {
      this.hidePause();
      return;
    }
    if (!this.active || !this.paused || !this.cur) return;
    this.hidePause();
    const at = this.pausedAt;
    await this.audio.startAt(at, 1);
    for (const t of this.cur.clicks) if (t > at) this.audio.scheduleTick(t);
    // 止めたときに予約して鳴らなかった打音を、もう一度予約し直す
    this.soundIdx = this.autoEvents.findIndex((e) => e.t >= at);
    if (this.soundIdx < 0) this.soundIdx = this.autoEvents.length;
    for (const c of this.compare) {
      c.sidx = c.ev.findIndex((e) => e.t >= at);
      if (c.sidx < 0) c.sidx = c.ev.length;
    }
    // ポーズ中にオートへ切り替えたときは、止めた所から自動で叩く（それより前は叩かない）
    this.autoIdx = this.soundIdx;
    this.runLoop();
  }

  private hidePause() {
    const wasOpen = !this.root.querySelector('#pauseMenu')?.classList.contains('hidden');
    this.paused = false;
    this.root.querySelector('#pauseMenu')?.classList.add('hidden');
    // 続けるときは、またアプリが指を受け取る
    if (wasOpen && this.active) postNative({ type: 'play', active: true });
  }

  /** 描画の重さの記録（結果画面の診断用） */
  perf = { frames: 0, work: 0, workMax: 0, gapMax: 0, slow: 0, last: 0 };

  /** オートで叩く予定（時刻順）。音はこの時刻に予約して鳴らす */
  private autoEvents: AutoEvent[] = [];
  /** 合作の見比べテストプレイ: いっしょに流すほかのレーン（オートで叩く。打音は左右に分ける） */
  private compare: { o: Opponent; ev: AutoEvent[]; sidx: number; nidx: number; pan: number }[] = [];
  /** 見比べのときの、自分のレーンの打音の左右 */
  private ownPan = 0;

  /** 見比べのレーンを決める（次の start から。null で外す） */
  setCompare(list: { name: string; course: Course; pan: number }[] | null, ownPan = 0) {
    this.ownPan = list?.length ? ownPan : 0;
    this.compare = (list ?? []).slice(0, 3).map((c, k) => ({
      o: {
        id: `cmp${k}`, name: c.name, tag: '見比べ（オート）', score: 0, combo: 0, gauge: 0, good: 0, ok: 0, bad: 0, marks: new Uint8Array(c.course.notes.length), fx: null, status: '' as const,
        course: c.course.name, lane: { game: new Game(c.course.notes), course: c.course, vis: [], bars: [] },
      },
      ev: buildAutoEvents(c.course.notes), sidx: 0, nidx: 0, pan: c.pan,
    }));
  }

  /** 見比べのレーンをオートで進める（音を予約し、叩いた印を付ける） */
  private stepCompare(now: number) {
    for (const c of this.compare) {
      while (c.sidx < c.ev.length && c.ev[c.sidx].t <= now + 0.3) {
        const e = c.ev[c.sidx++];
        if (!this.hitOn || e.t < now - 0.05) continue;
        this.audio.scheduleHit(e.kind, e.t, c.pan);
        if (e.pop) this.audio.scheduleHit('balloon', e.t, c.pan);
      }
      const notes = c.o.lane!.course.notes;
      while (c.nidx < notes.length && notes[c.nidx].time <= now) {
        const i = c.nidx++;
        const n = notes[i];
        if (n.type === 'roll' || n.type === 'bigRoll' || n.type === 'balloon') continue;
        c.o.marks[i] = 1;
        c.o.good++;
        c.o.combo++;
        c.o.score += 1000;
        c.o.gauge = Math.min(100, c.o.gauge + 100 / Math.max(1, notes.length) * 1.4);
        c.o.fx = { j: 1, t: performance.now(), i };
      }
    }
  }

  /** 見比べのレーンを、from 秒の位置から始める */
  private resetCompare(from: number) {
    for (const c of this.compare) {
      c.sidx = c.ev.findIndex((e) => e.t >= from);
      if (c.sidx < 0) c.sidx = c.ev.length;
      c.nidx = 0;
      c.o.marks.fill(0);
      c.o.good = c.o.ok = c.o.bad = c.o.combo = c.o.score = 0;
      c.o.gauge = 0;
      c.o.fx = null;
      // 始める位置より前は叩いたことにする
      this.stepCompareMarks(c, from);
    }
  }

  private stepCompareMarks(c: PlayMode['compare'][number], until: number) {
    const notes = c.o.lane!.course.notes;
    while (c.nidx < notes.length && notes[c.nidx].time < until) {
      const i = c.nidx++;
      if (notes[i].type === 'roll' || notes[i].type === 'bigRoll' || notes[i].type === 'balloon') continue;
      c.o.marks[i] = 1;
      c.o.good++;
      c.o.combo++;
      c.o.score += 1000;
    }
  }
  private autoIdx = 0;
  private soundIdx = 0;
  private autoSide: 'L' | 'R' = 'L';

  /** これから 0.3 秒以内に鳴る打音を、音符の時刻ちょうどに鳴るよう予約する（叩いた処理の遅れで音がずれない） */
  private scheduleSounds(now: number) {
    const ev = this.autoEvents;
    const on = this.hitOn;
    while (this.soundIdx < ev.length && ev[this.soundIdx].t <= now + 0.3) {
      const e = ev[this.soundIdx++];
      if (!on || e.t < now - 0.05) continue;
      this.audio.scheduleHit(e.kind, e.t, this.ownPan);
      if (e.pop) this.audio.scheduleHit('balloon', e.t, this.ownPan);
    }
  }

  /** 予定の時刻になった打撃を判定に渡す（音は scheduleSounds で予約済み） */
  private autoPlay(game: Game, now: number) {
    const ev = this.autoEvents;
    while (this.autoIdx < ev.length && ev[this.autoIdx].t <= now) {
      const e = ev[this.autoIdx++];
      this.autoSide = this.autoSide === 'L' ? 'R' : 'L';
      this.renderer.pushHit(e.kind, this.autoSide);
      this.pushTap(e.kind, this.autoSide, e.t);
      game.hit(e.kind, e.t);
    }
  }

  finish() {
    if (!this.active) return;
    this.stopVideo();
    this.hidePause();
    this.active = false;
    postNative({ type: 'play', active: false });
    cancelAnimationFrame(this.raf);
    this.audio.stop();
    const g = this.game;
    if (!g) return;
    if (this.online) {
      const o = this.online;
      if (!o.spectate) this.sendOnline(g, true);
      this.online = null;
      this.renderer.spectate = false;
      this.renderer.setOpponents([]);
      this.leaveScreen();
      const s = g.stats;
      // 自分で叩いて最後まで遊んだときは、王冠も渡す（記録に残す）
      const fc = s.bad === 0 && g.totalHitNotes > 0;
      const crown = !o.spectate && !this.auto ? (fc && s.ok === 0 ? 'allgood' : fc ? 'fc' : s.gauge >= CLEAR_LINE ? 'clear' : 'fail') as Crown : undefined;
      o.onFinish({ score: s.score, good: s.good, ok: s.ok, bad: s.bad, maxCombo: s.maxCombo, rolls: s.rolls, crown });
      return;
    }
    if (this.calibrating) {
      this.showCalibration(g);
      return;
    }
    const s = g.stats;
    const total = g.totalHitNotes || 1;
    const acc = ((s.good + s.ok * 0.5) / total) * 100;
    // スコア・良可不可などは結果のカードに出す。ここ（くわしい記録）には調べるための情報だけ
    const rows: [string, string][] = [];
    // 叩いたタイミングのずれ（オートのときは出さない）。
    // 判定幅の外だった打撃も含めて中央値を取るので、端末の音の遅れが 114ms より大きくても調整できる
    const calib = this.result.querySelector<HTMLElement>('.calib')!;
    calib.classList.add('hidden');
    if (!this.auto) {
      const T = g.taps;
      const all = [...g.deltas, ...g.outside].sort((a, b) => a - b);
      rows.push(['叩いた回数', `${T.total}（判定 ${T.judged}・連打 ${T.roll + T.big}）`]);
      if (T.none > 0) {
        const out = g.outside;
        const outMean = out.length ? Math.round((out.reduce((a, b) => a + b, 0) / out.length) * 1000) : 0;
        const parts = [];
        if (out.length) parts.push(`判定幅の外 ${out.length}（平均 ${outMean > 0 ? '+' : ''}${outMean}ms）`);
        if (T.wrongColor) parts.push(`色違い ${T.wrongColor}`);
        const rest = T.none - out.length - T.wrongColor;
        if (rest > 0) parts.push(`近くに音符なし ${rest}`);
        rows.push(['判定されなかった', `${T.none}：${parts.join('・')}`]);
      }
      if (all.length >= 8) {
        const med = all[Math.floor(all.length / 2)];
        const mean = g.deltas.length ? g.deltas.reduce((a, b) => a + b, 0) / g.deltas.length : med;
        const sd = g.deltas.length
          ? Math.sqrt(g.deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / g.deltas.length)
          : 0;
        const ms = Math.round(med * 1000);
        rows.push(['ずれ', `${ms > 0 ? '+' : ''}${ms}ms（${Math.abs(ms) <= 5 ? 'ちょうど' : ms > 0 ? '遅め' : '早め'}）`]);
        if (g.deltas.length) rows.push(['ばらつき', `±${Math.round(sd * 1000)}ms`]);
        this.suggested = Math.round(this.settings.offset + med * 1000);
        if (Math.abs(ms) > 5) {
          calib.classList.remove('hidden');
          calib.querySelector('button')!.textContent = `判定調整を ${this.suggested}ms にする（今は ${this.settings.offset}ms）`;
        }
      }
    }
    // 見逃しの内訳（その音符の前後 114ms に何が起きていたか）
    if (!this.auto) {
      const taps = g.log.filter((x) => x.e === 'tap') as Extract<typeof g.log[number], { e: 'tap' }>[];
      const misses = g.log.filter((x) => x.e === 'miss') as Extract<typeof g.log[number], { e: 'miss' }>[];
      if (misses.length) {
        let wrong = 0;
        let stolen = 0;
        let none = 0;
        const rings: number[] = [];
        for (const m of misses) {
          const isDonNote = m.type === 'don' || m.type === 'bigDon';
          const near = taps.filter((t) => Math.abs(t.t - m.t) <= 0.114);
          const other = near.find((t) => (t.kind === 'don') !== isDonNote);
          const same = near.find((t) => (t.kind === 'don') === isDonNote);
          if (other) {
            wrong++;
            if (other.ring !== undefined) rings.push(other.ring);
          } else if (same) stolen++;
          else none++;
        }
        const parts = [];
        if (wrong) {
          const avg = rings.length ? `、ドンの帯の端からの位置 平均 ${(rings.reduce((a, b) => a + b, 0) / rings.length).toFixed(2)}` : '';
          parts.push(`色違いで叩いた ${wrong}${avg}`);
        }
        if (stolen) parts.push(`同じ色で叩いたが別の音符に使われた ${stolen}`);
        if (none) parts.push(`近くで叩いていない ${none}`);
        rows.push(['見逃し', `${misses.length}：${parts.join('・')}`]);
      }
    }
    // 不具合を調べるための情報
    const c = this.audio.clockInfo();
    rows.push([
      '音の遅れ',
      `${c.latencyMs}ms（${c.mode === 'outputTimestamp' ? '再生位置から' : '端末の申告値'}、申告 ${c.outputLatencyMs}/${c.baseLatencyMs}ms）`,
    ]);
    const S = touchStats;
    if (S.starts + S.recovered + S.pointers + S.native > 0) {
      rows.push([
        'タッチ',
        `${isNativeHost() ? `アプリ方式 ${S.native}・` : ''}${this.settings.pointerInput ? 'ポインター方式' : 'タッチ方式'}／touchstart ${S.starts}・pointerdown ${S.pointers}・補った ${S.recovered}・瞬間移動 ${S.jumps}・指置き ${S.rests}・取り消し ${S.cancels}/${S.pointerCancels}・同時に触れた指 最大 ${S.maxFingers}本`,
      ]);
    }
    const P = this.perf;
    if (P.frames) {
      rows.push([
        '描画',
        `1コマ平均 ${(P.work / P.frames).toFixed(1)}ms・最大 ${P.workMax.toFixed(0)}ms／コマ落ち ${P.slow}回（最長 ${P.gapMax.toFixed(0)}ms）`,
      ]);
    }
    rows.push(['判定調整', `${this.settings.offset}ms`]);
    rows.push(['バージョン', BUILD_ID.slice(0, 7)]);
    this.lastLog = this.logText(g);
    // 叩いた位置から、ドンの帯のちょうどいい幅を提案する
    const cur = this.settings.donWidth ?? 0.6;
    const sug = this.auto ? null : suggestDonWidth(zoneSamples(g.log, cur), cur);
    this.suggestedDonWidth = sug ? sug.width : null;
    const hint = this.result.querySelector<HTMLElement>('.edgehint');
    if (hint) {
      hint.classList.toggle('hidden', !sug);
      if (sug) {
        hint.querySelector('button')!.textContent = `ドンの幅を ${Math.round(sug.width * 100)}% にする（今 ${Math.round(cur * 100)}%）`;
      }
    }
    this.result.querySelector('h2')!.textContent = '結果';
    this.result.querySelector('dl')!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.showResultCard(g, acc);
  }

  /** 結果のカード（スコア・良可不可・王冠など）を出して、数を数え上げる */
  private showResultCard(g: Game, acc: number) {
    const R = this.result;
    const s = g.stats;
    const info = this.cur?.info ?? { title: '', course: '', level: 0 };
    const cleared = s.gauge >= CLEAR_LINE;
    const fc = s.bad === 0 && g.totalHitNotes > 0;
    const allGood = fc && s.ok === 0;
    const rank = allGood ? 'allgood' : fc ? 'fc' : cleared ? 'clear' : 'fail';
    const COURSE: Record<string, [string, string]> = {
      Easy: ['かんたん', 'var(--c-easy)'], Normal: ['ふつう', 'var(--c-normal)'], Hard: ['むずかしい', 'var(--c-hard)'], Oni: ['おに', 'var(--c-oni)'], Edit: ['おに（裏）', 'var(--c-edit)'],
    };
    const [cl, cc] = COURSE[info.course] ?? [info.course, 'var(--btn)'];
    R.classList.remove('res-calib', 'go', 'r-allgood', 'r-fc', 'r-clear', 'r-fail');
    R.classList.add(`r-${rank}`);
    if (!this.auto) this.onFinished({ score: s.score, crown: rank });
    R.querySelector('.res-title')!.textContent = info.title;
    R.querySelector('.res-sub')!.textContent = `${cl} ★${info.level}`;
    const badge = R.querySelector<HTMLElement>('.res-course')!;
    badge.textContent = `${cl} ★${info.level}`;
    badge.style.setProperty('--cc', cc);
    // ゲージ: プレイ中と同じく、クリアまでは青・クリアからは黄色（満タンは虹色）
    const gv = Math.max(0, Math.min(100, s.gauge));
    const gi = R.querySelector<HTMLElement>('.res-gauge i')!;
    gi.style.width = `${gv}%`;
    gi.style.backgroundSize = gv > 0 ? `${10000 / gv}% 100%` : '';
    gi.classList.toggle('full', gv >= 100);
    const ge = R.querySelector<HTMLElement>('.res-gauge');
    ge?.style.setProperty('--cl', `${CLEAR_LINE}%`);
    R.querySelector<HTMLElement>('.res-gauge em')!.style.left = `${CLEAR_LINE}%`;
    R.querySelector('.res-acc')!.textContent = `精度 ${acc.toFixed(2)}%`;
    R.querySelector('.res-detail')?.removeAttribute('open');
    const targets: [HTMLElement, number][] = [[R.querySelector<HTMLElement>('#resScore')!, s.score]];
    for (const k of ['good', 'ok', 'bad', 'rolls', 'maxCombo'] as const) targets.push([R.querySelector<HTMLElement>(`[data-c="${k}"]`)!, s[k]]);
    for (const [el] of targets) el.textContent = '0';
    R.classList.remove('hidden');
    this.audio.playUi('result');
    // 数え上げ（0.35 秒後から 0.8 秒かけて）→ 背景が明るくなり、王冠と吹き出しが出る（CSS）
    const t0 = performance.now() + 350;
    const step = () => {
      if (R.classList.contains('hidden')) return;
      const k = Math.max(0, Math.min(1, (performance.now() - t0) / 800));
      const e = 1 - (1 - k) * (1 - k);
      for (const [el, v] of targets) el.textContent = String(Math.round(v * e));
      if (k < 1) requestAnimationFrame(step);
      else R.classList.add('go');
    };
    requestAnimationFrame(step);
  }

  /** 結果画面で提案する判定調整の値（ms） */
  suggested = 0;

  /** 結果画面で提案するドンの帯の幅（提案がなければ null） */
  suggestedDonWidth: number | null = null;

  /** 直前のプレイの記録（「ログをコピー」で使う） */
  lastLog = '';

  /** 届いたタッチイベントそのものの記録（曲の時刻つき） */
  private raw: { t: number; s: string }[] = [];

  private logText(g: Game): string {
    const f = (t: number) => t.toFixed(3);
    const S = touchStats;
    const lines = [
      `version ${BUILD_ID.slice(0, 7)} offset ${this.settings.offset}ms input ${isNativeHost() ? 'native' : this.settings.pointerInput ? 'pointer' : 'touch'}${this.settings.passiveTouch ? '+passive' : ''}${this.settings.restZone ? '+rest' : ''} ua ${navigator.userAgent}`,
      `touchstart ${S.starts} pointerdown ${S.pointers} recovered ${S.recovered} jumps ${S.jumps} rests ${S.rests} native ${S.native} cancel ${S.cancels}/${S.pointerCancels} maxFingers ${S.maxFingers}`,
    ];
    const items: { t: number; s: string }[] = this.raw.map((r) => ({ t: r.t, s: `    ${r.s}` }));
    for (const x of g.log) {
      if (x.e === 'miss') items.push({ t: x.t, s: `MISS ${x.type}` });
      else {
        const j = x.res === 'judged' ? ` ${x.judge} note=${f(x.note!)} (${Math.round((x.t - x.note!) * 1000)}ms)` : ` ${x.res}`;
        items.push({ t: x.t, s: `tap ${x.kind}${j}${x.ring !== undefined ? ` ring=${x.ring.toFixed(2)}` : ''}` });
      }
    }
    // 見逃しは判定した時刻ではなく音符の時刻に置く。同じ時刻なら元の順番のまま
    items.sort((a, b) => a.t - b.t);
    for (const it of items) lines.push(`${f(it.t)} ${it.s}`);
    return lines.join('\n');
  }

  private showCalibration(g: Game) {
    const all = [...g.deltas, ...g.outside].filter((d) => Math.abs(d) < 0.3).sort((a, b) => a - b);
    const calib = this.result.querySelector<HTMLElement>('.calib')!;
    const rows: [string, string][] = [['叩いた回数', `${g.taps.total}（測れた ${all.length}）`]];
    if (all.length >= 8) {
      // 外れ値に強いよう、中央付近の半分の平均を使う
      const q = all.slice(Math.floor(all.length / 4), Math.ceil((all.length * 3) / 4));
      const mid = q.reduce((a, b) => a + b, 0) / q.length;
      const sd = Math.sqrt(all.reduce((a, b) => a + (b - mid) ** 2, 0) / all.length);
      const ms = Math.round(mid * 1000);
      rows.push(['ずれ', `${ms > 0 ? '+' : ''}${ms}ms（${Math.abs(ms) <= 5 ? 'ちょうど' : ms > 0 ? '遅め' : '早め'}）`]);
      rows.push(['ばらつき', `±${Math.round(sd * 1000)}ms`]);
      this.suggested = Math.round(this.settings.offset + mid * 1000);
      calib.classList.remove('hidden');
      calib.querySelector('button')!.textContent = `判定調整を ${this.suggested}ms にする（今は ${this.settings.offset}ms）`;
    } else {
      rows.push(['結果', '測れた打撃が少ないので、もう一度試してください']);
      calib.classList.add('hidden');
    }
    const c = this.audio.clockInfo();
    rows.push(['音の遅れ', `${c.latencyMs}ms`]);
    rows.push(['バージョン', BUILD_ID.slice(0, 7)]);
    this.result.classList.remove('go', 'r-allgood', 'r-fc', 'r-clear', 'r-fail');
    this.result.classList.add('res-calib');
    this.result.querySelector('.res-title')!.textContent = 'タイミング調整';
    this.result.querySelector('.res-sub')!.textContent = '';
    this.result.querySelector('.res-detail')?.setAttribute('open', '');
    this.result.querySelector('h2')!.textContent = 'タイミング調整の結果';
    this.result.querySelector('dl')!.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.result.classList.remove('hidden');
  }

  /** 結果を出さずに止める（途中でやめた） */
  private stopQuietly() {
    this.stopVideo();
    this.hidePause();
    this.active = false;
    postNative({ type: 'play', active: false });
    cancelAnimationFrame(this.raf);
    this.audio.stop();
  }

  /** 「もう一度」で同じモードをやり直す */
  get lastWasCalibration() {
    return this.calibrating;
  }

  close() {
    // 途中でやめたときは結果も記録も出さずに止める（最後まで遊んだときは finish 済み）
    if (this.active && !this.online) this.stopQuietly();
    else this.finish();
    this.root.classList.add('hidden');
    document.body.classList.remove('playing');
    this.result.classList.add('hidden');
    this.onExit();
  }
}

import type { HitKind } from './engine/game';
import { localPoint } from './orient';

/** at = 叩いた瞬間（performance.now() 基準の ms）、pt = タッチした場所（キーボードのときはなし） */
export type HitHandler = (kind: HitKind, side: 'L' | 'R', at: number, pt?: { x: number; y: number; ring: number }) => void;

/** イベントの timeStamp を performance.now() 基準の時刻として使う（古いブラウザの別基準の値は捨てる） */
function eventTime(ts: number): number {
  const now = performance.now();
  // 指を置いたまま叩くと、iPhone が古い時刻（置いた指の時刻など）を付けてくることがあるので、
  // 今より 60ms 以上前の時刻は信用せず、受け取った時刻を使う
  return ts > 0 && ts <= now + 5 && now - ts < 60 ? ts : now;
}

/** 記録用: イベントの時刻が受け取った時刻よりどれだけ前か（ms） */
const lag = (ts: number) => Math.round(performance.now() - ts);

/** キー割り当て（KeyboardEvent.code） */
export const DEFAULT_KEYS: Record<string, { kind: HitKind; side: 'L' | 'R' }> = {
  KeyD: { kind: 'ka', side: 'L' },
  KeyF: { kind: 'don', side: 'L' },
  KeyJ: { kind: 'don', side: 'R' },
  KeyK: { kind: 'ka', side: 'R' },
};

/** タッチ入力の集計（結果画面の診断用） */
export const touchStats = {
  starts: 0,
  recovered: 0,
  /** iPhone がタッチを途中で取り消した回数（ジェスチャーとして横取りされた） */
  cancels: 0,
  /** ポインターイベント（指）で届いた数 */
  pointers: 0,
  /** ポインターイベントの取り消し */
  pointerCancels: 0,
  /** 同時に触れていた指の最大数 */
  maxFingers: 0,
  /** 指が瞬間移動した（別の指の打撃とみなした）回数 */
  jumps: 0,
  /** 指置きの場所に触れた回数 */
  rests: 0,
  /** Expo Go のアプリ側から届いたタッチ */
  native: 0,
};

export function resetTouchStats() {
  for (const k of Object.keys(touchStats) as (keyof typeof touchStats)[]) touchStats[k] = 0;
}

/**
 * キーボードとタッチ（ポインタ）入力。
 * タッチは画面の横の位置で ドン（中央の帯）/ カッ（左右の端）を判定する。
 *
 * iPhone の Safari では、片方の指がまだ画面に触れている間に別の指で叩くと、
 * その指の touchstart が届かないことがある（2 本指のジェスチャーとして扱われる・他のイベントにまとめられる）。
 * そこで、どのタッチイベントでも「まだ見ていない指」が含まれていたら、その指が叩いたものとして扱う。
 */
export function bindInput(
  root: HTMLElement,
  canvas: HTMLCanvasElement,
  getDrum: () => { x: number; half: number; y: number; ry: number; restBottom?: number; pause?: { bottom: number; half: number; go: () => void } },
  onHit: HitHandler,
  /** true のときは指のタッチをポインターイベントで受け取る（タッチイベントは止めるだけ） */
  usePointer: () => boolean = () => false,
  /** 届いたタッチ・ポインターイベントをそのまま記録する（不具合調査用） */
  onRaw: (line: string, at: number) => void = () => {},
  /** true のときはタッチを passive で受け取る（preventDefault しない） */
  usePassive: () => boolean = () => false,
): { refresh: () => void; dispose: () => void } {
  const pos = (x: number, y: number) => {
    const p = localPoint({ clientX: x, clientY: y }, canvas);
    const r = canvas.getBoundingClientRect();
    const w = Math.max(r.width, r.height) || 1;
    return `${(p.x / w).toFixed(2)},${(p.y / w).toFixed(2)}`;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.repeat) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    const k = DEFAULT_KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    onHit(k.kind, k.side, eventTime(e.timeStamp));
  };

  const hitAt = (clientX: number, clientY: number, at: number) => {
    const { x: px, y: py } = localPoint({ clientX, clientY }, canvas);
    const d = getDrum();
    // ポーズボタンを出さないとき: 上の真ん中に触れたらポーズ
    if (d.pause && py < d.pause.bottom && Math.abs(px - d.x) < d.pause.half) {
      d.pause.go();
      return;
    }
    // 指置きの場所は叩いても反応しない（指を 1 本置いておくと iPhone の取りこぼしが起きにくい）
    if (d.restBottom && py < d.restBottom) {
      touchStats.rests++;
      return;
    }
    // 画面のどこを叩いても反応する（画面の端まで）。太鼓の面（楕円）の中＝ドン、それ以外（縁・面の上・左右の端）＝カッ
    // ring = 面の中心からの楕円の距離（1 が面と縁の境目）
    const side = px < d.x ? 'L' : 'R';
    const ring = Math.hypot((px - d.x) / Math.max(1, d.half), (py - d.y) / Math.max(1, d.ry));
    onHit(ring <= 1 ? 'don' : 'ka', side, at, { x: px, y: py, ring });
  };

  /** いま画面に触れている（叩いたとして処理済みの）指 */
  let seen = new Set<number>();
  /** 指ごとの最後の位置（画面の長辺に対する割合） */
  const lastPos = new Map<number, { x: number; y: number }>();
  /**
   * 両手で交互に叩くと、片方の指が離れるのとほぼ同時にもう片方の指が触れたとき、
   * iPhone が「同じ指が瞬間移動した」と判断して、新しい指の touchstart を出さずに
   * touchmove だけを送ってくることがある。指が一度に大きく動いたら新しい打撃とみなす。
   */
  const JUMP = 0.08;
  const unit = () => {
    const r = canvas.getBoundingClientRect();
    return Math.max(r.width, r.height) || 1;
  };
  const jumped = (id: number, x: number, y: number) => {
    const u = unit();
    const prev = lastPos.get(id);
    lastPos.set(id, { x: x / u, y: y / u });
    if (!prev) return false;
    return Math.hypot(x / u - prev.x, y / u - prev.y) > JUMP;
  };

  const onTouch = (e: TouchEvent) => {
    // 終了ボタンなどのボタンはふつうに押せるようにする
    if (e.target instanceof Element && e.target.closest('button, .pause-menu')) return;
    if (e.cancelable && !attached) e.preventDefault();
    if (e.type === 'touchcancel') touchStats.cancels++;
    const raw = (list: Touch[]) =>
      onRaw(
        `${e.type.replace('touch', 't-')} [${list.map((t) => `${t.identifier % 1000}@${pos(t.clientX, t.clientY)}`).join(' ')}] down=${e.touches.length} lag=${lag(e.timeStamp)}`,
        eventTime(e.timeStamp),
      );
    // touchmove は数が多いので、新しい打撃とみなしたときだけ記録する
    if (e.type !== 'touchmove') raw(Array.from(e.changedTouches));
    touchStats.maxFingers = Math.max(touchStats.maxFingers, e.touches.length);
    if (usePointer()) {
      seen = new Set(Array.from(e.touches).map((t) => t.identifier));
      return;
    }
    const at = eventTime(e.timeStamp);
    const fresh: Touch[] = [];
    if (e.type === 'touchstart') {
      for (const t of Array.from(e.changedTouches)) {
        fresh.push(t);
        lastPos.delete(t.identifier);
        jumped(t.identifier, t.clientX, t.clientY);
      }
      touchStats.starts += fresh.length;
    } else if (e.type === 'touchmove') {
      // touchstart が届かなかった指が、ほかの指の touchmove に混ざって現れることがある
      for (const t of Array.from(e.touches)) {
        const jump = jumped(t.identifier, t.clientX, t.clientY);
        if (!seen.has(t.identifier) || jump) {
          fresh.push(t);
          if (jump) touchStats.jumps++;
          else touchStats.recovered++;
        }
      }
    } else {
      // touchstart も touchmove も届かずに離れた指
      for (const t of Array.from(e.changedTouches)) if (!seen.has(t.identifier)) fresh.push(t);
      touchStats.recovered += fresh.length;
    }
    if (e.type === 'touchmove' && fresh.length) raw(fresh);
    for (const t of fresh) hitAt(t.clientX, t.clientY, at);
    // いま触れている指の一覧に合わせる（離れた指・取りこぼした touchend の指を忘れる）
    seen = new Set(Array.from(e.touches).map((t) => t.identifier));
    for (const id of Array.from(lastPos.keys())) if (!seen.has(id)) lastPos.delete(id);
  };

  const block = (e: Event) => {
    if (e.target instanceof Element && e.target.closest('button, .pause-menu')) return;
    e.preventDefault();
  };

  const onPointer = (e: PointerEvent) => {
    if (e.target instanceof Element && e.target.closest('button, .pause-menu')) return;
    if (e.pointerType === 'touch') {
      touchStats.pointers++;
      onRaw(`p-down ${e.pointerId % 1000}@${pos(e.clientX, e.clientY)} lag=${lag(e.timeStamp)}`, eventTime(e.timeStamp));
      if (!usePointer()) return; // タッチは touch イベント側で処理
    }
    if (!attached) e.preventDefault();
    hitAt(e.clientX, e.clientY, eventTime(e.timeStamp));
  };

  const pjump = new Map<number, { x: number; y: number }>();
  const onPointerDownPos = (e: PointerEvent) => {
    if (e.pointerType === 'touch') pjump.set(e.pointerId, { x: e.clientX / unit(), y: e.clientY / unit() });
  };
  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !usePointer()) return;
    const u = unit();
    const prev = pjump.get(e.pointerId);
    const cur = { x: e.clientX / u, y: e.clientY / u };
    pjump.set(e.pointerId, cur);
    if (prev && Math.hypot(cur.x - prev.x, cur.y - prev.y) > JUMP) {
      touchStats.jumps++;
      onRaw(`p-jump ${e.pointerId % 1000}@${pos(e.clientX, e.clientY)}`, eventTime(e.timeStamp));
      hitAt(e.clientX, e.clientY, eventTime(e.timeStamp));
    }
  };
  const onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    if (e.type === 'pointercancel') touchStats.pointerCancels++;
    onRaw(`${e.type.replace('pointer', 'p-')} ${e.pointerId % 1000}`, eventTime(e.timeStamp));
  };

  /**
   * 登録するイベント。passive のときは preventDefault しない（できない）登録にする。
   * iPhone の Safari は、preventDefault できる登録があると指の動きを 1 つずつページの処理を待ってから進めるので、
   * 指が離れた直後の次の指を取りこぼすことがある。passive にすると待たずに進む（拡大などは CSS の touch-action で止める）。
   */
  const list: [string, EventListener][] = [
    ['touchstart', onTouch as EventListener],
    ['touchmove', onTouch as EventListener],
    ['touchend', onTouch as EventListener],
    ['touchcancel', onTouch as EventListener],
    ['pointerdown', onPointer as EventListener],
    ['pointerdown', onPointerDownPos as EventListener],
    ['pointermove', onPointerMove as EventListener],
    ['pointerup', onPointerCancel as EventListener],
    ['pointercancel', onPointerCancel as EventListener],
  ];
  const gestures = ['gesturestart', 'gesturechange', 'gestureend'];
  let attached: boolean | null = null;
  const detach = () => {
    if (attached === null) return;
    const o = { capture: true };
    for (const [t, f] of list) root.removeEventListener(t, f, o);
    for (const t of gestures) root.removeEventListener(t, block, o);
    attached = null;
  };
  const attach = (passive: boolean) => {
    if (attached === passive) return;
    detach();
    const o = { passive, capture: true };
    for (const [t, f] of list) root.addEventListener(t, f, o);
    // iPhone の Safari: 2 本指のピンチ・回転ジェスチャーを止める（passive のときは CSS に任せる）
    if (!passive) for (const t of gestures) root.addEventListener(t, block, o);
    attached = passive;
  };
  attach(usePassive());

  // Expo Go のアプリ（expo/App.js）の中で動いているとき: プレイ中はアプリが指を受け取ってここへ渡す。
  // x, y は画面に対する割合、ts はアプリ側の時刻（ms）。アプリ側の時刻とこちらの時刻の差の最小値を
  // 「届くまでの遅れがいちばん少なかったとき」とみなして、叩いた瞬間の時刻に直す
  let nativeOffset = Infinity;
  (window as unknown as { __nativeHit?: unknown }).__nativeHit = (nx: number, ny: number, ts?: number, tag?: string, seq?: number) => {
    const now = performance.now();
    const cx = nx * window.innerWidth;
    const cy = ny * window.innerHeight;
    // ボタン（ポーズなど）の上なら押す。ボタンの探索（elementFromPoint）は画面の配置の計算を伴って遅くなることがあるので、
    // ポーズのメニューなどが出ているときと、ボタンの上のときだけにする（ふだんは打音をすぐ鳴らす）
    const overlay = root.querySelector('.pause-menu:not(.hidden)');
    const onButton = Array.from(root.querySelectorAll<HTMLElement>(':scope > button')).some((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
    if (overlay || onButton) {
      const el = document.elementFromPoint(cx, cy);
      const btn = el instanceof Element ? el.closest('button') : null;
      if (btn) {
        btn.click();
        return;
      }
      if (overlay) return;
    }
    let at = now;
    if (typeof ts === 'number' && isFinite(ts)) {
      // アプリ側の時刻の基準が変わった（アプリの再起動など）ときは測り直す
      if (Math.abs(now - ts - nativeOffset) > 1000) nativeOffset = now - ts;
      nativeOffset = Math.min(nativeOffset, now - ts);
      at = Math.min(now, ts + nativeOffset);
    }
    touchStats.native++;
    // 先に叩いた処理（打音）をして、記録は後で
    hitAt(cx, cy, at);
    onRaw(`n-${tag ?? 'start'} #${seq ?? '?'} @${nx.toFixed(2)},${ny.toFixed(2)} lag=${Math.round(now - at)}`, at);
  };
  root.addEventListener('contextmenu', block);
  root.addEventListener('dblclick', block);
  window.addEventListener('keydown', onKey);
  return {
    /** 設定が変わったときに登録し直す */
    refresh: () => attach(usePassive()),
    dispose: () => {
      detach();
      window.removeEventListener('keydown', onKey);
      root.removeEventListener('contextmenu', block);
      root.removeEventListener('dblclick', block);
    },
  };
}

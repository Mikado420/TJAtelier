import { localPoint } from '../orient';

/**
 * FL Studio Mobile のような操作の部品（BPM・OFFSET の画面と、音源カットの画面で使う）。
 *
 * - bindTimeline: 波形の上の指の操作。2 本指でピンチ（横に拡大・縮小）と移動、
 *   vzoom があれば、縦に開く・閉じるピンチで縦に拡大・縮小（波形の高さ）。
 *   マウスのホイールで移動（Ctrl / ⌘ を押しながら、またはトラックパッドのピンチで拡大・縮小、Alt / Shift で縦）。
 *   1 本指は single() が返した操作に任せる（null なら表示する所を動かす）
 * - bindValueBoxes: 値の箱。上下にドラッグで値を変える（上で増える）。‹ › で 1 つずつ、値をタップで入力
 *
 * 画面を回して表示しているとき（縦持ち）も、座標は localPoint で画面の向きに直して使う。
 */

export interface SingleDrag {
  /** 指を動かした（x, y は要素の中の座標。dx は押した所からの横のずれ） */
  move(x: number, y: number, dx: number): void;
  /** 指を離した。moved = 動かしたか（動かしていなければタップ） */
  end(moved: boolean): void;
  /** 2 本目の指が来たなどで取りやめ */
  cancel?(): void;
}

export interface TimelineOpts {
  /** 1 本指で押したとき。null を返すと、ドラッグで表示する所を動かす */
  single(x: number, y: number): SingleDrag | null;
  /** 表示する所を dx px ぶん動かす（右へドラッグ = dx > 0 = 前の時刻が見える） */
  pan(dx: number): void;
  /** x px の所を中心に、表示する長さを k 倍にする（k < 1 で拡大） */
  zoom(k: number, x: number): void;
  /** 縦に k 倍（波形の高さ）。無ければ縦のピンチも横の拡大・縮小になる */
  vzoom?(k: number): void;
  /** 指を全部離したあと（描き直しなど） */
  done?(): void;
}

const TAP_PX = 6;

export function bindTimeline(el: HTMLElement, o: TimelineOpts) {
  const pts = new Map<number, { x: number; y: number }>();
  let single: SingleDrag | null = null;
  let start: { x: number; y: number } | null = null;
  let moved = false;
  let panning = false;
  let lastX = 0;
  let pinch: { d: number; mx: number; dy: number; vertical: boolean } | null = null;

  const pinchInfo = (vertical = false) => {
    const [a, b] = [...pts.values()];
    return { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, dy: Math.max(10, Math.abs(a.y - b.y)), vertical };
  };

  // iPhone の Safari が指の動きをスクロールなどに使って、ドラッグを途中で取り消さないように
  const stop = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
  el.addEventListener('touchstart', stop, { passive: false });
  el.addEventListener('touchmove', stop, { passive: false });
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const p = localPoint(e, el);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      start = p;
      moved = false;
      lastX = p.x;
      single = o.single(p.x, p.y);
      panning = !single;
    } else if (pts.size === 2) {
      // 2 本目: 1 本指の操作をやめて、ピンチ
      single?.cancel?.();
      single = null;
      panning = false;
      // 2 本の指が縦に並んでいれば縦のピンチ
      const [a, b] = [...pts.values()];
      pinch = pinchInfo(!!o.vzoom && Math.abs(a.y - b.y) > Math.abs(a.x - b.x) * 1.2);
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = localPoint(e, el);
    pts.set(e.pointerId, p);
    if (pts.size >= 2 && pinch) {
      const now = pinchInfo(pinch.vertical);
      if (pinch.vertical) o.vzoom?.(now.dy / pinch.dy);
      else {
        o.zoom(pinch.d / now.d, now.mx);
        o.pan(now.mx - pinch.mx);
      }
      pinch = now;
      return;
    }
    if (!start) return;
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < TAP_PX) return;
    moved = true;
    if (single) single.move(p.x, p.y, p.x - start.x);
    else if (panning) {
      o.pan(p.x - lastX);
      lastX = p.x;
    }
  });
  const up = (e: PointerEvent, cancelled: boolean) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size === 1 && pinch) {
      // ピンチから 1 本指に戻った: 残った指で移動を続ける
      pinch = null;
      const rest = [...pts.values()][0];
      start = rest;
      lastX = rest.x;
      moved = true;
      panning = true;
      return;
    }
    if (pts.size > 0) return;
    pinch = null;
    const s = single;
    single = null;
    start = null;
    if (s) {
      if (cancelled) s.cancel?.();
      else s.end(moved);
    }
    o.done?.();
  };
  el.addEventListener('pointerup', (e) => up(e, false));
  el.addEventListener('pointercancel', (e) => up(e, true));
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPoint(e, el);
    if (o.vzoom && (e.altKey || e.shiftKey)) o.vzoom(Math.exp(-(e.deltaY || e.deltaX) * 0.01));
    else if (e.ctrlKey || e.metaKey) o.zoom(Math.exp(e.deltaY * 0.01), p.x);
    else o.pan(-(Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY));
    o.done?.();
  }, { passive: false });
}

export interface ValueBox {
  /** 今の値の表示 */
  get(): string;
  /** n 段だけ変える（+ で増える）。変えられなかったら false */
  step?(n: number): boolean | void;
  /** ドラッグで 1 段変えるのに動かす px */
  px?: number;
  /** 値をタップしたとき（入力など） */
  tap?(): void;
  /** 使えないとき */
  disabled?(): boolean;
}

/** 値の箱の HTML（ラベル・‹ 値 ›）。key で bindValueBoxes の定義と結びつける */
export function valueBoxHtml(key: string, label: string, opts: { steppers?: boolean; extra?: string; cls?: string } = {}) {
  const st = opts.steppers !== false;
  return `<div class="dv ${opts.cls ?? ''}" data-dv="${key}">
    <span class="dv-l">${label}</span>
    <div class="dv-row">${st ? `<button class="dv-s" data-dvs="-1" aria-label="${label}を下げる">‹</button>` : ''}<b class="dv-v" data-dvv></b>${st ? `<button class="dv-s" data-dvs="1" aria-label="${label}を上げる">›</button>` : ''}</div>
    ${opts.extra ?? ''}
  </div>`;
}

/**
 * 値の箱を動くようにする。refresh() で表示を更新（値を変えるたびに呼ぶ）。
 * begin / end はドラッグの始めと終わり（元に戻すの記録を 1 回にまとめるため）
 */
export function bindValueBoxes(root: HTMLElement, defs: Record<string, ValueBox>, hooks: { begin(): void; end(): void; changed(): void }) {
  const refresh = () => {
    root.querySelectorAll<HTMLElement>('[data-dv]').forEach((box) => {
      const d = defs[box.dataset.dv!];
      if (!d) return;
      box.querySelector<HTMLElement>('[data-dvv]')!.textContent = d.get();
      const dis = d.disabled?.() ?? false;
      box.classList.toggle('off', dis);
      box.querySelectorAll<HTMLButtonElement>('[data-dvs]').forEach((b) => { b.disabled = dis; });
    });
  };
  root.querySelectorAll<HTMLElement>('[data-dv]').forEach((box) => {
    const d = defs[box.dataset.dv!];
    if (!d) return;
    box.querySelectorAll<HTMLButtonElement>('[data-dvs]').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (d.disabled?.()) return;
      hooks.begin();
      d.step?.(Number(b.dataset.dvs));
      hooks.end();
      hooks.changed();
    }));
    const val = box.querySelector<HTMLElement>('[data-dvv]')!;
    let drag: { y: number; done: number; moved: boolean } | null = null;
    val.addEventListener('pointerdown', (e) => {
      if (d.disabled?.()) return;
      val.setPointerCapture(e.pointerId);
      drag = { y: localPoint(e, val).y, done: 0, moved: false };
    });
    val.addEventListener('pointermove', (e) => {
      if (!drag || !d.step) return;
      const dy = drag.y - localPoint(e, val).y;
      if (!drag.moved && Math.abs(dy) < TAP_PX) return;
      if (!drag.moved) { drag.moved = true; hooks.begin(); box.classList.add('drag'); }
      const want = Math.trunc(dy / (d.px ?? 12));
      if (want !== drag.done) {
        d.step(want - drag.done);
        drag.done = want;
        refresh();
        hooks.changed();
      }
    });
    const end = () => {
      if (!drag) return;
      const was = drag;
      drag = null;
      box.classList.remove('drag');
      if (was.moved) { hooks.end(); hooks.changed(); }
      else d.tap?.();
    };
    val.addEventListener('pointerup', end);
    val.addEventListener('pointercancel', end);
  });
  refresh();
  return refresh;
}

/** 値をその場で入力する（箱の値の所に入力欄を重ねる）。決めたら ok(文字列) */
export function inlineInput(box: HTMLElement, value: string, ok: (v: string) => void) {
  const val = box.querySelector<HTMLElement>('[data-dvv]');
  if (!val) return;
  const inp = document.createElement('input');
  inp.className = 'dv-in';
  inp.inputMode = 'decimal';
  inp.value = value;
  val.replaceWith(inp);
  inp.focus();
  inp.select();
  let fin = false;
  const finish = (apply: boolean) => {
    if (fin) return;
    fin = true;
    if (apply && inp.value.trim() !== '') ok(inp.value.trim());
    inp.replaceWith(val);
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
}

/** 時間の目盛り（ルーラー）を引く。t0〜t1 秒を幅 W に。label(t) が null の所は書かない */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  marks: { x: number; major: boolean; label?: string }[],
) {
  ctx.fillStyle = '#25282c';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, H - 1, W, 1);
  ctx.font = '700 11px "Makinas 4 Square", sans-serif';
  ctx.textBaseline = 'middle';
  for (const m of marks) {
    ctx.fillStyle = m.major ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.28)';
    const h = m.major ? H * 0.55 : H * 0.28;
    ctx.fillRect(Math.round(m.x), H - h, 1, h);
    if (m.label) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(m.label, m.x + 3, H * 0.36);
    }
  }
  ctx.textBaseline = 'alphabetic';
}

/** 再生位置（黄色の線と、ルーラーの上の三角） */
export const PLAYHEAD = '#ffc94d';
export function drawPlayhead(ctx: CanvasRenderingContext2D, x: number, H: number, rulerH: number) {
  ctx.fillStyle = PLAYHEAD;
  ctx.fillRect(Math.round(x) - 1, 0, 2, H);
  ctx.beginPath();
  ctx.moveTo(x - 6, 0);
  ctx.lineTo(x + 6, 0);
  ctx.lineTo(x, rulerH * 0.6);
  ctx.closePath();
  ctx.fill();
}

/** ちょうどよい目盛りの間隔（秒）。1 目盛りが minPx 以上になるように */
export function niceStep(span: number, W: number, minPx: number) {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60];
  for (const s of steps) if ((s / span) * W >= minPx) return s;
  return 120;
}

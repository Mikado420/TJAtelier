/**
 * 曲えらび・リザルトの背景: 薄い水色の方眼と、その線の上をときどき横に走る光。
 * 方眼は canvas に一度だけ描く。走る光は小さな要素を GPU で横に動かすだけ（毎フレーム描き直さない）。
 * 見えていないとき（画面が隠れている・プレイ中）は動かさない
 */
const CELL = 40;
const STREAKS = 7;

export function mountGridBg(host: HTMLElement, hideWhilePlaying = true) {
  const c = document.createElement('canvas');
  c.className = 'grid-bg';
  c.setAttribute('aria-hidden', 'true');
  const lay = document.createElement('div');
  lay.className = `grid-streaks${hideWhilePlaying ? ' hide-playing' : ''}`;
  lay.setAttribute('aria-hidden', 'true');
  host.prepend(c, lay);
  const g = c.getContext('2d')!;
  let W = 0;
  let H = 0;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const frozenNow = () => !!host.querySelector(':scope > .home-diff.on');

  /** 1 本の光: 行・長さ・速さを決めて、左の外から右の外まで流す。流れ終わったら次の 1 本 */
  const run = (el: HTMLElement, first: boolean) => {
    if (!W || !H) return;
    const row = Math.floor(rnd() * Math.max(1, H / CELL)) + 1;
    const len = 120 + rnd() * 260;
    const speed = 60 + rnd() * 140;
    const from = first ? rnd() * W : -len - rnd() * W;
    const to = W + 20;
    el.style.top = `${row * CELL - 2}px`;
    el.style.width = `${len}px`;
    const anim = el.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
      duration: ((to - from) / speed) * 1000,
      easing: 'linear',
      fill: 'both',
    });
    anim.onfinish = () => run(el, false);
    if (frozenNow()) anim.pause();
    (el as HTMLElement & { _anim?: Animation })._anim = anim;
  };

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = host.clientWidth;
    H = host.clientHeight;
    if (!W || !H) return;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    // 動かない部分（地・方眼・ぼんやりした光）
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#16191c';
    g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(77,159,190,0.10)';
    for (let x = 0; x < W; x += CELL) g.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += CELL) g.fillRect(0, y, W, 1);
    const rg = g.createRadialGradient(W * 0.72, H * 0.28, 10, W * 0.72, H * 0.28, Math.max(W, H) * 0.65);
    rg.addColorStop(0, 'rgba(77,159,190,0.16)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, W, H);
    // 走る光は大きさが変わったら最初から
    for (const el of Array.from(lay.children) as (HTMLElement & { _anim?: Animation })[]) {
      el._anim?.cancel();
      el.remove();
    }
    for (let i = 0; i < STREAKS; i++) {
      const el = document.createElement('i');
      lay.append(el);
      run(el, true);
    }
  };
  new ResizeObserver(resize).observe(host);

  // ぼかした画面（難易度えらび）を重ねている間は、後ろの光を止める（ぼかしを毎フレーム計算し直さずに済む。見た目はぼけていて変わらない）
  let frozen = false;
  const sync = () => {
    const on = !!host.querySelector(':scope > .home-diff.on');
    if (on === frozen) return;
    frozen = on;
    for (const el of Array.from(lay.children) as (HTMLElement & { _anim?: Animation })[]) {
      if (on) el._anim?.pause();
      else el._anim?.play();
    }
  };
  new MutationObserver(sync).observe(host, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
}

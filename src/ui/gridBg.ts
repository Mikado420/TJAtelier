/**
 * 曲えらび・リザルトの背景: 薄い水色の方眼と、その線の上をときどき横に走る光。
 * 見えていないとき（画面が隠れている・プレイ中）は描かない
 */
const CELL = 40;

interface Streak { row: number; x: number; len: number; speed: number }

export function mountGridBg(host: HTMLElement, hideWhilePlaying = true) {
  const c = document.createElement('canvas');
  c.className = 'grid-bg';
  c.setAttribute('aria-hidden', 'true');
  host.prepend(c);
  const g = c.getContext('2d')!;
  let base: HTMLCanvasElement | null = null;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const streaks: Streak[] = [];
  const spawn = (s?: Streak): Streak => {
    const t = s ?? ({} as Streak);
    t.row = Math.floor(rnd() * Math.max(1, H / CELL)) + 1;
    t.len = 120 + rnd() * 260;
    t.speed = 60 + rnd() * 140;
    t.x = -t.len - rnd() * W;
    return t;
  };
  const resize = () => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = host.clientWidth;
    H = host.clientHeight;
    if (!W || !H) return;
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    // 動かない部分（地・方眼・ぼんやりした光）は一度だけ描く
    base = document.createElement('canvas');
    base.width = c.width;
    base.height = c.height;
    const b = base.getContext('2d')!;
    b.scale(dpr, dpr);
    b.fillStyle = '#16191c';
    b.fillRect(0, 0, W, H);
    b.fillStyle = 'rgba(77,159,190,0.10)';
    for (let x = 0; x < W; x += CELL) b.fillRect(x, 0, 1, H);
    for (let y = 0; y < H; y += CELL) b.fillRect(0, y, W, 1);
    const rg = b.createRadialGradient(W * 0.72, H * 0.28, 10, W * 0.72, H * 0.28, Math.max(W, H) * 0.65);
    rg.addColorStop(0, 'rgba(77,159,190,0.16)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    b.fillStyle = rg;
    b.fillRect(0, 0, W, H);
    streaks.length = 0;
    for (let i = 0; i < 7; i++) {
      const s = spawn();
      s.x = rnd() * W;
      streaks.push(s);
    }
  };
  new ResizeObserver(resize).observe(host);
  let last = 0;
  const frame = (t: number) => {
    requestAnimationFrame(frame);
    const shown = host.getClientRects().length > 0 && !host.classList.contains('hidden') && !(hideWhilePlaying && document.body.classList.contains('playing')) && !document.hidden;
    if (!shown || !base) { last = 0; return; }
    // 30 コマ/秒で十分
    if (last && t - last < 33) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of streaks) {
      s.x += s.speed * dt;
      if (s.x > W + 20) spawn(s);
      const y = s.row * CELL;
      const lg = g.createLinearGradient(s.x, 0, s.x + s.len, 0);
      lg.addColorStop(0, 'rgba(147,205,226,0)');
      lg.addColorStop(1, 'rgba(147,205,226,0.6)');
      g.fillStyle = lg;
      g.fillRect(s.x, y - 1, s.len, 2);
      g.fillStyle = 'rgba(210,240,255,0.9)';
      g.fillRect(s.x + s.len - 3, y - 2, 4, 4);
    }
  };
  requestAnimationFrame(frame);
}

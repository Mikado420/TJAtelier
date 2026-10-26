/**
 * 曲を始めるときの幕（青の濃淡の斜めの帯が上から閉じ、真ん中に曲名とヒント。プレイが始まったら下へ開く）
 */
const COLORS = ['#14181b', '#1f3a48', '#2a5a70', '#3a7ca5', '#4d9fbe', '#5ab4d6', '#93cde2', '#4d9fbe', '#2a5a70', '#1d2023'];
const HINTS = [
  'ポーズ中でも、ハイスピードや音量を変えられます',
  '設定の「太鼓の大きさ」で、タッチの太鼓を大きくも小さくもできます',
  '曲えらびでは、上下にスワイプするとまんなかの曲が選ばれます',
  'オンライン対戦は、曲えらびの地球のマークから',
  '判定がずれるときは、設定の「タイミング調整」を試してみてください',
  '譜面情報では、密度の推移や連打のシミュレーションが見られます',
];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let el: HTMLElement | null = null;

/** 幕を閉じる（閉じ終わったら解決） */
export async function closeCurtain(info: { title: string; sub?: string; course?: string; color?: string }) {
  el?.remove();
  const c = document.createElement('div');
  c.className = 'curtain';
  c.innerHTML = `<div class="cu-st">${COLORS.map((col, i) => `<i style="background:${col};transition-delay:${i * 35}ms"></i>`).join('')}</div>
    <div class="cu-band"><b>${esc(info.title)}</b><span>${esc(info.sub ?? '')}${info.course ? ` <em style="--cc:${info.color ?? 'var(--accent)'}">${esc(info.course)}</em>` : ''}</span></div>
    <div class="cu-hint"><small>ヒント</small><span>${esc(HINTS[Math.floor(Math.random() * HINTS.length)])}</span></div>`;
  document.body.appendChild(c);
  el = c;
  void c.offsetWidth;
  c.classList.add('in');
  await wait(700);
}

/** 幕を開ける（プレイ画面が見える） */
export async function openCurtain() {
  const c = el;
  if (!c) return;
  el = null;
  c.classList.add('out');
  await wait(800);
  c.remove();
}

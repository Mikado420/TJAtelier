/**
 * 曲を始めるときの幕（青の濃淡の斜めの帯が上から閉じ、真ん中に曲名。プレイが始まったら下へ開く）
 */
const COLORS = ['#14181b', '#1f3a48', '#2a5a70', '#3a7ca5', '#4d9fbe', '#5ab4d6', '#93cde2', '#4d9fbe', '#2a5a70', '#1d2023'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let el: HTMLElement | null = null;
/** 曲名が出た時刻 */
let shownAt = 0;
let sound: (name: string) => void = () => {};
/** 曲名が出たときに鳴らす音 */
export function setUiSound(f: (name: string) => void) { sound = f; }

/** 幕を閉じる（閉じ終わったら解決） */
export async function closeCurtain(info: { title: string; sub?: string }) {
  el?.remove();
  const c = document.createElement('div');
  c.className = 'curtain';
  c.innerHTML = `<div class="cu-st">${COLORS.map((col, i) => `<i style="background:${col};transition-delay:${i * 35}ms"></i>`).join('')}</div>
    <div class="cu-band"><b>${esc(info.title)}</b><span>${esc(info.sub ?? '')}</span></div>`;
  (document.getElementById('root') ?? document.body).appendChild(c);
  el = c;
  void c.offsetWidth;
  c.classList.add('in');
  // 曲名の帯が出るところで音を鳴らす
  await wait(450);
  shownAt = performance.now();
  sound('title');
  await wait(250);
}

/** 曲名を出してから ms たつまで待つ */
export async function holdCurtain(ms: number) {
  const left = shownAt + ms - performance.now();
  if (left > 0) await wait(left);
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

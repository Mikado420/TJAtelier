/**
 * 曲を始めるときの幕（案3）: 画面が暗くなり、ジャケットが中央へ寄って、右に曲の情報。
 * プレイが始まるときは上下からシャッターが閉じて、開くとプレイ画面が見える
 */
/** ジャケットが無いときの印（音符） */
const JACKET_NONE = '<svg class="jk-none" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let el: HTMLElement | null = null;
/** 曲名が出た時刻 */
let shownAt = 0;
let sound: (name: string) => void = () => {};
/** 曲名が出たときに鳴らす音 */
export function setUiSound(f: (name: string) => void) { sound = f; }

/** 幕に出す曲の情報 */
export interface CurtainInfo {
  title: string;
  sub?: string;
  /** 難易度の名前・レベル・色 */
  course?: { label: string; level: number; color: string };
  /** ジャケットの画像の URL */
  jacket?: string;
  /** BPM・長さ・自己ベストなど（名前と値） */
  stats?: [string, string][];
}

/** 幕を閉じる（閉じ終わったら解決） */
export async function closeCurtain(info: CurtainInfo) {
  el?.remove();
  const c = document.createElement('div');
  c.className = 'curtain';
  const cs = info.course;
  c.innerHTML = `<i class="cu-dim"></i><i class="cu-line t"></i><i class="cu-line b"></i>
    <div class="cu-jk">${info.jacket ? `<img src="${esc(info.jacket)}" alt="">` : JACKET_NONE}</div>
    <div class="cu-info">
      ${cs ? `<span class="cu-course" style="--cc:${esc(cs.color)}">${esc(cs.label)} ★${cs.level}</span>` : ''}
      <b class="cu-title">${esc(info.title)}</b>
      ${info.sub ? `<span class="cu-sub">${esc(info.sub)}</span>` : ''}
      ${info.stats?.length ? `<span class="cu-stats">${info.stats.map(([k, v]) => `<span>${esc(k)}<b>${esc(v)}</b></span>`).join('')}</span>` : ''}
    </div>
    <i class="cu-sh t"></i><i class="cu-sh b"></i>`;
  (document.getElementById('root') ?? document.body).appendChild(c);
  el = c;
  void c.offsetWidth;
  c.classList.add('in');
  // ジャケットが寄りきったところで音を鳴らす
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
  await wait(700);
  c.remove();
}

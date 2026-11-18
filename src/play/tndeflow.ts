/**
 * TNDE スキン: 曲の読み込み画面・終わりの暗転・リザルト画面を、プレイ画面の上の canvas に描く。
 * 1920×1080 の画面を、プレイ画面と同じく縦横の比を保ってまん中に置き、はみ出した左右（上下）は黒にする
 */
import type { TndeSkin } from '../render/tnde';
import { TndeLoading, TndeResult, LOAD_CLOSE, LOAD_OPEN, type TndeResultData, type ResultSound } from '../render/tndescreens';

const W = 1920;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const H = 1080;

export class TndeOverlay {
  private cv: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private paint: ((c: CanvasRenderingContext2D, dt: number) => void) | null = null;
  /** 16:9 の外側（左右・上下の帯）を黒くする濃さ */
  private band = 1;
  private last = 0;
  private buttons: HTMLElement;
  private result: TndeResult | null = null;
  private onKey = (e: KeyboardEvent) => this.key(e);

  constructor() {
    this.cv = document.createElement('canvas');
    this.cv.className = 'tnde-overlay';
    this.ctx = this.cv.getContext('2d')!;
    this.buttons = document.createElement('div');
    this.buttons.className = 'tnde-res-btns hidden';
    this.cv.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.result?.skip()) this.onSkip();
    });
  }

  /** リザルトを飛ばしたとき */
  onSkip: () => void = () => {};

  private mount() {
    if (!this.cv.isConnected) document.body.append(this.cv);
    this.cv.classList.remove('hidden');
    this.resize();
  }

  private resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (this.cv.width !== pw || this.cv.height !== ph) {
      this.cv.width = pw;
      this.cv.height = ph;
    }
  }

  private loop = (now: number) => {
    const dt = this.last ? Math.min(100, now - this.last) : 0;
    this.last = now;
    this.resize();
    const c = this.ctx;
    const pw = this.cv.width;
    const ph = this.cv.height;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, pw, ph);
    const k = Math.min(pw / W, ph / H);
    const ox = (pw - W * k) / 2;
    const oy = (ph - H * k) / 2;
    if (this.band > 0) {
      c.fillStyle = `rgba(0,0,0,${this.band})`;
      if (ox > 0) { c.fillRect(0, 0, Math.ceil(ox), ph); c.fillRect(Math.floor(ox + W * k), 0, pw, ph); }
      if (oy > 0) { c.fillRect(0, 0, pw, Math.ceil(oy)); c.fillRect(0, Math.floor(oy + H * k), pw, ph); }
    }
    c.setTransform(k, 0, 0, k, ox, oy);
    c.save();
    c.beginPath();
    c.rect(0, 0, W, H);
    c.clip();
    try {
      this.paint?.(c, dt);
    } catch (e) {
      console.error(e);
    }
    c.restore();
    this.raf = requestAnimationFrame(this.loop);
  };

  private run(paint: (c: CanvasRenderingContext2D, dt: number) => void) {
    this.paint = paint;
    this.mount();
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  /** 消す */
  hide() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.paint = null;
    this.result = null;
    this.cv.remove();
    this.buttons.classList.add('hidden');
    window.removeEventListener('keydown', this.onKey, true);
  }

  get shown() {
    return !!this.raf;
  }

  // ---------- 曲の読み込み ----------

  /**
   * 幕を閉じて曲名を出し、ready が済んで（最低 hold ms 見せて）から戻る。
   * 戻り値の open() で幕を開ける（プレイ画面が後ろに見える）
   */
  async loading(sk: TndeSkin, title: string, subtitle: string | undefined, ready: Promise<unknown>, hold = 2500) {
    const L = new TndeLoading(sk, title, subtitle);
    let phase: 'close' | 'wait' | 'open' = 'close';
    let t = 0;
    this.band = 0;
    this.run((c, dt) => {
      t += dt;
      if (phase === 'close') this.band = Math.min(1, t / 500);
      L.draw(c, phase, t);
    });
    const t0 = performance.now();
    await Promise.all([ready.catch(() => {}), new Promise((r) => setTimeout(r, LOAD_CLOSE + hold))]);
    void t0;
    return {
      open: () =>
        new Promise<void>((done) => {
          phase = 'open';
          t = 0;
          setTimeout(() => {
            this.hide();
            done();
          }, LOAD_OPEN + 30);
        }),
      /** 幕を開けずに消す（やめたとき） */
      cancel: () => this.hide(),
    };
  }

  // ---------- 終わりの暗転・リザルト ----------

  /** プレイ画面の上を ms かけて黒くする */
  fadeOut(ms: number) {
    let t = 0;
    this.band = 0;
    this.run((c, dt) => {
      t += dt;
      const a = Math.min(1, t / ms);
      this.band = a;
      c.fillStyle = `rgba(0,0,0,${a})`;
      c.fillRect(0, 0, W, H);
    });
  }

  /**
   * リザルト画面。黒から 0.5 秒で出す。動きが終わったらボタンを出す
   * buttons: [ラベル, 押したとき]
   */
  showResult(sk: TndeSkin, d: TndeResultData, sound: (n: ResultSound) => { stop(): void } | null, buttons: [string, () => void][]) {
    const R = new TndeResult(sk, d, sound);
    this.result = R;
    let black = 300;
    this.band = 1;
    this.buttons.replaceChildren(
      ...buttons.map(([label, f], i) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (i === 0) b.className = 'primary';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          f();
        });
        return b;
      }),
    );
    if (!this.buttons.isConnected) document.body.append(this.buttons);
    this.buttons.classList.add('hidden');
    window.addEventListener('keydown', this.onKey, true);
    this.run((c, dt) => {
      // 黒のまま 0.3 秒 → 0.27 秒で明るく（明るくなり始めたところから時間が進む。本家の参考動画で測った）
      if (black > 0) black -= dt;
      R.draw(c, black > 0 ? 0 : dt);
      const a = black > 0 ? 1 : clamp01(1 - R.t / 270);
      if (R.done && this.buttons.classList.contains('hidden')) this.buttons.classList.remove('hidden');
      if (a > 0) {
        c.fillStyle = `rgba(0,0,0,${a})`;
        c.fillRect(0, 0, W, H);
        R.drawCoin(c);
      }
    });
  }

  private key(e: KeyboardEvent) {
    if (!this.result || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (!this.result.done) {
        if (this.result.skip()) this.onSkip();
      } else (this.buttons.querySelector('button') as HTMLButtonElement | null)?.click();
    } else if (e.key === 'Escape') {
      (this.buttons.querySelectorAll('button')[1] as HTMLButtonElement | undefined)?.click();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

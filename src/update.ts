/**
 * 自動更新。
 * ホーム画面に追加したアプリは古い版を開き続けることがあるので、
 * 起動時・アプリに戻ってきたとき・10分ごとに version.json を確認し、
 * 新しい版が公開されていたら読み直す（編集中の譜面は自動保存済みなので消えない）。
 * 読み直してよいかは canReload が決める。だめな間は待ち、よくなったらすぐ読み直す。
 */

declare const __BUILD_ID__: string;

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
declare const __BUILD_NUM__: string;
declare const __BUILD_DATE__: string;
/** 画面に出す版（公開の通し番号と日付） */
export const BUILD_NUM: string = typeof __BUILD_NUM__ === 'string' ? __BUILD_NUM__ : 'dev';
export const BUILD_DATE: string = typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '';

export interface UpdateHooks {
  /** 今すぐ読み直してよいか（テストプレイ中などは待つ） */
  canReload: () => boolean;
  /** 読み直す前に保存などを済ませる */
  beforeReload: () => Promise<void>;
  notify: (msg: string) => void;
}

export function startAutoUpdate(h: UpdateHooks) {
  if (BUILD_ID === 'dev') return;
  let pending: string | null = null;
  let checking = false;

  const reload = async (id: string) => {
    if (!h.canReload()) {
      pending = id;
      return;
    }
    // 公開直後でまだ古い index.html が返ってくる場合に読み直しを繰り返さないよう、同じ版へは 1 分に 1 回まで
    try {
      const last = JSON.parse(sessionStorage.getItem('malody-web:reload') ?? 'null') as { id: string; t: number } | null;
      if (last && last.id === id && Date.now() - last.t < 60_000) return;
      sessionStorage.setItem('malody-web:reload', JSON.stringify({ id, t: Date.now() }));
    } catch { /* 使えない環境 */ }
    h.notify('新しいバージョンに更新します…');
    await h.beforeReload();
    // クエリを付けてキャッシュされた古い index.html を避ける
    const url = new URL(location.href);
    url.searchParams.set('v', id.slice(0, 12));
    location.replace(url.toString());
  };

  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const { id } = (await res.json()) as { id?: string };
        if (id && id !== BUILD_ID) await reload(id);
      }
    } catch {
      /* オフラインなど */
    } finally {
      checking = false;
    }
  };

  void check();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
  window.addEventListener('focus', () => void check());
  window.addEventListener('online', () => void check());
  setInterval(() => void check(), 10 * 60 * 1000);
  // テストプレイが終わるまで待っていた更新
  setInterval(() => {
    if (pending && h.canReload()) void reload(pending);
  }, 2000);
}

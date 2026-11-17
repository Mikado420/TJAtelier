/**
 * 録画の別スレッド（Worker）で、画面の描き方（Renderer・TNDE スキン）をそのまま動かすための代わりの部品。
 * Worker には document・window が無いので、使っている所だけ用意する（canvas は OffscreenCanvas）。
 * これは一番最初に読み込むこと（ほかの部品が読み込まれたときに使うので）
 */
const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.document === 'undefined') {
  const W = 1920;
  const H = 1080;
  const fonts = (g.fonts as FontFaceSet | undefined) ?? {
    add() {},
    load: () => Promise.resolve([]),
    ready: Promise.resolve(),
    addEventListener() {},
  };
  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`no ${tag} in worker`);
      const c = new OffscreenCanvas(1, 1) as OffscreenCanvas & Record<string, unknown>;
      c.style = {};
      c.className = '';
      c.setAttribute = () => {};
      c.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
      return c;
    },
    fonts,
    body: { classList: { contains: () => false, toggle() {} } },
    documentElement: { style: { setProperty() {} } },
    addEventListener() {},
  };
  g.window = g;
  g.devicePixelRatio = 1;
  g.innerWidth = W;
  g.innerHeight = H;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
}

export {};

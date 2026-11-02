import { defineConfig } from 'vite';

// ビルドごとの版（GitHub Actions ではコミットの SHA）。
// version.json として一緒に公開し、アプリは起動時・復帰時にこれを見て新しい版があれば自動で読み直す。
const buildId = process.env.GITHUB_SHA ?? `local-${Date.now()}`;

export default defineConfig(({ command }) => ({
  // base: './' にしておくと GitHub Pages のサブパス (/リポジトリ名/) でもそのまま動く
  base: './',
  define: {
    __BUILD_ID__: JSON.stringify(command === 'serve' ? 'dev' : buildId),
  },
  build: {
    // ファイル名に公開ごとの印（ハッシュ）を付けない。
    // 付けると、端末に残っていた古い index.html が、公開し直して消えた古い名前のファイルを読みに行き、
    // 見た目もプログラムも読めずに起動のロゴで止まる。名前を変えなければ、古い index.html からでも起動でき、
    // 起動したら新しい版を見つけて読み直す（src/update.ts）
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  plugins: [
    {
      name: 'version-json',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ id: buildId }) });
      },
    },
    {
      // 古いファイルが端末に残らないよう、index.html から読むファイルには版を付ける（?v=…）
      name: 'asset-version',
      apply: 'build',
      transformIndexHtml: {
        order: 'post',
        handler: (html) => html.replace(/((?:src|href)="\.\/assets\/[^"?]+)"/g, `$1?v=${buildId.slice(0, 12)}"`),
      },
    },
  ],
}));

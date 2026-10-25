/**
 * 最初の画面（曲選択）。左にロゴとフォルダ、真ん中に曲の縦の一覧、右の青い面に選んだ曲
 * （BPM・長さ・難易度・試聴・「プレイ」「編集」）。
 */
import type { AudioFile } from '../io/load';
import {
  addFolder, addToFolder, deleteFolder, deleteSong, listFolders, listSongs, loadSongAudio, removeFromFolder, renameFolder, type SongEntry,
} from '../io/library';

export interface HomeHost {
  /** 曲を開く（編集・プレイ） */
  open(id: string, mode: 'edit' | 'play'): Promise<void>;
  /** ファイルを選んで読み込む（読み込んだ曲は一覧に入る） */
  importFiles(): void;
  /** 新しい譜面を作って開く */
  create(folder: string): Promise<void>;
  settings(): void;
  /** 譜面情報を出す */
  analyze(id: string): void;
  toast(msg: string): void;
}

type Sort = 'updated' | 'title' | 'bpm';
const SORT_LABEL: Record<Sort, string> = { updated: '更新順', title: '名前順', bpm: 'BPM 順' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmtLen = (s: number) => (s > 0 ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--:--');
const fmtBpm = (e: SongEntry) => {
  const r = (x: number) => String(Number(x.toFixed(2)));
  return e.bpmMin !== e.bpmMax ? `${r(e.bpmMin)}-${r(e.bpmMax)}` : r(e.bpm);
};
const COURSE_SHORT: Record<string, string> = { Easy: 'かんたん', Normal: 'ふつう', Hard: 'むずかしい', Oni: 'おに', Edit: 'うら' };

/** 曲名から決まる、ジャケットの代わりの斜線の模様（傾きは CSS の --tilt と同じ 8°。曲ごとに変わるのは太さ・間隔・色） */
function jacket(e: SongEntry) {
  let h = 0;
  for (const ch of e.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const w = 5 + (h % 5);
  const gap = 8 + ((h >> 4) % 10);
  const bands = Array.from({ length: 14 }, (_, k) => `<rect x="${-60 + k * (w + gap)}" y="-40" width="${w}" height="200" fill="${k % 3 === (h >> 8) % 3 ? '#fff' : '#1d2023'}" opacity="${k % 3 === (h >> 8) % 3 ? 0.9 : 0.55}"/>`).join('');
  return `<svg class="hj" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g transform="rotate(8 50 50)">${bands}</g></svg>`;
}

/** 「未分類」（どのフォルダにも入っていない曲）を表す、フォルダ名には使えない値 */
const UNCAT = '\u0000uncat';

/** 0.05 秒の無音（試聴の音を、タップの瞬間に鳴らせる状態にしておくため） */
const SILENT = (() => {
  const n = 400;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, t: string) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  b.fill(128, 44);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return `data:audio/wav;base64,${btoa(bin)}`;
})();

const ICON = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
};

export class Home {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly foldersEl: HTMLElement;
  private songs: SongEntry[] = [];
  private folders: string[] = [];
  /** 今見ているフォルダ（null は「すべて」、UNCAT は「未分類」） */
  private folder: string | null = null;
  /** 曲を選んでまとめてフォルダに入れる・外すとき（選んでいる曲） */
  private picking: Set<string> | null = null;
  /** 試聴の音を鳴らせる状態にしたか（iPhone はタップの瞬間に一度鳴らさないと、後から鳴らせない） */
  private unlocked = false;
  /** 自動で鳴らせなかったので、次のタップで鳴らす */
  private pendingPreview = false;
  private sel: string | null = null;
  private sort: Sort = 'updated';
  private query = '';
  private preview = new Audio();
  private previewUrl = '';
  private previewId = '';
  private playing = false;

  constructor(private readonly host: HomeHost) {
    this.el = document.getElementById('home')!;
    this.list = document.getElementById('homeList')!;
    this.preview.loop = true;
    this.preview.addEventListener('play', () => { this.playing = true; this.paintPlayer(); });
    this.preview.addEventListener('pause', () => { this.playing = false; this.paintPlayer(); });
    this.detail = document.getElementById('homeDetail')!;
    this.foldersEl = document.getElementById('homeFolders')!;
    const q = document.getElementById('homeQuery') as HTMLInputElement;
    q.addEventListener('input', () => { this.query = q.value.trim(); this.render(); });
    this.el.addEventListener('click', (e) => this.onClick(e));
    // どこかに触れた瞬間に試聴の音を鳴らせる状態にする（曲を選んだ後、音源を読むのを待ってから鳴らすので）
    this.el.addEventListener('pointerdown', () => {
      this.unlock();
      if (this.pendingPreview) {
        this.pendingPreview = false;
        // 音源は読み込んであるので、触れた瞬間にそのまま鳴らす（iPhone はタップの中で鳴らさないと鳴らない）
        if (!this.playing && this.previewId === this.sel && this.preview.getAttribute('src')) {
          void this.preview.play().catch(() => {});
          this.unlocked = true;
        }
      }
    }, true);
  }

  /** 試聴の音を鳴らせる状態にする（タップの中で呼ぶ） */
  private unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    if (!this.preview.getAttribute('src')) {
      this.preview.src = SILENT;
      void this.preview.play().then(() => this.preview.pause()).catch(() => { this.unlocked = false; });
    }
  }

  /** 今見ているフォルダ（すべて・未分類なら ''）。読み込んだ曲を入れる */
  get currentFolder() {
    return this.folder && this.folder !== UNCAT ? this.folder : '';
  }

  /** 曲が今見ているフォルダに出るか */
  private inView(e: SongEntry) {
    if (this.folder === null) return true;
    if (this.folder === UNCAT) return !e.folders.length;
    return e.folders.includes(this.folder);
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  /** 画面を出す（select の曲を選んだ状態で、その曲のフォルダを開く） */
  async show(select?: string | null) {
    this.el.classList.remove('hidden');
    await this.reload();
    if (select) {
      const e = this.songs.find((x) => x.id === select);
      if (e) {
        if (!this.inView(e)) this.folder = null;
        this.sel = e.id;
      }
    }
    this.render(true);
    // 選んでいる曲の試聴を流す（自動で鳴らせないときは、次に触れたときに）
    const s = this.songs.find((x) => x.id === this.sel);
    if (s) void this.startPreview(s);
  }

  hide() {
    this.el.classList.add('hidden');
    this.stopPreview();
  }

  async reload() {
    this.songs = await listSongs();
    this.folders = await listFolders();
    // 曲が入っているのに一覧に無いフォルダも出す
    for (const s of this.songs) for (const f of s.folders) if (!this.folders.includes(f)) this.folders.push(f);
    if (this.folder && this.folder !== UNCAT && !this.folders.includes(this.folder)) this.folder = null;
    if (this.picking) for (const id of [...this.picking]) if (!this.songs.some((x) => x.id === id)) this.picking.delete(id);
  }

  /** 読み込んだ・作った曲を選ぶ */
  async select(id: string) {
    await this.reload();
    const e = this.songs.find((x) => x.id === id);
    if (e) {
      if (!this.inView(e)) this.folder = null;
      this.sel = id;
    }
    this.render(true);
    if (e) void this.startPreview(e);
  }

  private sorted(list: SongEntry[]) {
    const s = [...list];
    if (this.sort === 'title') s.sort((a, b) => a.title.localeCompare(b.title, 'ja'));
    else if (this.sort === 'bpm') s.sort((a, b) => a.bpm - b.bpm);
    else s.sort((a, b) => b.updatedAt - a.updatedAt);
    return s;
  }

  /** 今の一覧に出す曲（検索中は全部の曲から） */
  private shown(): SongEntry[] {
    if (this.query) {
      const q = this.query.toLowerCase();
      return this.sorted(this.songs.filter((s) => `${s.title} ${s.subtitle}`.toLowerCase().includes(q)));
    }
    return this.sorted(this.songs.filter((s) => this.inView(s)));
  }

  private render(scrollToSel = false) {
    const songs = this.shown();
    // 左: フォルダ（選んでいるフォルダには「…」で名前の変更・削除）
    const uncat = this.songs.filter((x) => !x.folders.length).length;
    const fl = [
      `<button class="hf ${this.folder === null && !this.query ? 'on' : ''}" data-folder=""><span>すべて</span><small>${this.songs.length}</small></button>`,
      `<button class="hf hf-uncat ${this.folder === UNCAT && !this.query ? 'on' : ''}" data-folder="${UNCAT}"><span>未分類</span><small>${uncat}</small></button>`,
    ];
    for (const f of [...this.folders].sort((a, b) => a.localeCompare(b, 'ja'))) {
      const n = this.songs.filter((x) => x.folders.includes(f)).length;
      const on = this.folder === f && !this.query;
      fl.push(`<div class="hf ${on ? 'on' : ''}" data-folder="${esc(f)}"><span>${esc(f)}</span><small>${n}</small>${on ? `<button class="hf-more" data-fmore="${esc(f)}" aria-label="フォルダの操作">${ICON.more}</button>` : ''}</div>`);
    }
    fl.push(`<button class="hf hf-add" data-h="folder"><span>＋ 新しいフォルダ</span></button>`);
    this.foldersEl.innerHTML = fl.join('');

    // 真ん中: 曲の縦の一覧
    const pk = this.picking;
    const tags = (s: SongEntry) => (this.folder === null || this.query ? s.folders : s.folders.filter((f) => f !== this.folder));
    const rows = songs.map((s) => `<div class="hr ${s.id === this.sel && !pk ? 'on' : ''} ${pk?.has(s.id) ? 'pk' : ''}" data-song="${s.id}">${pk ? `<i class="hr-ck">${pk.has(s.id) ? '✓' : ''}</i>` : '<i class="hr-mk"></i>'}<div class="hr-t"><b>${esc(s.title)}</b><small>${esc(s.subtitle || ' ')}${tags(s).length ? ` <span class="hr-tags">${tags(s).map((f) => `<em>${esc(f)}</em>`).join('')}</span>` : ''}</small></div><span class="hr-bpm">${fmtBpm(s)}</span></div>`);
    if (!rows.length) {
      rows.push(`<div class="hr-empty">${this.query ? '見つかりませんでした' : this.folder === UNCAT ? '未分類の曲はありません' : this.folder !== null ? 'このフォルダには曲がありません。「選択」で曲を選んで入れられます' : 'まだ曲がありません。左下の読み込み（↓）で .tja・.zip・音源を入れるか、＋で新しく作れます'}</div>`);
    }
    this.list.innerHTML = rows.join('');

    // 選んでいるときの操作（下に出す）
    const bar = document.getElementById('homePick')!;
    bar.classList.toggle('hidden', !pk);
    if (pk) {
      const inFolder = this.folder !== null && this.folder !== UNCAT && !this.query;
      bar.innerHTML = `<b>${pk.size} 曲</b>
        <button data-pk="all">${songs.length && songs.every((x) => pk.has(x.id)) ? '選択を解除' : 'すべて選択'}</button>
        <button data-pk="add" class="primary" ${pk.size ? '' : 'disabled'}>フォルダへ…</button>
        ${inFolder ? `<button data-pk="move" ${pk.size ? '' : 'disabled'}>移す…</button><button data-pk="remove" class="bad" ${pk.size ? '' : 'disabled'}>ここから外す</button>` : `<button data-pk="clear" ${pk.size ? '' : 'disabled'}>未分類に戻す</button>`}
        <button data-pk="done">完了</button>`;
    }
    this.el.classList.toggle('home-picking', !!pk);
    (document.getElementById('homePickBtn') as HTMLElement).classList.toggle('on', !!pk);

    // 右: 選んでいる曲
    const s = this.songs.find((x) => x.id === this.sel && songs.includes(x));
    if (s) {
      const courses = s.courses.map((c) => `<span class="hd hd-${esc(c.name.toLowerCase())}">${esc(COURSE_SHORT[c.name] ?? c.name)}<b>${c.level}</b></span>`).join('');
      this.detail.innerHTML = `
        <div class="hdx-jk">${jacket(s)}</div>
        <div class="hdx-top"><small>選んでいる曲</small><button class="hdx-more" data-smore="${s.id}" aria-label="曲の操作">${ICON.more}</button></div>
        <h1 class="hdx-title">${esc(s.title)}</h1>
        <div class="hdx-sub">${esc(s.subtitle || 'アーティスト未設定')}</div>
        <div class="hdx-bpm">${fmtBpm(s)}<small>BPM</small></div>
        <div class="hdx-row"><span>長さ ${fmtLen(s.length)}</span><span class="hdx-pv"><button data-h="prev" aria-label="前の曲"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14"/><path d="M19 5 9 12l10 7z"/></svg></button><button data-h="pp" aria-label="試聴"></button><button data-h="next" aria-label="次の曲"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14"/><path d="M5 5l10 7-10 7z"/></svg></button></span></div>
        <div class="hdx-diffs">${courses}</div>
        <div class="hdx-acts"><button class="hdx-an" data-analyze="${s.id}" aria-label="譜面情報"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>情報</button><button class="hdx-edit" data-edit="${s.id}">編集</button><button class="hdx-play" data-play="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>プレイ</button></div>`;
    } else {
      this.detail.innerHTML = `<div class="hdx-empty"><b>曲を選んでください</b><small>.tja・.zip・音源ファイルから読み込めます</small><button class="hdx-play" data-h="import">読み込む</button></div>`;
    }

    (document.getElementById('homeSort') as HTMLElement).textContent = SORT_LABEL[this.sort];
    (document.getElementById('homePath') as HTMLElement).textContent = this.query ? `「${this.query}」` : this.folder === UNCAT ? '未分類' : this.folder ?? 'すべて';
    (document.getElementById('homeCount') as HTMLElement).textContent = `${songs.length} 曲`;
    if (scrollToSel) this.list.querySelector('.hr.on')?.scrollIntoView({ block: 'center' });
    this.paintPlayer();
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const d = (sel: string) => t.closest<HTMLElement>(sel);
    let x: HTMLElement | null;
    if ((x = d('[data-play]'))) { this.stopPreview(); void this.host.open(x.dataset.play!, 'play'); return; }
    if ((x = d('[data-edit]'))) { this.stopPreview(); void this.host.open(x.dataset.edit!, 'edit'); return; }
    if ((x = d('[data-analyze]'))) { this.host.analyze(x.dataset.analyze!); return; }
    if ((x = d('[data-smore]'))) { this.songMenu(x.dataset.smore!, x); return; }
    if ((x = d('[data-fmore]'))) { this.folderMenu(x.dataset.fmore!, x); return; }
    if ((x = d('[data-pk]'))) { void this.pickAction(x.dataset.pk!, x); return; }
    if ((x = d('[data-h]'))) { void this.action(x.dataset.h!); return; }
    if ((x = d('[data-folder]'))) {
      const f = x.dataset.folder!;
      this.folder = f || null;
      this.query = '';
      const q = document.getElementById('homeQuery') as HTMLInputElement;
      q.value = '';
      document.getElementById('homeSearch')!.classList.add('hidden');
      this.render(true);
      return;
    }
    if ((x = d('[data-song]'))) {
      const id = x.dataset.song!;
      // 選んでいるとき: タップで選ぶ・外す
      if (this.picking) {
        if (this.picking.has(id)) this.picking.delete(id);
        else this.picking.add(id);
        this.render();
        return;
      }
      if (this.sel === id) return;
      this.sel = id;
      this.render();
      const s = this.songs.find((q) => q.id === id);
      if (s) void this.startPreview(s);
    }
  }

  private async action(a: string) {
    if (a === 'import') this.host.importFiles();
    else if (a === 'settings') this.host.settings();
    else if (a === 'new') { this.stopPreview(); await this.host.create(this.folder ?? ''); }
    else if (a === 'folder') {
      const name = prompt('新しいフォルダの名前')?.trim();
      if (!name || name === UNCAT) return;
      await addFolder(name);
      await this.reload();
      this.folder = name;
      this.render();
    } else if (a === 'pick') {
      this.picking = this.picking ? null : new Set();
      this.render();
    } else if (a === 'sort') {
      const order: Sort[] = ['updated', 'title', 'bpm'];
      this.sort = order[(order.indexOf(this.sort) + 1) % order.length];
      this.render(true);
    } else if (a === 'search') {
      const box = document.getElementById('homeSearch')!;
      box.classList.toggle('hidden');
      const q = document.getElementById('homeQuery') as HTMLInputElement;
      if (!box.classList.contains('hidden')) q.focus();
      else { q.value = ''; this.query = ''; this.render(true); }
    } else if (a === 'prev' || a === 'next') {
      const list = this.shown();
      if (!list.length) return;
      const i = list.findIndex((s) => s.id === this.sel);
      const j = i < 0 ? 0 : (i + (a === 'next' ? 1 : -1) + list.length) % list.length;
      this.sel = list[j].id;
      this.render(true);
      void this.startPreview(list[j]);
    } else if (a === 'pp') {
      if (this.playing) this.preview.pause();
      else {
        const s = this.songs.find((q) => q.id === this.sel);
        if (s && this.previewId === s.id) void this.preview.play().catch(() => {});
        else if (s) void this.startPreview(s);
      }
    }
  }

  // ---------- 試聴 ----------

  private async startPreview(s: SongEntry) {
    const id = s.id;
    this.previewId = id;
    this.preview.pause();
    const a: AudioFile | null = await loadSongAudio(id);
    if (this.previewId !== id || !this.visible) return;
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
    if (!a) { this.paintPlayer(); return; }
    this.previewUrl = URL.createObjectURL(new Blob([a.data]));
    this.preview.src = this.previewUrl;
    this.preview.currentTime = 0;
    const start = Math.max(0, s.demoStart || 0);
    this.preview.addEventListener('loadedmetadata', () => { try { this.preview.currentTime = start; } catch { /* 無視 */ } }, { once: true });
    // 自動で鳴らせない（まだ画面に触れていない）ときは、次に触れたときに鳴らす
    void this.preview.play().catch(() => { this.playing = false; this.pendingPreview = true; this.paintPlayer(); });
  }

  stopPreview() {
    this.previewId = '';
    this.preview.pause();
  }

  private paintPlayer() {
    const b = this.el.querySelector<HTMLElement>('[data-h="pp"]');
    if (b) b.innerHTML = this.playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
    this.el.classList.toggle('home-playing', this.playing);
  }

  // ---------- 曲・フォルダの操作 ----------

  private popup(anchor: HTMLElement, items: [string, () => void | Promise<void>, boolean?][]) {
    document.querySelector('.home-pop')?.remove();
    const pop = document.createElement('div');
    pop.className = 'home-pop';
    pop.innerHTML = items.map(([l, , danger], i) => `<button data-i="${i}" class="${danger ? 'bad' : ''}">${esc(l)}</button>`).join('');
    this.el.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const hr = this.el.getBoundingClientRect();
    // ボタンの左端にそろえる（右にはみ出すときは右端にそろえる）
    pop.style.left = `${Math.max(8, Math.min(r.left - hr.left, hr.width - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.min(hr.height - pop.offsetHeight - 8, r.bottom - hr.top + 4)}px`;
    pop.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (!b) return;
      pop.remove();
      void items[Number(b.dataset.i)][1]();
    });
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (!pop.contains(e.target as Node)) pop.remove(); }, { once: true }), 0);
  }

  private songMenu(id: string, anchor: HTMLElement) {
    const s = this.songs.find((x) => x.id === id);
    if (!s) return;
    const inFolder = this.folder !== null && this.folder !== UNCAT && s.folders.includes(this.folder);
    this.popup(anchor, [
      ...(inFolder ? [[`「${this.folder}」から外す`, async () => { await removeFromFolder([id], this.folder!); await this.reload(); this.render(); }] as [string, () => Promise<void>]] : []),
      ['入れるフォルダを選ぶ…', () => this.folderPicker([id], anchor)],
      ['この曲を消す', async () => {
        if (!confirm(`「${s.title}」を消しますか？（譜面と音源がこのブラウザから消えます）`)) return;
        this.stopPreview();
        await deleteSong(id);
        this.sel = null;
        await this.reload();
        this.render();
        this.host.toast(`「${s.title}」を消しました`);
      }, true],
    ]);
  }

  /**
   * 入れるフォルダを選ぶ（いくつでも。✓ が入っているフォルダ）。ids の曲を、押したフォルダに入れる・外す。
   * move を渡すと、そのフォルダから外して移す
   */
  private folderPicker(ids: string[], anchor: HTMLElement, move?: string) {
    const has = (f: string) => ids.every((id) => this.songs.find((x) => x.id === id)?.folders.includes(f));
    const names = [...this.folders].sort((a, b) => a.localeCompare(b, 'ja')).filter((f) => f !== move);
    const done = async (msg: string) => { await this.reload(); this.render(); this.host.toast(msg); };
    this.popup(anchor, [
      ...names.map((f) => [`${has(f) && !move ? '✓ ' : '　 '}${f}`, async () => {
        if (move) {
          await addToFolder(ids, f);
          await removeFromFolder(ids, move);
          await done(`${ids.length} 曲を「${f}」へ移しました`);
        } else if (has(f)) {
          await removeFromFolder(ids, f);
          await done(`${ids.length} 曲を「${f}」から外しました`);
        } else {
          await addToFolder(ids, f);
          await done(`${ids.length} 曲を「${f}」に入れました`);
        }
      }] as [string, () => Promise<void>]),
      ['＋ 新しいフォルダ…', async () => {
        const name = prompt('新しいフォルダの名前')?.trim();
        if (!name || name === UNCAT) return;
        await addToFolder(ids, name);
        if (move) await removeFromFolder(ids, move);
        await done(`${ids.length} 曲を「${name}」に${move ? '移しました' : '入れました'}`);
      }],
    ]);
  }

  /** 曲を選んでいるときの操作 */
  private async pickAction(a: string, anchor: HTMLElement) {
    const pk = this.picking;
    if (!pk) return;
    const ids = [...pk];
    if (a === 'done') { this.picking = null; this.render(); return; }
    if (a === 'all') {
      const list = this.shown();
      if (list.every((x) => pk.has(x.id))) list.forEach((x) => pk.delete(x.id));
      else list.forEach((x) => pk.add(x.id));
      this.render();
      return;
    }
    if (!ids.length) return;
    if (a === 'add') this.folderPicker(ids, anchor);
    else if (a === 'move' && this.folder) this.folderPicker(ids, anchor, this.folder);
    else if (a === 'remove' && this.folder) {
      await removeFromFolder(ids, this.folder);
      pk.clear();
      await this.reload();
      this.render();
      this.host.toast(`${ids.length} 曲を「${this.folder}」から外しました`);
    } else if (a === 'clear') {
      if (!confirm(`${ids.length} 曲を、入っているフォルダから全部外しますか？（曲は消えません）`)) return;
      for (const f of this.folders) await removeFromFolder(ids, f);
      await this.reload();
      this.render();
      this.host.toast(`${ids.length} 曲をフォルダから外しました`);
    }
  }

  private folderMenu(name: string, anchor: HTMLElement) {
    this.popup(anchor, [
      ['名前を変える', async () => {
        const to = prompt('フォルダの名前', name)?.trim();
        if (!to || to === name) return;
        await renameFolder(name, to);
        if (this.folder === name) this.folder = to;
        await this.reload();
        this.render();
      }],
      ['フォルダを消す（曲は残す）', async () => {
        if (!confirm(`フォルダ「${name}」を消しますか？（中の曲は消えず、このフォルダから外れるだけです）`)) return;
        await deleteFolder(name);
        await this.reload();
        this.render();
      }, true],
    ]);
  }
}

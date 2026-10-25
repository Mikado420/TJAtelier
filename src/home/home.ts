/**
 * 最初の画面（曲選択）。左にロゴとフォルダ、真ん中に曲の縦の一覧、右の青い面に選んだ曲
 * （BPM・長さ・難易度・試聴・「プレイ」「編集」）。
 */
import type { AudioFile } from '../io/load';
import {
  addFolder, deleteFolder, deleteSong, listFolders, listSongs, loadSongAudio, moveSong, renameFolder, type SongEntry,
} from '../io/library';

export interface HomeHost {
  /** 曲を開く（編集・プレイ） */
  open(id: string, mode: 'edit' | 'play'): Promise<void>;
  /** ファイルを選んで読み込む（読み込んだ曲は一覧に入る） */
  importFiles(): void;
  /** 新しい譜面を作って開く */
  create(folder: string): Promise<void>;
  settings(): void;
  /** 譜面分析を出す */
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
  /** 今見ているフォルダ（null は「すべて」） */
  private folder: string | null = null;
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
  }

  /** 今見ているフォルダ（一番上なら ''） */
  get currentFolder() {
    return this.folder ?? '';
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
        this.folder = e.folder || null;
        this.sel = e.id;
      }
    }
    this.render(true);
  }

  hide() {
    this.el.classList.add('hidden');
    this.stopPreview();
  }

  async reload() {
    this.songs = await listSongs();
    this.folders = await listFolders();
    // 曲が入っているのに一覧に無いフォルダも出す
    for (const s of this.songs) if (s.folder && !this.folders.includes(s.folder)) this.folders.push(s.folder);
    if (this.folder && !this.folders.includes(this.folder)) this.folder = null;
  }

  /** 読み込んだ・作った曲を選ぶ */
  async select(id: string) {
    await this.reload();
    const e = this.songs.find((x) => x.id === id);
    if (e) {
      this.folder = e.folder || null;
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
    return this.sorted(this.folder === null ? this.songs : this.songs.filter((s) => s.folder === this.folder));
  }

  private render(scrollToSel = false) {
    const songs = this.shown();
    // 左: フォルダ（選んでいるフォルダには「…」で名前の変更・削除）
    const fl = [`<button class="hf ${this.folder === null && !this.query ? 'on' : ''}" data-folder=""><span>すべて</span><small>${this.songs.length}</small></button>`];
    for (const f of [...this.folders].sort((a, b) => a.localeCompare(b, 'ja'))) {
      const n = this.songs.filter((x) => x.folder === f).length;
      const on = this.folder === f && !this.query;
      fl.push(`<div class="hf ${on ? 'on' : ''}" data-folder="${esc(f)}"><span>${esc(f)}</span><small>${n}</small>${on ? `<button class="hf-more" data-fmore="${esc(f)}" aria-label="フォルダの操作">${ICON.more}</button>` : ''}</div>`);
    }
    fl.push(`<button class="hf hf-add" data-h="folder"><span>＋ 新しいフォルダ</span></button>`);
    this.foldersEl.innerHTML = fl.join('');

    // 真ん中: 曲の縦の一覧
    const rows = songs.map((s) => `<div class="hr ${s.id === this.sel ? 'on' : ''}" data-song="${s.id}"><i class="hr-mk"></i><div class="hr-t"><b>${esc(s.title)}</b><small>${esc(s.subtitle || ' ')}</small></div><span class="hr-bpm">${fmtBpm(s)}</span></div>`);
    if (!rows.length) {
      rows.push(`<div class="hr-empty">${this.query ? '見つかりませんでした' : this.folder !== null ? 'このフォルダには曲がありません' : 'まだ曲がありません。左下の読み込み（↓）で .tja・.zip・音源を入れるか、＋で新しく作れます'}</div>`);
    }
    this.list.innerHTML = rows.join('');

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
        <div class="hdx-acts"><button class="hdx-an" data-analyze="${s.id}" aria-label="譜面分析"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>分析</button><button class="hdx-edit" data-edit="${s.id}">編集</button><button class="hdx-play" data-play="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>プレイ</button></div>`;
    } else {
      this.detail.innerHTML = `<div class="hdx-empty"><b>曲を選んでください</b><small>.tja・.zip・音源ファイルから読み込めます</small><button class="hdx-play" data-h="import">読み込む</button></div>`;
    }

    (document.getElementById('homeSort') as HTMLElement).textContent = SORT_LABEL[this.sort];
    (document.getElementById('homePath') as HTMLElement).textContent = this.query ? `「${this.query}」` : this.folder ?? 'すべて';
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
      if (!name) return;
      await addFolder(name);
      await this.reload();
      this.folder = name;
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
    void this.preview.play().catch(() => { this.playing = false; this.paintPlayer(); });
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
    const moves: [string, () => Promise<void>][] = [
      ...(s.folder ? [['一番上へ出す', async () => { await moveSong(id, ''); await this.select(id); }] as [string, () => Promise<void>]] : []),
      ...this.folders.filter((f) => f !== s.folder).map((f) => [`「${f}」へ移す`, async () => { await moveSong(id, f); await this.select(id); }] as [string, () => Promise<void>]),
    ];
    this.popup(anchor, [
      ...moves,
      ['新しいフォルダへ移す…', async () => {
        const name = prompt('新しいフォルダの名前')?.trim();
        if (!name) return;
        await addFolder(name);
        await moveSong(id, name);
        await this.select(id);
      }],
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
        if (!confirm(`フォルダ「${name}」を消しますか？（中の曲は一番上に出ます）`)) return;
        await deleteFolder(name);
        await this.reload();
        this.render();
      }, true],
    ]);
  }
}

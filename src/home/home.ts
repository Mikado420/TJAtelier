/**
 * 最初の画面（曲選択）。左にロゴと集めた王冠、真ん中にフォルダの帯（タップで下に中の曲が開く）。
 * 選んだフォルダの帯には名前の変更・削除、選んだ曲の帯には試聴・エディタ・譜面情報・「この曲にする」。
 */
import type { AudioEngine } from '../audio/audio';
import { closeCurtain, holdCurtain, openCurtain } from '../ui/curtain';
import { uiScale } from '../orient';
import {
  addFolder, addToFolder, deleteFolder, deleteSong, folderParents, inFolderTree, listFolderColors,
  listFolders, listSongs, loadSongAudio, removeFromFolder, renameFolder, type SongEntry,
} from '../io/library';

export interface HomeHost {
  /** 曲を開く（編集・プレイ）。course を渡すとその難易度で */
  open(id: string, mode: 'edit' | 'play', course?: string): Promise<void>;
  /** 難易度えらびに出す、プレイの設定（ハイスピード・オート） */
  playOpts(): { speed: number; auto: boolean };
  setPlayOpt(key: 'speed' | 'auto', v: number | boolean): void;
  /** ファイルを選んで読み込む（読み込んだ曲は一覧に入る） */
  importFiles(): void;
  /** 新しい譜面を作って開く */
  create(folder: string): Promise<void>;
  settings(): void;
  /** オンライン対戦の画面を開く */
  online(): void;
  /** 譜面情報を出す */
  analyze(id: string): void;
  toast(msg: string): void;
  /** 試聴を鳴らす音の仕組み */
  audio: AudioEngine;
  /** オンライン作業（入ったことのある部屋・部屋を作る） */
  collab?: {
    list(): { id: string; title: string; role: 'edit' | 'view'; at: number }[];
    open(id: string): void;
    /** 部屋をさがす・作る画面 */
    lobby(): void;
    forget(id: string): void;
    share(songId: string): void;
    /** その曲を共有したプロジェクト */
    sharedOf(songId: string): string | undefined;
  };
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
const COURSE_ORDER = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit'];
const COURSE_COLOR: Record<string, string> = { Easy: 'var(--c-easy)', Normal: 'var(--c-normal)', Hard: 'var(--c-hard)', Oni: 'var(--c-oni)', Edit: 'var(--c-edit)' };
const sortCourses = (cs: SongEntry['courses']) => [...cs].sort((a, b) => (COURSE_ORDER.indexOf(a.name) + 99) % 99 - (COURSE_ORDER.indexOf(b.name) + 99) % 99);
const LAST_COURSE = 'malody-web:lastCourse';
const BEST = 'malody-web:best';
export type Crown = 'allgood' | 'fc' | 'clear' | 'fail';
/** 自己ベスト（曲・難易度ごと） */
export function loadBest(id: string, course: string): { score: number; crown: Crown } | null {
  try { return (JSON.parse(localStorage.getItem(BEST) ?? '{}') as Record<string, { score: number; crown: Crown }>)[`${id}:${course}`] ?? null; } catch { return null; }
}
const CROWN_RANK: Record<Crown, number> = { fail: 0, clear: 1, fc: 2, allgood: 3 };
/** 遊んだ記録を残す（点数・王冠はそれぞれ良いほうを残す） */
export function saveBest(id: string, course: string, score: number, crown: Crown) {
  try {
    const m = JSON.parse(localStorage.getItem(BEST) ?? '{}') as Record<string, { score: number; crown: Crown }>;
    const k = `${id}:${course}`;
    const p = m[k];
    m[k] = { score: Math.max(score, p?.score ?? 0), crown: !p || CROWN_RANK[crown] > CROWN_RANK[p.crown] ? crown : p.crown };
    localStorage.setItem(BEST, JSON.stringify(m));
  } catch { /* 保存できない */ }
}
function rememberCourse(id: string, c: string) {
  try {
    const m = JSON.parse(localStorage.getItem(LAST_COURSE) ?? '{}') as Record<string, string>;
    m[id] = c;
    localStorage.setItem(LAST_COURSE, JSON.stringify(m));
  } catch { /* 保存できない */ }
}

/** 「未分類」（どのフォルダにも入っていない曲）を表す、フォルダ名には使えない値 */
const UNCAT = '\uE000uncat'; // HTML の属性に入れても変わらない文字（\u0000 は属性に入れると別の文字に置き換わる）
/** 「すべて」の帯を表す値 */
const ALL = '\uE000all';
const FOLDER_COLORS = ['#3a7ca5', '#7b4bd0', '#c8337e', '#1fa59a', '#e8603c', '#c9a227', '#5a8f3c', '#b3477a'];
/** フォルダごとの色（すべては青、未分類は灰色、ほかは名前から決まる） */
function folderColor(key: string, custom?: Record<string, string>) {
  if (key === ALL) return '#4d9fbe';
  if (key === UNCAT) return '#5a6670';
  // genre.ini の GenreColor で決まった色
  if (custom?.[key]) return custom[key];
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_COLORS[h % FOLDER_COLORS.length];
}
/** 明るい色か（その上の文字を黒にする） */
function isLight(hex: string) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.45;
}
/** 曲の行に出す王冠: 王冠のある難易度のうち、いちばん難しいもの（かんたん→ふつう→むずかしい→おに→裏おに） */
function topCrown(m: Record<string, { crown: Crown }>, s: SongEntry): Crown | null {
  let r: Crown | null = null;
  for (const c of sortCourses(s.courses)) {
    const b = m[`${s.id}:${c.name}`];
    if (b && b.crown !== 'fail') r = b.crown;
  }
  return r;
}
/** 王冠の印（全良は虹色、フルコンボは金、クリアは銀） */
const crownIcon = (c: Crown | null | undefined, cls = '') => (c && c !== 'fail' ? `<i class="crn cr-${c} ${cls}" aria-label="${c === 'allgood' ? '全良' : c === 'fc' ? 'フルコンボ' : 'クリア'}"></i>` : '');
const STAT_MODE = 'malody-web:statMode';
const STAT_MODES: { label: string; color: string; courses: string[] | null }[] = [
  { label: '曲ごと', color: 'var(--accent)', courses: null },
  { label: 'かんたん', color: 'var(--c-easy)', courses: ['Easy'] },
  { label: 'ふつう', color: 'var(--c-normal)', courses: ['Normal'] },
  { label: 'むずかしい', color: 'var(--c-hard)', courses: ['Hard'] },
  { label: 'おに・裏おに', color: 'var(--c-oni)', courses: ['Oni', 'Edit'] },
];
function bestMap(): Record<string, { score: number; crown: Crown }> {
  try { return JSON.parse(localStorage.getItem(BEST) ?? '{}'); } catch { return {}; }
}

/** 背景の動画がある曲の印 */
const VIDEO_ICON = '<svg class="hr-vid" viewBox="0 0 24 24" role="img" aria-label="動画あり"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3z"/></svg>';

const ICON = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v10H3z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>',
};

export class Home {
  private readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly foldersEl: HTMLElement;
  private songs: SongEntry[] = [];
  private folders: string[] = [];
  /** フォルダの色（genre.ini の GenreColor） */
  private colors: Record<string, string> = {};
  /** 中の曲を見ているフォルダ（null は「すべて」、UNCAT は「未分類」） */
  private folder: string | null = null;
  /** folder の帯を開いて、下に曲を並べているか */
  private open = false;
  /** 合作の帯を開いているか */
  private collabOpen = false;
  /** 選んでいる帯（フォルダの帯なら 'folder'、曲なら 'song'） */
  private focus: 'folder' | 'song' = 'folder';
  /** 選んでいるフォルダの帯（ALL・UNCAT・フォルダ名） */
  private fbar = ALL;
  /** 曲を選んでまとめてフォルダに入れる・外すとき（選んでいる曲） */
  private picking: Set<string> | null = null;
  /** 自動で鳴らせなかったので、次のタップで鳴らす */
  private pendingPreview = false;
  private sel: string | null = null;
  private sort: Sort = 'updated';
  private query = '';
  /** 試聴している曲（読み込み中も） */
  private previewId = '';
  private playing = false;
  /** 一時停止した位置（秒） */
  private pausedAt = -1;

  constructor(private readonly host: HomeHost) {
    this.el = document.getElementById('home')!;
    this.list = document.getElementById('homeList')!;
    this.foldersEl = document.getElementById('homeFolders')!;
    const q = document.getElementById('homeQuery') as HTMLInputElement;
    q.addEventListener('input', () => { this.query = q.value.trim(); this.render(); });
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.list.addEventListener('scroll', () => this.onListScroll(), { passive: true });
    // 触れた瞬間に音を鳴らせる状態にする（iPhone はタップの中でないと音を出し始められない）
    this.el.addEventListener('pointerdown', () => {
      const ctx = this.host.audio.ctx;
      if (ctx.state !== 'running') void ctx.resume();
      if (this.pendingPreview) {
        this.pendingPreview = false;
        const s = this.focus === 'song' ? this.songs.find((x) => x.id === this.sel) : undefined;
        if (s && !this.playing) void this.startPreview(s);
      }
    }, true);
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
        this.openOn();
      }
    }
    this.render(true);
    // 曲を選んでいるときだけ、その曲の試聴を流す（自動で鳴らせないときは、次に触れたときに）
    const s = this.focus === 'song' ? this.songs.find((x) => x.id === this.sel) : undefined;
    if (s) void this.startPreview(s);
  }

  hide() {
    this.el.classList.add('hidden');
    document.getElementById('homeDiff')?.classList.add('hidden');
    this.stopPreview();
  }

  async reload() {
    this.songs = await listSongs();
    this.folders = await listFolders();
    this.colors = await listFolderColors();
    // 曲が入っているのに一覧に無いフォルダも出す
    for (const s of this.songs) for (const f of s.folders) if (!this.folders.includes(f)) this.folders.push(f);
    // フォルダの中のフォルダ: 親のフォルダも出す
    for (const f of [...this.folders]) for (const p of folderParents(f)) if (!this.folders.includes(p)) this.folders.push(p);
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
      this.openOn();
    }
    this.render(true);
    if (e) void this.startPreview(e);
  }

  /** 読み込んだ曲: 一覧を読み直すだけ（フォルダは開いている所のまま。今のフォルダに見えていれば選ぶ） */
  async added(id: string) {
    await this.reload();
    const e = this.songs.find((x) => x.id === id);
    if (e && this.open && this.inView(e)) {
      this.sel = id;
      this.focus = 'song';
    }
    this.render(true);
  }

  /** 今のフォルダを開いて、その曲を選んだ状態にする */
  private openOn() {
    this.open = true;
    this.focus = 'song';
    this.fbar = this.folder === null ? ALL : this.folder;
  }

  private keyOf(f: string | null) { return f === null ? ALL : f; }
  /** 帯に出す名前（フォルダの中のフォルダは、いちばん下の名前） */
  private folderName(key: string) { return key === ALL ? 'すべて' : key === UNCAT ? '未分類' : key.split('/').pop()!; }
  /** フォルダ（中のフォルダも含む）に入っている曲 */
  private folderSongs(key: string) {
    return key === ALL ? this.songs : key === UNCAT ? this.songs.filter((x) => !x.folders.length) : this.songs.filter((x) => x.folders.some((f) => inFolderTree(f, key)));
  }
  /** すぐ下のフォルダ */
  private childFolders(key: string) {
    return this.folders.filter((f) => f.startsWith(`${key}/`) && !f.slice(key.length + 1).includes('/')).sort((a, b) => a.localeCompare(b, 'ja'));
  }
  /** 開いているフォルダと、その親たち */
  private openChain(): Set<string> {
    if (!this.open) return new Set();
    const k = this.keyOf(this.folder);
    return new Set(k === ALL || k === UNCAT ? [k] : [...folderParents(k), k]);
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

  private render(scrollToSel = false, listToo = true) {
    const songs = this.shown();
    // 左: 集めた王冠の数（重ならない数え方。タップで 曲ごと → かんたん → ふつう → むずかしい → おに・裏おに）
    const bm = bestMap();
    this.foldersEl.innerHTML = this.statHtml(bm);

    const pk = this.picking;
    if (listToo) {
      const tags = (s: SongEntry) => (this.folder === null || this.query ? s.folders : s.folders.filter((f) => f !== this.folder));
      const songRow = (s: SongEntry, inner: string) => {
        const cs = sortCourses(s.courses);
        const top = cs.length ? Math.max(...cs.map((c) => c.level)) : 0;
        const cr = topCrown(bm, s);
        // 詳しいところ（難易度・操作のボタン）は、選んでいる曲の帯にだけ入れる（曲が多くても軽いように）
        const on = s.id === this.sel && this.focus === 'song' && !pk;
        const d = on ? this.rowDetail(s, bm) : { x: '', acts: '' };
        return `<div class="hr ${inner ? 'in' : ''} ${on ? 'on' : ''} ${pk?.has(s.id) ? 'pk' : ''}" data-song="${s.id}" ${inner ? `style="--fc:${inner}"` : ''}>${pk ? `<i class="hr-ck">${pk.has(s.id) ? '✓' : ''}</i>` : (cr ? crownIcon(cr, 'hr-crn') : '<i class="hr-mk"></i>')}<div class="hr-t"><b>${esc(s.title)}${s.video ? VIDEO_ICON : ''}${this.host.collab?.sharedOf(s.id) ? '<i class="hr-share" title="オンライン作業の部屋あり">👥</i>' : ''}</b><small>${esc(s.subtitle || ' ')}${tags(s).length ? ` <span class="hr-tags">${tags(s).map((f) => `<em>${esc(f.replace(/\//g, ' › '))}</em>`).join('')}</span>` : ''}</small>${d.x}</div><span class="hr-bpm">${top ? `★${top}` : ''}</span>${d.acts}</div>`;
      };
      const rows: string[] = [];
      if (this.query) {
        // 検索中: フォルダの帯は出さず、見つかった曲だけ
        for (const x of songs) rows.push(songRow(x, ''));
        if (!rows.length) rows.push('<div class="hr-empty">見つかりませんでした</div>');
      } else {
        // フォルダの帯（すべて・未分類・作ったフォルダ）。開いている帯の下に、中のフォルダと曲（フォルダの中のフォルダは字下げ）
        const chain = this.openChain();
        const deepest = this.open ? this.keyOf(this.folder) : '';
        const ic = (d: string) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
        const bar = (k: string, dp: number) => {
          const n = this.folderSongs(k).length;
          const col = folderColor(k, this.colors);
          // 明るい色の帯（選んだとき）は、文字を黒に
          const ft = isLight(col) ? '#1b1f23' : '#fff';
          const isOpen = chain.has(k);
          const on = this.focus === 'folder' && k === this.fbar && !pk;
          const user = k !== ALL && k !== UNCAT;
          const acts = pk ? '' : `<span class="hfb-acts">${user
            ? `<button data-fsub="${esc(k)}" aria-label="中にフォルダを作る">${ic('M3 6.5h6l2 2h10v10H3zM12 11v6M9 14h6')}<small>フォルダ</small></button><button data-frename="${esc(k)}" aria-label="名前を変える">${ic('M4 20h4L19 9l-4-4L4 16z')}<small>名前</small></button><button data-fdel="${esc(k)}" aria-label="フォルダを消す">${ic('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13')}<small>消す</small></button>`
            : ''}</span>`;
          rows.push(`<div class="hr hfb ${on ? 'on' : ''} ${isOpen ? 'open' : ''} ${k === UNCAT ? 'hf-uncat' : ''}" data-fbar="${esc(k)}" style="--fc:${col};--ft:${ft};--dp:${dp}"><svg class="hfb-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h6l2 2h10v10H3z"/></svg><span class="hfb-n">${esc(this.folderName(k))}</span><small>${n}<span> 曲</span></small>${acts}<i class="hfb-ar" aria-hidden="true"></i></div>`);
          if (!isOpen) return;
          const kids = user ? this.childFolders(k) : [];
          for (const c of kids) bar(c, dp + 1);
          if (k !== deepest) return;
          for (const x of songs) rows.push(songRow(x, col).replace('data-song=', `data-dp="${dp + 1}" data-song=`).replace('style="--fc:', `style="--dp:${dp + 1};--fc:`));
          if (!songs.length && !kids.length) rows.push(`<div class="hr-empty in" style="--fc:${col};--dp:${dp + 1}">${k === UNCAT ? '未分類の曲はありません' : k === ALL ? 'まだ曲がありません' : 'このフォルダには曲がありません'}</div>`);
        };
        // 合作: 参加しているプロジェクト（タップで開く）
        const cl = this.host.collab?.list() ?? [];
        if (this.host.collab && !pk) {
          const col = '#e8a33c';
          rows.push(`<div class="hr hfb ${this.collabOpen ? 'open' : ''}" data-collabbar style="--fc:${col};--dp:0"><svg class="hfb-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/><circle cx="17" cy="9" r="2.6"/><path d="M16 14.2c2.6.2 4.6 2 5.3 5"/></svg><span class="hfb-n">オンライン作業</span><small>${cl.length}<span> 部屋</span></small><i class="hfb-ar" aria-hidden="true"></i></div>`);
          if (this.collabOpen) {
            for (const p of cl) {
              const d = new Date(p.at);
              rows.push(`<div class="hr in hc-row" data-collab="${esc(p.id)}" style="--dp:1;--fc:${col}"><i class="hr-mk"></i><div class="hr-t"><b>${esc(p.title || '（無題）')}</b><small>${esc(p.id)} ・ ${p.role === 'view' ? '見学' : 'メンバー'} ・ ${d.getMonth() + 1}/${d.getDate()} に開いた</small></div><span class="hr-ib"><button data-collabopen="${esc(p.id)}" aria-label="開く"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg><small>開く</small></button><button data-collabdel="${esc(p.id)}" aria-label="一覧から外す">${ICON.more}</button></span></div>`);
            }
            rows.push(`<div class="hr hfb hfb-add" data-collabjoin style="--dp:1"><span class="hfb-n">＋ 部屋をさがす・作る</span></div>`);
          }
        }
        for (const k of [ALL, UNCAT, ...this.folders.filter((f) => !f.includes('/')).sort((a, b) => a.localeCompare(b, 'ja'))]) bar(k, 0);
        if (!pk) rows.push('<div class="hr hfb hfb-add" data-h="folder"><span class="hfb-n">＋ 新しいフォルダ</span></div>');
      }
      this.list.innerHTML = rows.join('');
      this.list.classList.toggle('picking', !!pk);
    }

    // 選んでいるとき: 一覧の下に「すべて選択」「完了」、右の面に選んだ曲と操作
    const bar = document.getElementById('homePick')!;
    bar.classList.toggle('hidden', !pk);
    if (pk) {
      const allOn = songs.length > 0 && songs.every((x) => pk.has(x.id));
      const inFolder = this.folder !== null && this.folder !== UNCAT && !this.query;
      const off = pk.size ? '' : 'disabled';
      bar.innerHTML = `
        <button data-pk="all" class="pk-all ${allOn ? 'on' : ''}"><i class="hr-ck">${allOn ? '✓' : ''}</i>${allOn ? '選択を解除' : 'すべて選択'}</button>
        <span class="pk-hint">${pk.size ? `<b>${pk.size}</b> 曲` : ''}</span>
        <button data-pk="add" ${off}>フォルダに入れる</button>
        ${inFolder ? `<button data-pk="move" ${off}>移す</button><button data-pk="remove" ${off}>外す</button>` : `<button data-pk="clear" ${off}>未分類に戻す</button>`}
        <button data-pk="delete" class="bad" ${off}>削除</button>
        <button data-pk="done" class="pk-done">完了</button>`;
    }
    this.el.classList.toggle('home-picking', !!pk);
    const pb = document.getElementById('homePickBtn') as HTMLElement;
    pb.classList.toggle('on', !!pk);
    pb.querySelector('small')!.textContent = pk ? '完了' : '選択';

    (document.getElementById('homeSort') as HTMLElement).textContent = SORT_LABEL[this.sort];
    const path = document.getElementById('homePath') as HTMLElement;
    if (this.query) path.textContent = `「${this.query}」`;
    else if (this.open) path.innerHTML = `<span class="hp-dim">フォルダ ›</span> ${esc(this.folderName(this.keyOf(this.folder)))}`;
    else path.textContent = 'フォルダ';
    (document.getElementById('homeCount') as HTMLElement).textContent = this.query || this.open ? `${songs.length} 曲` : `${this.folders.length + 2} フォルダ`;
    // 端の曲もまんなかまで来られるよう、上下に余白
    const pad = `${Math.max(0, this.list.clientHeight / 2 - 26)}px`;
    this.list.style.paddingTop = pad;
    this.list.style.paddingBottom = pad;
    if (scrollToSel) this.centerSel(false);
    this.paintPlayer();
    this.paintCurve();
  }

  // ---------- 左: 集めた王冠 ----------

  /** 0 = 曲ごと、1〜4 = 難易度ごと */
  private statMode = (() => { try { return Math.max(0, Math.min(4, Number(localStorage.getItem(STAT_MODE)) || 0)); } catch { return 0; } })();
  private statAnim = 0;

  private statHtml(bm: Record<string, { score: number; crown: Crown }>) {
    const m = STAT_MODES[this.statMode];
    const cnt: Record<Crown | 'none', number> = { allgood: 0, fc: 0, clear: 0, fail: 0, none: 0 };
    let total = 0;
    if (!m.courses) {
      // 曲ごと: 曲の行と同じく、王冠のある難易度のうちいちばん難しいものの王冠
      for (const x of this.songs) { total++; cnt[topCrown(bm, x) ?? 'none']++; }
    } else {
      // 難易度ごと: その難易度の譜面ひとつずつ
      for (const x of this.songs) for (const c of x.courses) {
        if (!m.courses.includes(c.name)) continue;
        total++;
        const r = bm[`${x.id}:${c.name}`]?.crown;
        cnt[r && r !== 'fail' ? r : 'none']++;
      }
    }
    const rows: [Crown | 'none', string][] = [['allgood', '全良'], ['fc', 'フルコンボ'], ['clear', 'クリア'], ['none', '未クリア']];
    const bar = rows.map(([k]) => (cnt[k] ? `<i class="cr-${k}" style="flex:${cnt[k]}"></i>` : '')).join('');
    const dots = STAT_MODES.map((_, i) => `<i class="${i === this.statMode ? 'on' : ''}"></i>`).join('');
    const anim = this.statAnim ? ' cst-in' : '';
    this.statAnim = 0;
    return `<button class="cst" data-stat style="--sc:${m.color}" aria-label="あつめた王冠（タップで切り替え）">
      <span class="cst-h"><small>あつめた王冠</small><span class="cst-dots">${dots}</span></span>
      <span class="cst-body${anim}">
        <span class="cst-mode"><em>${m.label}</em><span class="cst-tot"><b>${total}</b><small>${m.courses ? '譜面' : '曲'}</small></span></span>
        <span class="cst-bar">${bar || '<i class="cr-none" style="flex:1"></i>'}</span>
        ${rows.map(([k, l]) => `<span class="cst-r cr-${k}"><i aria-hidden="true"></i><span>${l}</span><b>${cnt[k]}</b></span>`).join('')}
      </span>
    </button>`;
  }

  private nextStat() {
    this.statMode = (this.statMode + 1) % STAT_MODES.length;
    try { localStorage.setItem(STAT_MODE, String(this.statMode)); } catch { /* 保存できない */ }
    this.statAnim = 1;
    this.foldersEl.innerHTML = this.statHtml(bestMap());
  }

  // ---------- まんなかの縦リスト ----------

  /** 選んでいる曲をリストのまんなかへ */
  private centerSel(smooth: boolean) {
    const row = this.list.querySelector<HTMLElement>('.hr.on');
    if (!row) return;
    const top = row.offsetTop - (this.list.clientHeight - row.offsetHeight) / 2;
    this.ignoreScroll = performance.now() + (smooth ? 500 : 120);
    this.list.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
  }

  private ignoreScroll = 0;
  private scrollTimer = 0;
  private curveRaf = 0;

  /** スクロールしたら: 帯をまんなかからの距離で右へずらす（弧のように）。止まったら、まんなかの曲を選ぶ */
  private onListScroll() {
    if (!this.curveRaf) this.curveRaf = requestAnimationFrame(() => { this.curveRaf = 0; this.paintCurve(); });
    clearTimeout(this.scrollTimer);
    if (this.picking) return;
    this.scrollTimer = window.setTimeout(() => {
      if (performance.now() < this.ignoreScroll) return;
      const mid = this.list.scrollTop + this.list.clientHeight / 2;
      let best: HTMLElement | null = null;
      let bd = Infinity;
      for (const r of Array.from(this.list.querySelectorAll<HTMLElement>('.hr[data-song], .hr[data-fbar]'))) {
        const d = Math.abs(r.offsetTop + r.offsetHeight / 2 - mid);
        if (d < bd) { bd = d; best = r; }
      }
      const id = best?.dataset.song;
      const fb = best?.dataset.fbar;
      if (id && (id !== this.sel || this.focus !== 'song')) this.selectRow(id, false);
      else if (fb && (fb !== this.fbar || this.focus !== 'folder')) this.selectBar(fb, false);
    }, 140);
  }

  private paintCurve() {
    const L = this.list;
    const mid = L.scrollTop + L.clientHeight / 2;
    const h = Math.max(1, L.clientHeight / 2);
    // 先に位置を全部読んでから書く（読む・書くを交互にすると、そのたびに配置の計算が走って重い）
    const rows = Array.from(L.querySelectorAll<HTMLElement>('.hr'));
    const ds: [HTMLElement, string][] = [];
    for (const r of rows) {
      const c = r.offsetTop + r.offsetHeight / 2;
      if (Math.abs(c - mid) > L.clientHeight) continue;
      ds.push([r, Math.min(1.4, Math.abs(c - mid) / h).toFixed(2)]);
    }
    for (const [r, d] of ds) if (r.style.getPropertyValue('--d') !== d) r.style.setProperty('--d', d);
  }

  /** 選んでいる曲の帯に入れる、難易度のチップと操作のボタン */
  private rowDetail(s: SongEntry, bm: Record<string, { crown: Crown }>) {
    const cs = sortCourses(s.courses);
    const chips = cs.map((c) => `<span class="hc" style="--cc:${COURSE_COLOR[c.name] ?? 'var(--btn)'}">${crownIcon(bm[`${s.id}:${c.name}`]?.crown)}${esc(COURSE_SHORT[c.name] ?? c.name)}<b>${c.level}</b></span>`).join('');
    return {
      x: `<span class="hr-x"><span class="hr-meta">BPM ${fmtBpm(s)}　${fmtLen(s.length)}</span><span class="hr-cs">${chips}</span></span>`,
      acts: `<span class="hr-acts">
          <span class="hr-ib"><button data-h="pp" aria-label="試聴"></button><button data-edit="${s.id}" aria-label="エディタで開く"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg><small>エディタ</small></button><button data-analyze="${s.id}" aria-label="譜面情報"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><small>譜面情報</small></button><button data-smore="${s.id}" aria-label="曲の操作">${ICON.more}</button></span>
          <button class="hr-go" data-pickdiff="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>この曲にする</button></span>`,
    };
  }

  /** 曲を選ぶ（一覧を作り直さずに、選んでいる帯と右の面だけ変える） */
  private selectRow(id: string, scroll: boolean) {
    this.sel = id;
    this.focus = 'song';
    this.list.querySelectorAll('.hr.on').forEach((r) => r.classList.remove('on'));
    this.list.querySelectorAll('.hr-x, .hr-acts').forEach((x) => x.remove());
    const row = this.list.querySelector<HTMLElement>(`[data-song="${id}"]`);
    const s0 = this.songs.find((q) => q.id === id);
    if (row && s0 && !this.picking) {
      const d = this.rowDetail(s0, bestMap());
      row.querySelector('.hr-t')?.insertAdjacentHTML('beforeend', d.x);
      row.insertAdjacentHTML('beforeend', d.acts);
    }
    row?.classList.add('on');
    this.render(false, false);
    // 選んだ帯が広がるので、まんなかへ寄せ直す
    if (scroll) this.centerSel(true);
    else requestAnimationFrame(() => this.centerSel(true));
    const s = this.songs.find((q) => q.id === id);
    if (s) void this.startPreview(s);
  }

  /** フォルダの帯を選ぶ（開け閉めはしない） */
  private selectBar(key: string, scroll: boolean) {
    this.fbar = key;
    this.focus = 'folder';
    // フォルダを選んでいるあいだは曲を鳴らさない
    this.stopPreview();
    this.list.querySelectorAll('.hr.on').forEach((r) => r.classList.remove('on'));
    this.list.querySelectorAll('.hr-x, .hr-acts').forEach((x) => x.remove());
    this.list.querySelector(`[data-fbar="${CSS.escape(key)}"]`)?.classList.add('on');
    this.render(false, false);
    if (scroll) this.centerSel(true);
    else requestAnimationFrame(() => this.centerSel(true));
  }

  /** フォルダの帯を開く・閉じる（ほかの帯は閉じる） */
  private toggleFolder(key: string) {
    const isOpen = this.openChain().has(key);
    this.fbar = key;
    this.focus = 'folder';
    this.host.audio.playUi('folder');
    // フォルダを選んでいるあいだは曲を鳴らさない
    this.stopPreview();
    if (isOpen) {
      // 閉じる: 親のフォルダがあれば、そこを開いたままにする
      const parent = key === ALL || key === UNCAT ? undefined : folderParents(key).pop();
      if (parent) this.folder = parent;
      else this.open = false;
    } else {
      this.folder = key === ALL ? null : key;
      this.open = true;
    }
    this.render(false);
    this.centerSel(true);
  }

  private async deleteFolderAsk(name: string) {
    const kids = this.folders.some((f) => f.startsWith(`${name}/`));
    if (!confirm(`フォルダ「${name.replace(/\//g, ' › ')}」を消しますか？（${kids ? '中のフォルダもいっしょに消えます。' : ''}曲は消えず、フォルダから外れるだけです）`)) return;
    await deleteFolder(name);
    if (this.folder && inFolderTree(this.folder, name)) {
      const parent = folderParents(name).pop();
      this.folder = parent ?? null;
      this.open = !!parent;
    }
    this.fbar = this.folder ?? ALL;
    this.focus = 'folder';
    await this.reload();
    this.render(true);
  }

  /** フォルダの中に新しいフォルダを作る */
  private async newSubfolder(parent: string) {
    const name = await this.askName(`「${this.folderName(parent)}」の中に新しいフォルダ`, '', '作る');
    if (!name) return;
    const path = `${parent}/${name}`;
    await addFolder(path);
    await this.reload();
    this.folder = parent;
    this.open = true;
    this.fbar = path;
    this.focus = 'folder';
    this.render(true);
  }

  // ---------- 難易度えらび ----------

  private diffSong: SongEntry | null = null;
  /** 選んでいる難易度（'' = まだ選んでいない） */
  private diffCourse = '';
  /** おにの枠を裏おに（Edit）にしているか */
  private diffUra = false;

  private openDiff(id: string) {
    const s = this.songs.find((x) => x.id === id);
    if (!s || !s.courses.length) { this.host.toast('譜面がありません'); return; }
    this.diffSong = s;
    this.diffCourse = '';
    // おにが無く裏おにだけある曲は、おにの枠に最初から裏おにを出す
    this.diffUra = !s.courses.some((c) => c.name === 'Oni') && s.courses.some((c) => c.name === 'Edit');
    this.paintDiff();
    const el = document.getElementById('homeDiff')!;
    el.classList.remove('hidden');
    void el.offsetWidth;
    el.classList.add('on');
  }

  private closeDiff() {
    const el = document.getElementById('homeDiff')!;
    el.classList.remove('on');
    setTimeout(() => { if (!el.classList.contains('on')) el.classList.add('hidden'); }, 260);
    this.diffSong = null;
  }

  /** 並べる枠（かんたん・ふつう・むずかしい・おに）。おにの枠は裏おにと入れ替わる */
  private diffSlots(s: SongEntry) {
    const has = (n: string) => s.courses.find((c) => c.name === n);
    // 4 枚いつも並べる。無い難易度は灰色（level = -1）で、選べない
    const slots: { slot: string; name: string; level: number }[] = [];
    for (const n of ['Easy', 'Normal', 'Hard']) {
      const c = has(n);
      slots.push({ slot: n, name: n, level: c ? c.level : -1 });
    }
    const oni = has('Oni');
    const ura = has('Edit');
    const show = this.diffUra && ura ? ura : oni ?? ura;
    slots.push(show ? { slot: 'Oni', name: show.name, level: show.level } : { slot: 'Oni', name: 'Oni', level: -1 });
    return { slots, canUra: !!(oni && ura) };
  }

  private paintDiff(flipIn = false) {
    const s = this.diffSong;
    if (!s) return;
    const o = this.host.playOpts();
    const { slots, canUra } = this.diffSlots(s);
    const sel = slots.find((x) => x.name === this.diffCourse && x.level >= 0);
    const bars = (n: number) => [0, 1, 2].map((k) => `<rect x="${8 + k * 12}" y="${30 - k * 9}" width="7" height="${10 + k * 9}" fill="${k < n ? '#fff' : 'rgba(255,255,255,0.3)'}"/>`).join('');
    const ICON_D: Record<string, string> = {
      Easy: bars(1), Normal: bars(2), Hard: bars(3),
      Oni: '<path d="M6 40 L10 14 L18 26 L24 8 L30 26 L38 14 L42 40 Z" fill="#fff"/>',
      Edit: '<path d="M6 40 L10 14 L18 26 L24 8 L30 26 L38 14 L42 40 Z" fill="#1d2023" stroke="#fff" stroke-width="2.5"/>',
    };
    const DARK: Record<string, string> = { Easy: '#9c3a20', Normal: '#4f7a1e', Hard: '#11615a', Oni: '#7a1a4a', Edit: '#2e1660' };
    const cards = slots.map((c) => {
      const none = c.level < 0;
      const on = !none && c.name === this.diffCourse;
      const meter = Array.from({ length: 10 }, (_, k) => `<i class="${k < c.level ? 'on' : ''}"></i>`).join('');
      const label = c.name === 'Edit' ? 'おに（裏）' : COURSE_SHORT[c.name] ?? c.name;
      const cb = none ? null : loadBest(s.id, c.name);
      return `<button class="hdf-card ${on ? 'on' : ''} ${none ? 'none' : ''} ${flipIn && c.slot === 'Oni' ? 'fin' : ''} ${c.name === 'Edit' ? 'ura' : ''}" data-dcourse="${esc(c.name)}" data-slot="${c.slot}" style="--cc:${COURSE_COLOR[c.name] ?? 'var(--btn)'};--cd:${DARK[c.name] ?? '#222'}">
        <svg viewBox="0 0 48 48" aria-hidden="true">${ICON_D[c.name] ?? ''}</svg>
        <span>${esc(label)}</span><b>★${none ? '-' : c.level}</b><em class="hdf-meter">${meter}</em>
        ${c.slot === 'Oni' && canUra && c.name !== 'Edit' ? '<small class="hdf-uraok">裏あり</small>' : ''}
        ${c.name === 'Edit' ? '<small class="hdf-urab">裏</small>' : ''}
        ${crownIcon(cb?.crown, 'hdf-crn')}
        ${on ? '<u>1P</u>' : ''}</button>`;
    }).join('');
    const best = sel ? loadBest(s.id, sel.name) : null;
    const crownLabel: Record<string, string> = { allgood: '全良', fc: 'フルコンボ', clear: 'クリア', fail: '未クリア' };
    const info = sel
      ? `<span class="hdf-il">${esc(sel.name === 'Edit' ? 'おに（裏）' : COURSE_SHORT[sel.name] ?? sel.name)} ★${sel.level} の記録</span>
         <span class="hdf-il">自己ベスト</span><b class="hdf-best">${best ? best.score.toLocaleString() : '---'}</b>
         <span class="hdf-ir"><span>王冠</span><b class="cr-${best?.crown ?? 'none'}">${best ? crownLabel[best.crown] ?? '' : 'なし'}</b></span>`
      : '';
    const el = document.getElementById('homeDiff')!;
    el.classList.toggle('ura', this.diffUra && slots.some((x) => x.name === 'Edit'));
    el.innerHTML = `
      <div class="hdf-info" style="--cc:${sel ? COURSE_COLOR[sel.name] ?? 'var(--accent)' : 'var(--accent)'}">${info}</div>
      <div class="hdf-box" role="dialog" aria-label="むずかしさをえらぶ">
        <div class="hdf-head"><b>${esc(s.title)}</b><small>${esc(s.subtitle || '')}　BPM ${fmtBpm(s)}　${fmtLen(s.length)}</small></div>
        <div class="hdf-body">
          <div class="hdf-side">
            <button data-df="back" aria-label="曲えらびにもどる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg></button>
            <button data-df="opt" aria-label="設定"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg></button>
          </div>
          <div class="hdf-cards">${cards}</div>
        </div>
        <i class="hdf-flash"></i>
      </div>
      <div class="hdf-foot">
        <span class="hdf-tip"></span>
        <span class="hdf-opt">ハイスピード<button data-df="sp-" aria-label="ハイスピードを下げる">−</button><b>×${o.speed.toFixed(1)}</b><button data-df="sp+" aria-label="ハイスピードを上げる">＋</button></span>
        <button class="hdf-opt hdf-auto ${o.auto ? 'on' : ''}" data-df="auto">オート ${o.auto ? 'ON' : 'OFF'}</button>
        <button class="hdf-go" data-df="go" ${sel ? '' : 'disabled'}>はじめる</button>
      </div>`;
  }

  /** おにの枠をめくって、裏おに⇔おもてのおにを入れ替える */
  private async flipUra() {
    const el = document.getElementById('homeDiff')!;
    const card = el.querySelector<HTMLElement>('[data-slot="Oni"]');
    if (this.flipping || !card) return;
    this.flipping = true;
    card.classList.add('fout');
    await new Promise((r) => setTimeout(r, 180));
    this.diffUra = !this.diffUra;
    this.diffCourse = this.diffUra ? 'Edit' : 'Oni';
    this.paintDiff(true);
    const f = el.querySelector<HTMLElement>('.hdf-flash');
    if (f) { f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); }
    setTimeout(() => { this.flipping = false; }, 240);
  }

  private flipping = false;

  private async onDiffClick(t: HTMLElement) {
    const card = t.closest<HTMLElement>('[data-dcourse]');
    if (card) {
      if (card.classList.contains('none')) return; // 無い難易度
      const c = card.dataset.dcourse!;
      if (c === this.diffCourse) {
        // 選んでいるおにをもう一度: 裏おにがあれば入れ替える（無ければ何もしない）
        const s = this.diffSong;
        if (s && card.dataset.slot === 'Oni' && this.diffSlots(s).canUra) await this.flipUra();
        return;
      }
      this.diffCourse = c;
      this.paintDiff();
      return;
    }
    const b = t.closest<HTMLElement>('[data-df]');
    if (!b) {
      if (t.id === 'homeDiff') this.closeDiff();
      return;
    }
    const a = b.dataset.df!;
    const o = this.host.playOpts();
    if (a === 'back') this.closeDiff();
    else if (a === 'opt') this.host.settings();
    else if (a === 'sp-' || a === 'sp+') {
      const v = Math.round((o.speed + (a === 'sp+' ? 0.1 : -0.1)) * 10) / 10;
      this.host.setPlayOpt('speed', Math.max(0.1, Math.min(10, v)));
      this.paintDiff();
    } else if (a === 'auto') {
      this.host.setPlayOpt('auto', !o.auto);
      this.paintDiff();
    } else if (a === 'go' && this.diffCourse) await this.startSong();
  }

  private starting = false;

  /** 幕を閉じて、選んだ難易度で始める（始まったら幕を開ける） */
  private async startSong() {
    const s = this.diffSong;
    if (!s || this.starting) return;
    this.starting = true;
    const course = this.diffCourse;
    if (!course) return;
    rememberCourse(s.id, course);
    const lv = s.courses.find((c) => c.name === course)?.level ?? 0;
    this.stopPreview();
    try {
      await closeCurtain({ title: s.title, sub: s.subtitle, course: `${course === 'Edit' ? 'おに（裏）' : COURSE_SHORT[course] ?? course} ${lv}`, color: COURSE_COLOR[course] });
      this.closeDiff();
      // 曲名を 3 秒見せてから始める
      await holdCurtain(3000);
      await this.host.open(s.id, 'play', course);
    } finally {
      this.starting = false;
      void openCurtain();
    }
  }

  private onClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    const d = (sel: string) => t.closest<HTMLElement>(sel);
    let x: HTMLElement | null;
    if (d('#homeDiff')) { void this.onDiffClick(t); return; }
    if ((x = d('[data-pickdiff]'))) { this.openDiff(x.dataset.pickdiff!); return; }
    if ((x = d('[data-play]'))) { this.stopPreview(); void this.host.open(x.dataset.play!, 'play'); return; }
    if ((x = d('[data-edit]'))) { this.stopPreview(); void this.host.open(x.dataset.edit!, 'edit'); return; }
    if ((x = d('[data-analyze]'))) { this.host.analyze(x.dataset.analyze!); return; }
    if ((x = d('[data-smore]'))) { this.songMenu(x.dataset.smore!, x); return; }
    if (d('[data-collabbar]')) { this.collabOpen = !this.collabOpen; this.render(); return; }
    if (d('[data-collabjoin]')) { this.stopPreview(); this.host.collab?.lobby(); return; }
    if ((x = d('[data-h="online"]')) && this.host.collab) {
      // オンライン: 対戦（遊ぶ）と作業（いっしょに作る）は部屋の一覧が別
      const c = this.host.collab;
      this.popup(x, [
        ['オンライン対戦', () => { this.stopPreview(); this.host.online(); }],
        ['オンライン作業', () => { this.stopPreview(); c.lobby(); }],
      ]);
      return;
    }
    if ((x = d('[data-collabdel]'))) {
      const id = x.dataset.collabdel!;
      this.popup(x, [['自分の一覧から外す', () => { this.host.collab?.forget(id); this.render(); }, true]]);
      return;
    }
    if ((x = d('[data-collabopen]')) || (x = d('[data-collab]'))) { this.stopPreview(); this.host.collab?.open((x.dataset.collabopen ?? x.dataset.collab)!); return; }
    if (d('[data-stat]')) { this.nextStat(); return; }
    if ((x = d('[data-fopen]'))) { this.toggleFolder(x.dataset.fopen!); return; }
    if ((x = d('[data-fsub]'))) { void this.newSubfolder(x.dataset.fsub!); return; }
    if ((x = d('[data-frename]'))) { void this.renameFolderAsk(x.dataset.frename!); return; }
    if ((x = d('[data-fdel]'))) { void this.deleteFolderAsk(x.dataset.fdel!); return; }
    if ((x = d('[data-pk]'))) { void this.pickAction(x.dataset.pk!, x); return; }
    if ((x = d('[data-h]'))) { void this.action(x.dataset.h!); return; }
    if ((x = d('[data-fbar]'))) { this.toggleFolder(x.dataset.fbar!); return; }
    if ((x = d('[data-song]'))) {
      const id = x.dataset.song!;
      // 選んでいるとき: タップで選ぶ・外す
      if (this.picking) {
        if (this.picking.has(id)) this.picking.delete(id);
        else this.picking.add(id);
        this.render();
        return;
      }
      // まんなかの曲をもう一度タップで難易度えらび
      if (this.sel === id && this.focus === 'song') { this.openDiff(id); return; }
      this.selectRow(id, true);
    }
  }

  private async action(a: string) {
    if (a === 'import') this.host.importFiles();
    else if (a === 'settings') this.host.settings();
    else if (a === 'online') { this.stopPreview(); this.host.online(); }
    else if (a === 'new') {
      this.stopPreview();
      const f = this.focus === 'folder' && !this.query ? this.fbar : this.folder ?? '';
      await this.host.create(f === ALL || f === UNCAT ? '' : f);
    }
    else if (a === 'folder') {
      const name = await this.askName('新しいフォルダ', '', '作る');
      if (!name) return;
      await addFolder(name);
      await this.reload();
      this.folder = name;
      this.fbar = name;
      this.focus = 'folder';
      this.open = false;
      this.render(true);
    } else if (a === 'pick') {
      // 曲を選ぶので、選んでいるフォルダを開いておく
      if (!this.picking && !this.open && !this.query) { this.folder = this.fbar === ALL ? null : this.fbar; this.open = true; }
      this.picking = this.picking ? null : new Set();
      this.render(!this.picking);
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
      this.selectRow(list[j].id, true);
    } else if (a === 'pp') {
      if (this.playing) this.pausePreview();
      else {
        const s = this.songs.find((q) => q.id === this.sel);
        if (s) void this.startPreview(s, this.previewId === s.id && this.pausedAt >= 0 ? this.pausedAt : undefined);
      }
    }
  }

  // ---------- 試聴 ----------

  /** 試聴を流す（from を省くと DEMOSTART から） */
  /** この時刻（performance.now()）までは試聴を鳴らさない（起動のロゴの効果音のあいだ） */
  private previewHold = 0;
  holdPreview(until: number) {
    this.previewHold = until;
  }

  private async startPreview(s: SongEntry, from?: number) {
    const id = s.id;
    const A = this.host.audio;
    A.previewStop();
    this.previewId = id;
    this.pausedAt = -1;
    this.playing = false;
    this.paintPlayer();
    const a = await loadSongAudio(id);
    if (this.previewId !== id || !this.visible || !a) return;
    try {
      await A.previewLoad(id, a.data);
    } catch {
      return; // 読めない音源
    }
    if (this.previewId !== id || !this.visible) return;
    const start = Math.max(0, s.demoStart || 0);
    // まだ画面に触れていない（音を出せない）ときは、次に触れたときに鳴らす
    if (A.ctx.state !== 'running') {
      void A.ctx.resume();
      await new Promise((r) => setTimeout(r, 60));
      if ((A.ctx.state as string) !== 'running') { this.pendingPreview = true; return; }
    }
    if (this.previewId !== id || !this.visible) return;
    // 起動のロゴの効果音が終わるまで待つ
    const hold = this.previewHold - performance.now();
    if (hold > 0) {
      await new Promise((r) => setTimeout(r, hold));
      if (this.previewId !== id || !this.visible || this.playing) return;
    }
    A.previewStart(id, from ?? start, start);
    this.playing = true;
    this.paintPlayer();
  }

  private pausePreview() {
    this.pausedAt = this.host.audio.previewStop();
    this.playing = false;
    this.paintPlayer();
  }

  stopPreview() {
    this.previewId = '';
    this.pausedAt = -1;
    this.pendingPreview = false;
    this.host.audio.previewRelease();
    this.playing = false;
    this.paintPlayer();
  }

  private paintPlayer() {
    const html = this.playing
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
    this.el.querySelectorAll<HTMLElement>('[data-h="pp"]').forEach((b) => { b.innerHTML = `${html}<small>試聴</small>`; });
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
    // 画面の px を、中の px に戻す（PC で丸ごと拡大しているとき）
    const k = uiScale();
    pop.style.left = `${Math.max(8, Math.min((r.left - hr.left) / k, hr.width / k - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.min(hr.height / k - pop.offsetHeight - 8, (r.bottom - hr.top) / k + 4)}px`;
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
    const shared = this.host.collab?.sharedOf(id);
    const joined = shared && this.host.collab?.list().some((p) => p.id === shared);
    this.popup(anchor, [
      ...(this.host.collab ? [[joined ? 'この曲の作業部屋を開く' : 'オンライン作業の部屋を作る…', () => { this.stopPreview(); if (joined) this.host.collab!.open(shared!); else this.host.collab!.share(id); }] as [string, () => void]] : []),
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
      ...names.map((f) => [`${has(f) && !move ? '✓ ' : '　 '}${'　'.repeat(f.split('/').length - 1)}${f.split('/').pop()}`, async () => {
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
        const name = await this.askName('新しいフォルダ', '', '作って入れる');
        if (!name) return;
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
    if (a === 'done') { this.picking = null; this.render(true); return; }
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
    } else if (a === 'delete') {
      const names = this.songs.filter((x) => pk.has(x.id)).map((x) => `・${x.title}`);
      const shown = names.slice(0, 8).join('\n') + (names.length > 8 ? `\nほか ${names.length - 8} 曲` : '');
      if (!confirm(`${ids.length} 曲を削除しますか？\n${shown}\n\n譜面と音源がこのブラウザから消えます。元に戻せません。`)) return;
      if (this.sel && pk.has(this.sel)) { this.stopPreview(); this.sel = null; }
      for (const id of ids) await deleteSong(id);
      pk.clear();
      await this.reload();
      this.render();
      this.host.toast(`${ids.length} 曲を削除しました`);
    } else if (a === 'clear') {
      if (!confirm(`${ids.length} 曲を、入っているフォルダから全部外しますか？`)) return;
      for (const f of this.folders) await removeFromFolder(ids, f);
      await this.reload();
      this.render();
      this.host.toast(`${ids.length} 曲をフォルダから外しました`);
    }
  }

  /**
   * フォルダの名前を入れてもらう（画面の上のほうに大きな入力欄を出す。下はキーボードで隠れるので）。
   * やめたら null。使えない名前は入れられない
   */
  private askName(title: string, initial: string, ok: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.el.querySelector('.home-ask')?.remove();
      const box = document.createElement('div');
      box.className = 'home-ask';
      box.innerHTML = `<div class="ha-box" role="dialog" aria-label="${esc(title)}">
          <h3>${esc(title)}</h3>
          <input class="ha-in" type="text" maxlength="40" value="${esc(initial)}" placeholder="フォルダの名前" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false">
          <p class="ha-err"></p>
          <div class="ha-btns"><button class="ha-cancel">やめる</button><button class="ha-ok">${esc(ok)}</button></div>
        </div>`;
      this.el.appendChild(box);
      const input = box.querySelector<HTMLInputElement>('.ha-in')!;
      const okBtn = box.querySelector<HTMLButtonElement>('.ha-ok')!;
      const err = box.querySelector<HTMLElement>('.ha-err')!;
      const check = () => {
        const v = input.value.trim();
        const bad = !v ? '' : v === UNCAT || v === 'すべて' || v === '未分類' ? 'その名前は使えません' : v.includes('/') ? '「/」は使えません' : '';
        err.textContent = bad;
        okBtn.disabled = !v || !!bad || v === initial;
        return okBtn.disabled ? null : v;
      };
      const close = (v: string | null) => {
        box.remove();
        resolve(v);
      };
      input.addEventListener('input', check);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); const v = check(); if (v) close(v); }
        else if (e.key === 'Escape') close(null);
      });
      okBtn.addEventListener('click', () => { const v = check(); if (v) close(v); });
      box.querySelector('.ha-cancel')!.addEventListener('click', () => close(null));
      box.addEventListener('pointerdown', (e) => { if (e.target === box) close(null); });
      check();
      input.focus();
      input.select();
    });
  }

  /** フォルダの名前を変える（同じ名前のフォルダがあるときは、まとめてよいか聞く） */
  private async renameFolderAsk(from: string) {
    const parent = folderParents(from).pop();
    const nm = await this.askName('フォルダの名前を変える', from.split('/').pop()!, '変える');
    if (!nm) return;
    const to = parent ? `${parent}/${nm}` : nm;
    if (this.folders.includes(to) && !confirm(`「${nm}」はすでにあります。2 つのフォルダをまとめますか？`)) return;
    await renameFolder(from, to);
    const mv = (f: string) => (inFolderTree(f, from) ? to + f.slice(from.length) : f);
    if (this.folder) this.folder = mv(this.folder);
    this.fbar = mv(this.fbar);
    await this.reload();
    this.render();
    this.host.toast(`フォルダの名前を「${to}」にしました`);
  }
}

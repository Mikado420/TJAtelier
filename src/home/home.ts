/**
 * 最初の画面（曲選択）。左にロゴとフォルダ、真ん中に曲の縦の一覧、右の青い面に選んだ曲
 * （BPM・長さ・難易度・試聴・「プレイ」「編集」）。
 */
import type { AudioEngine } from '../audio/audio';
import { closeCurtain, openCurtain } from '../ui/curtain';
import {
  addFolder, addToFolder, deleteFolder, deleteSong, listFolders, listSongs, loadSongAudio, removeFromFolder, renameFolder, type SongEntry,
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
const UNCAT = '\uE000uncat'; // HTML の属性に入れても変わらない文字（\u0000 は属性に入れると別の文字に置き換わる）

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
    this.detail = document.getElementById('homeDetail')!;
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
        const s = this.songs.find((x) => x.id === this.sel);
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
      }
    }
    this.render(true);
    // 選んでいる曲の試聴を流す（自動で鳴らせないときは、次に触れたときに）
    const s = this.songs.find((x) => x.id === this.sel);
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

  private render(scrollToSel = false, listToo = true) {
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
      fl.push(`<div class="hf ${on ? 'on' : ''}" data-folder="${esc(f)}"><span>${esc(f)}</span><small>${n}</small><button class="hf-more" data-fmore="${esc(f)}" aria-label="フォルダの操作">${ICON.more}</button></div>`);
    }
    fl.push(`<button class="hf hf-add" data-h="folder"><span>＋ 新しいフォルダ</span></button>`);
    this.foldersEl.innerHTML = fl.join('');

    const pk = this.picking;
    if (listToo) {
      // 真ん中: 曲の縦の一覧
      const tags = (s: SongEntry) => (this.folder === null || this.query ? s.folders : s.folders.filter((f) => f !== this.folder));
      const rows = songs.map((s) => {
        const cs = sortCourses(s.courses);
        const top = cs.length ? Math.max(...cs.map((c) => c.level)) : 0;
        const chips = cs.map((c) => `<span class="hc" style="--cc:${COURSE_COLOR[c.name] ?? 'var(--btn)'}">${esc(COURSE_SHORT[c.name] ?? c.name)}<b>${c.level}</b></span>`).join('');
        return `<div class="hr ${s.id === this.sel && !pk ? 'on' : ''} ${pk?.has(s.id) ? 'pk' : ''}" data-song="${s.id}">${pk ? `<i class="hr-ck">${pk.has(s.id) ? '✓' : ''}</i>` : '<i class="hr-mk"></i>'}<div class="hr-t"><b>${esc(s.title)}</b><small>${esc(s.subtitle || ' ')}${tags(s).length ? ` <span class="hr-tags">${tags(s).map((f) => `<em>${esc(f)}</em>`).join('')}</span>` : ''}</small><span class="hr-x"><span class="hr-meta">BPM ${fmtBpm(s)}　${fmtLen(s.length)}</span><span class="hr-cs">${chips}</span></span></div><span class="hr-bpm">${top ? `★${top}` : ''}</span></div>`;
      });
      if (!rows.length) {
        rows.push(`<div class="hr-empty">${this.query ? '見つかりませんでした' : this.folder === UNCAT ? '未分類の曲はありません' : this.folder !== null ? 'このフォルダには曲がありません' : 'まだ曲がありません'}</div>`);
      }
      this.list.innerHTML = rows.join('');
      this.list.classList.toggle('picking', !!pk);
    }

    // 選んでいるとき: 一覧の下に「すべて選択」「完了」、右の面に選んだ曲と操作
    const bar = document.getElementById('homePick')!;
    bar.classList.toggle('hidden', !pk);
    if (pk) {
      const allOn = songs.length > 0 && songs.every((x) => pk.has(x.id));
      bar.innerHTML = `
        <button data-pk="all" class="pk-all ${allOn ? 'on' : ''}"><i class="hr-ck">${allOn ? '✓' : ''}</i>${allOn ? '選択を解除' : 'すべて選択'}</button>
        <span class="pk-hint">${pk.size ? `<b>${pk.size}</b> 曲を選択中` : ''}</span>
        <button data-pk="done" class="pk-done">完了</button>`;
    }
    this.el.classList.toggle('home-picking', !!pk);
    const pb = document.getElementById('homePickBtn') as HTMLElement;
    pb.classList.toggle('on', !!pk);
    pb.querySelector('small')!.textContent = pk ? '完了' : '選択';

    // 右: 選んでいる曲
    const s = this.songs.find((x) => x.id === this.sel && songs.includes(x));
    if (pk) {
      const inFolder = this.folder !== null && this.folder !== UNCAT && !this.query;
      const picked = this.songs.filter((x) => pk.has(x.id));
      const off = pk.size ? '' : 'disabled';
      const act = (k: string, icon: string, label: string, sub: string, cls = '') =>
        `<button data-pk="${k}" class="pk-act ${cls}" ${off}><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span><b>${label}</b>${sub ? `<small>${sub}</small>` : ''}</span></button>`;
      this.detail.innerHTML = `
        <div class="pk-panel">
          <div class="pk-head"><small>選択中</small><b>${pk.size}<span>曲</span></b></div>
          <div class="pk-list">${picked.map((x) => `<div class="pk-item"><b>${esc(x.title)}</b>${x.subtitle ? `<small>${esc(x.subtitle)}</small>` : ''}</div>`).join('')}</div>
          <div class="pk-acts">
            ${act('add', '<path d="M3 6.5h6l2 2h10v10H3z"/><path d="M12 11.5v5M9.5 14h5"/>', 'フォルダに入れる', '')}
            ${inFolder ? act('move', '<path d="M3 6.5h6l2 2h10v10H3z"/><path d="M9 14h6M13 11.5l2.5 2.5-2.5 2.5"/>', '別のフォルダへ移す', '') : ''}
            ${inFolder ? act('remove', '<path d="M3 6.5h6l2 2h10v10H3z"/><path d="M9.5 14h5"/>', 'このフォルダから外す', '') : act('clear', '<path d="M3 6.5h6l2 2h10v10H3z"/><path d="M9.5 11.5l5 5M14.5 11.5l-5 5"/>', '未分類に戻す', '')}
            ${act('delete', '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>', '削除する', '', 'bad')}
          </div>
        </div>`;
    } else if (s) {
      this.detail.innerHTML = `
        <div class="hdx-jk">${jacket(s)}</div>
        <div class="hdx-top"><small>試聴</small><span class="hdx-pv"><button data-h="prev" aria-label="前の曲"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14"/><path d="M19 5 9 12l10 7z"/></svg></button><button data-h="pp" aria-label="試聴"></button><button data-h="next" aria-label="次の曲"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14"/><path d="M5 5l10 7-10 7z"/></svg></button></span><button class="hdx-more" data-smore="${s.id}" aria-label="曲の操作">${ICON.more}</button></div>
        <h1 class="hdx-title">${esc(s.title)}</h1>
        <div class="hdx-bpm">${fmtBpm(s)}<small>BPM</small></div>
        <div class="hdx-acts">
          <button class="hdx-play" data-pickdiff="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>この曲にする</button>
          <button class="hdx-edit" data-edit="${s.id}">エディタで開く</button>
          <button class="hdx-an" data-analyze="${s.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>譜面情報</button>
        </div>`;
    } else {
      this.detail.innerHTML = `<div class="hdx-empty"><b>曲を選んでください</b><button class="hdx-play" data-h="import">読み込む</button></div>`;
    }

    (document.getElementById('homeSort') as HTMLElement).textContent = SORT_LABEL[this.sort];
    (document.getElementById('homePath') as HTMLElement).textContent = this.query ? `「${this.query}」` : this.folder === UNCAT ? '未分類' : this.folder ?? 'すべて';
    (document.getElementById('homeCount') as HTMLElement).textContent = `${songs.length} 曲`;
    // 端の曲もまんなかまで来られるよう、上下に余白
    const pad = `${Math.max(0, this.list.clientHeight / 2 - 26)}px`;
    this.list.style.paddingTop = pad;
    this.list.style.paddingBottom = pad;
    if (scrollToSel) this.centerSel(false);
    this.paintPlayer();
    this.paintCurve();
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
      for (const r of Array.from(this.list.querySelectorAll<HTMLElement>('.hr'))) {
        const d = Math.abs(r.offsetTop + r.offsetHeight / 2 - mid);
        if (d < bd) { bd = d; best = r; }
      }
      const id = best?.dataset.song;
      if (id && id !== this.sel) this.selectRow(id, false);
    }, 140);
  }

  private paintCurve() {
    const L = this.list;
    const mid = L.scrollTop + L.clientHeight / 2;
    const h = Math.max(1, L.clientHeight / 2);
    for (const r of Array.from(L.querySelectorAll<HTMLElement>('.hr'))) {
      const c = r.offsetTop + r.offsetHeight / 2;
      if (Math.abs(c - mid) > L.clientHeight) continue;
      const d = Math.min(1.4, Math.abs(c - mid) / h);
      r.style.setProperty('--d', d.toFixed(3));
    }
  }

  /** 曲を選ぶ（一覧を作り直さずに、選んでいる帯と右の面だけ変える） */
  private selectRow(id: string, scroll: boolean) {
    this.sel = id;
    this.list.querySelectorAll('.hr.on').forEach((r) => r.classList.remove('on'));
    this.list.querySelector(`[data-song="${id}"]`)?.classList.add('on');
    this.render(false, false);
    // 選んだ帯が広がるので、まんなかへ寄せ直す
    if (scroll) this.centerSel(true);
    else requestAnimationFrame(() => this.centerSel(true));
    const s = this.songs.find((q) => q.id === id);
    if (s) void this.startPreview(s);
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
    const slots: { slot: string; name: string; level: number }[] = [];
    for (const n of ['Easy', 'Normal', 'Hard']) {
      const c = has(n);
      if (c) slots.push({ slot: n, name: n, level: c.level });
    }
    const oni = has('Oni');
    const ura = has('Edit');
    const show = this.diffUra && ura ? ura : oni ?? ura;
    if (show) slots.push({ slot: 'Oni', name: show.name, level: show.level });
    return { slots, canUra: !!(oni && ura) };
  }

  private paintDiff(flipIn = false) {
    const s = this.diffSong;
    if (!s) return;
    const o = this.host.playOpts();
    const { slots, canUra } = this.diffSlots(s);
    const sel = slots.find((x) => x.name === this.diffCourse);
    const bars = (n: number) => [0, 1, 2].map((k) => `<rect x="${8 + k * 12}" y="${30 - k * 9}" width="7" height="${10 + k * 9}" fill="${k < n ? '#fff' : 'rgba(255,255,255,0.3)'}"/>`).join('');
    const ICON_D: Record<string, string> = {
      Easy: bars(1), Normal: bars(2), Hard: bars(3),
      Oni: '<path d="M6 40 L10 14 L18 26 L24 8 L30 26 L38 14 L42 40 Z" fill="#fff"/>',
      Edit: '<path d="M6 40 L10 14 L18 26 L24 8 L30 26 L38 14 L42 40 Z" fill="#1d2023" stroke="#fff" stroke-width="2.5"/>',
    };
    const DARK: Record<string, string> = { Easy: '#9c3a20', Normal: '#4f7a1e', Hard: '#11615a', Oni: '#7a1a4a', Edit: '#2e1660' };
    const cards = slots.map((c) => {
      const on = c.name === this.diffCourse;
      const meter = Array.from({ length: 10 }, (_, k) => `<i class="${k < c.level ? 'on' : ''}"></i>`).join('');
      const label = c.name === 'Edit' ? 'おに（裏）' : COURSE_SHORT[c.name] ?? c.name;
      return `<button class="hdf-card ${on ? 'on' : ''} ${flipIn && c.slot === 'Oni' ? 'fin' : ''} ${c.name === 'Edit' ? 'ura' : ''}" data-dcourse="${esc(c.name)}" data-slot="${c.slot}" style="--cc:${COURSE_COLOR[c.name] ?? 'var(--btn)'};--cd:${DARK[c.name] ?? '#222'}">
        <svg viewBox="0 0 48 48" aria-hidden="true">${ICON_D[c.name] ?? ''}</svg>
        <span>${esc(label)}</span><b>★${c.level}</b><em class="hdf-meter">${meter}</em>
        ${c.slot === 'Oni' && canUra && c.name !== 'Edit' ? '<small class="hdf-uraok">裏あり</small>' : ''}
        ${c.name === 'Edit' ? '<small class="hdf-urab">裏</small>' : ''}
        ${on ? '<u>1P</u>' : ''}</button>`;
    }).join('');
    const best = sel ? loadBest(s.id, sel.name) : null;
    const crownLabel: Record<string, string> = { allgood: '全良', fc: 'フルコンボ', clear: 'クリア', fail: '未クリア' };
    const info = sel
      ? `<span class="hdf-il">${esc(sel.name === 'Edit' ? 'おに（裏）' : COURSE_SHORT[sel.name] ?? sel.name)} ★${sel.level} の記録</span>
         <span class="hdf-il">自己ベスト</span><b class="hdf-best">${best ? best.score.toLocaleString() : '---'}</b>
         <span class="hdf-ir"><span>王冠</span><b class="cr-${best?.crown ?? 'none'}">${best ? crownLabel[best.crown] ?? '' : 'なし'}</b></span>`
      : '<span class="hdf-il">難易度をえらんでください</span>';
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
        <span class="hdf-tip">${this.diffUra && canUra ? 'おにをもう一度タップで、おもてのおにに戻る' : canUra ? 'カードをえらぶ → はじめる　／　おにをもう一度で裏おに' : 'カードをえらぶ → はじめる'}</span>
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
      // まんなかの曲をもう一度タップで難易度えらび
      if (this.sel === id) { this.openDiff(id); return; }
      this.selectRow(id, true);
    }
  }

  private async action(a: string) {
    if (a === 'import') this.host.importFiles();
    else if (a === 'settings') this.host.settings();
    else if (a === 'online') { this.stopPreview(); this.host.online(); }
    else if (a === 'new') { this.stopPreview(); await this.host.create(this.folder ?? ''); }
    else if (a === 'folder') {
      const name = await this.askName('新しいフォルダ', '', '作る');
      if (!name) return;
      await addFolder(name);
      await this.reload();
      this.folder = name;
      this.render();
    } else if (a === 'pick') {
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
      if (!confirm(`${ids.length} 曲を、入っているフォルダから全部外しますか？（曲は消えません）`)) return;
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
        const bad = !v ? '' : v === UNCAT || v === 'すべて' || v === '未分類' ? 'その名前は使えません' : '';
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
    const to = await this.askName('フォルダの名前を変える', from, '変える');
    if (!to) return;
    if (this.folders.includes(to) && !confirm(`「${to}」はすでにあります。2 つのフォルダをまとめますか？`)) return;
    await renameFolder(from, to);
    if (this.folder === from) this.folder = to;
    await this.reload();
    this.render();
    this.host.toast(`フォルダの名前を「${to}」にしました`);
  }

  private folderMenu(name: string, anchor: HTMLElement) {
    this.popup(anchor, [
      ['名前を変える', () => this.renameFolderAsk(name)],
      ['フォルダを消す（曲は残す）', async () => {
        if (!confirm(`フォルダ「${name}」を消しますか？（中の曲は消えず、このフォルダから外れるだけです）`)) return;
        await deleteFolder(name);
        await this.reload();
        this.render();
      }, true],
    ]);
  }
}

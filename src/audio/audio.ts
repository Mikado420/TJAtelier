/**
 * Web Audio まわり。ゲーム内の時刻は「曲の再生位置（秒）」で統一し、
 * AudioContext.currentTime から計算するので映像と音がずれにくい。
 */
/** 打音の種類（balloon = 風船が割れた音） */
export type HitSound = 'don' | 'ka' | 'balloon';

export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: 'interactive' });
  private music: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0; // 再生を開始した ctx 時刻
  private readonly musicGain = this.ctx.createGain();
  private readonly sfxGain = this.ctx.createGain();
  private readonly metroGain = this.ctx.createGain();
  /** 画面の音（タップ・フォルダ・結果・曲名） */
  private readonly uiGain = this.ctx.createGain();
  /** 音量を上げたときに音が割れないように、最後に通す（強い音だけ抑える） */
  private readonly limiter: DynamicsCompressorNode | null =
    typeof this.ctx.createDynamicsCompressor === 'function' ? this.ctx.createDynamicsCompressor() : null;

  constructor() {
    const out: AudioNode = this.limiter ?? this.ctx.destination;
    if (this.limiter) {
      this.limiter.threshold.value = -3;
      this.limiter.knee.value = 3;
      this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.002;
      this.limiter.release.value = 0.1;
      this.limiter.connect(this.ctx.destination);
    }
    this.musicGain.connect(out);
    this.sfxGain.connect(out);
    this.metroGain.connect(out);
    this.uiGain.connect(out);
    this.applyMix();
  }

  // ---------- 音量（自動で揃える） ----------
  // 音源・打音・メトロノームの「聞こえる大きさ」を測って、どれも同じ大きさ（TARGET）になるように音量を決め、
  // そこに設定の比率（初期値 1 : 1 : 1.2）を掛ける。

  /** 揃える先の大きさ（短い区間の RMS） */
  private static readonly TARGET = 0.2;
  private mix = { music: 1, hit: 1, metro: 1.2, ui: 1 };
  private musicLevel = 0;
  private hitLevel: Record<HitSound, number> = { don: 0, ka: 0, balloon: 0 };

  // ---------- 画面の音 ----------
  private uiBufs = new Map<string, AudioBuffer>();
  /** 画面の音を読み込む（失敗しても何もしない） */
  async loadUi(name: string, url: string) {
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      this.uiBufs.set(name, await this.ctx.decodeAudioData(await res.arrayBuffer()));
    } catch { /* 鳴らせない */ }
  }
  /** 画面の音を鳴らす */
  playUi(name: string) {
    const buf = this.uiBufs.get(name);
    if (!buf || this.mix.ui <= 0) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.uiGain);
    src.start();
  }

  /** 音量の比率（音源・打音・メトロノーム）を変える */
  setMix(m: { music: number; hit: number; metro: number; ui?: number }) {
    this.mix = { ...m, ui: m.ui ?? this.mix.ui };
    this.applyMix();
  }

  private applyMix() {
    const T = AudioEngine.TARGET;
    const music = this.musicLevel > 0 ? Math.min(6, T / this.musicLevel) : 0.8;
    this.musicGain.gain.value = music * this.mix.music;
    this.sfxGain.gain.value = this.mix.hit;
    this.uiGain.gain.value = 0.6 * this.mix.ui;
    // メトロノームの音の大きさは、音を作ったとき（初めて鳴らすとき）に測る
    this.metroGain.gain.value = this.mix.metro * (this.metroLv > 0 ? Math.min(20, T / this.metroLv) : 1);
  }

  /**
   * 聞こえる大きさ: 50ms ごとの RMS を求める。
   * 曲は大きい側から 1 割の所（サビなどの大きい部分の大きさ）、短い音（打音など）はいちばん大きい区間を使う
   */
  private static level(buf: AudioBuffer, short: boolean): number {
    const win = Math.max(1, Math.round(buf.sampleRate * 0.05));
    const chs = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
    const step = short ? 1 : 4; // 曲は 4 サンプルおきに見て軽くする
    const vals: number[] = [];
    for (let a = 0; a < buf.length; a += win) {
      const b = Math.min(buf.length, a + win);
      let sum = 0;
      let n = 0;
      for (let i = a; i < b; i += step) {
        let v = 0;
        for (const d of chs) v += d[i];
        v /= chs.length;
        sum += v * v;
        n++;
      }
      if (n) vals.push(Math.sqrt(sum / n));
    }
    if (!vals.length) return 0;
    if (short) return Math.max(...vals);
    vals.sort((x, y) => x - y);
    return vals[Math.floor(vals.length * 0.9)] ?? 0;
  }

  /** 打音の 1 打ごとの音量（大きさを揃えるための倍率） */
  private hitNorm(kind: HitSound) {
    const lv = this.hitLevel[kind];
    return lv > 0 ? Math.min(8, AudioEngine.TARGET / lv) : 1;
  }

  /**
   * 書き出す音源（.zip の .ogg）に掛ける倍率。
   * 音源と打音（ドン）を同じ大きさに揃えたうえで、設定の比率（音源 : 打音）になるようにする。
   * 書き出した先では打音はそのままの大きさで鳴るので、「打音の大きさ ÷ 音源の大きさ × 音源の比率 ÷ 打音の比率」倍にする
   */
  exportGain(buf: AudioBuffer, volMusic: number, volHit: number): number {
    const lm = AudioEngine.level(buf, false);
    const lh = AudioEngine.level(this.customHit.don ?? this.builtinHit('don'), true);
    if (!(lm > 0) || !(lh > 0) || !(volHit > 0)) return 1;
    return (lh / lm) * (volMusic / volHit);
  }

  private measureHit(kind: HitSound) {
    this.hitLevel[kind] = AudioEngine.level(this.customHit[kind] ?? this.builtinHit(kind), true);
  }

  async loadMusic(buf: ArrayBuffer | null) {
    this.music = buf ? await this.ctx.decodeAudioData(buf) : null;
    this.musicLevel = this.music ? AudioEngine.level(this.music, false) : 0;
    this.applyMix();
  }

  get buffer() {
    return this.music;
  }

  get hasMusic() {
    return this.music !== null;
  }

  get musicDuration() {
    return this.music?.duration ?? 0;
  }

  /** leadIn 秒後に曲の 0 秒が来るように再生開始 */
  async start(leadIn: number) {
    await this.startAt(-leadIn, 1);
  }

  /**
   * 曲の songTime 秒の位置から rate 倍速で再生（songTime が負なら、その分待ってから曲が始まる）。
   * buf を渡すと、読み込んだ曲の代わりにその音を鳴らす（音源の切り貼りの確認用）
   */
  /** 音を出せる状態にしておく（始める時刻を決める前に。待った時間のぶん遅れて始まらないように） */
  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  async startAt(songTime: number, rate = 1, buf?: AudioBuffer) {
    await this.ctx.resume();
    this.stop();
    this.rate = rate;
    this.songStart = songTime;
    this.startedAt = this.ctx.currentTime + 0.03;
    this.samples = [];
    this.sampleCount = 0;
    this.bigDiffCount = 0;
    this.lastSample = -Infinity;
    this.perfZero = this.perfZeroCandidate() ?? performance.now() + 30;
    this.playing = true;
    const music = buf ?? this.music;
    if (music && songTime < music.duration) {
      const src = this.ctx.createBufferSource();
      src.buffer = music;
      src.playbackRate.value = rate;
      src.connect(this.musicGain);
      src.start(this.startedAt + Math.max(0, -songTime) / rate, Math.max(0, songTime));
      this.source = src;
    }
  }

  /** 曲の songTime 秒の位置で鳴るように、クリック音を予約する（タイミング調整用） */
  scheduleTick(songTime: number) {
    this.scheduleMetro(true, songTime);
  }

  private scheduled: AudioScheduledSourceNode[] = [];

  stop() {
    this.playing = false;
    for (const n of this.scheduled) {
      try { n.stop(); } catch { /* 停止済み */ }
    }
    this.scheduled = [];
    if (this.source) {
      try { this.source.stop(); } catch { /* 既に停止済み */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  /**
   * 現在の曲の再生位置（秒）。perfMs は performance.now() 基準の時刻（イベントの timeStamp も同じ基準）。
   *
   * 時計は「端末の高精度タイマー（performance.now）」で進め、音の再生位置はそのずれを少しずつ直すのにだけ使う。
   * 音の再生位置（AudioContext の currentTime / getOutputTimestamp）は端末によって 10〜40ms 刻みでしか進まなかったり、
   * 値が行ったり来たりするので、そのまま使うと判定が数十 ms 単位でぶれて、正確に叩いても可・不可になることがある。
   */
  now(perfMs = performance.now()): number {
    this.refineClock();
    return this.songStart + ((perfMs - this.perfZero) / 1000) * this.rate;
  }

  /** ctx の startedAt の音が実際に聞こえる performance.now() の時刻（ms） */
  private perfZero = 0;
  private samples: number[] = [];
  private lastSample = -Infinity;

  /** いまの音の再生位置から求めた perfZero の候補。使える値がないときは null */
  private perfZeroCandidate(): number | null {
    const perf = performance.now();
    const heard = this.heardContextTime(perf);
    if (heard === null) return null;
    return perf + (this.startedAt - heard) * 1000;
  }

  /** 再生開始から何回照らし合わせたか（最初のうちはすぐ合わせる） */
  private sampleCount = 0;
  private bigDiffCount = 0;

  /**
   * 0.1 秒ごとに音の再生位置と照らし合わせて、時計のずれを直す。
   * - 直近 11 回（約 1 秒）の、外れ値を除いた平均を使うので、たまに外れた値が来ても影響しない
   * - 再生開始から 2 秒間はすぐ合わせる
   * - それ以降、15ms 未満のずれは 0.1 秒あたり 1ms ずつ寄せる（判定や見た目が細かく揺れない）
   * - 15ms 以上のずれ（音が一瞬止まって曲が遅れた等）は 0.1 秒ごとに 25% ずつ素早く寄せる
   * - 0.1 秒以上のずれが続いたとき（アプリに戻ってきた等）は一気に合わせる
   */
  private refineClock() {
    if (!this.playing) return;
    const perf = performance.now();
    if (perf - this.lastSample < 100) return;
    this.lastSample = perf;
    const c = this.perfZeroCandidate();
    if (c === null) return;
    this.samples.push(c);
    if (this.samples.length > 11) this.samples.shift();
    this.sampleCount++;
    // 外れ値に強い平均: 大きい側・小さい側の 1/4 ずつを捨てて、真ん中の値を平均する
    const sorted = [...this.samples].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length / 4);
    const mid = sorted.slice(cut, sorted.length - cut);
    const med = mid.reduce((a, b) => a + b, 0) / mid.length;
    const diff = med - this.perfZero;
    if (this.sampleCount <= 20) {
      this.perfZero = med;
      return;
    }
    this.bigDiffCount = Math.abs(diff) > 100 ? this.bigDiffCount + 1 : 0;
    if (this.bigDiffCount >= 3) {
      this.perfZero = med;
      this.bigDiffCount = 0;
    } else if (Math.abs(diff) >= 15) {
      this.perfZero += diff * 0.25;
    } else {
      this.perfZero += Math.max(-1, Math.min(1, diff));
    }
  }

  /** 一度でも getOutputTimestamp の正しい値が取れたら、以後はそれだけを使う（方式を混ぜると値が跳ぶ） */
  private tsReliable = false;

  /**
   * perfMs の時点でスピーカーから聞こえている音の ctx 時刻（の推定）。使える値がないときは null。
   * - getOutputTimestamp() があれば「いま出力されている音の ctx 時刻」と「その時刻」の組から求める（出力の遅れを含む）
   * - なければ currentTime から端末が申告している出力の遅れを引く
   */
  private heardContextTime(perfMs: number): number | null {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.performanceTime > 0 && ts.contextTime) {
      const off = ts.contextTime - ts.performanceTime / 1000;
      // 明らかにおかしい値（出力の遅れがマイナス、または 0.5 秒以上）は使わない
      const lat = this.ctx.currentTime - (performance.now() / 1000 + off);
      if (lat > -0.05 && lat < 0.5) {
        if (!this.tsReliable) {
          // ここから getOutputTimestamp の値だけを使う。それまでの別方式の値は捨てる
          this.tsReliable = true;
          this.samples = [];
          this.sampleCount = 0;
        }
        this.clockMode = 'outputTimestamp';
        return perfMs / 1000 + off;
      }
    }
    if (this.tsReliable) return null;
    this.clockMode = 'outputLatency';
    const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0;
    return this.ctx.currentTime - latency - (performance.now() - perfMs) / 1000;
  }

  private clockMode: 'outputTimestamp' | 'outputLatency' = 'outputLatency';

  /** 診断用: 時計の方式と、推定している出力の遅れ（ms） */
  clockInfo() {
    const lat = this.ctx.currentTime - (this.startedAt + (performance.now() - this.perfZero) / 1000);
    return {
      mode: this.clockMode,
      latencyMs: Math.round(lat * 1000),
      outputLatencyMs: Math.round((this.ctx.outputLatency || 0) * 1000),
      baseLatencyMs: Math.round((this.ctx.baseLatency || 0) * 1000),
    };
  }

  playing = false;
  private rate = 1;
  private songStart = 0;

  private metroBufs: { strong: AudioBuffer; weak: AudioBuffer } | null = null;
  private metroLv = 0;

  /** メトロノームの音（小節の頭は高い音）。一度だけ作って使い回す */
  private metroBuf(strong: boolean) {
    if (!this.metroBufs) {
      const sr = this.ctx.sampleRate;
      const make = (f: number) => {
        const len = Math.round(sr * 0.05);
        const buf = this.ctx.createBuffer(1, len, sr);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.sin((2 * Math.PI * f * i) / sr) * 0.5 * Math.exp(-i / sr / 0.012);
        return buf;
      };
      this.metroBufs = { strong: make(1600), weak: make(1000) };
      this.metroLv = AudioEngine.level(this.metroBufs.weak, true);
      this.applyMix();
    }
    return strong ? this.metroBufs.strong : this.metroBufs.weak;
  }


  /** メトロノームの音を、曲の songTime 秒の位置で鳴るように予約する（過ぎていればすぐ鳴らす） */
  scheduleMetro(strong: boolean, songTime: number) {
    const ctx = this.ctx;
    const when = this.startedAt + (songTime - this.songStart) / this.rate;
    if (when < ctx.currentTime - 0.02) return;
    const src = ctx.createBufferSource();
    src.buffer = this.metroBuf(strong);
    src.connect(this.metroGain);
    src.start(Math.max(when, ctx.currentTime));
    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
      src.disconnect();
    };
  }

  /** メトロノームの音をすぐ鳴らす */
  playTick(strong: boolean) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.metroBuf(strong);
    src.connect(this.metroGain);
    src.start();
  }

  // ---------- 打音 ----------
  // 叩くたびに音を合成すると、速く叩いたときに端末の負荷で音が途切れることがあるので、
  // 打音は最初に一度だけ AudioBuffer にしておき、叩くたびにそれを鳴らすだけにする。

  private hitBuffers: Record<HitSound, AudioBuffer | null> = { don: null, ka: null, balloon: null };
  private customHit: Record<HitSound, AudioBuffer | null> = { don: null, ka: null, balloon: null };
  private voices: Record<'don' | 'ka', { src: AudioBufferSourceNode; g: GainNode }[]> = { don: [], ka: [] };

  // ---------- 曲選択の試聴 ----------
  // <audio> は iPhone で .ogg を鳴らせず、読み込みを待つ間にタップの扱いが切れて鳴らないことがあるので、Web Audio で鳴らす

  private pvCache: { key: string; buf: AudioBuffer; gain: number } | null = null;
  private pv: { src: AudioBufferSourceNode; g: GainNode; at: number; from: number; dur: number } | null = null;

  /** 試聴の音源を読み込む（同じ key なら前に読んだものを使う） */
  async previewLoad(key: string, data: ArrayBuffer): Promise<AudioBuffer> {
    if (this.pvCache?.key === key) return this.pvCache.buf;
    this.pvCache = null; // 前の曲の音（大きい）は持たない
    const buf = await this.ctx.decodeAudioData(data.slice(0));
    const lv = AudioEngine.level(buf, false);
    this.pvCache = { key, buf, gain: lv > 0 ? Math.min(6, AudioEngine.TARGET / lv) : 0.8 };
    return buf;
  }

  /** 試聴を from 秒から鳴らす（最後まで行ったら loopFrom 秒へ戻って繰り返す） */
  previewStart(key: string, from: number, loopFrom = from) {
    this.previewStop();
    const c = this.pvCache;
    if (!c || c.key !== key) return;
    if (this.ctx.state !== 'running') void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = c.buf;
    src.loop = true;
    src.loopStart = Math.min(Math.max(0, loopFrom), c.buf.duration - 0.1);
    src.loopEnd = c.buf.duration;
    const g = this.ctx.createGain();
    const at = this.ctx.currentTime + 0.02;
    const vol = c.gain * this.mix.music;
    // 頭を少しずつ大きくする（いきなり大きな音にならないように）
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + 0.4);
    src.connect(g).connect(this.limiter ?? this.ctx.destination);
    const off = Math.min(Math.max(0, from), Math.max(0, c.buf.duration - 0.1));
    src.start(at, off);
    this.pv = { src, g, at, from: off, dur: c.buf.duration };
  }

  /** 試聴を止める。止めた位置（秒）を返す */
  previewStop(): number {
    const p = this.pv;
    if (!p) return 0;
    this.pv = null;
    const el = this.ctx.currentTime - p.at;
    const pos = p.from + Math.max(0, el);
    try {
      p.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
      p.src.stop(this.ctx.currentTime + 0.15);
    } catch { /* 止まっている */ }
    setTimeout(() => { try { p.src.disconnect(); p.g.disconnect(); } catch { /* 無視 */ } }, 300);
    return pos >= p.dur ? 0 : pos;
  }

  get previewing() {
    return this.pv !== null;
  }

  /** 試聴の音源を手放す（エディタに戻るときなど） */
  previewRelease() {
    this.previewStop();
    this.pvCache = null;
  }

  /** 自分で用意した打音（ogg / mp3 / wav など）。null で内蔵の音に戻す */
  async setCustomHit(kind: HitSound, data: ArrayBuffer | null) {
    this.customHit[kind] = data ? trimLead(this.ctx, await this.ctx.decodeAudioData(data.slice(0))) : null;
    this.measureHit(kind);
  }

  hasCustomHit(kind: HitSound) {
    return this.customHit[kind] !== null;
  }

  /** 内蔵の打音（オリジナルの合成音）を AudioBuffer として作る */
  private builtinHit(kind: HitSound): AudioBuffer {
    const cached = this.hitBuffers[kind];
    if (cached) return cached;
    const sr = this.ctx.sampleRate;
    if (kind === 'balloon') {
      // 風船が割れる音（短い雑音）
      const len = Math.round(sr * 0.18);
      const buf = this.ctx.createBuffer(1, len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / sr / 0.03) * 0.9;
      this.hitBuffers.balloon = buf;
      return buf;
    }
    const len = Math.round(sr * (kind === 'don' ? 0.22 : 0.1));
    const buf = this.ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      if (kind === 'don') {
        const f = 60 + 100 * Math.exp(-t / 0.035); // 160Hz → 60Hz
        phase += (2 * Math.PI * f) / sr;
        d[i] = Math.sin(phase) * Math.exp(-t / 0.05) * 0.95;
      } else {
        const f = 700 + 500 * Math.exp(-t / 0.012);
        phase += (2 * Math.PI * f) / sr;
        const tri = (2 / Math.PI) * Math.asin(Math.sin(phase));
        d[i] = (tri * 0.45 + (Math.random() * 2 - 1) * 0.15) * Math.exp(-t / 0.022);
      }
    }
    this.hitBuffers[kind] = buf;
    return buf;
  }

  /** 種類（と左右の位置）ごとの、最後に予約した音 */
  private lastScheduled: Record<string, { g: GainNode; end: number }> = {};
  /** 左右の位置ごとのつなぎ先（合作で複数のレーンの打音を左右に分ける） */
  private panNodes = new Map<number, AudioNode>();
  private panOut(pan: number): AudioNode {
    if (!pan) return this.sfxGain;
    let n = this.panNodes.get(pan);
    if (!n) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(this.sfxGain);
      this.panNodes.set(pan, (n = p));
    }
    return n;
  }

  /**
   * 曲の時刻 songTime ちょうどに打音を鳴らす予約（オートで音符の位置に正確に鳴らす）。
   * 同じ種類の前の音がまだ鳴っていれば、新しい音の瞬間に素早く消す（連打で音が重なりすぎないように）
   */
  scheduleHit(kind: HitSound, songTime: number, pan = 0) {
    const ctx = this.ctx;
    const when = this.startedAt + (songTime - this.songStart) / this.rate;
    if (when < ctx.currentTime - 0.005) return;
    const at = Math.max(when, ctx.currentTime);
    const lk = pan ? `${kind}:${pan}` : kind;
    const prev = this.lastScheduled[lk];
    if (prev && prev.end > at) prev.g.gain.setTargetAtTime(0, at, 0.006);
    const src = ctx.createBufferSource();
    src.buffer = this.customHit[kind] ?? this.builtinHit(kind);
    const g = ctx.createGain();
    if (!this.hitLevel[kind]) this.measureHit(kind);
    g.gain.value = this.hitNorm(kind);
    src.connect(g).connect(this.panOut(pan));
    src.start(at);
    this.lastScheduled[lk] = { g, end: at + src.buffer.duration };
    this.scheduled.push(src);
    src.onended = () => {
      const i = this.scheduled.indexOf(src);
      if (i >= 0) this.scheduled.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
  }

  /** 叩いた音。同じ種類の音は同時に 4 つまで（古いものから素早く消す） */
  playHit(kind: 'don' | 'ka') {
    const ctx = this.ctx;
    if (ctx.state !== 'running') void ctx.resume();
    const t = ctx.currentTime;
    const list = this.voices[kind];
    while (list.length >= 4) {
      const old = list.shift()!;
      old.g.gain.setTargetAtTime(0, t, 0.005);
      try { old.src.stop(t + 0.03); } catch { /* 停止済み */ }
    }
    const src = ctx.createBufferSource();
    src.buffer = this.customHit[kind] ?? this.builtinHit(kind);
    const g = ctx.createGain();
    if (!this.hitLevel[kind]) this.measureHit(kind);
    g.gain.value = this.hitNorm(kind);
    src.connect(g).connect(this.sfxGain);
    src.start(t);
    const v = { src, g };
    list.push(v);
    src.onended = () => {
      const i = list.indexOf(v);
      if (i >= 0) list.splice(i, 1);
      src.disconnect();
      g.disconnect();
    };
  }
}

/**
 * 打音の頭の無音を削る（叩いてから音が聞こえるまでの遅れをなくす）。
 * mp3・ogg は変換のときに頭に数十 ms の無音が付くことが多く、wav でも頭に間がある音がある。
 * いちばん大きい所の 2% を最初に超える所の 1ms 手前から使う
 */
export function trimLead(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const chs = Array.from({ length: buf.numberOfChannels }, (_, k) => buf.getChannelData(k));
  let peak = 0;
  for (const d of chs) for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
  if (peak <= 0) return buf;
  const th = peak * 0.02;
  let first = buf.length;
  for (const d of chs) for (let i = 0; i < Math.min(first, d.length); i++) if (Math.abs(d[i]) > th) { first = i; break; }
  const start = Math.max(0, first - Math.round(buf.sampleRate * 0.001));
  if (start < Math.round(buf.sampleRate * 0.002)) return buf; // 2ms 未満なら削らない
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length - start, buf.sampleRate);
  chs.forEach((d, k) => out.getChannelData(k).set(d.subarray(start)));
  return out;
}

/**
 * 動画ファイル（.mp4 / .mov）を組み立てる。
 * WebCodecs で作った H.264 の映像と、AAC・Opus（.mp4）か 16bit PCM（.mov）の音を 1 つにまとめる。
 * 先頭に目次（moov）を置くので、読み込み途中から再生できる
 */

type Bytes = Uint8Array | number[];

const enc = new TextEncoder();
const u8 = (n: number) => [n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const str = (s: string) => Array.from(enc.encode(s));

function cat(parts: Bytes[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function box(type: string, ...parts: Bytes[]): Uint8Array {
  const body = cat(parts);
  return cat([u32(body.length + 8), str(type), body]);
}
function full(type: string, version: number, flags: number, ...parts: Bytes[]) {
  return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
}
const MATRIX = [...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x10000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

/** 記述子（esds の中身）: タグ・長さ・中身 */
function desc(tag: number, ...parts: Bytes[]) {
  const body = cat(parts);
  const n = body.length;
  return cat([[tag, 0x80 | ((n >>> 21) & 127), 0x80 | ((n >>> 14) & 127), 0x80 | ((n >>> 7) & 127), n & 127], body]);
}

export type AudioCodec = { kind: 'aac'; asc: Uint8Array } | { kind: 'opus'; preSkip: number } | { kind: 'pcm' };

interface Track {
  id: number;
  video: boolean;
  timescale: number;
  sizes: number[];
  durs: number[];
  keys: number[];
  /** かたまり（chunk）ごとの、データの始まり（mdat の中身の先頭から）と、入っている数 */
  chunks: { at: number; n: number; sd?: number }[];
  /** PCM の音の数（1 つずつ数を並べるとメモリを使いすぎるので、数だけ） */
  pcm: number;
}
const totalOf = (t: Track) => (t.pcm ? t.pcm : t.durs.reduce((a, b) => a + b, 0));

export class Mp4Writer {
  /** できたデータ（まとまったら Blob にして、JS のメモリから外す） */
  private parts: Blob[] = [];
  private pend: Uint8Array[] = [];
  private pendBytes = 0;
  private pos = 0;
  private v: Track;
  private a: Track | null = null;
  /** 映像の設定（avcC）。エンコーダーが違うと変わることがあるので、いくつでも持つ */
  private avcCs: Uint8Array[] = [];
  private sd = 1;

  constructor(
    private readonly W: number,
    private readonly H: number,
    fps: number,
    private audio: { codec: AudioCodec; rate: number; ch: number } | null,
  ) {
    this.v = { id: 1, video: true, timescale: fps * 100, sizes: [], durs: [], keys: [], chunks: [], pcm: 0 };
    if (audio) this.a = { id: 2, video: false, timescale: audio.rate, sizes: [], durs: [], keys: [], chunks: [], pcm: 0 };
  }

  /** 入れた映像のコマ数 */
  get videoFrames() {
    return this.v.sizes.length;
  }

  /** エンコーダーが渡した音の設定（AAC は AudioSpecificConfig、Opus は OpusHead） */
  setAudioDescription(d: Uint8Array) {
    const A = this.audio;
    if (!A || !d.length) return;
    if (A.codec.kind === 'aac') A.codec = { kind: 'aac', asc: d };
    else if (A.codec.kind === 'opus' && d.length >= 12 && String.fromCharCode(...d.slice(0, 8)) === 'OpusHead') A.codec = { kind: 'opus', preSkip: d[10] | (d[11] << 8) };
  }

  /** .mov（音が PCM のとき）か .mp4 か */
  get ext() {
    return this.audio?.codec.kind === 'pcm' ? 'mov' : 'mp4';
  }

  private put(d: Uint8Array) {
    const at = this.pos;
    this.pend.push(d);
    this.pendBytes += d.length;
    this.pos += d.length;
    if (this.pendBytes > 4 << 20) this.flush();
    return at;
  }
  private flush() {
    if (!this.pend.length) return;
    this.parts.push(new Blob(this.pend as BlobPart[]));
    this.pend = [];
    this.pendBytes = 0;
  }

  /** 映像の 1 コマ（avcC は、エンコーダーが渡したとき） */
  addVideo(data: Uint8Array, key: boolean, avcC?: Uint8Array) {
    if (avcC) {
      const same = (a: Uint8Array) => a.length === avcC.length && a.every((x, i) => x === avcC[i]);
      let k = this.avcCs.findIndex(same);
      if (k < 0) k = this.avcCs.push(avcC) - 1;
      this.sd = k + 1;
    }
    const t = this.v;
    const at = this.put(data);
    t.sizes.push(data.length);
    t.durs.push(100);
    if (key) t.keys.push(t.sizes.length);
    t.chunks.push({ at, n: 1, sd: this.sd });
  }

  /** 音のかたまり。frames = 入っている音の数（PCM のときは 1 つが 1 サンプル） */
  addAudio(data: Uint8Array, frames: number) {
    const t = this.a;
    if (!t) return;
    const at = this.put(data);
    if (this.audio!.codec.kind === 'pcm') {
      t.chunks.push({ at, n: frames });
      t.pcm += frames;
    } else {
      t.sizes.push(data.length);
      t.durs.push(frames);
      t.chunks.push({ at, n: 1 });
    }
  }

  /** 音を sec 秒までにする（それより後のかたまりは目次から外す） */
  trimAudio(sec: number) {
    const t = this.a;
    if (!t) return;
    const max = Math.round(sec * t.timescale);
    if (t.pcm) {
      let acc = 0;
      const keep: { at: number; n: number }[] = [];
      for (const c of t.chunks) {
        if (acc >= max) break;
        const n = Math.min(c.n, max - acc);
        keep.push({ at: c.at, n });
        acc += n;
      }
      t.chunks = keep;
      t.pcm = acc;
      return;
    }
    let acc = 0;
    let k = 0;
    while (k < t.durs.length && acc < max) acc += t.durs[k++];
    t.sizes.length = t.durs.length = t.chunks.length = k;
  }

  /** 仕上げて 1 つのファイルにする */
  finish(): Blob {
    this.flush();
    const mov = this.ext === 'mov';
    const ftyp = mov
      ? box('ftyp', str('qt  '), u32(0x20050300), str('qt  '))
      : box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    // 目次の大きさが決まってから、データの位置を入れる
    const big = this.pos + 16 > 0xffffffff;
    const mdatHead = big ? cat([u32(1), str('mdat'), u32(Math.floor((this.pos + 16) / 2 ** 32)), u32((this.pos + 16) >>> 0)]) : cat([u32(this.pos + 8), str('mdat')]);
    let moov = this.moov(0, big);
    moov = this.moov(ftyp.length + moov.length + mdatHead.length, big);
    return new Blob([ftyp, moov, mdatHead, ...this.parts] as BlobPart[], { type: mov ? 'video/quicktime' : 'video/mp4' });
  }

  private moov(base: number, big: boolean) {
    const vDur = totalOf(this.v) / this.v.timescale;
    const aDur = this.a ? totalOf(this.a) / this.a.timescale : 0;
    const dur = Math.max(vDur, aDur);
    const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(Math.round(dur * 1000)), u32(0x10000), u16(0x100), new Array(10).fill(0), MATRIX, new Array(24).fill(0), u32(this.a ? 3 : 2));
    const traks = [this.trak(this.v, base, big)];
    if (this.a && this.a.chunks.length) traks.push(this.trak(this.a, base, big));
    return box('moov', mvhd, ...traks);
  }

  private trak(t: Track, base: number, big: boolean) {
    const total = totalOf(t);
    const ms = Math.round((total / t.timescale) * 1000);
    const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(t.id), u32(0), u32(ms), new Array(8).fill(0), u16(0), u16(0), u16(t.video ? 0 : 0x100), u16(0), MATRIX, u32(t.video ? this.W << 16 : 0), u32(t.video ? this.H << 16 : 0));
    const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(total), u16(0x55c4), u16(0));
    const hdlr = full('hdlr', 0, 0, u32(0), str(t.video ? 'vide' : 'soun'), u32(0), u32(0), u32(0), str(t.video ? 'VideoHandler' : 'SoundHandler'), [0]);
    const xmhd = t.video ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const minf = box('minf', xmhd, dinf, this.stbl(t, base, big));
    return box('trak', tkhd, box('mdia', mdhd, hdlr, minf));
  }

  private stbl(t: Track, base: number, big: boolean) {
    const runs = (vals: number[]) => {
      const r: [number, number][] = [];
      for (const v of vals) {
        const l = r[r.length - 1];
        if (l && l[1] === v) l[0]++;
        else r.push([1, v]);
      }
      return r;
    };
    const stts: [number, number][] = t.pcm ? [[t.pcm, 1]] : runs(t.durs);
    const sttsB = full('stts', 0, 0, u32(stts.length), ...stts.map(([n, d]) => [...u32(n), ...u32(d)]));
    // かたまりごとの数（同じ数が続く所はまとめる）
    const sc: [number, number, number][] = [];
    t.chunks.forEach((c, i) => {
      const l = sc[sc.length - 1];
      if (!l || l[1] !== c.n || l[2] !== (c.sd ?? 1)) sc.push([i + 1, c.n, c.sd ?? 1]);
    });
    const stsc = full('stsc', 0, 0, u32(sc.length), ...sc.map(([f, n, d]) => [...u32(f), ...u32(n), ...u32(d)]));
    const stsz = t.pcm
      ? full('stsz', 0, 0, u32(this.audio!.ch * 2), u32(t.pcm))
      : t.sizes.length > 0 && t.sizes.every((s) => s === t.sizes[0])
      ? full('stsz', 0, 0, u32(t.sizes[0]), u32(t.sizes.length))
      : full('stsz', 0, 0, u32(0), u32(t.sizes.length), ...t.sizes.map(u32));
    const stco = big
      ? full('co64', 0, 0, u32(t.chunks.length), ...t.chunks.map((c) => { const o = base + c.at; return [...u32(Math.floor(o / 2 ** 32)), ...u32(o >>> 0)]; }))
      : full('stco', 0, 0, u32(t.chunks.length), ...t.chunks.map((c) => u32(base + c.at)));
    const boxes = [this.stsd(t), sttsB];
    if (t.video && t.keys.length < t.sizes.length) boxes.push(full('stss', 0, 0, u32(t.keys.length), ...t.keys.map(u32)));
    boxes.push(stsc, stsz, stco);
    return box('stbl', ...boxes);
  }

  private stsd(t: Track) {
    if (t.video) {
      const list = this.avcCs.length ? this.avcCs : [new Uint8Array()];
      const avc1 = (c: Uint8Array) => box('avc1', new Array(6).fill(0), u16(1), u16(0), u16(0), new Array(12).fill(0), u16(this.W), u16(this.H), u32(0x480000), u32(0x480000), u32(0), u16(1), new Array(32).fill(0), u16(0x18), u16(0xffff), box('avcC', c));
      return full('stsd', 0, 0, u32(list.length), ...list.map(avc1));
    }
    const A = this.audio!;
    const head = (type: string, ...rest: Bytes[]) => box(type, new Array(6).fill(0), u16(1), new Array(8).fill(0), u16(A.ch), u16(16), u16(0), u16(0), u32(A.rate * 65536 >>> 0), ...rest);
    let entry: Uint8Array;
    if (A.codec.kind === 'aac') {
      const es = desc(3, u16(0), u8(0),
        desc(4, u8(0x40), u8(0x15), [0, 0, 0], u32(256000), u32(192000), desc(5, A.codec.asc)),
        desc(6, u8(2)));
      entry = head('mp4a', full('esds', 0, 0, es));
    } else if (A.codec.kind === 'opus') {
      entry = head('Opus', box('dOps', u8(0), u8(A.ch), u16(A.codec.preSkip), u32(A.rate), u16(0), u8(0)));
    } else {
      entry = head('sowt');
    }
    return full('stsd', 0, 0, u32(1), entry);
  }
}

/** AAC の AudioSpecificConfig（エンコーダーが渡さなかったとき） */
export function aacConfig(rate: number, ch: number) {
  const tab = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const i = Math.max(0, tab.indexOf(rate));
  return new Uint8Array([(2 << 3) | (i >> 1), ((i & 1) << 7) | (ch << 3)]);
}

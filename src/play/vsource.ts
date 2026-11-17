/**
 * 録画用: 背景の動画（.mp4 / .mov の H.264・HEVC）を、頭から順にデコードして 1 コマずつ渡す。
 * video 要素で 1 コマごとに位置を飛ばすより何倍も速い（飛ばすたびに前のキーフレームから読み直さずに済む）。
 * 読めない形式（webm・分割された mp4 など）は null を返す（そのときは video 要素で位置を合わせる）
 */

interface Sample {
  at: number;
  size: number;
  /** 表示する時刻（µs） */
  ts: number;
  dur: number;
  key: boolean;
}

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

/** 箱を順に読む（中身の範囲を返す） */
function* boxes(d: DataView, start: number, end: number): Generator<[string, number, number]> {
  let p = start;
  while (p + 8 <= end) {
    let size = d.getUint32(p);
    const type = String.fromCharCode(d.getUint8(p + 4), d.getUint8(p + 5), d.getUint8(p + 6), d.getUint8(p + 7));
    let head = 8;
    if (size === 1) {
      size = d.getUint32(p + 8) * 2 ** 32 + d.getUint32(p + 12);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head) return;
    yield [type, p + head, Math.min(end, p + size)];
    p += size;
  }
}
function child(d: DataView, s: number, e: number, path: string[]): [number, number] | null {
  let cur: [number, number] = [s, e];
  for (const name of path) {
    let found: [number, number] | null = null;
    for (const [t, a, b] of boxes(d, cur[0], cur[1])) if (t === name) { found = [a, b]; break; }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

/** HEVC の codec 文字列（hvcC から） */
function hevcCodec(type: string, c: Uint8Array) {
  const space = c[1] >> 6;
  const tier = (c[1] >> 5) & 1;
  const prof = c[1] & 31;
  let compat = ((c[2] << 24) | (c[3] << 16) | (c[4] << 8) | c[5]) >>> 0;
  // 互換フラグは逆順に書く
  let rev = 0;
  for (let i = 0; i < 32; i++) {
    rev = (rev << 1) | (compat & 1);
    compat >>>= 1;
  }
  const cons = Array.from(c.slice(6, 12));
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return [`${type}.${['', 'A', 'B', 'C'][space]}${prof}`, (rev >>> 0).toString(16).toUpperCase(), `${tier ? 'H' : 'L'}${c[12]}`, ...cons.map((x) => x.toString(16).toUpperCase())].join('.');
}

async function readMoov(blob: Blob): Promise<{ d: DataView; s: number; e: number } | null> {
  let p = 0;
  while (p + 8 <= blob.size) {
    const h = new DataView(await blob.slice(p, p + 16).arrayBuffer());
    let size = h.getUint32(0);
    const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
    if (size === 1) size = h.getUint32(8) * 2 ** 32 + h.getUint32(12);
    else if (size === 0) size = blob.size - p;
    if (size < 8) return null;
    // 分割された mp4 は読まない
    if (type === 'moof') return null;
    if (type === 'moov') {
      const d = new DataView(await blob.slice(p, p + size).arrayBuffer());
      return { d, s: size > 0xffffffff ? 16 : 8, e: size };
    }
    p += size;
  }
  return null;
}

export class VideoSource {
  private dec: VideoDecoder;
  private next = 0;
  private pending: VideoFrame[] = [];
  private cur: VideoFrame | null = null;
  private flushed = false;
  private wake: (() => void) | null = null;
  private err: unknown = null;

  private constructor(private readonly blob: Blob, private readonly samples: Sample[], private readonly cfg: VideoDecoderConfig) {
    this.dec = new VideoDecoder({
      output: (f) => {
        // 表示の順に届く
        this.pending.push(f);
        this.wake?.();
      },
      error: (e) => {
        this.err = e;
        this.wake?.();
      },
    });
    this.dec.configure(cfg);
  }

  static async open(url: string): Promise<VideoSource | null> {
    if (typeof VideoDecoder === 'undefined') return null;
    try {
      const blob = await (await fetch(url)).blob();
      const m = await readMoov(blob);
      if (!m) return null;
      const { d } = m;
      for (const [t, a, b] of boxes(d, m.s, m.e)) {
        if (t !== 'trak') continue;
        const hdlr = child(d, a, b, ['mdia', 'hdlr']);
        if (!hdlr || String.fromCharCode(d.getUint8(hdlr[0] + 8), d.getUint8(hdlr[0] + 9), d.getUint8(hdlr[0] + 10), d.getUint8(hdlr[0] + 11)) !== 'vide') continue;
        const mdhd = child(d, a, b, ['mdia', 'mdhd'])!;
        const ts = d.getUint8(mdhd[0]) === 1 ? d.getUint32(mdhd[0] + 20) : d.getUint32(mdhd[0] + 12);
        const stbl = child(d, a, b, ['mdia', 'minf', 'stbl']);
        if (!stbl || !ts) return null;
        const get = (n: string) => child(d, stbl[0], stbl[1], [n]);
        // 映像の設定
        const stsd = get('stsd')!;
        const ent = stsd[0] + 8;
        const etype = String.fromCharCode(d.getUint8(ent + 4), d.getUint8(ent + 5), d.getUint8(ent + 6), d.getUint8(ent + 7));
        const w = d.getUint16(ent + 8 + 24);
        const h = d.getUint16(ent + 8 + 26);
        const esize = d.getUint32(ent);
        let codec = '';
        let desc: Uint8Array | null = null;
        for (const [ct, ca, cb] of boxes(d, ent + 8 + 78, ent + esize)) {
          const bytes = new Uint8Array(d.buffer, d.byteOffset + ca, cb - ca).slice();
          if (ct === 'avcC' && (etype === 'avc1' || etype === 'avc3')) {
            codec = `avc1.${hex(bytes[1])}${hex(bytes[2])}${hex(bytes[3])}`;
            desc = bytes;
          } else if (ct === 'hvcC' && (etype === 'hvc1' || etype === 'hev1')) {
            codec = hevcCodec(etype, bytes);
            desc = bytes;
          }
        }
        if (!codec || !desc) return null;
        const cfg: VideoDecoderConfig = { codec, description: desc, codedWidth: w, codedHeight: h };
        if (!(await VideoDecoder.isConfigSupported(cfg)).supported) return null;
        // コマの位置・大きさ・時刻
        const stsz = get('stsz')!;
        const n = d.getUint32(stsz[0] + 8);
        const fixed = d.getUint32(stsz[0] + 4);
        const sizes = Array.from({ length: n }, (_, i) => (fixed || d.getUint32(stsz[0] + 12 + i * 4)));
        const stco = get('stco');
        const co64 = get('co64');
        const offs: number[] = [];
        if (stco) for (let i = 0, c = d.getUint32(stco[0] + 4); i < c; i++) offs.push(d.getUint32(stco[0] + 8 + i * 4));
        else if (co64) for (let i = 0, c = d.getUint32(co64[0] + 4); i < c; i++) offs.push(d.getUint32(co64[0] + 8 + i * 8) * 2 ** 32 + d.getUint32(co64[0] + 12 + i * 8));
        else return null;
        const stsc = get('stsc')!;
        const sc: [number, number][] = [];
        for (let i = 0, c = d.getUint32(stsc[0] + 4); i < c; i++) sc.push([d.getUint32(stsc[0] + 8 + i * 12), d.getUint32(stsc[0] + 12 + i * 12)]);
        const at: number[] = [];
        for (let ci = 0, k = 0, si = 0; ci < offs.length && si < n; ci++) {
          while (k + 1 < sc.length && sc[k + 1][0] <= ci + 1) k++;
          let o = offs[ci];
          for (let j = 0; j < sc[k][1] && si < n; j++, si++) {
            at.push(o);
            o += sizes[si];
          }
        }
        const stts = get('stts')!;
        const dts: number[] = [];
        const durs: number[] = [];
        let t0 = 0;
        for (let i = 0, c = d.getUint32(stts[0] + 4); i < c; i++) {
          const cnt = d.getUint32(stts[0] + 8 + i * 8);
          const dl = d.getUint32(stts[0] + 12 + i * 8);
          for (let j = 0; j < cnt; j++) { dts.push(t0); durs.push(dl); t0 += dl; }
        }
        const cts = new Array<number>(n).fill(0);
        const ctts = get('ctts');
        if (ctts) {
          const v1 = d.getUint8(ctts[0]) === 1;
          for (let i = 0, k = 0, c = d.getUint32(ctts[0] + 4); i < c; i++) {
            const cnt = d.getUint32(ctts[0] + 8 + i * 8);
            const off = v1 ? d.getInt32(ctts[0] + 12 + i * 8) : d.getUint32(ctts[0] + 12 + i * 8);
            for (let j = 0; j < cnt && k < n; j++) cts[k++] = off;
          }
        }
        const keys = new Set<number>();
        const stss = get('stss');
        if (stss) for (let i = 0, c = d.getUint32(stss[0] + 4); i < c; i++) keys.add(d.getUint32(stss[0] + 8 + i * 4) - 1);
        // 編集リストの最初のずれ（B フレームの分の先送りなど）
        let shift = 0;
        const elst = child(d, a, b, ['edts', 'elst']);
        if (elst && d.getUint32(elst[0] + 4) > 0) {
          const v1 = d.getUint8(elst[0]) === 1;
          const mt = v1 ? d.getInt32(elst[0] + 16) * 2 ** 32 + d.getUint32(elst[0] + 20) : d.getInt32(elst[0] + 12);
          if (mt > 0) shift = mt;
        }
        const samples: Sample[] = [];
        for (let i = 0; i < n && i < at.length && i < dts.length; i++) {
          samples.push({ at: at[i], size: sizes[i], ts: Math.round(((dts[i] + cts[i] - shift) / ts) * 1e6), dur: Math.round((durs[i] / ts) * 1e6), key: !stss || keys.has(i) });
        }
        if (!samples.length || !samples[0].key) return null;
        return new VideoSource(blob, samples, cfg);
      }
    } catch { /* 読めない */ }
    return null;
  }

  /** t 秒の少し前のキーフレームから読み直す（録画を区間に分けて描くとき） */
  seek(t: number) {
    const us = t * 1e6;
    let k = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i];
      if (s.ts > us) break;
      if (s.key) k = i;
    }
    this.cur?.close();
    for (const f of this.pending) f.close();
    this.cur = null;
    this.pending = [];
    this.flushed = false;
    this.next = k;
    if (this.dec.state === 'configured') {
      this.dec.reset();
      this.dec.configure(this.cfg);
    }
  }

  /** 動画の t 秒に出ているコマ（閉じないこと。次に呼ぶまで使える） */
  async frameAt(t: number): Promise<VideoFrame | null> {
    const us = t * 1e6;
    for (;;) {
      if (this.err) return this.cur ?? this.pending[0] ?? null;
      // 先のコマまで読んでおく
      while (this.next < this.samples.length && this.pending.length < 8 && this.dec.decodeQueueSize < 12) {
        const s = this.samples[this.next++];
        const data = new Uint8Array(await this.blob.slice(s.at, s.at + s.size).arrayBuffer());
        this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: s.ts, duration: s.dur, data }));
      }
      // t までのコマを進める
      while (this.pending.length && this.pending[0].timestamp <= us + 1) {
        this.cur?.close();
        this.cur = this.pending.shift()!;
      }
      if (this.pending.length) return this.cur ?? this.pending[0];
      // 届くのを待つ（全部渡したら、残りを出させる）
      if (this.next >= this.samples.length) {
        if (this.flushed) return this.cur;
        this.flushed = true;
        await this.dec.flush().catch(() => {});
        continue;
      }
      await new Promise<void>((r) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          clearTimeout(t);
          this.dec.removeEventListener('dequeue', fin);
          if (this.wake === fin) this.wake = null;
          r();
        };
        const t = setTimeout(fin, 500);
        this.wake = fin;
        this.dec.addEventListener('dequeue', fin);
      });
    }
  }

  close() {
    this.cur?.close();
    for (const f of this.pending) f.close();
    this.pending = [];
    this.cur = null;
    if (this.dec.state !== 'closed') this.dec.close();
  }
}

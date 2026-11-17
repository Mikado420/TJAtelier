/**
 * 録画の映像・音の形式を決め、混ぜた音を AAC（できなければ Opus・PCM）にする
 */
import { aacConfig, type AudioCodec } from './mp4';

export class RecordCancelled extends Error {}

/** 音の形式 */
export interface AudioPick { kind: AudioCodec['kind']; rate: number; config?: AudioEncoderConfig }

/**
 * 映像の設定。同じ見た目でファイルが小さくなる High プロファイルを先に試す（だめなら Main・Baseline。Baseline は少し多めに使う）。
 * 1080p が作れない端末は 720p にする
 */
export async function pickVideo(res: 1080 | 720, fps: number): Promise<VideoEncoderConfig | null> {
  const sizes: [number, number][] = res === 1080 ? [[1920, 1080], [1280, 720]] : [[1280, 720]];
  for (const [width, height] of sizes) {
    const big = height === 1080;
    // 1 秒あたりのビット数（High・Main のとき）。音符や光がずっと動く画面なので、にじまないよう多めに使う
    const rate = big ? (fps > 30 ? 14_000_000 : 9_000_000) : fps > 30 ? 8_000_000 : 5_000_000;
    const lv = big ? (fps > 30 ? '2A' : '28') : fps > 30 ? '20' : '1F';
    const tries: [string, number][] = [[`avc1.6400${lv}`, rate], [`avc1.4D00${lv}`, rate], [`avc1.4200${lv}`, Math.round(rate * 1.25)]];
    for (const [codec, bitrate] of tries) {
      const c: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' } };
      try {
        if ((await VideoEncoder.isConfigSupported(c)).supported) return c;
      } catch { /* 次 */ }
    }
  }
  return null;
}

/** 音の形式（AAC → Opus → PCM） */
export async function pickAudio(rate: number): Promise<AudioPick> {
  if (typeof AudioEncoder !== 'undefined') {
    for (const r of [...new Set([rate, 48000, 44100])]) {
      const c = { codec: 'mp4a.40.2', sampleRate: r, numberOfChannels: 2, bitrate: 192_000, aac: { format: 'aac' } } as AudioEncoderConfig;
      try {
        if ((await AudioEncoder.isConfigSupported(c)).supported) return { kind: 'aac', rate: r, config: c };
      } catch { /* 次 */ }
    }
    // iPhone・Mac は .mp4 の Opus を写真に保存できないことがあるので、AAC が無ければ PCM（.mov）に
    if (/iPhone|iPad|Macintosh/.test(navigator.userAgent)) return { kind: 'pcm', rate };
    const c: AudioEncoderConfig = { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 192_000 };
    try {
      if ((await AudioEncoder.isConfigSupported(c)).supported) return { kind: 'opus', rate: 48000, config: c };
    } catch { /* 次 */ }
  }
  return { kind: 'pcm', rate };
}

const toU8 = (d: AllowSharedBufferSource) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice();


/** エンコーダーの待ちが max 以下になるまで待つ */
function drained(enc: AudioEncoder, max: number) {
  return new Promise<void>((res) => {
    const check = () => {
      if (enc.encodeQueueSize > max && enc.state === 'configured') return;
      enc.removeEventListener('dequeue', check);
      clearInterval(t);
      res();
    };
    enc.addEventListener('dequeue', check);
    const t = setInterval(check, 4);
  });
}

export interface AudioOut {
  codec: AudioCodec;
  rate: number;
  chunks: { data: Uint8Array; frames: number }[];
}

/** 音を PCM（.mov）にする */
function pcmOf(mix: AudioBuffer, frames: number): { data: Uint8Array; frames: number }[] {
  const L = mix.getChannelData(0);
  const Rc = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
  const n = Math.min(mix.length, frames);
  const out: { data: Uint8Array; frames: number }[] = [];
  const BLK = 4800;
  for (let o = 0; o < n; o += BLK) {
    const m = Math.min(BLK, n - o);
    const b = new DataView(new ArrayBuffer(m * 4));
    for (let k = 0; k < m; k++) {
      b.setInt16(k * 4, Math.max(-32768, Math.min(32767, Math.round(L[o + k] * 32767))), true);
      b.setInt16(k * 4 + 2, Math.max(-32768, Math.min(32767, Math.round(Rc[o + k] * 32767))), true);
    }
    out.push({ data: new Uint8Array(b.buffer), frames: m });
  }
  return out;
}

/** 音の大きさ（全体の二乗平均の平方根。間引いて測る） */
function rmsOf(chs: Float32Array[]) {
  let s = 0;
  let n = 0;
  for (const c of chs) for (let i = 0; i < c.length; i += 7) { s += c[i] * c[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

/** ADTS の頭（AAC の 1 つずつに付くことがある）を外し、そこから AudioSpecificConfig を作る */
function stripAdts(d: Uint8Array): { body: Uint8Array; asc?: Uint8Array } {
  if (d.length < 7 || d[0] !== 0xff || (d[1] & 0xf0) !== 0xf0) return { body: d };
  const head = d[1] & 1 ? 7 : 9;
  const prof = ((d[2] >> 6) & 3) + 1;
  const fi = (d[2] >> 2) & 15;
  const ch = ((d[2] & 1) << 2) | (d[3] >> 6);
  return { body: d.subarray(head), asc: new Uint8Array([(prof << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)]) };
}

/**
 * 混ぜた音を形式に合わせて作る（length 秒まで）。AAC・Opus は作ったものを一度読み戻して、音が入っているか確かめる。
 * 読み戻せない・音が消えているときは PCM（.mov）にする
 */
export async function encodeAudio(mix: AudioBuffer, a: AudioPick, length: number, cancelled: () => boolean, diag: Record<string, unknown>): Promise<AudioOut> {
  const total = Math.min(mix.length, Math.round(length * a.rate));
  const L = mix.getChannelData(0);
  const Rc = mix.numberOfChannels > 1 ? mix.getChannelData(1) : L;
  const mixRms = rmsOf([L.subarray(0, total), Rc.subarray(0, total)]);
  const ad: Record<string, unknown> = { mixRms: Math.round(mixRms * 1e4) / 1e4, mixLen: mix.length };
  diag.audio = ad;
  const pcm = (): AudioOut => ({ codec: { kind: 'pcm' }, rate: a.rate, chunks: pcmOf(mix, total) });
  if (a.kind === 'pcm' || !a.config) {
    ad.final = 'pcm';
    return pcm();
  }
  try {
    let err: unknown = null;
    const per = a.kind === 'aac' ? 1024 : 960;
    let desc: Uint8Array | null = null;
    let adts = 0;
    const chunks: { data: Uint8Array; frames: number; ts: number }[] = [];
    const ae = new AudioEncoder({
      output: (chunk, meta) => {
        const dd = meta?.decoderConfig?.description;
        if (dd) desc = toU8(dd);
        let d = new Uint8Array(chunk.byteLength);
        chunk.copyTo(d);
        if (a.kind === 'aac') {
          const x = stripAdts(d);
          if (x.asc) {
            adts++;
            desc ??= x.asc;
            d = x.body.slice();
          }
        }
        // 1 つの長さ: AAC はいつも 1024。Opus は届いた長さ（無ければ 960）
        const frames = a.kind === 'aac' ? 1024 : Math.round(((chunk.duration ?? 0) * a.rate) / 1e6) || per;
        chunks.push({ data: d, frames, ts: chunk.timestamp });
      },
      error: (e) => { err = e; },
    });
    try {
      ae.configure(a.config);
      const BLK = 4096;
      for (let o = 0; o < mix.length; o += BLK) {
        if (err) throw err;
        if (cancelled()) throw new RecordCancelled();
        const m = Math.min(BLK, mix.length - o);
        const data = new Float32Array(m * 2);
        data.set(L.subarray(o, o + m), 0);
        data.set(Rc.subarray(o, o + m), m);
        const x = new AudioData({ format: 'f32-planar', sampleRate: a.rate, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((o / a.rate) * 1e6), data });
        ae.encode(x);
        x.close();
        if (ae.encodeQueueSize > 16) await drained(ae, 8);
      }
      await ae.flush();
      if (err) throw err;
    } finally {
      if (ae.state !== 'closed') ae.close();
    }
    // length 秒までにする
    let acc = 0;
    let k = 0;
    while (k < chunks.length && acc < total) acc += chunks[k++].frames;
    const used = chunks.slice(0, k);
    // AAC の設定（AudioSpecificConfig）: iPhone はエンコーダーが別の形（ES 記述子など）で渡すことがあり、
    // そのまま .mp4 に入れると、写真などのアプリで音が鳴らない。AAC-LC・2ch と決めて作ったので、こちらで作った正しい形を使う
    const codec: AudioCodec =
      a.kind === 'aac'
        ? { kind: 'aac', asc: aacConfig(a.rate, 2) }
        : { kind: 'opus', preSkip: desc && (desc as Uint8Array).length >= 12 ? (desc as Uint8Array)[10] | ((desc as Uint8Array)[11] << 8) : 312 };
    ad.chunks = used.length;
    ad.adts = adts;
    ad.desc = desc ? Array.from((desc as Uint8Array).slice(0, 24)).map((x) => x.toString(16).padStart(2, '0')).join('') : '';
    // 読み戻して確かめる
    if (typeof AudioDecoder !== 'undefined' && mixRms > 1e-4) {
      const dec = await decodeRms(a, codec, used);
      ad.decRms = dec === null ? null : Math.round(dec * 1e4) / 1e4;
      if (dec === null || dec < mixRms * 0.3) {
        ad.final = 'pcm';
        return pcm();
      }
    }
    ad.final = a.kind;
    return { codec, rate: a.rate, chunks: used.map((c) => ({ data: c.data, frames: c.frames })) };
  } catch (e) {
    if (e instanceof RecordCancelled) throw e;
    ad.error = String((e as Error)?.message ?? e);
    ad.final = 'pcm';
    return pcm();
  }
}

/** 作った音を読み戻した大きさ（読めなければ null） */
async function decodeRms(a: { kind: AudioCodec['kind']; rate: number }, codec: AudioCodec, chunks: { data: Uint8Array; frames: number; ts: number }[]): Promise<number | null> {
  let s = 0;
  let n = 0;
  let err = false;
  const dec = new AudioDecoder({
    output: (x) => {
      try {
        for (let ch = 0; ch < x.numberOfChannels; ch++) {
          const buf = new Float32Array(x.numberOfFrames);
          x.copyTo(buf, { planeIndex: ch, format: 'f32-planar' });
          for (let i = 0; i < buf.length; i += 7) { s += buf[i] * buf[i]; n++; }
        }
      } catch {
        err = true;
      }
      x.close();
    },
    error: () => { err = true; },
  });
  try {
    const description = codec.kind === 'aac' ? codec.asc : undefined;
    dec.configure({ codec: a.kind === 'aac' ? 'mp4a.40.2' : 'opus', sampleRate: a.rate, numberOfChannels: 2, description });
    let t = 0;
    for (const c of chunks) {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((t / a.rate) * 1e6), data: c.data }));
      t += c.frames;
      if (dec.decodeQueueSize > 32) await new Promise((r) => setTimeout(r, 1));
    }
    await dec.flush();
  } catch {
    err = true;
  } finally {
    if (dec.state !== 'closed') dec.close();
  }
  return err || !n ? null : Math.sqrt(s / n);
}

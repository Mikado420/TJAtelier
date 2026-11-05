# 拍の AI（Beat This! 通常版）と音源分離（HTDemucs）を ONNX に書き出す（GitHub Actions で動かす）
import math, os, sys
import numpy as np
import torch

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
os.makedirs(OUT, exist_ok=True)
torch.set_grad_enabled(False)
torch.backends.mha.set_fastpath_enabled(False)

# ---------- Beat This! final0 ----------
from beat_this.inference import load_model
bt = load_model('final0', device='cpu').eval()

class BT(torch.nn.Module):
    def __init__(s, m):
        super().__init__(); s.m = m
    def forward(s, mel):
        o = s.m(mel)
        return o['beat'], o['downbeat']

mel = torch.randn(1, 1500, 128)
import onnxruntime as ort
# 比べる正解は、書き出す前に別のモデルで出しておく（書き出しでモデルの中の覚えが変わるため）
ref_model = BT(load_model('final0', device='cpu').eval())
tests = []
for T in (500, 1500, 3000, 6000):
    x = torch.randn(1, T, 128)
    rb, rd = ref_model(x)
    tests.append((x, rb.numpy(), rd.numpy()))
torch.onnx.export(BT(bt), (mel,), f'{OUT}/beat-this-final0.onnx', input_names=['mel'], output_names=['beat', 'downbeat'],
                  dynamic_axes={'mel': {0: 'batch', 1: 'time'}, 'beat': {0: 'batch', 1: 'time'}, 'downbeat': {0: 'batch', 1: 'time'}}, opset_version=17, dynamo=False)
s = ort.InferenceSession(f'{OUT}/beat-this-final0.onnx')
for x, rb, rd in tests:
    b, d = s.run(None, {'mel': x.numpy()})
    print('beat this diff T', x.shape[1], np.abs(b - rb).max(), np.abs(d - rd).max(), 'ref', np.abs(rb).max())

# ---------- HTDemucs ----------
from demucs.pretrained import get_model
bag = get_model('htdemucs')
m = bag.models[0].eval()
print('sources', m.sources, 'sr', m.samplerate, 'segment', m.segment, 'params', sum(p.numel() for p in m.parameters()))
L = int(m.segment * m.samplerate)
print('training_length', L)
NFFT, HL = m.nfft, m.hop_length
print('nfft', NFFT, 'hop', HL, 'cac', m.cac)

store = {}
def _ispec(z, length=None, scale=0):
    store['spec'] = z
    return torch.zeros(z.shape[0], z.shape[1], z.shape[2] // 2, length)

class HD(torch.nn.Module):
    """音の波形 mix と、その複素スペクトル（実部・虚部を交互の 4ch）mag から、
    スペクトル側の出力（4 音源 × 4ch）と波形側の出力（4 音源 × 2ch）を返す。最後に足し合わせるのは外で行う"""
    def __init__(s, m):
        super().__init__(); s.m = m
    def forward(s, mix, mag):
        mm = s.m
        mm._spec = lambda x: None
        mm._magnitude = lambda z: mag
        mm._mask = lambda z, x: x
        mm._ispec = _ispec
        wav = mm(mix)
        return store['spec'], wav

def spec_np(x):
    """demucs の _spec と同じ（x: [C, L]）→ [C, 2048, T] 複素"""
    le = int(math.ceil(x.shape[-1] / HL))
    pad = HL // 2 * 3
    x = np.pad(x, ((0, 0), (pad, pad + le * HL - x.shape[-1])), mode='reflect')
    z = torch.stft(torch.from_numpy(x), NFFT, HL, window=torch.hann_window(NFFT), win_length=NFFT, normalized=True, center=True, return_complex=True, pad_mode='reflect').numpy()
    return z[:, :-1, 2:2 + le]

def ispec_np(z, length):
    """demucs の _ispec と同じ（z: [..., 2048, T] 複素）"""
    z = np.pad(z, [(0, 0)] * (z.ndim - 2) + [(0, 1), (2, 2)])
    pad = HL // 2 * 3
    le = HL * int(math.ceil(length / HL)) + 2 * pad
    sh = z.shape
    x = torch.istft(torch.from_numpy(z.reshape(-1, sh[-2], sh[-1])), NFFT, HL, window=torch.hann_window(NFFT), win_length=NFFT, normalized=True, length=le, center=True).numpy()
    return x.reshape(*sh[:-2], -1)[..., pad:pad + length]

rng = np.random.default_rng(0)
t = np.arange(L) / m.samplerate
sig = (0.3 * np.sin(2 * np.pi * 220 * t) + 0.2 * rng.standard_normal(L) * (np.sin(2 * np.pi * 2 * t) > 0.9)).astype(np.float32)
mix = np.stack([sig, np.roll(sig, 100)])[None]

def mag_of(mix):
    z = spec_np(mix[0])  # [2, 2048, T]
    return np.stack([z.real, z.imag], 1).reshape(1, 4, z.shape[1], z.shape[2]).astype(np.float32)

# 半精度（GPU 用）: 32bit で動かして値が半精度の範囲を超える計算と、正規化などの溢れやすい計算だけ 32bit のまま残す
def to_fp16(src, dst, x):
    import onnx
    from onnxconverter_common import float16
    mdl = onnx.load(src)
    # 途中の値を少しずつ出して、いちばん大きい値を見る（一度に全部出すとメモリが足りない）
    names = [o for n in mdl.graph.node for o in n.output if o]
    big = {}
    feeds = {'mix': x, 'mag': mag_of(x)}
    so = ort.SessionOptions(); so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    so.enable_cpu_mem_arena = False
    B = 150
    for k in range(0, len(names), B):
        probe = onnx.load(src)
        del probe.graph.output[:]
        for n in names[k:k + B]:
            probe.graph.output.append(onnx.ValueInfoProto(name=n))
        tmp = src + '.probe.onnx'
        onnx.save(probe, tmp)
        del probe
        sess = ort.InferenceSession(tmp, so)
        for o, v in zip([o.name for o in sess.get_outputs()], sess.run(None, feeds)):
            if isinstance(v, np.ndarray) and v.dtype == np.float32 and v.size:
                big[o] = float(np.abs(v).max())
        del sess
        os.remove(tmp)
    print('fp16 probe max', max(big.values()))
    block = []
    for n in mdl.graph.node:
        if any(big.get(o, 0) > 2e4 for o in n.output) or any(big.get(i, 0) > 2e4 for i in n.input):
            block.append(n.name)
    print('fp16 block nodes', len(block), 'of', len(mdl.graph.node))
    mdl16 = float16.convert_float_to_float16(mdl, keep_io_types=True, node_block_list=block,
                                             op_block_list=['ReduceMean', 'ReduceSum', 'Pow', 'Sqrt', 'InstanceNormalization', 'LayerNormalization', 'Softmax', 'ReduceL2'])
    # 32bit に残した計算の出力を、いったん半精度にしてからまた 32bit に戻す無駄な変換があり、そこで値が溢れるので、
    # 行き先がすべて 32bit に戻す変換なら、半精度にしない
    cons = {}
    for n in mdl16.graph.node:
        for i in n.input:
            cons.setdefault(i, []).append(n)
    def to_of(n):
        return next((a.i for a in n.attribute if a.name == 'to'), None)
    fixed = 0
    for n in mdl16.graph.node:
        if n.op_type == 'Cast' and to_of(n) == onnx.TensorProto.FLOAT16:
            cs = [c for o in n.output for c in cons.get(o, [])]
            if cs and all(c.op_type == 'Cast' and to_of(c) == onnx.TensorProto.FLOAT for c in cs) and not any(o in [g.name for g in mdl16.graph.output] for o in n.output):
                for a2 in n.attribute:
                    if a2.name == 'to':
                        a2.i = onnx.TensorProto.FLOAT
                for vi in mdl16.graph.value_info:
                    if vi.name in n.output:
                        vi.type.tensor_type.elem_type = onnx.TensorProto.FLOAT
                fixed += 1
    print('fp16 cast fixed', fixed)
    onnx.save(mdl16, dst)
    print('fp16 saved', dst, os.path.getsize(dst))
    # 半精度の版で、どこで値が壊れる（NaN・無限大になる）かを探す
    m16 = onnx.load(dst)
    order = [(n.name, n.op_type, list(n.input), [o for o in n.output if o]) for n in m16.graph.node]
    outs16 = [o for _, _, _, os_ in order for o in os_]
    bad = {}
    vals = {}
    B2 = 800
    for k in range(0, len(outs16), B2):
        pr = onnx.load(dst)
        del pr.graph.output[:]
        for n in outs16[k:k + B2]:
            pr.graph.output.append(onnx.ValueInfoProto(name=n))
        tmp = dst + '.probe.onnx'
        onnx.save(pr, tmp)
        del pr
        try:
            sess = ort.InferenceSession(tmp, so)
        finally:
            os.remove(tmp)
        for o, v in zip([o.name for o in sess.get_outputs()], sess.run(None, feeds)):
            if isinstance(v, np.ndarray) and v.dtype.kind == 'f' and v.size:
                vf = v.astype(np.float32)
                bad[o] = bool(~np.isfinite(vf).all())
                vals[o] = float(np.nanmax(np.abs(np.where(np.isfinite(vf), vf, 0))))
        del sess
    shown = 0
    for name, op, ins, os_ in order:
        if any(bad.get(o) for o in os_) and not any(bad.get(i) for i in ins):
            print('fp16 first bad', name, op, 'in', [(i, vals.get(i), big.get(i)) for i in ins], 'out32', [big.get(o) for o in os_])
            shown += 1
            if shown >= 8:
                break
    print('fp16 bad count', sum(bad.values()))

mg = mag_of(mix)
print('mag', mg.shape)
w = HD(m)
torch.onnx.export(w, (torch.from_numpy(mix), torch.from_numpy(mg)), f'{OUT}/htdemucs.onnx', input_names=['mix', 'mag'], output_names=['spec', 'wave'], opset_version=17, dynamo=False)
# 短い区切りの版（メモリを抑えるため）
from fractions import Fraction
for name, seg in (('s39', Fraction(39, 10)), ('s26', Fraction(13, 5)), ('s20', Fraction(2, 1))):
    mm = get_model('htdemucs').models[0].eval()
    mm.segment = seg
    Ls = int(seg * mm.samplerate)
    xs = mix[..., :Ls].copy()
    torch.onnx.export(HD(mm), (torch.from_numpy(xs), torch.from_numpy(mag_of(xs))), f'{OUT}/htdemucs-{name}.onnx', input_names=['mix', 'mag'], output_names=['spec', 'wave'], opset_version=17, dynamo=False)
    print('exported', name, Ls)
    if name == 's20':
        try:
            # 大きめの音（ほぼ最大音量の雑音と音程）で値の大きさを見る
            r2 = np.random.default_rng(1)
            tt = np.arange(Ls) / 44100
            loud = (0.6 * r2.standard_normal((1, 2, Ls)) + 0.4 * np.sin(2 * np.pi * 55 * tt)).clip(-1, 1).astype(np.float32)
            to_fp16(f'{OUT}/htdemucs-{name}.onnx', f'{OUT}/htdemucs-{name}-fp16.onnx', loud)
        except Exception as e:
            print('fp16 failed', name, e)

def combine(spec, wave):
    S = spec.shape[1]
    sp = spec.reshape(1, S, 2, 2, spec.shape[-2], spec.shape[-1])
    z = sp[:, :, :, 0] + 1j * sp[:, :, :, 1]
    return wave + ispec_np(z, L)

s = ort.InferenceSession(f'{OUT}/htdemucs.onnx')
sp, wv = s.run(None, {'mix': mix, 'mag': mg})
got = combine(sp, wv)
ref = bag.models[0].__class__.forward  # 元に戻したモデルで比べる
m2 = get_model('htdemucs').models[0].eval()
exp = m2(torch.from_numpy(mix)).numpy()
print('htdemucs diff', np.abs(got - exp).max(), 'ref max', np.abs(exp).max())

# 確かめ用の入出力（ブラウザ側の STFT を合わせるため）
np.save(f'{OUT}/check-mix.npy', mix)
np.save(f'{OUT}/check-out.npy', exp.astype(np.float32))
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(f'{OUT}/{f}'))

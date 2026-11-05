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
def check(path):
    s = ort.InferenceSession(path)
    out = []
    for T in (500, 1500, 3000):
        x = torch.randn(1, T, 128)
        b, d = s.run(None, {'mel': x.numpy()})
        rb, rd = BT(bt)(x)
        out.append(f'T{T} {np.abs(b - rb.numpy()).max():.2e}/{np.abs(d - rd.numpy()).max():.2e}')
    return ' '.join(out)

variants = {
    'legacy': dict(dynamo=False),
    'legacy-nofold': dict(dynamo=False, do_constant_folding=False),
    'legacy-op18': dict(dynamo=False, opset_version=18),
}
best = None
for name, kw in variants.items():
    kw = {'opset_version': 17, **kw}
    path = f'/tmp/bt-{name}.onnx'
    try:
        torch.onnx.export(BT(bt), (mel,), path, input_names=['mel'], output_names=['beat', 'downbeat'],
                          dynamic_axes={'mel': {0: 'batch', 1: 'time'}, 'beat': {0: 'batch', 1: 'time'}, 'downbeat': {0: 'batch', 1: 'time'}}, **kw)
        r = check(path)
        print('beat this', name, r)
        if best is None and all(float(t.split(' ')[1].split('/')[0]) < 1e-3 for t in r.split(' T')[0:1]) and 'e+' not in r and 'e-01' not in r:
            best = path
    except Exception as e:
        print('beat this', name, 'failed', str(e)[:300])
# 速い経路を切った素の torch.jit.trace でも試す
try:
    tr = torch.jit.trace(BT(bt), (mel,), check_trace=False)
    for T in (500, 3000):
        x = torch.randn(1, T, 128)
        print('jit trace diff T', T, (tr(x)[0] - BT(bt)(x)[0]).abs().max().item())
except Exception as e:
    print('jit failed', e)
import shutil
if best:
    shutil.copy(best, f'{OUT}/beat-this-final0.onnx')
    print('beat this picked', best)

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

mg = mag_of(mix)
print('mag', mg.shape)
w = HD(m)
torch.onnx.export(w, (torch.from_numpy(mix), torch.from_numpy(mg)), f'{OUT}/htdemucs.onnx', input_names=['mix', 'mag'], output_names=['spec', 'wave'], opset_version=17, dynamo=False)

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

# 半精度（GPU 用）
try:
    import onnx
    from onnxconverter_common import float16
    mdl = onnx.load(f'{OUT}/htdemucs.onnx')
    mdl16 = float16.convert_float_to_float16(mdl, keep_io_types=True, op_block_list=['ReduceMean', 'ReduceSum', 'Pow', 'Sqrt', 'Div', 'InstanceNormalization', 'LayerNormalization', 'Softmax', 'Exp', 'Erf', 'ReduceL2'])
    onnx.save(mdl16, f'{OUT}/htdemucs-fp16.onnx')
    s16 = ort.InferenceSession(f'{OUT}/htdemucs-fp16.onnx')
    sp, wv = s16.run(None, {'mix': mix, 'mag': mg})
    print('htdemucs fp16 diff', np.abs(combine(sp, wv) - exp).max())
except Exception as e:
    print('fp16 failed', e)

# 確かめ用の入出力（ブラウザ側の STFT を合わせるため）
np.save(f'{OUT}/check-mix.npy', mix)
np.save(f'{OUT}/check-out.npy', exp.astype(np.float32))
for f in sorted(os.listdir(OUT)):
    print(f, os.path.getsize(f'{OUT}/{f}'))

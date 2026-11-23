"""TNDE スキンの、まだ元の大きさ（k が無い）の絵を、waifu2x（swin_unet・art）でまとめて細かくする。

- 音符・レーン・太鼓・ゲージ・風船・判定の光など、プレイ中によく見る絵は 2 倍
- 背景・踊り子・ロード画面・リザルトの雲など大きな絵は、メモリを抑えるため 1.5 倍
- 2 倍・1.5 倍にすると iPhone の上限（1 枚 420 万画素）を超える絵は 1.25 倍
- 画質を落として入れてある絵（webp の VP8）は、ノイズを消すモデルで
- 連番（anim）は 1 コマずつ細かくして、420 万画素・横 4096 px ごとに分けて並べ直す

1 枚ごとに skin.json に k を書くので、途中で止めても、もう一度動かせば続きから細かくする。

使い方: python3 -I tools/skin/hqall.py <public/skins/tnde> <waifu2x の onnx_models> [絵の名前,…]
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import hq

OUT, hq.MODELS = sys.argv[1], sys.argv[2]
hq.OUT = OUT
ONLY = set(sys.argv[3].split(',')) if len(sys.argv) > 3 else None
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))

LIMIT, MAXW = 4_200_000, 4096

# 細かくしない絵
SKIP = {
    'bar', 'barBranch',  # 幅 3 px の線
    'nameplate_frames',  # もとから 4 倍の絵
    # 1.25 倍でも 420 万画素を超える大きな絵
    'mob', 'bg/Bg_down/c/0/Clear', 'fx/TitleShine', 'fx/GoGoSplash',
}
# 1.25 倍にする絵（1 コマの大きさが 1.25 倍で割り切れる）
Q125 = {'fx/Explosion', 'fx/FireWorks', 'gauge/1P_Explosion'}
# 1.5 倍にする大きな絵
BIG = ('bg/', 'dancer/', 'load/Bg', 'load/BgWait', 'load/Fade', 'load/Chara', 'res/cloud', 'fx/Fire', 'fx/Rainbow', 'gauge/Fire')


def scale_of(name):
    if name in Q125:
        return 1.25
    return 1.5 if name.startswith(BIG) else 2


def lossy_src(f):
    with open(os.path.join(OUT, f), 'rb') as fp:
        return b'VP8L' not in fp.read(200)


def save():
    man['v'] = '%x' % int(time.time())
    json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))


def up(im, q, noisy):
    # 小さな絵は小さなタイルで（大きなタイルの余白を計算しない）
    hq.TILE = 256 if max(im.shape[:2]) <= 432 else 512
    return hq.up(im, q, noisy=noisy)


def want(name):
    return (ONLY is None or name in ONLY) and name not in SKIP


# 目に入りやすい順に
def prio(name):
    for i, p in enumerate(['notes', 'chip', 'taiko/', 'lane/', 'gauge/', 'fx/', 'balloon/', 'game/', 'arm', 'footer', 'end/', 'load/', 'res/', 'bg/Bg_down', 'bg/Bg_up', 'bg/clear', 'dancer/']):
        if name.startswith(p):
            return i
    return 99


todo = [('img', k) for k, v in man['img'].items() if not v.get('k') and want(k)]
todo += [('anim', k) for k, v in man['anim'].items() if not v.get('k') and want(k)]
todo.sort(key=lambda t: prio(t[1]))
print(len(todo), 'images', flush=True)

for n, (sec, name) in enumerate(todo):
    t0 = time.time()
    e = man[sec][name]
    q = scale_of(name)
    noisy = lossy_src(e['f'])
    if sec == 'img':
        im = hq.rd(os.path.join(OUT, e['f']))
        u = up(im, q, noisy)
        big = u.shape[0] * u.shape[1] > 1_500_000
        hq.wr(e['f'], u, noisy or big, 95)
        e['k'] = q
    else:
        sheet = hq.rd(os.path.join(OUT, e['f']))
        fw, fh, cols = e['w'], e['h'], e['cols']
        # 1.5 倍で割り切れるよう、コマの大きさを偶数に（下・右に透明な 1 px を足す）
        fw2, fh2 = (fw + fw % 2, fh + fh % 2) if q == 1.5 else (fw, fh)
        W, H = round(fw2 * q), round(fh2 * q)
        cells = []
        for i in range(e['n']):
            c = sheet[(i // cols) * fh:(i // cols) * fh + fh, (i % cols) * fw:(i % cols) * fw + fw]
            cl = np.zeros((fh2, fw2, 4), np.uint8)
            cl[:c.shape[0], :c.shape[1]] = c
            cells.append(up(cl, q, noisy)[:H, :W])
        cols2 = max(1, min(len(cells), MAXW // W))
        rows = max(1, LIMIT // (cols2 * W * H))
        per = cols2 * rows
        old = os.path.join(OUT, e['f'])
        base = e['f'][:-5]
        files = []
        for pg in range(-(-len(cells) // per)):
            part = cells[pg * per:(pg + 1) * per]
            r = -(-len(part) // cols2)
            out = np.zeros((r * H, min(cols2, len(part)) * W, 4), np.uint8)
            for j, cl in enumerate(part):
                out[(j // cols2) * H:(j // cols2) * H + H, (j % cols2) * W:(j % cols2) * W + W] = cl
            f = '%s-%d.webp' % (base, pg)
            hq.wr(f, out, noisy or out.shape[0] * out.shape[1] > 1_500_000, 95)
            files.append(f)
        if os.path.exists(old) and old not in [os.path.join(OUT, f) for f in files]:
            os.remove(old)
        e.update({'f': files[0], 'w': fw2, 'h': fh2, 'cols': cols2, 'k': q})
        if len(files) > 1:
            e.update({'per': per, 'pages': files})
    save()
    print('%d/%d %s %s x%s %.0fs' % (n + 1, len(todo), sec, name, q, time.time() - t0), flush=True)

save()
print('done', flush=True)

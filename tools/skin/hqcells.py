"""TNDE スキンの、何コマかを 1 枚に並べた絵を、1 コマずつ waifu2x で細かくし直す。

1 枚まるごと細かくすると、となりのコマの端がにじんで入り、切り出したときにゴミの線として出る。
元の大きさの絵（細かくする前）から、コマごとに細かくして同じ並びで貼り直す。
コマの大きさが倍率で割り切れない絵は、割り切れる倍率（2 倍）にする。

使い方: python3 -I tools/skin/hqcells.py <public/skins/tnde> <waifu2x の onnx_models> <細かくする前の絵のフォルダ> [絵の名前,…]
（細かくする前の絵のフォルダは public/skins/tnde と同じ並び。git show で取り出しておく）
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import hq

OUT, hq.MODELS, SRC = sys.argv[1], sys.argv[2], sys.argv[3]
hq.OUT = OUT
ONLY = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))


def grid(cw, ch, nx, ny, x0=0, y0=0):
    return [(x0 + i * cw, y0 + j * ch, cw, ch) for j in range(ny) for i in range(nx)]


def strip(W, H, n):
    """横に n コマ（1 コマの幅が整数でない絵）"""
    return [(i * W / n, 0, W / n, H) for i in range(n)]


def gauge(W, H):
    """魂ゲージ: 上の帯（44 px）と、下に 58 px ずつ並んだクリアの印"""
    return [(0, 0, W, 44)] + [(x, 44, min(58, W - x), H - 44) for x in range(0, W, 58)]


# 名前: (倍率, コマ（元の絵の px で x, y, w, h）)
CELLS = {
    'fx/Explosion': (1.25, grid(260, 260, 7, 4)),
    'fx/Fire': (1.5, grid(360, 370, 7, 1)),
    'fx/FireWorks': (1.25, grid(192, 192, 16, 1)),
    'gauge/Fire': (1.5, grid(230, 230, 8, 1)),
    'gauge/1P_Explosion': (1.25, grid(180, 180, 18, 1)),
    'gauge/Soul': (2, grid(80, 80, 1, 2)),
    'game/ScoreRank': (2, grid(140, 120, 1, 7)),
    'game/BestScore': (2, [(0, 0, 332, 44), (0, 44, 332, 56), (0, 100, 332, 76)]),
    'balloon/Combo_2P': (2, grid(360, 192, 3, 1)),
    'bg/Bg_up/3/Chara': (2, grid(328, 233, 2, 3)),
    'bg/Bg_up/3/Base': (2, grid(335, 188, 3, 1)),
    'bg/Bg_up/3/Flower': (1.5, grid(641, 184, 1, 3)),
    'load/Chara': (1.5, grid(640, 300, 2, 1)),
}
for s in ('', '2', '3'):
    CELLS['bg/Bg_up/2/Ika' + s] = (1.5, strip(1230, 136, 9))
    CELLS['bg/Bg_up/2/Hair' + s] = (1.5, strip(176, 54, 3))
    CELLS['bg/Bg_up/2/Hair_Clear' + s] = (1.5, strip(234, 54, 4))
for i in range(4):
    CELLS['gauge/fill%d' % i] = (2, gauge(700, 68))
for i in range(3):
    CELLS['gauge/base%d' % i] = (2, gauge(700, 68))


def lossy_src(p):
    with open(p, 'rb') as fp:
        return b'VP8L' not in fp.read(200)


for name, (q, cells) in CELLS.items():
    e = man['img'].get(name)
    if not e or (ONLY is not None and name not in ONLY):
        continue
    t0 = time.time()
    p = os.path.join(SRC, e['f'])
    im = hq.rd(p)
    noisy = lossy_src(p)
    H, W = im.shape[:2]
    out = np.zeros((round(H * q), round(W * q), 4), np.uint8)
    for x, y, w, h in cells:
        # 元の絵での範囲（整数でないコマは、いちばん近い px で）と、細かくした絵での範囲
        sx0, sy0, sx1, sy1 = round(x), round(y), round(x + w), round(y + h)
        dx0, dy0, dx1, dy1 = round(x * q), round(y * q), round((x + w) * q), round((y + h) * q)
        c = im[sy0:sy1, sx0:sx1]
        if c.size == 0:
            continue
        hq.TILE = 256 if max(c.shape[:2]) <= 432 else 512
        u = hq.up(c, q, noisy=noisy)
        if u.shape[:2] != (dy1 - dy0, dx1 - dx0):
            u = cv2.resize(u, (dx1 - dx0, dy1 - dy0), interpolation=cv2.INTER_AREA)
        out[dy0:dy1, dx0:dx1] = u
    hq.wr(e['f'], out, noisy or out.shape[0] * out.shape[1] > 1_500_000, 95)
    e['k'] = q
    man['v'] = '%x' % int(time.time())
    json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(name, q, len(cells), 'cells', '%.0fs' % (time.time() - t0), flush=True)

print('done', flush=True)

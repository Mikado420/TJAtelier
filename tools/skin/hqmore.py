"""TNDE スキンの残りの粗い絵（手前のお客さん・ゴーゴーの水しぶき・判定の爆発・花火・魂ゲージの爆発）を、
スキンの元の絵（png）から 1 コマずつ waifu2x で 1.5 倍に細かくする。

- お客さん（mob）: 使っている上の 3 段（0〜955px）だけを残す
- ゴーゴーの水しぶき: 横 30 コマ（6900px）は長すぎるので、横 10 コマ × 3 段に並べ直す
- 花火: 黒い地の絵を細かくしてから、地が透けるようにする（pack.py の glow と同じ）

使い方: python3 -I tools/skin/hqmore.py <TNDE-R/Graphics/5_Game> <public/skins/tnde> <waifu2x の onnx_models> [絵の名前,…]
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cv2
import numpy as np
import hq

G, OUT, hq.MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
hq.OUT = OUT
ONLY = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))
Q = 1.5


def grid(cw, ch, nx, ny):
    return [(i * cw, j * ch, cw, ch) for j in range(ny) for i in range(nx)]


def glow(im):
    rgb = im[:, :, :3].astype(np.float32)
    a = rgb.max(axis=2, keepdims=True)
    out = np.zeros_like(im)
    out[:, :, :3] = np.clip(rgb * 255 / np.maximum(a, 1), 0, 255).astype(np.uint8)
    out[:, :, 3:] = (a * im[:, :, 3:].astype(np.float32) / 255).astype(np.uint8)
    return out


# 名前: (元の絵, 元の絵のコマ（x, y, w, h）, 並べ直す横のコマ数（None = 元のまま）, 後で通す関数)
JOBS = {
    'mob': ('3_Mob/0.png', [(0, 0, 1280, 317), (0, 317, 1280, 319), (0, 636, 1280, 319)], None, None),
    'fx/GoGoSplash': ('10_Effects/GoGoSplash.png', grid(230, 460, 30, 1), 10, None),
    'fx/Explosion': ('10_Effects/Hit/Explosion.png', grid(260, 260, 7, 4), None, None),
    'fx/FireWorks': ('10_Effects/Hit/FireWorks.png', grid(192, 192, 16, 1), None, glow),
    'gauge/1P_Explosion': ('7_Gauge/1P_Explosion.png', grid(180, 180, 18, 1), None, None),
}

for name, (src, cells, cols, post) in JOBS.items():
    if ONLY is not None and name not in ONLY:
        continue
    e = man['img'][name]
    t0 = time.time()
    im = hq.rd(os.path.join(G, src))
    # 並べ直したあとの各コマの置き場所（元の絵の px で）
    if cols:
        cw, ch = cells[0][2], cells[0][3]
        dst = [((i % cols) * cw, (i // cols) * ch) for i in range(len(cells))]
    else:
        dst = [(x, y) for x, y, _, _ in cells]
    W = max(x + w for (x, _), (_, _, w, _) in zip(dst, cells))
    H = max(y + h for (_, y), (_, _, _, h) in zip(dst, cells))
    out = np.zeros((round(H * Q), round(W * Q), 4), np.uint8)
    for (x, y, w, h), (dx, dy) in zip(cells, dst):
        c = im[y:y + h, x:x + w]
        hq.TILE = 256 if max(c.shape[:2]) <= 432 else 512
        u = hq.up(c, Q)
        tw, th = round(w * Q), round(h * Q)
        if u.shape[:2] != (th, tw):
            u = cv2.resize(u, (tw, th), interpolation=cv2.INTER_AREA)
        X, Y = round(dx * Q), round(dy * Q)
        out[Y:Y + th, X:X + tw] = u
        print(' ', name, x, y, '%.0fs' % (time.time() - t0), flush=True)
    if post:
        out = post(out)
    hq.wr(e['f'], out, out.shape[0] * out.shape[1] > 1_500_000, 95)
    e.update({'w': W, 'h': H, 'k': Q})
    if cols:
        e['cols'] = cols
    man['v'] = '%x' % int(time.time())
    json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(name, out.shape, '%.0fs' % (time.time() - t0), flush=True)

print('done', flush=True)

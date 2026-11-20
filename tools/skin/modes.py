"""TNDE スキンの演奏オプションの印（はやさ・ドロン・あべこべ・きまぐれ・でたらめ・オート）を書き出す。

元: 5_Game/4_CourseSymbol/ModeSymbol（はやさは Speed/<値×10>.png）と 3_SongSelect/Auto.png（どれも 30×30）。
waifu2x（swin_unet・art）で 2 倍にして、横に並べた 2 枚にする:
  mode/speed: はやさの印（SPEEDS の順。1 つ 30×30）
  mode/sym: ドロン・あべこべ・きまぐれ（Random）・でたらめ（Hyper_Random）・オート
使い方: python3 -I tools/skin/modes.py <TNDE-R/Graphics> <public/skins/tnde> <waifu2x の onnx_models>
"""
import json, os, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import hq

G, OUT, hq.MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
hq.OUT = OUT
MS = os.path.join(G, '5_Game', '4_CourseSymbol', 'ModeSymbol')
SPEEDS = [5, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 30, 35, 40]
SYMS = [os.path.join(MS, f) for f in ['Doron.png', 'Mirror.png', 'Random.png', 'Hyper_Random.png']] + [os.path.join(G, '3_SongSelect', 'Auto.png')]
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))
os.makedirs(os.path.join(OUT, 'mode'), exist_ok=True)


def row(paths, name):
    ims = [hq.rd(p) for p in paths]
    # 1 つずつだと端がにじむので、まわりに 8 px の透明を足して並べてから 2 倍にし、切り分けて並べ直す
    P = 8
    big = np.zeros((30 + P * 2, (30 + P * 2) * len(ims), 4), np.uint8)
    for i, im in enumerate(ims):
        big[P:P + 30, i * (30 + P * 2) + P:i * (30 + P * 2) + P + 30] = im[:30, :30]
    up = hq.up(big, 2)
    out = np.zeros((60, 60 * len(ims), 4), np.uint8)
    for i in range(len(ims)):
        x = (i * (30 + P * 2) + P) * 2
        out[:, i * 60:(i + 1) * 60] = up[P * 2:P * 2 + 60, x:x + 60]
    f = 'mode/%s.webp' % name
    hq.wr(f, out, False)
    man['img']['mode/' + name] = {'f': f, 'w': 30 * len(ims), 'h': 30, 'k': 2}
    print(name, len(ims), flush=True)


row([os.path.join(MS, 'Speed', '%d.png' % v) for v in SPEEDS], 'speed')
row(SYMS, 'sym')
man['v'] = '%x' % int(time.time())
json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

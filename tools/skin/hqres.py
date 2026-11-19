"""TNDE スキンのリザルト画面の絵を、waifu2x（swin_unet・art）で細かくする。

元の絵（TNDE-R/Graphics の PNG。画質を落としていない）から作り直す。
- 字・数字・線のはっきりした絵は 2 倍（画質を落とさずに入れる。ふきだしと枠は大きいので画質 95）
- 背景・山・雲・どんちゃんはメモリを抑えるため 1.5 倍（背景はノイズを消すモデルで）
skin.json の各絵に k（細かさの倍率）を書く。描くときは元の大きさで描く（tnde.ts）。

使い方: python3 -I tools/skin/hqres.py <TNDE-R/Graphics> <public/skins/tnde> <waifu2x の onnx_models> [絵の名前,…]
screens.py で書き出したあとに動かす（もう細かくしてある絵は飛ばす）。
"""
import json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import hq

G, OUT, hq.MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
hq.OUT = OUT
ONLY = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
R = os.path.join(G, '6_Result')
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))

# 名前: (元の絵, 倍率, 画質を落とすか, ノイズを消すか)
IMGS = {
    'res/SongCount': ('SongCount.png', 2, False, False),
    'res/Header': ('Header.png', 2, True, False),
    'res/Panel0': ('Panel_1P/0.png', 2, True, False),
    'res/DifficultyBar': ('DifficultyBar.png', 2, False, False),
    'res/Gauge': ('Gauge.png', 2, False, False),
    'res/Gauge_Base': ('Gauge_Base.png', 2, False, False),
    'res/Soul_Text': ('Soul_Text.png', 2, False, False),
    'res/Result_Soul_Fire': ('Result_Soul_Fire.png', 2, False, False),
    'res/ScoreRank': ('ScoreRank.png', 2, False, False),
    'res/Crown': ('Crown.png', 2, False, False),
    'res/Number': ('Number.png', 2, False, False),
    'res/Score_Number': ('Score_Number.png', 2, False, False),
    'res/BestScore': ('BestScore.png', 2, False, False),
    'res/Speech_Bubble': ('Speech_Bubble.png', 2, True, False),
    'res/Flower': ('Flower/Flower.png', 2, False, False),
    'res/Shine': ('BackEffect.png', 2, False, False),
    'res/Bg0': ('Background_0.png', 1.5, True, True),
    'res/Bg1': ('Background_1.png', 1.5, True, True),
    'res/Mt0': ('Background_Mountain_0.png', 1.5, True, True),
    'res/Mt1': ('Background_Mountain_1.png', 1.5, True, True),
}
for i in range(1, 6):
    IMGS['res/FlowerR%d' % i] = ('Flower/Rotate_%d.png' % i, 2, False, False)

# 連番: (元のフォルダ, 倍率, 画質を落とすか)
ANIMS = {
    'res/Rainbow': ('Rainbow', 2, False),
    'res/DonNormal': ('Result_Donchan_Normal', 1.5, True),
    'res/DonClear': ('Result_Donchan_Clear', 1.5, True),
    'res/DonFailed': ('Result_Donchan_Failed', 1.5, True),
    'res/DonFailedLoop': ('Result_Donchan_Failed_Loop', 1.5, True),
}


def want(name):
    return ONLY is None or name in ONLY


def crop(im, e):
    """書き出したときと同じ所を切り出す（切り出していない絵はそのまま）"""
    x, y = e.get('x', 0), e.get('y', 0)
    return im[y:y + e['h'], x:x + e['w']]


def save():
    man['v'] = '%x' % int(time.time())
    json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))


for name, (rel, q, lossy, noisy) in IMGS.items():
    e = man['img'].get(name)
    if not e or e.get('k') or not want(name):
        continue
    im = crop(hq.rd(os.path.join(R, rel)), e)
    print(name, im.shape, q, flush=True)
    hq.wr(e['f'], hq.up(im, q, noisy=noisy), lossy, 95)
    e['k'] = q
    save()

# 雲（Cloud.png を 11 × 3 に分けた 1 つずつ。使うのは上の 2 段）
_cl = hq.rd(os.path.join(R, 'Cloud.png'))
_cw, _ch = _cl.shape[1] // 11, _cl.shape[0] // 3
for r in range(2):
    for i in range(11):
        name = 'res/cloud%d_%d' % (r, i)
        e = man['img'].get(name)
        if not e or e.get('k') or not want(name):
            continue
        c = _cl[r * _ch:(r + 1) * _ch, i * _cw:(i + 1) * _cw]
        print(name, flush=True)
        hq.wr(e['f'], hq.up(crop(c, e), 1.5, noisy=True), True, 95)
        e['k'] = 1.5
        save()


def nkey(f):
    m = re.match(r'(\d+)', f)
    return int(m.group(1)) if m else 1e9


# iPhone（Safari）は 500 万画素を超える絵を粗く読み込むので、1 枚 420 万画素・横 4096 px までに分ける
LIMIT, MAXW = 4_200_000, 4096

for name, (rel, q, lossy) in ANIMS.items():
    a = man['anim'].get(name)
    if not a or a.get('k') or not want(name):
        continue
    d = os.path.join(R, rel)
    fs = sorted([f for f in os.listdir(d) if f.lower().endswith('.png')], key=nkey)
    fw, fh = a['w'], a['h']
    # 1.5 倍で割り切れるよう、コマの大きさを偶数に（下・右に透明な 1 px を足す）
    fw2, fh2 = fw + fw % 2, fh + fh % 2
    W, H = round(fw2 * q), round(fh2 * q)
    cells = []
    print(name, len(fs), 'frames', flush=True)
    for f in fs:
        im = crop(hq.rd(os.path.join(d, f)), {'x': a.get('x', 0), 'y': a.get('y', 0), 'w': fw, 'h': fh})
        cl = np.zeros((fh2, fw2, 4), np.uint8)
        cl[:im.shape[0], :im.shape[1]] = im
        cells.append(hq.up(cl, q)[:H, :W])
    cols = max(1, min(len(cells), MAXW // W))
    rows = max(1, LIMIT // (cols * W * H))
    per = cols * rows
    old = os.path.join(OUT, a['f'])
    base = a['f'][:-5]
    files = []
    for pg in range(-(-len(cells) // per)):
        part = cells[pg * per:(pg + 1) * per]
        r = -(-len(part) // cols)
        sheet = np.zeros((r * H, min(cols, len(part)) * W, 4), np.uint8)
        for j, cl in enumerate(part):
            sheet[(j // cols) * H:(j // cols) * H + H, (j % cols) * W:(j % cols) * W + W] = cl
        f = '%s-%d.webp' % (base, pg)
        hq.wr(f, sheet, lossy, 95)
        files.append(f)
    if os.path.exists(old) and old not in [os.path.join(OUT, f) for f in files]:
        os.remove(old)
    a.update({'f': files[0], 'w': fw2, 'h': fh2, 'n': len(cells), 'cols': cols, 'k': q})
    if len(files) > 1:
        a.update({'per': per, 'pages': files})
    save()

save()
print('done', flush=True)

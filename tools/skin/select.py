"""TNDE スキンの選曲画面・難易度えらびの絵を書き出す（public/skins/tnde/sel/ と sel.json）。

字・枠などは waifu2x（swin_unet・art）で 2 倍に、どんちゃんは 1.5 倍にしておく。
1280×720 いっぱいの絵（右上の帯・記録の表など）は、描いてある所だけ切り出して、その左上を x, y に書く。
sel.json の各絵: f（ファイル）, k（細かさの倍率）, x, y（切り出した左上・1280×720 の座標）, w, h（元の大きさ）

使い方: python3 -I tools/skin/select.py <TNDE-R/Graphics> <public/skins/tnde> <waifu2x の onnx_models> [絵の名前,…]
もう書き出してある絵は飛ばす（作り直すときは sel.json から消す）。
"""
import json, os, re, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import hq

G, OUT, hq.MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
hq.OUT = OUT
ONLY = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
SS = os.path.join(G, '3_SongSelect')
os.makedirs(os.path.join(OUT, 'sel'), exist_ok=True)
MAN = os.path.join(OUT, 'sel.json')
man = json.load(open(MAN, encoding='utf-8')) if os.path.exists(MAN) else {'img': {}, 'anim': {}}


def save():
    man['v'] = '%x' % int(time.time())
    json.dump(man, open(MAN, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))


def want(name):
    return (ONLY is None or name in ONLY) and name not in man['img'] and name not in man['anim']


def bbox(im):
    ys, xs = np.nonzero(im[:, :, 3] > 0)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def put(name, im, q=2, lossy=False, noisy=False, trim=False, qual=92):
    """im（BGRA）を q 倍にして書く。trim は描いてある所だけ切り出す"""
    if not want(name):
        return
    x = y = 0
    H, W = im.shape[:2]
    if trim:
        x0, y0, x1, y1 = bbox(im)
        im = im[y0:y1, x0:x1]
        x, y = x0, y0
    h, w = im.shape[:2]
    out = hq.up(im, q, noisy) if q != 1 else im
    f = 'sel/%s.webp' % name.replace('/', '_')
    hq.wr(f, out, lossy, qual)
    man['img'][name] = {'f': f, 'k': q, 'x': x, 'y': y, 'w': w, 'h': h}
    print(name, w, h, q, flush=True)
    save()


def rd(rel):
    return hq.rd(os.path.join(SS, rel))


# ---- 選曲 ----
for i in range(12):
    put('bar%d' % i, rd('Bar_Genre/Bar_Genre_%d.png' % i))
put('barOverlay', rd('Bar_Genre_Overlay.png'))
put('barBack', rd('Bar_Genre_Back.png'))
put('barSelect', rd('Bar_Select.png'))
put('frameScore', rd('Frame_Score.png'), trim=True)
put('crown', rd('SongSelect_Crown.png'))
put('rank', rd('ScoreRank.png'))
put('levelNum', rd('Level_Number.png'))
put('bg', rd('Background.png'), q=1, lossy=True)
for n in ['Header', 'Credit', 'Point']:
    put(n.lower(), rd('%s.png' % n), trim=True)


def delabel(im):
    """自己ベストの枠の「ベストスコア」の字を消す（本家は「自己ベスト」。字は描くときに書く）"""
    p = im[384:434, 26:221].astype(np.float32)
    x0, x1 = 40, 168
    # 上の縁と、字の下の白い所は横に同じなので、字の無い列から写す
    p[0:4, x0:x1] = p[0:4, 20:21]
    p[22:25, x0:x1] = p[22:25, 20:21]
    # 金の帯: 左右の列の間を横にならし、本家と同じ所に斜めの明るい筋を 2 本
    L, R = p[4:22, x0 - 1:x0], p[4:22, x1:x1 + 1]
    t = (np.arange(x0, x1) - (x0 - 1)) / (x1 - x0 + 1)
    p[4:22, x0:x1] = L * (1 - t[None, :, None]) + R * t[None, :, None]
    for cx in (47, 143):
        for y in range(4, 22):
            for x in range(cx - 14, cx + 15):
                a = max(0.0, 1 - abs((x - cx) + (y - 13) * 0.9) / 6.0) * 0.55
                if a > 0:
                    p[y, x, :3] = p[y, x, :3] * (1 - a) + np.array([215, 250, 255]) * a
    # 金の帯を本家の濃い金に（本家の画面からスポイトで取った色に合わせる。BGR）
    band = p[4:22, 3:192, :3]
    p[4:22, 3:192, :3] = 255 - (255 - band) * np.array([1.3, 1.45, 0.7])
    im = im.copy()
    im[384:434, 26:221] = np.clip(p, 0, 255).astype(np.uint8)
    return im


for i in range(5):
    put('table%d' % i, rd('Table/%d.png' % i), trim=True)
    put('score%d' % i, delabel(rd('Score/%d.png' % i)), trim=True)
put('headerTimer', rd('Header_Timer.png'), trim=True)
for i in range(-1, 12):
    put('boxChara%d' % i, rd('Box_Chara/Box_Chara_%d.png' % i), lossy=True, qual=94)
for n in ['Base', 'Taiko', 'Bachi', 'Arrow_Down', 'Arrow_Up', 'Don', 'Ka']:
    put('taiko' + n.replace('_', ''), rd('TaikoAnim/%s.png' % n))
put('guide', rd('TaikoAnim/TaikoBase_Mini.png'), trim=True)

# 案内の太鼓（ふち＝えらぶ: 太鼓とばち 1 本、面＝決定: 太鼓と面の光とばち 2 本）
t = rd('TaikoAnim/Taiko.png').astype(np.float32)
b = rd('TaikoAnim/Bachi.png').astype(np.float32)
d = rd('TaikoAnim/Don.png').astype(np.float32)


def over(dst, src, x=0, y=0):
    h, w = src.shape[:2]
    a = src[:, :, 3:4] / 255
    D = dst[y:y + h, x:x + w]
    oa = a + D[:, :, 3:4] / 255 * (1 - a)
    rgb = (src[:, :, :3] * a + D[:, :, :3] * (D[:, :, 3:4] / 255) * (1 - a)) / np.maximum(oa, 1e-6)
    dst[y:y + h, x:x + w] = np.dstack([rgb, oa * 255])


L = t.copy(); over(L, b[:, 0:207][:207, :206])
R = t.copy(); over(R, d, 110 - 45, 88 - 41); over(R, b[:, 3 * 207:4 * 207][:207, :206])
put('drumL', np.clip(L, 0, 255).astype(np.uint8))
put('drumR', np.clip(R, 0, 255).astype(np.uint8))

# ---- 難易度えらび ----
D = 'Difficulty_Select/'
put('diffBar', rd(D + 'Difficulty_Bar.png'))
put('diffCursor', rd(D + 'Difficulty_Select_Bar_1P.png'))
put('diffCrown', rd(D + 'Difficulty_Crown.png'))
put('diffNum', rd(D + 'Difficulty_Number.png'))
put('diffStar', rd(D + 'Difficulty_Star.png'))
put('diffRank', rd(D + 'ScoreRank.png'))
for i in range(12):
    put('diffBack%d' % i, rd(D + 'Difficulty_Back/Difficulty_Back_%d.png' % i), lossy=True, qual=94)
mk = rd(D + 'Difficulty_Mark.png')
# かんたん・ふつう・むずかしい・おに・裏おにの印（上の段。うすく大きく出すので 1 倍）
for i, (x, y, w, h) in enumerate([(65, 70, 328, 318), (510, 70, 348, 318), (973, 70, 347, 318), (1446, 70, 318, 318), (1905, 70, 318, 318)]):
    put('mark%d' % i, mk[y:y + h, x:x + w], q=1, lossy=True, qual=90)

# 「達人」の札の横などに使う、おに・裏おにの小さな印（Frame_Score の左の絵を、黒い縁の外を透かして）
from scipy import ndimage
fs = rd('Frame_Score.png')
for nm, x in [('iconOni', 367), ('iconUra', 489)]:
    c = fs[155:195, x + 8:x + 58].copy()
    dark = c[:, :, :3].astype(int).sum(2) < 150
    lab, _ = ndimage.label(~dark)
    border = set(np.unique(np.r_[lab[0], lab[-1], lab[:, 0], lab[:, -1]])) - {0}
    c[np.isin(lab, list(border)), 3] = 0
    put(nm, c, trim=True)

# ---- どんちゃん（コマの描いてある所だけを並べる。1.5 倍） ----
LIMIT, MAXW = 4_200_000, 4096


def nkey(f):
    m = re.match(r'(\d+)', f)
    return int(m.group(1)) if m else 1e9


for name, rel in [('donLoop', 'Donchan/Loop'), ('donStart', 'Donchan/Start'), ('donSelect', 'Donchan/Select')]:
    if not want(name):
        continue
    dd = os.path.join(SS, rel)
    fs_ = sorted([f for f in os.listdir(dd) if f.endswith('.png')], key=nkey)
    ims = [hq.rd(os.path.join(dd, f)) for f in fs_]
    x0 = min(bbox(i)[0] for i in ims); y0 = min(bbox(i)[1] for i in ims)
    x1 = max(bbox(i)[2] for i in ims); y1 = max(bbox(i)[3] for i in ims)
    x0 -= x0 % 2; y0 -= y0 % 2; x1 += x1 % 2; y1 += y1 % 2
    q = 1.5
    W, H = round((x1 - x0) * q), round((y1 - y0) * q)
    cells = [hq.up(np.ascontiguousarray(i[y0:y1, x0:x1]), q)[:H, :W] for i in ims]
    cols = max(1, min(len(cells), MAXW // W))
    rows = max(1, LIMIT // (cols * W * H))
    per = cols * rows
    pages = []
    for pg in range(-(-len(cells) // per)):
        part = cells[pg * per:(pg + 1) * per]
        r = -(-len(part) // cols)
        sheet = np.zeros((r * H, min(cols, len(part)) * W, 4), np.uint8)
        for j, cl in enumerate(part):
            sheet[(j // cols) * H:(j // cols + 1) * H, (j % cols) * W:(j % cols + 1) * W] = cl
        f = 'sel/%s-%d.webp' % (name, pg)
        hq.wr(f, sheet, True, 92)
        pages.append(f)
    man['anim'][name] = {'pages': pages, 'k': q, 'x': x0, 'y': y0, 'w': x1 - x0, 'h': y1 - y0, 'n': len(cells), 'cols': cols, 'per': per}
    print(name, len(cells), flush=True)
    save()

save()
print('done', flush=True)

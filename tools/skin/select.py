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


def pattern():
    """背景の模様（白・不透明度つき）。本家の模様は GenreBackground と同じ並びで 720p の 1.5 倍。
    灰色の GenreBackground_8 の「明るい地より暗い所」を模様として取り出し、
    横 640・縦 2 段（318）で繰り返す 1 枚を切り出し、2 倍に細かくする。
    格子の点は本家と同じ丸に描き直す。不透明度は本家の画面からスポイトで取った値"""
    from scipy import ndimage
    import cv2
    L = rd('Genre_Background/GenreBackground_8.png')[:, :, :3].astype(np.float32).mean(2)
    b = ndimage.percentile_filter(L[::4, ::4], 97, size=25, mode='reflect')
    b = cv2.resize(ndimage.gaussian_filter(b, 3), (L.shape[1], L.shape[0]), interpolation=cv2.INTER_CUBIC)
    D = np.clip(b - L, 0, None)[:, :1280]
    PY, TW, TH = 159, 640, 318
    # 上の端は形が切れているので、120 px 下から 2 段分を切り出す（格子の横の線が y=6.3 に来る）。
    # 何か所かを重ねると少しずつずれていてぼやけるので、1 か所だけを使う
    Y0 = 120
    T = D[Y0:Y0 + TH, :TW].copy()
    T = np.clip(T - 1.5, 0, None)
    # 格子の点（横の線 y=6.3, 165.3・縦の線 x=9.1+160k）を消して、本家と同じ丸で描き直す
    GX, GY = 9.1, 126.3 - Y0
    yy, xx = np.mgrid[0:TH, 0:TW]
    hl = np.abs((yy - GY + 79.5) % 159 - 79.5) < 8
    vl = np.abs((xx - GX + 80) % 160 - 80) < 8
    T[hl | vl] = 0
    cs = [(GY + 159 * j, GX + 16 * k) for j in range(2) for k in range(40)]
    cs += [(GY + 15.9 * k, GX + 160 * i) for i in range(4) for k in range(1, 20) if k % 10]
    # 繰り返しのつなぎ目が切れないよう、まわりを足してから 2 倍に
    P = 48
    big = np.pad(T, P, mode='wrap')
    g8 = np.clip(big / 27 * 255, 0, 255).astype(np.uint8)
    im = np.dstack([g8, g8, g8, np.full_like(g8, 255)])
    u = hq.up(im, 2)[P * 2:(P + TH) * 2, P * 2:(P + TW) * 2, 0].astype(np.float32) / 255
    a = np.clip(u, 0, 1) * 0.26
    # 丸い点（直径 9。4 倍で描いて縮める）
    S = 4
    Y, X = np.mgrid[0:TH * 2 * S, 0:TW * 2 * S]
    dots = np.zeros((TH * 2 * S, TW * 2 * S), np.float32)
    for (cy, cx) in cs:
        for oy in (-TH, 0, TH):
            for ox in (-TW, 0, TW):
                py, px = (cy + oy) * 2 * S, (cx + ox) * 2 * S
                r = 4.5 * 2 * S
                if -r < px < TW * 2 * S + r and -r < py < TH * 2 * S + r:
                    y0, y1 = int(max(0, py - r - 1)), int(min(TH * 2 * S, py + r + 2))
                    x0, x1 = int(max(0, px - r - 1)), int(min(TW * 2 * S, px + r + 2))
                    if y1 <= y0 or x1 <= x0:
                        continue
                    d = (Y[y0:y1, x0:x1] + 0.5 - py) ** 2 + (X[y0:y1, x0:x1] + 0.5 - px) ** 2
                    dots[y0:y1, x0:x1] = np.maximum(dots[y0:y1, x0:x1], (d <= r * r).astype(np.float32))
    dots = dots.reshape(TH * 2, S, TW * 2, S).mean((1, 3))
    a = np.maximum(a, dots * 0.24)
    out = np.dstack([np.full_like(a, 255), np.full_like(a, 255), np.full_like(a, 255), a * 255 + 0.5]).astype(np.uint8)
    f = 'sel/pattern.webp'
    hq.wr(f, out, False)
    man['img']['pattern'] = {'f': f, 'k': 2, 'x': 0, 'y': 0, 'w': TW, 'h': TH}
    print('pattern', flush=True)
    save()


if want('pattern'):
    pattern()
for n in ['Credit', 'Point']:
    put(n.lower(), rd('%s.png' % n), trim=True)


# 本家の自己ベストの帯の色（段の左の縁から右の縁までを 0〜1 として → RGB。本家の画面からスポイトで取った）
BAND = [(0, (216, 155, 4)), (0.03, (221, 158, 11)), (0.094, (231, 166, 18)), (0.156, (242, 177, 27)), (0.22, (249, 190, 40)),
        (0.28, (254, 195, 49)), (0.5, (254, 205, 70)), (0.68, (253, 223, 100)), (0.74, (254, 234, 150)), (0.8, (252, 242, 185)),
        (0.86, (252, 250, 223)), (0.93, (253, 253, 247)), (1, (254, 254, 250))]


def band_rgb(t):
    xs = [b[0] for b in BAND]
    return np.array([np.interp(t, xs, [b[1][c] for b in BAND]) for c in range(3)])


def delabel(im):
    """自己ベストの枠の「ベストスコア」の字を消し、金の帯を本家の色と光に描き直す（字は描くときに書く）。
    本家の帯は、斜めの縁（/）で区切られた 3 つの段で、どの段も縁の右で濃い金、右へ行くほど明るくなり次の縁の手前で白に。
    縁の位置と色は本家の画面に重ねて測った"""
    from scipy import ndimage
    p = im[384:434, 26:221].astype(np.float32)
    o = p.copy()
    E1 = lambda y: 56 - 1.5 * (y - 6)     # 左の光から金に変わる縁
    E2 = lambda y: 155.6 - 1.14 * (y - 6)  # 右の光から金に変わる縁
    # 左下の鬼の印は残す（黒い縁とその中・赤紫）
    rgb = o[:, :, 2::-1]
    dark = rgb.sum(2) < 450
    mag = (rgb[:, :, 0] > 120) & (rgb[:, :, 1] < 120)
    keep = np.zeros(dark.shape, bool)
    keep[14:, 18:45] = ndimage.binary_fill_holes((dark | mag)[14:, 18:45])
    for y in range(6, 21):
        for x in range(9, 186):
            if keep[y, x]:
                continue
            acc = np.zeros(3)
            for sy in (0.125, 0.375, 0.625, 0.875):  # 縁がぎざぎざにならないよう 4×4 で平均
                e1, e2 = E1(y - 0.5 + sy), E2(y - 0.5 + sy)
                for sx in (0.125, 0.375, 0.625, 0.875):
                    u = x - 0.5 + sx
                    t = (u - e1 + 100) / 100 if u < e1 else ((u - e1) / (e2 - e1) if u < e2 else (u - e2) / 100)
                    acc += band_rgb(t)
            p[y, x, :3] = (acc / 16)[::-1]
    # 帯の下の細い線と白い所は横に同じなので、字の無い列から写す
    for y in range(21, 26):
        p[y, 56:152] = o[y, 155:156]
    # 上下の細い線・両端の丸い所の金を、本家の濃い金に（白からの差を G 1.55 倍・B 1.25 倍）
    q = p[:, :, :3]
    R, G, B = q[:, :, 2], q[:, :, 1], q[:, :, 0]
    gold = (R > 170) & (R >= G) & (G >= B) & (R - B > 25)
    band = np.zeros(gold.shape, bool)
    band[6:21, 9:186] = True
    m = gold & ~band
    q[:, :, 1] = np.where(m, 255 - (255 - G) * 1.55, G)
    q[:, :, 0] = np.where(m, 255 - (255 - B) * 1.25, B)
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

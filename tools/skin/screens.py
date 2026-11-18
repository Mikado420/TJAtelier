"""TNDE スキンの、曲の読み込み画面・リザルト画面・プレイ中に足す絵（スコアランク・ベストスコア）を
public/skins/tnde へ書き出し、skin.json に足す（pack.py のあとに動かす。hq.py より前）。
使い方: python3 -I tools/skin/screens.py <TNDE-R/Graphics> <出力先>

画面いっぱいの大きさ（1280×720）で、絵のある所が一部だけの絵は、絵のある所だけを切り出す。
skin.json には、切り出した位置 x, y と元の大きさ ow, oh を書く（描くときは元の絵の位置に置く）"""
import cv2, json, os, re, sys, shutil
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))


def rd(p):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit('読めない: ' + p)
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3:
        im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    return im


def wr(name, im, lossy):
    p = os.path.join(OUT, name + '.webp')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    cv2.imwrite(p, im, [cv2.IMWRITE_WEBP_QUALITY, 90 if lossy else 101])
    return name + '.webp'


def bbox(ims):
    a = np.zeros(ims[0].shape[:2], bool)
    for im in ims:
        a |= im[:, :, 3] > 0
    ys, xs = np.nonzero(a)
    if not len(xs):
        return 0, 0, 1, 1
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def img(name, rel, lossy=False, trim=False):
    im = rd(os.path.join(SRC, rel))
    e = {'w': im.shape[1], 'h': im.shape[0]}
    if trim:
        x0, y0, x1, y1 = bbox([im])
        e = {'w': x1 - x0, 'h': y1 - y0, 'x': x0, 'y': y0, 'ow': im.shape[1], 'oh': im.shape[0]}
        im = im[y0:y1, x0:x1]
    e['f'] = wr(name, im, lossy)
    man['img'][name] = e


def nkey(f):
    m = re.match(r'(\d+)', f)
    return int(m.group(1)) if m else 1e9


def anim(name, rel, lossy=True, trim=False, maxw=4096):
    d = os.path.join(SRC, rel)
    fs = sorted([f for f in os.listdir(d) if f.lower().endswith('.png')], key=nkey)
    ims = [rd(os.path.join(d, f)) for f in fs]
    extra = {}
    if trim:
        x0, y0, x1, y1 = bbox(ims)
        extra = {'x': x0, 'y': y0, 'ow': ims[0].shape[1], 'oh': ims[0].shape[0]}
        ims = [im[y0:y1, x0:x1] for im in ims]
    fh = max(i.shape[0] for i in ims)
    fw = max(i.shape[1] for i in ims)
    cols = max(1, min(len(ims), maxw // fw))
    rows = (len(ims) + cols - 1) // cols
    sheet = np.zeros((rows * fh, cols * fw, 4), np.uint8)
    for k, im in enumerate(ims):
        y, x = (k // cols) * fh, (k % cols) * fw
        sheet[y:y + im.shape[0], x:x + im.shape[1]] = im
    man['anim'][name] = {'f': wr(name, sheet, lossy), 'w': fw, 'h': fh, 'n': len(ims), 'cols': cols, 'step': 1, **extra}


# ---------- 曲の読み込み画面 ----------
L = '4_SongLoading/'
img('load/Bg', L + 'Bg.png', lossy=True)
img('load/Fade', L + 'Fade.png', lossy=True)
img('load/BgWait', L + 'Bg_Wait.png', lossy=True)
img('load/Chara', L + 'Chara.png', trim=True)
img('load/Plate', L + 'Plate.png', trim=True)
_hints = sorted([f for f in os.listdir(os.path.join(SRC, L + 'Hints')) if f.endswith('.png')], key=nkey)
for i, f in enumerate(_hints):
    img('load/hint%d' % i, L + 'Hints/' + f, trim=True)
man['loadHints'] = len(_hints)

# ---------- リザルト画面 ----------
R = '6_Result/'
img('res/Bg0', R + 'Background_0.png', lossy=True)
img('res/Bg1', R + 'Background_1.png', lossy=True)
img('res/Mt0', R + 'Background_Mountain_0.png', lossy=True, trim=True)
img('res/Mt1', R + 'Background_Mountain_1.png', lossy=True, trim=True)
img('res/Header', R + 'Header.png', lossy=True)
img('res/SongCount', R + 'SongCount.png', trim=True)
# 雲（11 個 × 3 段。1 つずつ、雲のある所だけを切り出す）
_cl = rd(os.path.join(SRC, R + 'Cloud.png'))
_cw, _ch = _cl.shape[1] // 11, _cl.shape[0] // 3
for r in range(3):
    for i in range(11):
        c = _cl[r * _ch:(r + 1) * _ch, i * _cw:(i + 1) * _cw]
        x0, y0, x1, y1 = bbox([c])
        man['img']['res/cloud%d_%d' % (r, i)] = {'f': wr('res/cloud%d_%d' % (r, i), c[y0:y1, x0:x1], True), 'w': x1 - x0, 'h': y1 - y0, 'x': x0, 'y': y0, 'ow': _cw, 'oh': _ch}
img('res/Shine', R + 'BackEffect.png')
img('res/Effect', R + 'Effect.png')
for i in range(6):
    img('res/Panel%d' % i, R + 'Panel_1P/%d.png' % i, trim=True)
for f in ['Gauge', 'Gauge_Base', 'Soul_Text', 'Result_Soul_Fire', 'ScoreRank', 'Crown', 'Number', 'Score_Number',
          'BestScore', 'Speech_Bubble', 'DifficultyBar']:
    img('res/' + f, R + f + '.png')
for i in range(3):
    img('res/Work%d' % i, R + 'Firework/%d.png' % i)
img('res/Flower', R + 'Flower/Flower.png')
for i in range(1, 6):
    img('res/FlowerR%d' % i, R + 'Flower/Rotate_%d.png' % i)
anim('res/Rainbow', R + 'Rainbow', lossy=False)
anim('res/DonClear', R + 'Result_Donchan_Clear')
anim('res/DonNormal', R + 'Result_Donchan_Normal')
anim('res/DonFailed', R + 'Result_Donchan_Failed', trim=True)
anim('res/DonFailedLoop', R + 'Result_Donchan_Failed_Loop', trim=True)

# ---------- プレイ中 ----------
G = '5_Game/'
img('game/ScoreRank', G + 'ScoreRank.png')
img('game/BestScore', G + '6_Taiko/Best_Score.png')
img('game/BestScoreFx', G + '6_Taiko/BestScore_Effect.png', trim=True)

# ---------- 音 ----------
_S = os.path.join(SRC, '..', 'Sounds')
os.makedirs(os.path.join(OUT, 'se'), exist_ok=True)
for n, f in [('decide', 'SongDecide.ogg'), ('gameEnd', 'Game end.ogg'), ('resGauge', 'Result_Gauge.ogg'), ('resPom', 'Result_Pom.ogg'),
             ('rankIn', 'RankIn.ogg'), ('crownClear', 'CrownIn_Clear.ogg'), ('crownFc', 'CrownIn_FullCombo.ogg'),
             ('crownDfc', 'CrownIn_DondaFullCombo.ogg'), ('best', 'BestScore.ogg'), ('resClear', 'Result_Clear.ogg'),
             ('resFailed', 'Result_Failed.ogg'), ('skip', 'Skip.ogg'), ('resIn', 'BGM/Result_In.ogg'), ('resBgm', 'BGM/Result.ogg')]:
    shutil.copy(os.path.join(_S, f), os.path.join(OUT, 'se', n + '.ogg'))

json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('ok')

"""TNDE スキン（TaikoNijiiroDondaEX Ver4.1用）の 5_Game から、プレイ画面で使う絵を public/skins/tnde へ書き出す。
使い方: python3 -I tools/skin/pack.py <TNDE-R/Graphics> <出力先> [差し替えのフォルダ]
差し替えのフォルダに NamePlate.png・FOT-OedoKtr.otf があれば、スキンのものの代わりに使う
連番の絵（どんちゃん・踊り子など）は 1 枚の絵にまとめる（読み込む数を減らす）"""
import cv2, json, os, re, sys, shutil
import numpy as np

SRC, OUT = sys.argv[1], sys.argv[2]
G = os.path.join(SRC, '5_Game')
os.makedirs(OUT, exist_ok=True)
man = {'img': {}, 'anim': {}}

def rd(p):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    if im is None: raise SystemExit('読めない: ' + p)
    if im.ndim == 2: im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3: im = cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    return im

def wr(name, im, lossy):
    p = os.path.join(OUT, name + '.webp')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    cv2.imwrite(p, im, [cv2.IMWRITE_WEBP_QUALITY, 90 if lossy else 101])
    return name + '.webp'

def img(name, rel, lossy=False):
    im = rd(os.path.join(G, rel))
    man['img'][name] = {'f': wr(name, im, lossy), 'w': im.shape[1], 'h': im.shape[0]}

def nkey(f):
    m = re.match(r'(\d+)', f)
    return int(m.group(1)) if m else 1e9

def anim(name, rel, lossy=True, step=1, maxw=4096):
    d = os.path.join(G, rel)
    fs = sorted([f for f in os.listdir(d) if f.lower().endswith('.png')], key=nkey)[::step]
    ims = [rd(os.path.join(d, f)) for f in fs]
    fh = max(i.shape[0] for i in ims); fw = max(i.shape[1] for i in ims)
    cols = max(1, min(len(ims), maxw // fw))
    rows = (len(ims) + cols - 1) // cols
    sheet = np.zeros((rows * fh, cols * fw, 4), np.uint8)
    for k, im in enumerate(ims):
        y, x = (k // cols) * fh, (k % cols) * fw
        sheet[y:y + im.shape[0], x:x + im.shape[1]] = im
    man['anim'][name] = {'f': wr(name, sheet, lossy), 'w': fw, 'h': fh, 'n': len(ims), 'cols': cols, 'step': step}

# 音符・レーン・判定
for n, r in [('notes', 'Notes.png'), ('senotes', 'SENotes.png'), ('chip', 'ChipEffect.png'), ('judge', 'Judge.png'),
             ('bar', 'Bar.png'), ('barBranch', 'Bar_Branch.png'), ('arm', 'Notes_Arm.png')]:
    img(n, r)
for f in ['Background_Main', 'Background_GoGo', 'Background_Sub', 'Red', 'Blue', 'Yellow',
          'Base_Normal', 'Base_Expert', 'Base_Master', 'Text_Normal', 'Text_Expert', 'Text_Master']:
    img('lane/' + f, '12_Lane/%s.png' % f)
# 左のパネル
for f in ['1P_Background', 'Base', 'Don', 'Ka', 'Combo', 'Combo_Big', 'Combo_Midium', 'Combo_Text', 'Combo_Effect', 'Score', 'LevelUp', 'LevelDown']:
    img('taiko/' + f, '6_Taiko/%s.png' % f)
for i in range(4):
    img('taiko/frame%d' % i, '6_Taiko/Frame/1P/%d/1P_Frame.png' % i)
for f in ['Easy', 'Normal', 'Hard', 'Oni', 'Edit']:
    img('course/' + f, '4_CourseSymbol/%s.png' % f)
# ジャンルの帯・曲目の帯は図形と字で描く（絵は使わない）
# ゲージ
for i in range(4):
    img('gauge/base%d' % i, '7_Gauge/Gauge/1P/%d/1P_Base.png' % i)
    img('gauge/fill%d' % i, '7_Gauge/Gauge/1P/%d/1P.png' % i)
    anim('gauge/rainbow%d' % i, '7_Gauge/Rainbow/%d' % i, lossy=False)
for f in ['1P_Line', 'Soul', 'Fire', '1P_Explosion', 'Gauge_Update']:
    img('gauge/' + f, '7_Gauge/%s.png' % f)
# 演出
for f in ['Fire', 'Rainbow', 'GoGoSplash', 'BigStar', 'MiniStar', 'Slash']:
    img('fx/' + f, '10_Effects/%s.png' % f, lossy=f == 'GoGoSplash')
for f in ['Explosion', 'Explosion_Big', 'FireWorks']:
    img('fx/' + f, '10_Effects/Hit/%s.png' % f, lossy=f == 'FireWorks')
for f in ['Good', 'Good_Big', 'Great', 'Great_Big']:
    anim('fx/' + f, '10_Effects/Hit/' + f, lossy=False)
for i in range(3):
    anim('fx/roll%d' % i, '10_Effects/Roll/%d' % i, lossy=False)
for f in os.listdir(os.path.join(G, '11_Balloon')):
    img('balloon/' + f[:-4], '11_Balloon/' + f)
# 背景
bg = os.path.join(G, '5_Background')
for d in ['Bg_up', 'Bg_down']:
    for root, _, fs in os.walk(os.path.join(bg, d)):
        for f in fs:
            if not f.lower().endswith('.png'): continue
            rel = os.path.relpath(os.path.join(root, f), G)
            name = 'bg/' + os.path.relpath(os.path.join(root, f[:-4]), bg).replace(os.sep, '/')
            img(name, rel, lossy=True)
# クリアの下の背景の部品（1 枚の絵に並んでいるのを、部品ごとに切り出す）
_cl = rd(os.path.join(G, '5_Background/Bg_down/c/0/Clear.png'))
_a = (_cl[:, :, 3] > 20).astype(np.uint8)
_n, _lab, _st, _ = cv2.connectedComponentsWithStats(cv2.dilate(_a, np.ones((25, 25), np.uint8)))
for _i in range(1, _n):
    _x, _y, _w, _h, _area = (int(v) for v in _st[_i])
    if _area <= 800:
        continue
    _p = _cl[_y:_y + _h, _x:_x + _w].copy()
    _p[_lab[_y:_y + _h, _x:_x + _w] != _i] = 0
    _k = 'bg/clear/%d_%d' % (_x, _y)
    man['img'][_k] = {'f': wr(_k, _p, True), 'w': _w, 'h': _h}
for i in range(3):
    img('footer%d' % i, '8_Footer/%d.png' % i, lossy=True)
img('mob', '3_Mob/0.png', lossy=True)
# 踊り子・どんちゃん
for k in ['Normal', 'In']:
    for i in (1, 2, 3):
        anim('dancer/%s%d' % (k, i), '2_Dancer/%s/%d' % (k, i))
for f in sorted(os.listdir(os.path.join(G, '1_Chara/1P'))):
    anim('chara/' + f, '1_Chara/1P/' + f, step=2)

# 曲の終わりの演出（クリア・フルコンボ・ドンだフルコンボ）
E9 = '9_End/'
img('end/clearChara', E9 + 'Clear/Clear_Chara.png')
img('end/clearText', E9 + 'Clear/Clear_Text.png')
img('end/star', E9 + 'Clear/Star.png')
img('end/fcLoop', E9 + 'FullCombo/FullCombo_Loop.png')
for f in ['Bachi', 'Bachi_Flush', 'Bachi_God', 'Bachi_God_Flush', 'Donda_Text', 'Donda_Text_Effect', 'Donda_Text_Rainbow_Effect']:
    img('end/dfc/' + f, E9 + 'DondaFullCombo/%s.png' % f)
for f in ['L', 'R']:
    img('end/dfc/fan' + f, E9 + 'DondaFullCombo/Fan/%s.png' % f)
# 金の背景は絵の中の帯だけを切り出す（置く位置は x, y）
_g = rd(os.path.join(G, E9 + 'DondaFullCombo/BackGold.png'))
_ys, _xs = np.nonzero(_g[:, :, 3] > 0)
_g = _g[_ys.min():_ys.max() + 1, _xs.min():_xs.max() + 1]
man['img']['end/dfc/gold'] = {'f': wr('end/dfc/gold', _g, True), 'w': _g.shape[1], 'h': _g.shape[0], 'x': int(_xs.min()), 'y': int(_ys.min())}
# フルコンボの連番は、絵のある所だけを切り出して 1 枚にまとめる（[元の x, y, 幅, 高さ, まとめた絵の x, y]）
_fs = [rd(os.path.join(G, E9 + 'FullCombo/%d.png' % k)) for k in range(66)]
_rects = []
for im in _fs:
    ys, xs = np.nonzero(im[:, :, 3] > 0)
    _rects.append((int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)) if len(xs) else (0, 0, 0, 0))
_W = 2048
_H = 2048
_pages = [[]]
_x = _y = _rowh = 0
_place = []
for (x0, y0, w, h) in _rects:
    if _x + w > _W: _x = 0; _y += _rowh + 1; _rowh = 0
    if _y + h > _H: _pages.append([]); _x = _y = _rowh = 0
    _place.append((len(_pages) - 1, _x, _y)); _x += w + 1; _rowh = max(_rowh, h)
_sheets = [np.zeros((_H, _W, 4), np.uint8) for _ in _pages]
_frames = []
for im, (x0, y0, w, h), (pg, px, py) in zip(_fs, _rects, _place):
    if w: _sheets[pg][py:py + h, px:px + w] = im[y0:y0 + h, x0:x0 + w]
    _frames.append([x0, y0, w, h, px, py, pg])
for pg, sh in enumerate(_sheets):
    ys = np.nonzero(sh[:, :, 3].max(1))[0]
    sh = sh[:ys.max() + 1]
    man['img']['end/fc%d' % pg] = {'f': wr('end/fc%d' % pg, sh, True), 'w': _W, 'h': sh.shape[0]}
man['img']['end/fc0']['frames'] = _frames
man['img']['end/fc0']['pages'] = len(_sheets)
# 声
_S = os.path.join(SRC, '..', 'Sounds')
for n, f in [('clear', 'Clear.ogg'), ('fc', 'Full combo.ogg'), ('dfc', 'Donda Full Combo.ogg')]:
    os.makedirs(os.path.join(OUT, 'se'), exist_ok=True)
    shutil.copy(os.path.join(_S, f), os.path.join(OUT, 'se', n + '.ogg'))
# ネームプレート・字
OVR = sys.argv[3] if len(sys.argv) > 3 else ''
def pick(f):
    o = os.path.join(OVR, f) if OVR else ''
    return o if o and os.path.exists(o) else os.path.join(SRC, f)
man['img']['nameplate'] = {'f': wr('nameplate', rd(pick('NamePlate.png')), False), 'w': 0, 'h': 0}
# 段位の枠（8〜10 段目）は小さい絵を大きく出すので、4 倍にしておく（ふちがぼやけないよう、なめらかに広げてから輪郭を立てる）
_np = rd(pick('NamePlate.png')).astype(np.float32)[8 * 54:11 * 54]
_a = _np[:, :, 3:] / 255
_pm = np.dstack([_np[:, :, :3] * _a, _np[:, :, 3:]])
_up = cv2.resize(_pm, None, fx=4, fy=4, interpolation=cv2.INTER_LANCZOS4)
_sh = np.clip(_up * 1.7 - cv2.GaussianBlur(_up, (0, 0), 2.2) * 0.7, 0, 255)
_A = _sh[:, :, 3:]
_hd = np.dstack([np.clip(np.where(_A > 1, _sh[:, :, :3] / np.maximum(_A, 1) * 255, 0), 0, 255), _A]).astype(np.uint8)
man['img']['nameplate_frames'] = {'f': wr('nameplate_frames', _hd, False), 'w': _hd.shape[1], 'h': _hd.shape[0]}
for f in ['FOT-Seurat_Pro_B.otf', 'FOT-OedoKtr.otf']:
    shutil.copy(pick(f), os.path.join(OUT, f))
json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w'), ensure_ascii=False, separators=(',', ':'))

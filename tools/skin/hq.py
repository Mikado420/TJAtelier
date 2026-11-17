"""TNDE スキンの粗く見える絵を、waifu2x（swin_unet・art）で細かくする。

iPhone では 1280×720 用の絵が 1.64 倍ほどに広げて描かれ、字や数字・どんちゃんの輪郭がぼやける。
字・数字の絵は 2 倍に、大きな絵（どんちゃん・終わりの演出）はメモリを抑えるため 1.5 倍にしておく。
skin.json の各絵に k（細かさの倍率）を書き、描くときは元の大きさで描く。

使い方: python3 -I tools/skin/hq.py <TNDE-R/Graphics> <public/skins/tnde> <waifu2x の onnx_models> [絵の名前,…]
pack.py で作り直したあとに動かす（もう細かくしてある絵は飛ばす）。
（waifu2x のモデル: https://github.com/nagadomi/nunif/releases の waifu2x_onnx_models_20230504.zip）
"""
import json, os, sys, time
import cv2
import numpy as np
import onnxruntime as ort

G, OUT, MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = set(sys.argv[4].split(',')) if len(sys.argv) > 4 else None
_sess = {}


def sess(name):
    if name not in _sess:
        o = ort.SessionOptions()
        o.intra_op_num_threads = os.cpu_count() or 2
        _sess[name] = ort.InferenceSession(os.path.join(MODELS, 'swin_unet/art/%s.onnx' % name), o, providers=['CPUExecutionProvider'])
    return _sess[name]


TILE, PAD = 128, 8


def run3(img, model, skip=None):
    """img: H×W×3（0〜1）を 2 倍に。skip: H×W の bool（True の所だけのタイルは計算しない）"""
    s = sess(model)
    H, W, _ = img.shape
    step = TILE - 2 * PAD
    nh, nw = -(-H // step), -(-W // step)
    pad = np.pad(img, ((PAD, nh * step - H + PAD), (PAD, nw * step - W + PAD), (0, 0)), mode='edge')
    sk = None if skip is None else np.pad(skip, ((PAD, nh * step - H + PAD), (PAD, nw * step - W + PAD)), mode='constant', constant_values=True)
    out = np.zeros((nh * step * 2, nw * step * 2, 3), np.float32)
    for ty in range(nh):
        for tx in range(nw):
            ys, xs = ty * step, tx * step
            if sk is not None and sk[ys:ys + TILE, xs:xs + TILE].all():
                out[ys * 2:ys * 2 + step * 2, xs * 2:xs * 2 + step * 2] = cv2.resize(pad[ys + PAD:ys + PAD + step, xs + PAD:xs + PAD + step], (step * 2, step * 2), interpolation=cv2.INTER_NEAREST)
                continue
            t = pad[ys:ys + TILE, xs:xs + TILE]
            y = s.run(None, {'x': t.transpose(2, 0, 1)[None].astype(np.float32)})[0][0].transpose(1, 2, 0)
            out[ys * 2:ys * 2 + step * 2, xs * 2:xs * 2 + step * 2] = y
    return np.clip(out[:H * 2, :W * 2], 0, 1)


def fill_rgb(bgra):
    """透けている所の色を、近くの色で埋める（ふちに黒がにじまないように）"""
    rgb = bgra[:, :, :3].astype(np.float32)
    m = (bgra[:, :, 3] > 12).astype(np.float32)
    if m.all() or not m.any():
        return rgb
    acc, w = rgb * m[:, :, None], m.copy()
    out, known = rgb.copy(), m > 0
    for _ in range(48):
        acc, w = cv2.blur(acc, (3, 3)), cv2.blur(w, (3, 3))
        new = (~known) & (w > 1e-4)
        out[new] = acc[new] / w[new][:, None]
        known |= new
        if known.all():
            break
    return out


def up(bgra, q, noisy=False):
    """BGRA uint8 を q 倍（2 か 1.5）に"""
    H, W = bgra.shape[:2]
    a = bgra[:, :, 3]
    empty = a == 0
    model = 'noise0_scale2x' if noisy else 'scale2x'
    rgb = run3(np.ascontiguousarray(fill_rgb(bgra)[:, :, ::-1] / 255), model, skip=empty)[:, :, ::-1]
    af = a.astype(np.float32) / 255
    # 不透明度は、全部透けている・全部不透明なタイルは計算しない
    flat = (a == 0) | (a == 255)
    al = run3(np.repeat(af[:, :, None], 3, axis=2), 'scale2x', skip=flat).mean(axis=2)
    al[al < 0.012] = 0
    al[al > 0.988] = 1
    if q != 2:
        w2, h2 = round(W * q), round(H * q)
        pm = rgb * al[:, :, None]
        pm = cv2.resize(pm, (w2, h2), interpolation=cv2.INTER_AREA)
        al = cv2.resize(al, (w2, h2), interpolation=cv2.INTER_AREA)
        rgb = np.where(al[:, :, None] > 1e-4, pm / np.maximum(al[:, :, None], 1e-4), 0)
    return np.dstack([np.clip(rgb * 255 + 0.5, 0, 255), np.clip(al * 255 + 0.5, 0, 255)]).astype(np.uint8)


def rd(p):
    im = cv2.imread(p, cv2.IMREAD_UNCHANGED)
    if im.ndim == 2:
        im = cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3:
        im = np.dstack([im, np.full(im.shape[:2], 255, np.uint8)])
    return im


def wr(rel, im, lossy, qual=92):
    p = os.path.join(OUT, rel)
    cv2.imwrite(p, im, [cv2.IMWRITE_WEBP_QUALITY, qual if lossy else 101])


man = json.load(open(os.path.join(OUT, 'skin.json'), encoding='utf-8'))


def want(name):
    return ONLY is None or name in ONLY


# 字・数字の絵（2 倍。元の絵は画質を落とさずに入れてあるので、そのまま使う）
TEXT = ['senotes', 'judge', 'lane/Text_Normal', 'lane/Text_Expert', 'lane/Text_Master',
        'taiko/Score', 'taiko/Combo', 'taiko/Combo_Big', 'taiko/Combo_Midium', 'taiko/Combo_Text',
        'gauge/base3', 'nameplate', 'balloon/Combo_1P', 'balloon/Number_Combo', 'balloon/Number_Roll', 'balloon/Roll',
        'end/clearText', 'end/dfc/Donda_Text', 'end/dfc/Donda_Text_Effect', 'end/dfc/Donda_Text_Rainbow_Effect',
        'end/dfc/Bachi', 'end/dfc/Bachi_Flush', 'end/dfc/Bachi_God', 'end/dfc/Bachi_God_Flush']
# 大きな絵（1.5 倍）
BIG = ['end/clearChara', 'end/fcLoop', 'end/dfc/fanL', 'end/dfc/fanR']


def src_of(name):
    """今入っている絵（k が付いていれば、もう細かくしてあるので元の絵は無い）"""
    info = man['img'][name]
    if info.get('k'):
        return None
    return rd(os.path.join(OUT, info['f']))


for name in TEXT + BIG:
    if not want(name) or name not in man['img']:
        continue
    im = src_of(name)
    if im is None:
        continue
    q = 2 if name in TEXT else 1.5
    print(name, im.shape, q, flush=True)
    wr(man['img'][name]['f'], up(im, q), False)
    man['img'][name]['k'] = q

# 光る金の帯（画質を落として入れてあるので、ノイズを消しながら）
for name in ['end/dfc/gold']:
    if want(name) and name in man['img']:
        im = src_of(name)
        if im is not None:
            print(name, flush=True)
            wr(man['img'][name]['f'], up(im, 1.5, noisy=True), True)
            man['img'][name]['k'] = 1.5

# フルコンボの字の連番（3 枚に詰めた絵。1 コマずつ 1.5 倍にして並べ直す）
if want('end/fc') and 'end/fc0' in man['img'] and not man['img']['end/fc0'].get('k'):
    meta = man['img']['end/fc0']
    pages = [rd(os.path.join(OUT, man['img']['end/fc%d' % i]['f'])) for i in range(meta['pages'])]
    newp = [np.zeros((round(p.shape[0] * 1.5) + 4, round(p.shape[1] * 1.5) + 4, 4), np.uint8) for p in pages]
    frames = []
    for fr in meta['frames']:
        x0, y0, w, h, px, py, pg = fr[:7]
        if not w:
            frames.append(fr)
            continue
        cell = pages[pg][py:py + h, px:px + w]
        u = up(cell, 1.5, noisy=True)
        nx, ny = round(px * 1.5), round(py * 1.5)
        newp[pg][ny:ny + u.shape[0], nx:nx + u.shape[1]] = u
        # 細かい絵での位置と大きさを、元の大きさの単位で（描くときに 1.5 倍される）
        frames.append([x0, y0, w, h, nx / 1.5, ny / 1.5, pg, u.shape[1] / 1.5, u.shape[0] / 1.5])
        print('fc frame', len(frames), flush=True)
    for i, p in enumerate(newp):
        wr(man['img']['end/fc%d' % i]['f'], p, True)
        man['img']['end/fc%d' % i]['k'] = 1.5
    meta['frames'] = frames

# どんちゃん（元の連番の絵から。1 コマずつ 1.5 倍）
CH = os.path.join(G, '5_Game/1_Chara/1P')
for k, a in list(man['anim'].items()):
    if not k.startswith('chara/') or not want(k) or a.get('k'):
        continue
    d = os.path.join(CH, k[6:])
    fs = sorted([f for f in os.listdir(d) if f.lower().endswith('.png')], key=lambda f: int(''.join(c for c in f if c.isdigit()) or 0))[::a.get('step', 1)]
    ims = [rd(os.path.join(d, f)) for f in fs]
    fw, fh = a['w'], a['h']
    # 1.5 倍で割り切れるよう、コマの大きさを偶数に（下・右に透明な 1 px を足す）
    fw2, fh2 = fw + fw % 2, fh + fh % 2
    cols = a['cols']
    rows = (len(ims) + cols - 1) // cols
    W2, H2 = fw2 * 3 // 2, fh2 * 3 // 2
    sheet = np.zeros((rows * H2, cols * W2, 4), np.uint8)
    print(k, len(ims), 'frames', flush=True)
    for i, im in enumerate(ims):
        cell = np.zeros((fh2, fw2, 4), np.uint8)
        cell[:im.shape[0], :im.shape[1]] = im[:fh2, :fw2]
        u = up(cell, 1.5)
        y, x = (i // cols) * H2, (i % cols) * W2
        sheet[y:y + H2, x:x + W2] = u[:H2, :W2]
    wr(a['f'], sheet, True)
    a.update({'w': fw2, 'h': fh2, 'n': len(ims), 'k': 1.5})
    json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))

# iPhone（Safari）は 500 万画素を超える絵を粗く読み込み、切り出す位置がずれる。
# 大きな絵は 1 枚 420 万画素・横 4096 px までに分ける（ファイル名も変えて、古い絵が残らないように）
LIMIT, MAXW = 4_200_000, 4096


def split_anims():
    for k, a in man['anim'].items():
        if not a.get('k') or a.get('pages'):
            continue
        q = a['k']
        p = os.path.join(OUT, a['f'])
        sheet = rd(p)
        W, H = round(a['w'] * q), round(a['h'] * q)
        cells = [sheet[(i // a['cols']) * H:(i // a['cols']) * H + H, (i % a['cols']) * W:(i % a['cols']) * W + W] for i in range(a['n'])]
        cols = max(1, min(a['n'], MAXW // W))
        rows = max(1, LIMIT // (cols * W * H))
        per = cols * rows
        base = a['f'][:-5]
        files = []
        for pg in range(-(-a['n'] // per)):
            part = cells[pg * per:(pg + 1) * per]
            r = -(-len(part) // cols)
            out = np.zeros((r * H, min(cols, len(part)) * W, 4), np.uint8)
            for j, cl in enumerate(part):
                out[(j // cols) * H:(j // cols) * H + H, (j % cols) * W:(j % cols) * W + W] = cl
            f = '%s-%d.webp' % (base, pg)
            wr(f, out, True, 95)
            files.append(f)
        os.remove(p)
        a.update({'f': files[0], 'cols': cols, 'per': per, 'pages': files})
        print(k, len(files), 'pages', flush=True)


def split_fc():
    meta = man['img'].get('end/fc0')
    if not meta or not meta.get('k') or meta.get('split'):
        return
    q = meta['k']
    old = [rd(os.path.join(OUT, man['img']['end/fc%d' % i]['f'])) for i in range(meta['pages'])]
    # コマを切り出して、棚に並べるように詰め直す
    cells = []
    for fr in meta['frames']:
        if not fr[2]:
            cells.append(None)
            continue
        px, py, pg, sw, sh = fr[4], fr[5], fr[6], fr[7], fr[8]
        x, y, w, h = round(px * q), round(py * q), round(sw * q), round(sh * q)
        cells.append(old[pg][y:y + h, x:x + w])
    PW = 3072
    PH = LIMIT // PW
    pages, place = [[]], []
    x = y = rowh = 0
    for cl in cells:
        if cl is None:
            place.append(None)
            continue
        h, w = cl.shape[:2]
        if x + w > PW:
            x, y, rowh = 0, y + rowh + 2, 0
        if y + h > PH:
            pages.append([])
            x = y = rowh = 0
        pages[-1].append((x, y, cl))
        place.append((x, y, len(pages) - 1))
        x += w + 2
        rowh = max(rowh, h)
    for i in range(meta['pages']):
        os.remove(os.path.join(OUT, man['img']['end/fc%d' % i]['f']))
        if i:
            del man['img']['end/fc%d' % i]
    for i, items in enumerate(pages):
        W = max(px + c.shape[1] for px, py, c in items)
        H = max(py + c.shape[0] for px, py, c in items)
        out = np.zeros((H, W, 4), np.uint8)
        for px, py, c in items:
            out[py:py + c.shape[0], px:px + c.shape[1]] = c
        f = 'end/fcp%d.webp' % i
        wr(f, out, True, 95)
        e = man['img'].setdefault('end/fc%d' % i, {})
        e.update({'f': f, 'w': W / q, 'h': H / q, 'k': q})
    for fr, pl in zip(meta['frames'], place):
        if pl:
            fr[4], fr[5], fr[6] = pl[0] / q, pl[1] / q, pl[2]
    meta['pages'] = len(pages)
    meta['split'] = 1
    print('end/fc', len(pages), 'pages', flush=True)


split_anims()
split_fc()
# 絵の版（読み込むときに URL に付け、古い絵が残らないように）
man['v'] = '%x' % int(time.time())
json.dump(man, open(os.path.join(OUT, 'skin.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('done', flush=True)

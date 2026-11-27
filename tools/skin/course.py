"""難易度マーク（プレイ画面の左のパネル）を 4 倍の細かさで作る。
5_Game/4_CourseSymbol の絵は小さく（89×60 など）拡大すると粗いので、選曲画面の大きなマーク（Difficulty_Mark.png）を
同じ大きさ・位置に縮めて貼り、まわりを黒で縁取り、下の字（かんたん など）を勘亭流（DF勘亭流）で書き直す。
大きさ・位置は元の小さな絵に重なりが一番よくなるように合わせた値。
使い方: python3 -I tools/skin/course.py <TNDE-R/Graphics> <出力先> [勘亭流のフォント]"""
import json, os, sys
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

K = 4
NAMES = ['Easy', 'Normal', 'Hard', 'Oni', 'Edit']
# 大きなマークの倍率（元の絵の 1px あたり）と、4 倍の絵での左上
FIT = {'Easy': (0.1875, 61, 16), 'Normal': (0.18, 74, 3), 'Hard': (0.1875, 51, 1), 'Oni': (0.1725, 33, 13), 'Edit': (0.1725, 33, 13)}
# 字と、元の絵で字の白いところが入る範囲（x0, x1, y0, y1）
LABEL = {'Easy': ('かんたん', (17, 73, 43, 53)), 'Normal': ('ふつう', (26, 66, 45, 56)), 'Hard': ('むずかしい', (10, 81, 45, 56)),
         'Oni': ('おに', (22, 47, 48, 59)), 'Edit': ('おに', (22, 47, 48, 59))}
# 縁取りの太さ（元の絵の px）
MARK_EDGE = 1.0
TEXT_EDGE = 2.6
# 字の幅と横の位置の手直し（参考動画「魔宵月」のプレイ画面の「おに」に DF勘亭流 を重ねて測った: 横に 2.5% 広く、画面で 1px 左）
TEXT_KX = 1.025
TEXT_DX = -1 / 1.5


def label(txt, box, font):
    x0, x1, y0, y1 = box
    tw, th = (x1 - x0 + 1) * K, (y1 - y0 + 1) * K
    sw = round(TEXT_EDGE * K)
    size = th * 1.6
    for _ in range(80):
        f = ImageFont.truetype(font, max(1, int(size)))
        bb = f.getbbox(txt)
        if bb[3] - bb[1] <= th:
            break
        size *= 0.98
    bb = f.getbbox(txt)
    gw, gh = bb[2] - bb[0], bb[3] - bb[1]
    im = Image.new('RGBA', (gw + 4 * sw, gh + 4 * sw), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 * sw - bb[0], 2 * sw - bb[1]), txt, font=f, fill=(255, 255, 255, 255), stroke_width=sw, stroke_fill=(0, 0, 0, 255))
    # 字の幅を元の絵に合わせる（縁取りは太さを保つため、中身の幅で比べる）
    im = im.resize((max(1, round(im.width * tw * TEXT_KX / gw)), im.height), Image.LANCZOS)
    cx, cy = ((x0 + x1 + 1) / 2 + TEXT_DX) * K, (y0 + y1 + 1) / 2 * K
    return im, (round(cx - im.width / 2), round(cy - im.height / 2))


def make(G, n, font):
    big = Image.open(os.path.join(G, '3_SongSelect/Difficulty_Select/Difficulty_Mark.png')).convert('RGBA')
    sm = Image.open(os.path.join(G, '5_Game/4_CourseSymbol/%s.png' % n)).convert('RGBA')
    W, H = sm.width * K, sm.height * K
    cw = big.width / 5
    i = NAMES.index(n)
    cell = big.crop((int(i * cw), 0, int((i + 1) * cw), int(big.height / 2)))
    cell = cell.crop(cell.getbbox())
    s, dx, dy = FIT[n]
    c2 = cell.resize((round(cell.width * s * K), round(cell.height * s * K)), Image.LANCZOS)
    mark = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mark.paste(c2, (dx, dy), c2)
    r = round(MARK_EDGE * K)
    a = cv2.dilate(np.array(mark)[:, :, 3], cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    edge = np.zeros((H, W, 4), np.uint8)
    edge[:, :, 3] = a
    out = Image.fromarray(edge)
    out.alpha_composite(mark)
    txt, box = LABEL[n]
    t, pos = label(txt, box, font)
    out.alpha_composite(t, pos) if pos[0] >= 0 and pos[1] >= 0 else out.paste(t, pos, t)
    return out, sm.size


def main():
    G, OUT = sys.argv[1], sys.argv[2]
    font = sys.argv[3] if len(sys.argv) > 3 else os.path.join(OUT, 'DFPKanTeiRyu-XB.ttf')
    mp = os.path.join(OUT, 'skin.json')
    man = json.load(open(mp, encoding='utf-8'))
    os.makedirs(os.path.join(OUT, 'course'), exist_ok=True)
    for n in NAMES:
        im, (w, h) = make(G, n, font)
        f = 'course/%s.webp' % n
        im.save(os.path.join(OUT, f), 'WEBP', lossless=True, quality=100, method=6)
        # w, h は元の絵の大きさ（貼るときはこの大きさの 1.5 倍）。絵は k 倍の細かさ
        man['img']['course/' + n] = {'f': f, 'w': w, 'h': h, 'k': K}
    json.dump(man, open(mp, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    main()

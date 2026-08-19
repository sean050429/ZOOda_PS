"""把 OSM 瓦片拼成一张旷野之息风格的圆形小地图。

底图用 Carto 的 voyager_nolabels：
  - nolabels 版本不带任何文字，地名要用我们自己的字体画上去，
    底图自带的标注是抠不掉的垃圾；
  - voyager 的默认配色本来就是米黄底 + 土黄路网，离羊皮纸最近。
"""

from __future__ import annotations

import hashlib
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageOps, ImageStat

TILE_URL = "https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png"
UA = "Zelda_PS/0.1 (personal photo UI overlay tool)"

TILE_CACHE = Path(__file__).resolve().parent.parent / "cache" / "tiles"
TILE_CACHE.mkdir(parents=True, exist_ok=True)

# @2x 瓦片是 512px 但体积约 4 倍。小地图本来就要压色阶，
# 小尺寸时 @1x 完全够用，在慢网络上能省下大半等待时间。
TILE_PX_1X = 256
TILE_PX_2X = 512
RETINA_THRESHOLD = 520  # 请求的直径超过这个才值得上 @2x

# 羊皮纸色阶：从深棕（水/阴影）到近白（高光），风格化时按亮度映射到这条带上
PARCHMENT = [
    (58, 44, 30),
    (92, 72, 46),
    (140, 112, 72),
    (186, 158, 108),
    (214, 192, 146),
    (236, 222, 186),
]
INK = (44, 32, 20)        # 描边、指针的深色
GOLD = (198, 166, 96)     # 外圈金环


# ---------------- 瓦片 ----------------

def deg2tile(lat: float, lon: float, z: int) -> tuple[float, float]:
    """经纬度 → 瓦片坐标（带小数，小数部分就是瓦片内的偏移）。"""
    n = 2 ** z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _fetch_tile(client: httpx.Client, z: int, x: int, y: int,
                retina: bool) -> Image.Image:
    n = 2 ** z
    x, y = x % n, min(max(y, 0), n - 1)  # 横向绕地球，纵向夹住
    suffix = "@2x" if retina else ""
    key = hashlib.md5(f"{z}/{x}/{y}{suffix}".encode()).hexdigest()
    cached = TILE_CACHE / f"{key}.png"
    if cached.exists():
        try:
            return Image.open(cached).convert("RGB")
        except Exception:
            cached.unlink(missing_ok=True)

    r = client.get(TILE_URL.format(z=z, x=x, y=y, r=suffix))
    r.raise_for_status()
    img = Image.open(BytesIO(r.content)).convert("RGB")
    try:
        # 每次都确认目录在：缓存目录被外部删掉时，写入会静默失败，
        # 结果就是每个请求都重新走网络，还查不出原因
        TILE_CACHE.mkdir(parents=True, exist_ok=True)
        img.save(cached, "PNG")
    except Exception:
        pass
    return img


def fetch_area(lat: float, lon: float, zoom: int, size: int) -> Image.Image:
    """抓够覆盖 size×size 的瓦片拼起来，再以目标点为中心裁切。

    瓦片范围是按需要的像素精确算的，不是「中心 ±N 圈」——
    后者在 size=686 时会抓 5×5=25 张，实际只需要 2×2。
    再加上并发下载，出图从二十多秒降到两三秒。
    """
    retina = size > RETINA_THRESHOLD
    tile_px = TILE_PX_2X if retina else TILE_PX_1X
    scale = tile_px // TILE_PX_1X  # @2x 时每个 CSS 像素有 2 个真实像素

    fx, fy = deg2tile(lat, lon, zoom)
    # 覆盖多大地理范围只由 size 决定，跟用不用 @2x 无关。
    # 若按 tile_px 算，跨过 @2x 阈值时覆盖范围会突然减半 —— 用户拖大小滑块
    # 就会看到地图比例毫无道理地跳一下。@2x 只该更清晰，不该更放大。
    half_tiles = size / 2 / TILE_PX_1X

    tx0, tx1 = math.floor(fx - half_tiles), math.floor(fx + half_tiles)
    ty0, ty1 = math.floor(fy - half_tiles), math.floor(fy + half_tiles)
    coords = [(x, y) for x in range(tx0, tx1 + 1) for y in range(ty0, ty1 + 1)]

    with httpx.Client(headers={"User-Agent": UA}, timeout=25,
                      follow_redirects=True) as client:
        # 瓦片服务器允许并发，串行下载纯属浪费
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(_fetch_tile, client, zoom, x, y, retina): (x, y)
                       for x, y in coords}
            tiles = {}
            for fut in as_completed(futures):
                tiles[futures[fut]] = fut.result()

    canvas = Image.new("RGB", (tile_px * (tx1 - tx0 + 1),
                               tile_px * (ty1 - ty0 + 1)), PARCHMENT[-1])
    for (x, y), tile in tiles.items():
        if tile.width != tile_px:
            tile = tile.resize((tile_px, tile_px), Image.LANCZOS)
        canvas.paste(tile, ((x - tx0) * tile_px, (y - ty0) * tile_px))

    cx = (fx - tx0) * tile_px
    cy = (fy - ty0) * tile_px
    half = size / 2 * scale
    crop = canvas.crop((round(cx - half), round(cy - half),
                        round(cx + half), round(cy + half)))
    # @2x 相当于超采样，缩回目标尺寸后细节更干净
    return crop if scale == 1 else crop.resize((size, size), Image.LANCZOS)


# ---------------- 风格化 ----------------

def _parchment_lut() -> list[int]:
    """做一张 256→RGB 的查表，把亮度直接映射成羊皮纸色阶。"""
    r_lut, g_lut, b_lut = [], [], []
    segments = len(PARCHMENT) - 1
    for i in range(256):
        pos = i / 255 * segments
        idx = min(int(pos), segments - 1)
        t = pos - idx
        c0, c1 = PARCHMENT[idx], PARCHMENT[idx + 1]
        r_lut.append(round(c0[0] + (c1[0] - c0[0]) * t))
        g_lut.append(round(c0[1] + (c1[1] - c0[1]) * t))
        b_lut.append(round(c0[2] + (c1[2] - c0[2]) * t))
    return r_lut + g_lut + b_lut


_LUT = _parchment_lut()


def _spread(gray: Image.Image) -> int:
    """灰度的 2%~98% 分位跨度，衡量「这张图上到底有没有东西」。"""
    hist = gray.histogram()
    total = sum(hist) or 1

    def percentile(p: float) -> int:
        acc = 0
        for value, count in enumerate(hist):
            acc += count
            if acc >= total * p:
                return value
        return 255

    return percentile(0.98) - percentile(0.02)


def stylize(img: Image.Image, posterize: int = 4) -> Image.Image:
    """现代地图 → 羊皮纸地图。

    关键一步是先做直方图拉伸。voyager 瓦片整张图的灰度只落在 205~255
    这 50 级里（标准差 9.5），直接压色阶会全部并进同一个桶，出来一片死白。
    先把这 50 级摊到 0~255，结构才出得来。

    转灰度是有意的：底图原本的绿地/水面配色再好看，
    混进羊皮纸色阶里也只会脏。丢掉色相、只留结构，再重新上色。
    """
    gray = img.convert("L")

    # 湖心、海面这种地方整张瓦片就是一个色，硬拉伸只会把压缩噪点放大成一坨泥。
    # 判据用 2%~98% 分位的跨度，不用标准差 —— 底图大片留白、结构只占少量像素，
    # 标准差会把有内容的市区（悉尼 z15 只有 3.9）误判成空白。
    if _spread(gray) <= 2:
        gray = Image.new("L", gray.size, round(ImageStat.Stat(gray).mean[0]))
    else:
        gray = ImageOps.autocontrast(gray, cutoff=0.5)

    # 压成几个色阶，这是「手绘地图」感的主要来源
    levels = max(2, min(8, posterize))
    step = 256 // levels
    gray = gray.point(lambda v: min(255, (v // step) * step + step // 2))

    # 色阶边界描边，模拟墨线
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edges = edges.point(lambda v: 255 if v > 24 else 0)

    out = gray.convert("RGB").point(_LUT)
    ink = Image.new("RGB", out.size, INK)
    out = Image.composite(ink, out, edges)

    return out.filter(ImageFilter.SMOOTH)


def _vignette(size: int) -> Image.Image:
    """边缘压暗，让圆形小地图有「往里凹」的立体感。

    返回的是遮罩：中心亮（保留原图），边缘暗（混入暗色）。
    """
    grad = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(grad)
    steps = 32
    for i in range(steps + 1):
        t = i / steps                       # 0 = 最外圈，1 = 圆心
        r = size / 2 * (1 - t)
        v = round(255 * (0.62 + 0.38 * t))  # 外圈 158 → 圆心 255
        d.ellipse([size / 2 - r, size / 2 - r, size / 2 + r, size / 2 + r], fill=v)
    return grad.filter(ImageFilter.GaussianBlur(size / 30))


def round_frame(img: Image.Image, heading: float | None = None) -> Image.Image:
    """裁成圆形，套上金环，中心放一个指针。返回带透明通道的 RGBA。"""
    size = img.width
    ss = 4  # 超采样，圆边才不会有锯齿
    big = size * ss

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, big - 1, big - 1], fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)

    # 暗角
    dark = Image.new("RGB", img.size, (30, 22, 14))
    img = Image.composite(img, dark, _vignette(size))

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)

    ring = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    outer = max(3, round(size * 0.028)) * ss
    rd.ellipse([outer // 2, outer // 2, big - 1 - outer // 2, big - 1 - outer // 2],
               outline=INK + (255,), width=outer)
    inner = max(2, round(size * 0.016)) * ss
    pad = outer + inner // 2
    rd.ellipse([pad, pad, big - 1 - pad, big - 1 - pad],
               outline=GOLD + (255,), width=inner)
    out.alpha_composite(ring.resize((size, size), Image.LANCZOS))

    # 中心指针：拍摄者站的位置
    marker = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    md = ImageDraw.Draw(marker)
    c = big / 2
    r = size * 0.075 * ss
    ang = math.radians(heading if heading is not None else 0)
    pts = []
    for a_off, rad in ((0, r), (math.radians(140), r * 0.62),
                       (math.radians(180), r * 0.28), (math.radians(220), r * 0.62)):
        a = ang + a_off - math.pi / 2
        pts.append((c + math.cos(a) * rad, c + math.sin(a) * rad))
    md.polygon(pts, fill=(240, 226, 190, 255), outline=INK + (255,))
    out.alpha_composite(marker.resize((size, size), Image.LANCZOS))

    return out


def render(lat: float, lon: float, zoom: int = 15, size: int = 420,
           posterize: int = 4, heading: float | None = None) -> Image.Image:
    raw = fetch_area(lat, lon, zoom, size)
    return round_frame(stylize(raw, posterize), heading)

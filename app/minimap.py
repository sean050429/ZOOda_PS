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
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageStat

TILE_URL = "https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}{r}.png"
UA = "Zelda_PS/0.1 (personal photo UI overlay tool)"

TILE_CACHE = Path(__file__).resolve().parent.parent / "cache" / "tiles"
TILE_CACHE.mkdir(parents=True, exist_ok=True)

# @2x 瓦片是 512px 但体积约 4 倍。小地图本来就要压色阶，
# 小尺寸时 @1x 完全够用，在慢网络上能省下大半等待时间。
# 拼接画布的底色。只在个别瓦片没拿到时才会露出来，
# 取中性浅灰，后面统一走调色链，不会突兀。
TILE_GAP_FILL = (232, 230, 224)

TILE_PX_1X = 256
TILE_PX_2X = 512
RETINA_THRESHOLD = 520  # 请求的直径超过这个才值得上 @2x

# 调色预设。走的是「照片调色」那一套 —— 降饱和 + 加褐调 + 压对比 + 叠色，
# 而不是压色阶。好处是地图原有的层次全部保留，出来是一张被做旧的地图，
# 而不是一张色块图。数值语义与 CSS filter 完全一致。
PALETTES = {
    "botw": {
        "name": "旷野之息",
        "saturate": 0.55,
        "sepia": 0.30,
        "contrast": 1.08,
        "brightness": 0.94,
        "tint": (0x8A, 0x7A, 0x4E),
        "tint_alpha": 0.28,
        "ink": (44, 34, 20),
        "ring": (198, 166, 96),
    },
    "slate": {
        "name": "希卡冷蓝",
        "saturate": 0.35,
        "sepia": 0.10,
        "contrast": 1.12,
        "brightness": 0.80,
        "tint": (0x46, 0x5E, 0x74),
        "tint_alpha": 0.42,
        "ink": (18, 24, 30),
        "ring": (120, 190, 210),
    },
    "dark": {
        "name": "原作深色",
        "saturate": 0.40,
        "sepia": 0.22,
        "contrast": 1.10,
        "brightness": 0.62,
        "tint": (0x5A, 0x58, 0x40),
        "tint_alpha": 0.40,
        "ink": (24, 24, 20),
        "ring": (108, 116, 128),
    },
}

DEFAULT_PALETTE = "botw"

for _key, _spec in PALETTES.items():
    _spec["key"] = _key


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
                               tile_px * (ty1 - ty0 + 1)), TILE_GAP_FILL)
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

def get_palette(name: str | None) -> dict:
    return PALETTES.get(name or DEFAULT_PALETTE, PALETTES[DEFAULT_PALETTE])


# CSS filter 的标准系数
_LUMA = (0.213, 0.715, 0.072)
_SEPIA = (
    (0.393, 0.769, 0.189),
    (0.349, 0.686, 0.168),
    (0.272, 0.534, 0.131),
)


def _matmul(a, b):
    return tuple(
        tuple(sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3))
        for i in range(3)
    )


def _saturate_matrix(s: float):
    lr, lg, lb = _LUMA
    return (
        (lr + (1 - lr) * s, lg - lg * s,       lb - lb * s),
        (lr - lr * s,       lg + (1 - lg) * s, lb - lb * s),
        (lr - lr * s,       lg - lg * s,       lb + (1 - lb) * s),
    )


def _sepia_matrix(a: float):
    """0 = 原样，1 = 全褐。中间按线性插值，和 CSS 的 sepia() 一致。"""
    return tuple(
        tuple((1 - a) * (1.0 if i == j else 0.0) + a * _SEPIA[i][j] for j in range(3))
        for i in range(3)
    )


def _stretch_lut(img: Image.Image) -> list[int] | None:
    """按亮度的 1%~99% 分位算一条线性拉伸表，整幅图不够开阔时返回 None。

    voyager 瓦片整张图的灰度只落在 205~255 这 50 级里，不拉伸的话
    套完调色链是一张几乎没有层次的浅色盘。
    """
    hist = img.convert("L").histogram()
    total = sum(hist) or 1

    def percentile(p: float) -> int:
        acc = 0
        for value, count in enumerate(hist):
            acc += count
            if acc >= total * p:
                return value
        return 255

    lo, hi = percentile(0.01), percentile(0.99)
    if hi - lo < 8:  # 湖心、海面这种整张一个色的，拉伸只会放大噪点
        return None
    scale = 255.0 / (hi - lo)
    return [min(255, max(0, round((v - lo) * scale))) for v in range(256)]


def stylize(img: Image.Image, posterize: int = 0,
            palette: str | None = None) -> Image.Image:
    """现代地图 → 做旧的手绘地图。

    调色链和 CSS filter 同序同义：saturate → sepia → contrast → brightness，
    最后叠一层 multiply 的色。和压色阶的做法不同，这样地图原有的层次
    全部保留，出来是「一张被做旧的地图」而不是「一张色块图」。

    唯一的额外步骤是先做亮度拉伸，因为底图的动态范围太窄。关键在于
    只拉亮度、不动色度：整幅拉伸会把 50 级的差距放大五倍，连带把水面
    的蓝也放大成霓虹青。所以拆成「亮度拉满 + 色度按 saturate 缩放」。

    posterize 默认关闭；给大于 1 的值才会额外压色阶。
    """
    spec = get_palette(palette)
    rgb = img.convert("RGB")

    gray = rgb.convert("L")
    lut = _stretch_lut(rgb)
    stretched = gray.point(lut) if lut else gray

    # 偏离灰度的部分就是色度，以 128 表示零，这样能保住负值
    gray_rgb = Image.merge("RGB", (gray, gray, gray))
    chroma = ImageChops.subtract(rgb, gray_rgb, scale=1, offset=128)
    sat = spec["saturate"]
    chroma = chroma.point([min(255, max(0, round(128 + (v - 128) * sat)))
                           for v in range(256)] * 3)

    base = Image.merge("RGB", (stretched, stretched, stretched))
    out = ImageChops.add(base, chroma, scale=1, offset=-128)

    # 褐调：0 = 原样，1 = 全褐，中间线性插值，与 CSS 的 sepia() 一致
    m = _sepia_matrix(spec["sepia"])
    out = out.convert("RGB", (
        m[0][0], m[0][1], m[0][2], 0,
        m[1][0], m[1][1], m[1][2], 0,
        m[2][0], m[2][1], m[2][2], 0,
    ))

    # 对比度绕 0.5 中灰旋转，亮度是纯缩放，一张查表搞定
    c, b = spec["contrast"], spec["brightness"]
    out = out.point([min(255, max(0, round((((v / 255 - 0.5) * c + 0.5) * b) * 255)))
                     for v in range(256)] * 3)

    if spec["tint_alpha"] > 0:
        tint = Image.new("RGB", out.size, spec["tint"])
        out = Image.blend(out, ImageChops.multiply(out, tint), spec["tint_alpha"])

    if posterize and posterize > 1:
        levels = min(8, posterize)
        step = 256 // levels
        out = out.point([min(255, (v // step) * step + step // 2)
                         for v in range(256)] * 3)

    return out


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


def round_frame(img: Image.Image, palette: str | None = None) -> Image.Image:
    """裁成圆形，套上外环。返回带透明通道的 RGBA。

    这里不画玩家箭头 —— 箭头只跟朝向有关，跟坐标无关，放在前端
    canvas 图层上画，拖朝向滑杆才能即时看到，不用回服务器重出图。
    导出成品时再调 draw_player_marker() 按原图分辨率画一次。
    """
    size = img.width
    ss = 4  # 超采样，圆边才不会有锯齿
    big = size * ss

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse([0, 0, big - 1, big - 1], fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)

    spec = get_palette(palette)

    # 暗角
    dark = Image.new("RGB", img.size, spec["ink"])
    img = Image.composite(img, dark, _vignette(size))

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)

    ring = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    outer = max(3, round(size * 0.028)) * ss
    rd.ellipse([outer // 2, outer // 2, big - 1 - outer // 2, big - 1 - outer // 2],
               outline=spec["ink"] + (255,), width=outer)
    inner = max(2, round(size * 0.016)) * ss
    pad = outer + inner // 2
    rd.ellipse([pad, pad, big - 1 - pad, big - 1 - pad],
               outline=spec["ring"] + (255,), width=inner)
    out.alpha_composite(ring.resize((size, size), Image.LANCZOS))

    return out


# 玩家箭头。形状与配色照搬 Zelda_photo 的 botw 主题
# （themes/botw/theme.json 的 slots.minimap.pin / .sector）：
# 四点箭形，尾部带凹口。参考里 pin.size=12、minimap radius=89，
# 所以 p 占直径 12/178 = 6.74%。前端 canvas 图层用的是同一组数值。
MARKER_FILL = (0xFF, 0xE2, 0x4A)
MARKER_STROKE = (0x0E, 0x1A, 0x24)
MARKER_P_RATIO = 0.0674       # pin.size / 小地图直径
MARKER_STROKE_RATIO = 0.0067  # strokeWidth 1.2 / 178


def draw_player_marker(img: Image.Image, heading: float = 0.0,
                       scale: float = 1.0) -> Image.Image:
    """把玩家箭头画到小地图上。预览不走这里（前端画），导出时才用。"""
    size = img.width
    ss = 4
    big = size * ss
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    c = big / 2
    a = math.radians(heading)

    p = MARKER_P_RATIO * big * max(0.1, scale)
    pts = [(0, -p), (p * 0.72, p * 0.8), (0, p * 0.4), (-p * 0.72, p * 0.8)]
    rot = [(c + x * math.cos(a) - y * math.sin(a),
            c + x * math.sin(a) + y * math.cos(a)) for x, y in pts]

    d.polygon(rot, fill=MARKER_FILL + (255,), outline=MARKER_STROKE + (255,),
              width=max(1, round(MARKER_STROKE_RATIO * big * max(0.1, scale))))
    out = img.copy()
    out.alpha_composite(layer.resize((size, size), Image.LANCZOS))
    return out


def render(lat: float, lon: float, zoom: int = 15, size: int = 420,
           posterize: int = 0, palette: str | None = None,
           marker: bool = False, heading: float = 0.0,
           marker_scale: float = 1.7) -> Image.Image:
    raw = fetch_area(lat, lon, zoom, size)
    out = round_frame(stylize(raw, posterize, palette), palette)
    return draw_player_marker(out, heading, marker_scale) if marker else out

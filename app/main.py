"""Zelda_PS —— 本机服务：接收照片上传，生成浏览器可显示的预览。

原图始终保留（导出高清成品 + 读 EXIF 用），另存一张 JPEG 预览给前端显示，
因为浏览器不认 HEIC，而且原图动辄几千万像素，直接塞进页面会很卡。
"""

from __future__ import annotations

import io
from datetime import datetime
import shutil
import uuid
from pathlib import Path

import pillow_heif
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from app import geo, minimap, weather
from app.exif_reader import read_photo_context

pillow_heif.register_heif_opener()

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
PREVIEW_MAX_EDGE = 2000

app = FastAPI(title="Zelda_PS")


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """开发时禁止浏览器缓存前端文件。

    默认的 StaticFiles 带 etag/last-modified，浏览器会直接吃缓存
    （transferSize=0，根本不回服务器），改了 js/css 刷新也看不到效果，
    非常容易误判成代码有 bug。地图瓦片那种真正该缓存的走 /api，不受影响。
    """
    response = await call_next(request)
    path = request.url.path
    if not path.startswith(("/api/", "/uploads/")) and (
        path.endswith((".js", ".css", ".html", ".json")) or path == "/"
    ):
        response.headers["Cache-Control"] = "no-store, must-revalidate"
    return response


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.post("/api/upload")
async def upload(photo: UploadFile = File(...)) -> dict:
    raw = await photo.read()
    if not raw:
        raise HTTPException(400, "文件是空的")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"照片超过 {MAX_UPLOAD_BYTES // 1024 // 1024}MB 上限")

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        raise HTTPException(400, "无法识别这个图片格式")

    photo_id = uuid.uuid4().hex[:12]
    photo_dir = UPLOAD_DIR / photo_id
    photo_dir.mkdir()

    try:
        suffix = Path(photo.filename or "").suffix.lower() or ".bin"
        (photo_dir / f"original{suffix}").write_bytes(raw)

        # exif_transpose：按 EXIF 的方向标记把图转正，否则竖拍照片在网页里是躺着的
        preview = ImageOps.exif_transpose(img)
        preview.thumbnail((PREVIEW_MAX_EDGE, PREVIEW_MAX_EDGE), Image.LANCZOS)
        if preview.mode not in ("RGB", "L"):
            preview = preview.convert("RGB")
        preview.save(photo_dir / "preview.jpg", "JPEG", quality=88)
    except Exception:
        shutil.rmtree(photo_dir, ignore_errors=True)
        raise

    return {
        "id": photo_id,
        "context": read_photo_context(img, raw),
        "preview_url": f"/uploads/{photo_id}/preview.jpg",
        "filename": photo.filename,
        "format": img.format,
        "original_size": [img.width, img.height],
        "preview_size": [preview.width, preview.height],
        "bytes": len(raw),
    }


# ---------------- 地名 ----------------

@app.get("/api/place")
def api_place(lat: float = Query(..., ge=-90, le=90),
              lon: float = Query(..., ge=-180, le=180)) -> dict:
    """快的那条腿：几百毫秒返回一个行政区级别的名字，先把界面点亮。"""
    return geo.reverse_geocode(lat, lon)


@app.get("/api/landmark")
def api_landmark(lat: float = Query(..., ge=-90, le=90),
                 lon: float = Query(..., ge=-180, le=180)) -> dict:
    """慢的那条腿：2~15 秒，但能挖出真正的地标名。前端异步调，失败不影响主流程。"""
    return geo.find_landmark(lat, lon)


@app.get("/api/weather")
def api_weather(lat: float = Query(..., ge=-90, le=90),
                lon: float = Query(..., ge=-180, le=180),
                at: str = Query(..., description="照片的本地拍摄时间，ISO 格式")) -> dict:
    """查拍摄当时的天气。数据来自 Open-Meteo，无需 API key。"""
    try:
        when = datetime.fromisoformat(at[:19])
    except ValueError:
        raise HTTPException(400, "时间格式不对，需要 ISO 格式如 2025-07-16T14:55:19")
    return weather.fetch_weather(lat, lon, when)


@app.get("/api/full/{photo_id}")
def api_full(photo_id: str) -> Response:
    """按原图分辨率给出一张 JPEG，供导出时在画布上打底。

    不能直接用 uploads 里的原文件：iPhone 的 HEIC 浏览器解不了，
    而且竖拍照片要按 EXIF 方向转正才和预览一致。结果落盘缓存，
    同一张照片重复导出不用反复解码。
    """
    if not photo_id.isalnum():
        raise HTTPException(400, "非法的照片 id")
    photo_dir = UPLOAD_DIR / photo_id
    if not photo_dir.is_dir():
        raise HTTPException(404, "找不到这张照片")

    cached = photo_dir / "full.jpg"
    if not cached.exists():
        originals = list(photo_dir.glob("original.*"))
        if not originals:
            raise HTTPException(404, "原图已丢失")
        with Image.open(originals[0]) as im:
            im.load()
            full = ImageOps.exif_transpose(im)
            if full.mode not in ("RGB", "L"):
                full = full.convert("RGB")
            full.save(cached, "JPEG", quality=95)

    return Response(cached.read_bytes(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/palettes")
def api_palettes() -> dict:
    """小地图可选的配色，前端拿去填下拉框。"""
    return {"palettes": [{"key": k, "name": v["name"]}
                         for k, v in minimap.PALETTES.items()]}


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1, max_length=120)) -> dict:
    """地名 → 坐标。没有 GPS 的照片靠这个。"""
    return {"results": geo.search_place(q)}


# ---------------- 小地图 ----------------

@app.get("/api/minimap")
def api_minimap(lat: float = Query(..., ge=-90, le=90),
                lon: float = Query(..., ge=-180, le=180),
                zoom: int = Query(15, ge=3, le=18),
                size: int = Query(420, ge=120, le=2000),
                posterize: int = Query(0, ge=0, le=8),
                palette: str = Query(minimap.DEFAULT_PALETTE)) -> Response:
    """只出底图。玩家箭头由前端 canvas 图层画，拖朝向不用回服务器。"""
    try:
        img = minimap.render(lat, lon, zoom=zoom, size=size,
                             posterize=posterize, palette=palette)
    except Exception as e:
        raise HTTPException(502, f"地图瓦片拉取失败：{e}")

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# 从游戏截图抠出来的 UI 元件，只用于本地对照排版。
# 目录在 .gitignore 里，这些是任天堂的素材，不会进仓库也不会进成品。
UI_SOURCE_DIR = BASE_DIR / "ui_source"
if UI_SOURCE_DIR.exists():
    app.mount("/ui_source", StaticFiles(directory=UI_SOURCE_DIR), name="ui_source")
# 挂在根路径，必须放最后，否则会盖掉上面的 /api 和 /uploads 路由
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

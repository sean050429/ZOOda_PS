"""Zelda_PS —— 本机服务：接收照片上传，生成浏览器可显示的预览。

原图始终保留（导出高清成品 + 读 EXIF 用），另存一张 JPEG 预览给前端显示，
因为浏览器不认 HEIC，而且原图动辄几千万像素，直接塞进页面会很卡。
"""

from __future__ import annotations

import io
import shutil
import uuid
from pathlib import Path

import pillow_heif
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

from app import geo, minimap
from app.exif_reader import read_photo_context

pillow_heif.register_heif_opener()

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
UPLOAD_DIR = BASE_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

MAX_UPLOAD_BYTES = 60 * 1024 * 1024
PREVIEW_MAX_EDGE = 2000

app = FastAPI(title="Zelda_PS")


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


@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1, max_length=120)) -> dict:
    """地名 → 坐标。没有 GPS 的照片靠这个。"""
    return {"results": geo.search_place(q)}


# ---------------- 小地图 ----------------

@app.get("/api/minimap")
def api_minimap(lat: float = Query(..., ge=-90, le=90),
                lon: float = Query(..., ge=-180, le=180),
                zoom: int = Query(15, ge=3, le=18),
                size: int = Query(420, ge=120, le=900),
                posterize: int = Query(4, ge=2, le=8),
                heading: float | None = Query(None, ge=0, lt=360)) -> Response:
    try:
        img = minimap.render(lat, lon, zoom=zoom, size=size,
                             posterize=posterize, heading=heading)
    except Exception as e:
        raise HTTPException(502, f"地图瓦片拉取失败：{e}")

    buf = io.BytesIO()
    img.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})


app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
# 挂在根路径，必须放最后，否则会盖掉上面的 /api 和 /uploads 路由
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

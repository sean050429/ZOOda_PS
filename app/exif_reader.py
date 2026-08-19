"""从照片里读出「在哪、什么时候」—— 小地图、地名、天气三个功能的数据源头。

优先走 Pillow 的 img.info["exif"]，因为 HEIC 的 EXIF 藏在容器里，
直接把整个文件丢给 piexif 是解不出来的（pillow-heif 会把它提取到 info 里）。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import piexif
from PIL import Image


def _load_exif(img: Image.Image, raw: bytes) -> dict | None:
    for source in (img.info.get("exif"), raw):
        if not source:
            continue
        try:
            return piexif.load(source)
        except Exception:
            continue
    return None


def _text(value) -> str | None:
    """EXIF 里的字符串是 bytes，且常带尾部 \\x00 和空格。"""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return None
    value = value.strip().strip("\x00").strip()
    return value or None


def _ratio(value) -> float | None:
    """EXIF 的分数写成 (分子, 分母)。"""
    try:
        num, den = value
        return num / den if den else None
    except Exception:
        return None


def _dms_to_degrees(dms, ref: str | None) -> float | None:
    """把 度/分/秒 三元组换算成十进制度数，南纬西经取负。"""
    try:
        d, m, s = (_ratio(x) for x in dms)
    except Exception:
        return None
    if d is None or m is None or s is None:
        return None
    deg = d + m / 60 + s / 3600
    return -deg if (ref or "").upper() in ("S", "W") else deg


def _parse_offset(text: str | None) -> timezone | None:
    """OffsetTimeOriginal 形如 "+09:00"，告诉我们拍摄时间是哪个时区的。"""
    if not text or len(text) < 6 or text[0] not in "+-":
        return None
    try:
        delta = timedelta(hours=int(text[1:3]), minutes=int(text[4:6]))
    except ValueError:
        return None
    return timezone(-delta if text[0] == "-" else delta)


def read_photo_context(img: Image.Image, raw: bytes) -> dict:
    """返回 {has_gps, lat, lon, altitude, taken_at, utc_offset, taken_at_utc, camera}。

    任何一项读不到就是 None —— 前端会让用户手填，而不是报错。
    """
    result: dict = {
        "has_gps": False,
        "lat": None,
        "lon": None,
        "altitude": None,
        "taken_at": None,
        "utc_offset": None,
        "taken_at_utc": None,
        "camera": None,
    }

    exif = _load_exif(img, raw)
    if not exif:
        return result

    gps = exif.get("GPS") or {}
    ifd0 = exif.get("0th") or {}
    sub = exif.get("Exif") or {}

    # ---- 坐标 ----
    lat = _dms_to_degrees(
        gps.get(piexif.GPSIFD.GPSLatitude), _text(gps.get(piexif.GPSIFD.GPSLatitudeRef))
    )
    lon = _dms_to_degrees(
        gps.get(piexif.GPSIFD.GPSLongitude), _text(gps.get(piexif.GPSIFD.GPSLongitudeRef))
    )
    # (0, 0) 落在几内亚湾公海，实际上是某些相机「没定位到」的占位值
    if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180:
        if not (abs(lat) < 1e-7 and abs(lon) < 1e-7):
            result.update(has_gps=True, lat=round(lat, 6), lon=round(lon, 6))

    alt = _ratio(gps.get(piexif.GPSIFD.GPSAltitude))
    if alt is not None:
        if gps.get(piexif.GPSIFD.GPSAltitudeRef) == 1:  # 1 = 海平面以下
            alt = -alt
        result["altitude"] = round(alt, 1)

    # ---- 拍摄时间 ----
    # DateTimeOriginal 是快门按下的本地时间，比 DateTime（可能是修改时间）更准
    shot = _text(sub.get(piexif.ExifIFD.DateTimeOriginal)) or _text(
        ifd0.get(piexif.ImageIFD.DateTime)
    )
    local_dt = None
    if shot:
        try:
            local_dt = datetime.strptime(shot[:19], "%Y:%m:%d %H:%M:%S")
            result["taken_at"] = local_dt.isoformat()
        except ValueError:
            pass

    offset_text = _text(sub.get(piexif.ExifIFD.OffsetTimeOriginal)) or _text(
        sub.get(piexif.ExifIFD.OffsetTime)
    )
    tz = _parse_offset(offset_text)
    if tz:
        result["utc_offset"] = offset_text

    # 查历史天气要的是 UTC 时刻。优先用 GPS 卫星授时（本身就是 UTC，最可靠），
    # 否则用本地时间 + 时区偏移换算。两者都没有就留空，等第 5 步按经度估。
    gps_date = _text(gps.get(piexif.GPSIFD.GPSDateStamp))
    gps_time = gps.get(piexif.GPSIFD.GPSTimeStamp)
    utc_dt = None
    if gps_date and gps_time:
        parts = [_ratio(x) for x in gps_time]
        if len(parts) == 3 and all(p is not None for p in parts):
            try:
                h, m, s = (int(p) for p in parts)
                utc_dt = datetime.strptime(gps_date[:10], "%Y:%m:%d").replace(
                    hour=h, minute=m, second=s, tzinfo=timezone.utc
                )
            except ValueError:
                utc_dt = None
    if utc_dt is None and local_dt is not None and tz is not None:
        utc_dt = local_dt.replace(tzinfo=tz).astimezone(timezone.utc)
    if utc_dt is not None:
        result["taken_at_utc"] = utc_dt.isoformat().replace("+00:00", "Z")

    # ---- 相机 ----
    make = _text(ifd0.get(piexif.ImageIFD.Make))
    model = _text(ifd0.get(piexif.ImageIFD.Model))
    if model and make and not model.lower().startswith(make.lower()):
        result["camera"] = f"{make} {model}"
    else:
        result["camera"] = model or make

    return result

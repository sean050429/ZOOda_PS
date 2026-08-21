"""查照片拍摄当时的天气。数据来自 Open-Meteo，不需要 API key。

实测 archive 接口能一直覆盖到昨天，所以主用它；只有当匹配到的那个小时
是空值时（最近几小时偶尔会缺）才退到 forecast 接口。

时间一律用照片的**本地**时间：Open-Meteo 传 timezone=auto 时返回的
就是当地时间，和 EXIF 里的 DateTimeOriginal 同一个口径，不用来回换算 UTC。
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

UA = "Zelda_PS/0.1 (personal photo UI overlay tool)"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"

# WMO 天气代码 → (中文, 图标标识)。
#
# 文字一律控制在 1~2 字：这条天气胶囊很窄，「冻毛毛雨」「雷阵雨伴冰雹」
# 这种四到六字的说法塞不进去，风格上也和游戏那种极简 HUD 不搭。
# 相近的强度合并到同一个说法（毛毛雨归入小雨、米雪归入小雪、
# 雷暴冰雹归入雷雨），但**图标标识保持细分** —— 图标画得出区别，
# 文字不必替它承担。
WMO: dict[int, tuple[str, str]] = {
    0: ("晴", "clear"),
    1: ("晴", "partly"),
    2: ("多云", "partly"),
    3: ("阴", "cloudy"),
    45: ("雾", "fog"),
    48: ("雾", "fog"),
    51: ("小雨", "drizzle"),
    53: ("小雨", "drizzle"),
    55: ("小雨", "drizzle"),
    56: ("冻雨", "drizzle"),
    57: ("冻雨", "drizzle"),
    61: ("小雨", "rain"),
    63: ("中雨", "rain"),
    65: ("大雨", "rain"),
    66: ("冻雨", "rain"),
    67: ("冻雨", "rain"),
    71: ("小雪", "snow"),
    73: ("中雪", "snow"),
    75: ("大雪", "snow"),
    77: ("小雪", "snow"),
    80: ("阵雨", "rain"),
    81: ("阵雨", "rain"),
    82: ("大雨", "rain"),
    85: ("阵雪", "snow"),
    86: ("大雪", "snow"),
    95: ("雷雨", "thunder"),
    96: ("雷雨", "thunder"),
    99: ("雷雨", "thunder"),
}


def describe(code: int | None) -> tuple[str, str]:
    if code is None:
        return ("未知", "unknown")
    return WMO.get(code, (f"天气代码 {code}", "unknown"))


def _cache_path(lat: float, lon: float, when: datetime) -> Path:
    # 约 1km 精度 + 精确到小时，同一张照片重复查直接命中
    key = f"{lat:.2f}_{lon:.2f}_{when:%Y%m%d%H}".replace("-", "m")
    return CACHE_DIR / f"weather_{key}.json"


def _query(url: str, lat: float, lon: float, day: str) -> dict | None:
    try:
        with httpx.Client(headers={"User-Agent": UA}, timeout=25) as c:
            r = c.get(url, params={
                "latitude": lat, "longitude": lon,
                "start_date": day, "end_date": day,
                "hourly": "temperature_2m,weather_code,is_day",
                "timezone": "auto",
            })
            if r.status_code != 200:
                return None
            return r.json()
    except Exception:
        return None


def _pick_hour(data: dict, when: datetime) -> tuple[float | None, int | None, int | None, str | None]:
    """取最接近拍摄时刻的那个整点。"""
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        return (None, None, None, None)

    target = when.strftime("%Y-%m-%dT%H:00")
    idx = times.index(target) if target in times else min(
        range(len(times)),
        key=lambda i: abs(datetime.fromisoformat(times[i]) - when),
    )

    def at(name):
        seq = hourly.get(name) or []
        return seq[idx] if idx < len(seq) else None

    return (at("temperature_2m"), at("weather_code"), at("is_day"), times[idx])


def fetch_weather(lat: float, lon: float, when: datetime) -> dict:
    """when 是照片的本地拍摄时间（EXIF 里的 DateTimeOriginal）。"""
    cached = _cache_path(lat, lon, when)
    if cached.exists():
        try:
            hit = json.loads(cached.read_text())
            # 文字按当前的措辞表重算，别用缓存里那份：
            # 否则改一次说法就得手动清缓存，很容易忘
            hit["text"], hit["icon"] = describe(hit.get("code"))
            return hit
        except Exception:
            pass

    day = when.strftime("%Y-%m-%d")
    result = {"ok": False, "temperature": None, "code": None, "text": None,
              "icon": None, "is_day": None, "time": None, "source": None,
              "error": None}

    for source, url in (("archive", ARCHIVE_URL), ("forecast", FORECAST_URL)):
        data = _query(url, lat, lon, day)
        if not data:
            continue
        temp, code, is_day, stamp = _pick_hour(data, when)
        if temp is None and code is None:
            continue  # 这个源该时刻没数据，换下一个
        text, icon = describe(code)
        result = {
            "ok": True,
            "temperature": round(temp, 1) if temp is not None else None,
            "code": code,
            "text": text,
            "icon": icon,
            "is_day": is_day,
            "time": stamp,
            "source": source,
            "error": None,
        }
        break
    else:
        result["error"] = "两个数据源都没返回可用数据"

    if result["ok"]:
        try:
            cached.write_text(json.dumps(result, ensure_ascii=False))
        except Exception:
            pass
    return result

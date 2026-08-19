"""地名解析：坐标 ⇄ 地名。全部走无 key 的公共服务。

分两条腿走，因为快的不准、准的不快：
  - Nominatim：几百毫秒回一个行政区名（港區、共和县），当兜底。
  - Overpass：能挖出真正的地标名（東京鐵塔、青海湖），但要 2~15 秒还会 429。

前端先拿 Nominatim 的结果把界面点亮，Overpass 在后台跑，出了更好的再替换。
"""

from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path

import httpx

CACHE_DIR = Path(__file__).resolve().parent.parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)

# Nominatim 的使用条款要求 UA 能标识出应用，匿名请求会被封
UA = "Zelda_PS/0.1 (personal photo UI overlay tool)"
NOMINATIM = "https://nominatim.openstreetmap.org"
OVERPASS = "https://overpass-api.de/api/interpreter"

# Nominatim 限 1 次/秒，这个锁保证并发上传时也不会超速
_nominatim_lock = threading.Lock()
_last_nominatim_call = 0.0


def _throttle() -> None:
    global _last_nominatim_call
    with _nominatim_lock:
        wait = 1.1 - (time.time() - _last_nominatim_call)
        if wait > 0:
            time.sleep(wait)
        _last_nominatim_call = time.time()


# ---------------- 磁盘缓存 ----------------

def _cache_path(kind: str, key: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in key)[:120]
    return CACHE_DIR / f"{kind}_{safe}.json"


def _cache_get(kind: str, key: str):
    p = _cache_path(kind, key)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return None


def _cache_put(kind: str, key: str, value) -> None:
    try:
        _cache_path(kind, key).write_text(json.dumps(value, ensure_ascii=False))
    except Exception:
        pass


def _coord_key(lat: float, lon: float) -> str:
    # 约 10m 精度，同一个地点的重复请求直接命中缓存
    return f"{lat:.4f}_{lon:.4f}"


# ---------------- Nominatim ----------------

def reverse_geocode(lat: float, lon: float) -> dict:
    """秒回一个能用的名字。zoom=14 是试出来的甜点：
    再大会返回街边随便一栋楼，再小就只剩省份了。"""
    key = _coord_key(lat, lon)
    hit = _cache_get("rev", key)
    if hit is not None:
        return hit

    result = {"name": None, "candidates": [], "display_name": None}
    try:
        _throttle()
        with httpx.Client(headers={"User-Agent": UA}, timeout=15) as c:
            r = c.get(f"{NOMINATIM}/reverse", params={
                "lat": lat, "lon": lon, "format": "jsonv2", "zoom": 14,
                "accept-language": "zh-CN,zh,en", "namedetails": 1,
                "addressdetails": 1,
            })
            r.raise_for_status()
            data = r.json()
    except Exception:
        return result

    addr = data.get("address") or {}
    names = data.get("namedetails") or {}
    cands: list[str] = []
    for v in (names.get("name:zh"), data.get("name")):
        if v:
            cands.append(v)
    for k in ("tourism", "attraction", "natural", "leisure", "neighbourhood",
              "suburb", "village", "town", "city_district", "city", "county", "state"):
        if addr.get(k):
            cands.append(addr[k])

    seen: set[str] = set()
    uniq = [x for x in cands if not (x in seen or seen.add(x))]
    result = {
        "name": uniq[0] if uniq else None,
        "candidates": uniq[:6],
        "display_name": data.get("display_name"),
    }
    _cache_put("rev", key, result)
    return result


def search_place(query: str, limit: int = 5) -> list[dict]:
    """地名 → 坐标。没有 GPS 的照片靠这个，实测中文地名命中率很高。"""
    key = f"{query}_{limit}"
    hit = _cache_get("search", key)
    if hit is not None:
        return hit

    try:
        _throttle()
        with httpx.Client(headers={"User-Agent": UA}, timeout=15) as c:
            r = c.get(f"{NOMINATIM}/search", params={
                "q": query, "format": "jsonv2", "limit": limit,
                "accept-language": "zh-CN,zh,en", "namedetails": 1,
            })
            r.raise_for_status()
            data = r.json()
    except Exception:
        return []

    hits = []
    for h in data:
        nd = h.get("namedetails") or {}
        hits.append({
            "name": nd.get("name:zh") or h.get("name") or h["display_name"].split(",")[0],
            "display_name": h.get("display_name"),
            "lat": float(h["lat"]),
            "lon": float(h["lon"]),
        })
    _cache_put("search", key, hits)
    return hits


# ---------------- Overpass ----------------

# 「像不像一个值得写在地图上的名字」的打分表。
# 试出来的：清水寺那里最近的是 8m 外的「本堂」，但 71m 外的「清水寺」才是要的答案，
# 所以标签类型必须压过距离。
_TAG_SCORE: dict[tuple[str, str], int] = {
    ("tourism", "attraction"): 100,
    ("natural", "peak"): 98, ("natural", "volcano"): 98,
    ("natural", "water"): 95, ("natural", "glacier"): 95,
    ("natural", "beach"): 92, ("natural", "bay"): 86, ("natural", "cape"): 86,
    ("tourism", "viewpoint"): 88,
    ("man_made", "lighthouse"): 86, ("man_made", "tower"): 82,
    ("historic", "*"): 80,
    ("leisure", "nature_reserve"): 78, ("leisure", "park"): 74,
    ("man_made", "bridge"): 70,
    ("tourism", "museum"): 60, ("tourism", "gallery"): 55,
    ("waterway", "waterfall"): 94, ("waterway", "*"): 50,
    ("tourism", "hotel"): 8, ("tourism", "guest_house"): 5,
    ("man_made", "survey_point"): 15,
}

# 行政区划不算「地标」，那是 Nominatim 兜底的活儿
_SKIP_KEYS = ("boundary", "admin_level")

_TYPE_BONUS = {"relation": 12, "way": 6, "node": 0}


def _score(tags: dict, elem_type: str, dist_m: float | None) -> tuple[int, str] | None:
    if any(k in tags for k in _SKIP_KEYS):
        return None
    best = None
    for key in ("tourism", "natural", "historic", "man_made", "leisure", "waterway"):
        if key not in tags:
            continue
        s = _TAG_SCORE.get((key, tags[key])) or _TAG_SCORE.get((key, "*"))
        if s is None:
            s = 40  # 有这类标签但不在表里，给个中等分
        if best is None or s > best[0]:
            best = (s, f"{key}={tags[key]}")
    if best is None:
        return None

    score = best[0] + _TYPE_BONUS.get(elem_type, 0)
    if dist_m is not None:
        score -= dist_m / 100.0  # 1km 扣 10 分，压不过标签差距
    return int(score), best[1]


def _distance(lat: float, lon: float, el: dict) -> float | None:
    ctr = el.get("center") or el
    if ctr.get("lat") is None:
        return None
    dx = (ctr["lon"] - lon) * math.cos(math.radians(lat)) * 111320
    dy = (ctr["lat"] - lat) * 111320
    return math.hypot(dx, dy)


def _overpass(client: httpx.Client, query: str) -> list[dict]:
    """Overpass 是公共免费服务，429 和 504 都很常见，必须重试。"""
    last = "未知错误"
    for attempt in range(3):
        try:
            r = client.post(OVERPASS, data={"data": query})
        except Exception as e:
            last = f"{type(e).__name__}"
            time.sleep(5 * (attempt + 1))
            continue
        if r.status_code == 429 or r.status_code >= 500:
            last = f"HTTP {r.status_code}"
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json().get("elements", [])
    raise RuntimeError(f"Overpass 连续失败（{last}）")


def find_landmark(lat: float, lon: float, radius: int = 1200) -> dict:
    """挖附近的知名地标。慢（2~15 秒）且可能失败，调用方要当成锦上添花。

    两路合并：
      around —— 附近带 wikidata 的地标（东京塔、清水寺这类）
      is_in  —— 把这个点包住的区域（青海湖、西湖这类巨型面要素，中心点离得很远）

    注意 out 千万不能加条数上限：Overpass 按 node→way→relation 排序返回，
    大地标基本都是 relation，加了上限会被整段截掉（第一版就栽在这里）。
    """
    key = _coord_key(lat, lon)
    hit = _cache_get("landmark", key)
    if hit is not None:
        return hit

    around = "".join(
        f'nwr(around:{radius},{lat},{lon})["wikidata"]["{k}"]["name"];'
        for k in ("tourism", "historic", "natural", "man_made", "leisure", "waterway")
    )
    # around 和 is_in 合并成一次请求 —— 连着发两次几乎必吃 429。
    # is_in 的结果 type 是 "area"，回来还能区分开。
    query = f"[out:json][timeout:60];({around}is_in({lat},{lon}););out center tags;"

    scored: list[tuple[int, str, str, float | None]] = []
    try:
        with httpx.Client(headers={"User-Agent": UA}, timeout=90) as c:
            for el in _overpass(c, query):
                tags = el.get("tags") or {}
                name = tags.get("name:zh") or tags.get("name")
                if not name:
                    continue
                elem_type = el.get("type", "node")
                is_area = elem_type == "area"
                dist = None if is_area else _distance(lat, lon, el)
                if not is_area and dist is None:
                    continue
                got = _score(tags, elem_type, dist)
                if got:
                    scored.append((got[0], name, got[1], dist))
    except Exception as e:
        # 别装作「这里没有地标」—— 前端要能分辨「查失败了」和「真的没有」
        return {"name": None, "candidates": [], "ok": False, "error": str(e)}

    scored.sort(key=lambda t: -t[0])
    seen: set[str] = set()
    cands = []
    for score, name, kind, dist in scored:
        if name in seen:
            continue
        seen.add(name)
        cands.append({"name": name, "kind": kind, "score": score,
                      "distance_m": round(dist) if dist is not None else None})
        if len(cands) >= 6:
            break

    result = {"name": cands[0]["name"] if cands else None,
              "candidates": cands, "ok": True, "error": None}
    _cache_put("landmark", key, result)
    return result

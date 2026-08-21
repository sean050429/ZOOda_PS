"""把 Noto Serif SC 抓到本地，让标题不再依赖系统字体。

原来用的是 macOS 自带的 Songti SC：换平台就没有，也不能随程序分发。
Noto Serif SC 是 SIL OFL 协议，可自由分发。

抓的是 Google Fonts 切好的 woff2 分片而不是整份字体文件：中文字体一份
十几兆，而分片按 Unicode 区段切开，浏览器只会下载用到的那几片。
下载后 CSS 里的地址会改写成本地路径，之后完全离线可用。

跑法：./.venv/bin/python scripts/fetch_font.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import httpx

FAMILY = "Noto Serif SC"
WEIGHTS = "600"          # 标题用的字重，只抓这一个
OUT_DIR = Path(__file__).resolve().parent.parent / "app" / "static" / "fonts"

# 必须报一个支持 woff2 的浏览器 UA，否则 Google 会回退到体积大得多的 ttf
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    css_url = ("https://fonts.googleapis.com/css2"
               f"?family={FAMILY.replace(' ', '+')}:wght@{WEIGHTS}&display=swap")

    with httpx.Client(headers={"User-Agent": UA}, timeout=60,
                      follow_redirects=True) as c:
        print(f"取样式表 {css_url}")
        r = c.get(css_url)
        r.raise_for_status()
        css = r.text

        urls = re.findall(r"url\((https://[^)]+\.woff2)\)", css)
        uniq = list(dict.fromkeys(urls))
        print(f"共 {len(uniq)} 个分片，开始下载")

        total = 0
        for i, url in enumerate(uniq, 1):
            name = url.rsplit("/", 1)[-1]
            dest = OUT_DIR / name
            if dest.exists():
                css = css.replace(url, f"/fonts/{name}")
                total += dest.stat().st_size
                continue
            resp = c.get(url)
            resp.raise_for_status()
            dest.write_bytes(resp.content)
            total += len(resp.content)
            css = css.replace(url, f"/fonts/{name}")
            if i % 20 == 0 or i == len(uniq):
                print(f"  {i}/{len(uniq)}  累计 {total/1024:.0f} KB")

    (OUT_DIR / "noto-serif-sc.css").write_text(css, encoding="utf-8")
    print(f"\n完成：{len(uniq)} 个分片，合计 {total/1024/1024:.2f} MB")
    print(f"输出目录 {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概况

给照片叠一套《旷野之息》风格的 HUD（小地图、地名标题、天气、血条、希卡圆盘），导出成原分辨率 PNG。本机跑 FastAPI 服务，用浏览器打开。外部数据源全部不需要 API key。

## 常用命令

需要 Python 3.10+（`main.py` 启动时会检查）。

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python scripts/fetch_font.py   # 可选：把 Noto Serif SC 抓到 app/static/fonts/
./.venv/bin/uvicorn app.main:app --reload --reload-dir app --port 8000
```

- `--reload-dir app` 不能省。小地图每次渲染都往 `cache/tiles/` 写瓦片，不限定目录的话，服务会被自己的缓存写入反复重启。
- 没有测试、lint 或构建步骤。前端是原生 ES module，改完刷新即可；`main.py` 的中间件给前端静态文件加了 `no-store`，不会吃到旧缓存。
- 验证就是起服务实际跑一遍：上传照片 → 看预览 → 导出。`.claude/launch.json` 里的 `zelda-ps` 配置对应 8000 端口。

## 架构

### 后端（`app/`）

`main.py` 只放路由，逻辑在四个模块里：

- `exif_reader.py`：读 GPS、拍摄时间、时区。HEIC 的 EXIF 要从 Pillow 的 `img.info["exif"]` 里取，把原文件直接交给 piexif 解不出来。
- `geo.py`：地名解析分两路。Nominatim 几百毫秒就能返回行政区名，先用它把界面点亮；Overpass 要 2~15 秒才能挖出地标名，还经常 429，失败时要明确返回 `ok: false`。Nominatim 限 1 次/秒，请求必须带 UA。
- `weather.py`：查 Open-Meteo 的历史实况。主用 archive 接口，只有匹配到的那个小时是空值时才退到 forecast。时间一律用照片的**本地**时间（`timezone=auto`），不转 UTC。
- `minimap.py`：拼 Carto `voyager_nolabels` 瓦片，调色，加圆形边框。

上传时保留原图，另存一张最长边 2000px 的 `preview.jpg` 给前端显示。导出用的底图来自 `/api/full/{id}`，是按 EXIF 方向转正的全尺寸 JPEG。地名、天气、瓦片都缓存在 `cache/`。

坐标一律用 WGS-84，与 EXIF 一致，不做 GCJ-02 转换。

### 前端（`app/static/`）

`app.js` 是控制器：修改 `hudState`（`hud.js`）和 `mapState`（`minimap.js`）里的字段，再调 `renderHud()` / `refreshMap()` 重画。

**HUD 布局**来自 `ui_layout.json`，记录每个元件在 1920×1080 游戏截图上的像素框和锚点。缩放系数只看照片宽度（`照片宽 / 1920`）；`top-left` 组锚左上角，`bottom-right` 组锚右下角，所以任何长宽比都不会变形。这份文件是坐标数据，随程序发布。布局里有一部分元件要换成程序自己生成的内容（小地图、血条、时间、天气等），这些列在 `hud.js` 的 `REPLACED` 里，不按布局加载素材。

**小地图分两层**。底图由服务端生成，只跟坐标有关，比较慢；中心箭头只跟朝向有关，在前端 canvas 上同步画，所以拖朝向滑块不发请求。箭头的比例常量 `MARKER_P_RATIO` / `MARKER_STROKE_RATIO` 在 `minimap.py` 和 `minimap.js` 里各写了一份，改的时候两边要同步。改了覆盖范围的算法，要把 `minimap.js` 里的 `MAP_VER` 加 1，否则浏览器还会用 24 小时缓存里的旧图。

### 改视觉时要顾到的四个组合

**两条渲染路径**，代码不共用：

| 预览（DOM） | 导出（canvas） |
|---|---|
| `renderHud` | `drawHudOnCanvas` |
| `renderTempDial` | `drawDial` |
| `renderHearts` / `renderClock` / `renderWeather` / `renderBanner` | `drawHeartsOn` / `drawClockOn` / `drawWeatherOn` / `drawBannerOn` |
| `blackenedDisk` | `blackenDiskToCanvas` |

`exporter.js` 先画小地图再画 HUD，和预览的叠放顺序一致。

**两种模式**，由 `hudState.useOriginal` 切换：

- **重绘**（默认）：所有元件都是代码画的。`drawerFor()` 先查 `hud.js` 的 `EXTRA_DRAWN`（温度盘、指北条），再查 `icons.js` 的 `ICONS`。完全不读 `ui_source/`。
- **原版**：从 `/ui_source/` 加载游戏抠图。三个圆盘会经过 `blackenInPlace` 压成黑底，其中感应器和声音盘换成 `ACTIVE_DISKS` 里的激活状态素材。温度指针和读数这类会动的部分，两种模式下都由代码叠画。

只改 `icons.js` 里的常量，只会影响重绘模式。原版模式的像素来自素材，要改色得在压黑之后处理，可以参考 `tintInPlace`。四个黑底栏位共用的蓝色是 `icons.js` 里的 `HUD_ACCENT`。

## 不进仓库的本地目录

下面这些被 `.gitignore` 挡掉了，所以 worktree 和干净克隆里都没有：

- `ui_source/`：从游戏截图抠出来的元件，属于任天堂的版权素材。没有这个目录时原版模式跑不了：`app.js` 会探测到并禁用切换按钮，`main.py` 也不会挂载 `/ui_source`。
- `test/`：真实测试照片，EXIF 里带精确 GPS 和拍摄时间，属于个人行程数据。**不要拿来做测试、截图，也不要放进任何输出。** 需要测试图时现造一张。
- `uploads/`、`cache/`、`app/static/fonts/`：运行时生成。

要在 worktree 里测原版模式，可以把主工作树的 `ui_source/` 软链过来。注意 `.gitignore` 里的 `ui_source/` 带斜杠，只匹配目录，软链不会被忽略，提交前要删掉。

## 约定

- 不引入 Node，也不引入任何前端构建链。
- 代码注释、提交信息、PR 描述都用中文。注释写「为什么这么做、之前试过什么不行」，不复述代码本身在做什么。
- 分支前缀用 `feat/`、`fix/`、`docs/`、`chore/`，PR 以 merge commit 方式合并。

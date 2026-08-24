# Zelda_PS

给照片叠上《塞尔达传说：旷野之息》风格的 UI —— 小地图、地名标题、天气状态栏、心心血条。

程序跑在本机，界面用浏览器打开。**不需要任何 API key。**

![状态](https://img.shields.io/badge/状态-开发中-orange) ![Python](https://img.shields.io/badge/Python-3.14-blue) ![API%20Key](https://img.shields.io/badge/API%20Key-零-brightgreen)

---

## 现在能做什么

上传一张照片，程序读出拍摄地点，在照片上叠一整套旷野之息风格的 HUD：左上是心心血条与装备槽，右下是希卡圆盘、拍摄时间、天气条和一张按当地地图生成的圆形小地图。天气和温度是照片拍摄那一刻的真实实况，不是当前天气。

两条路径都通：

- **照片自带 GPS** —— 拖进去，坐标、地名、拍摄时间自动填好，HUD 直接出现。改到别处之后可以用「回到照片位置」退回
- **照片没有 GPS** —— 搜索地名（「稻城亚丁」「西湖」），或者直接手填经纬度

坐标可以按东南西北 + 米数微调，界面上会显示当前离照片原始位置有多远。

可调项：HUD 整体大小、心心总数与剩余数、小地图的地理范围/色阶/配色/箭头朝向/箭头大小、地名文字、时间文字、天气文字。天气查到之后会自动填入，也可以手改。

HUD 各元件的位置跟随游戏原作布局，不单独调整 —— 坐标按 `照片宽 / 1920` 缩放，左上组锚左上角、右下组锚右下角，所以任何长宽比的照片都不会变形或跑出画面。

---

## 快速开始

需要 Python 3.10 以上（代码用了 `X | None` 联合类型语法）。版本不够时
启动会直接报出版本问题，不会给一个看不懂的 SyntaxError。

### macOS / Linux

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python scripts/fetch_font.py     # 抓地名标题用的字体，约 3 MB
./.venv/bin/uvicorn app.main:app --reload --reload-dir app --port 8000
```

### Windows（PowerShell）

```powershell
py -3 -m venv .venv
.\.venv\Scripts\pip.exe install -r requirements.txt
.\.venv\Scripts\python.exe scripts\fetch_font.py
.\.venv\Scripts\uvicorn.exe app.main:app --reload --reload-dir app --port 8000
```

直接调 `.venv\Scripts\` 下的可执行文件，不用 `activate`，因此不受
PowerShell 执行策略限制。`py -3` 换成 `python` 也可以，前提是它指向
Python 3。

> Windows 这套命令是按依赖情况推导的，**没有在 Windows 机器上实跑过**。
> 已核对的部分：代码里没有平台相关写法或写死的 unix 路径；
> `pillow-heif` 有 `win_amd64` / `win_arm64` 轮子；
> `uvicorn[standard]` 里的 `uvloop` 带 `sys_platform != "win32"` 标记，
> pip 会自动跳过，不会导致安装失败。

抓字体这步可以跳过 —— 跳了标题会退回系统自带的衬线字体，功能不受影响，
只是换机器时字形会不一致。Windows 上没有 Songti SC，跳过的话会退到系统
的中文衬线字体，字形差异更明显，建议别跳。

### 两点要注意

**`--reload-dir app` 不要省。** 不加的话 uvicorn 会盯着整个项目目录，
而每渲染一次小地图都会往 `cache/tiles/` 写瓦片，服务就会被自己的
缓存写入反复重启，表现为请求中途断掉。

**这条命令要一直开着。** 它是前台进程，关掉终端窗口服务就停了。

---

服务起来后打开 <http://localhost:8000>。界面是左右两栏：左边只放照片，
所有调节控件都在右边；窗口窄于 1180px 时自动改成上下排列。

首次生成小地图需要 3~6 秒下载地图瓦片，之后同一区域走本地缓存，约 0.1 秒。

### 打不开怎么办

浏览器报「localhost 拒绝了请求」（`ERR_CONNECTION_REFUSED`）只有一个
含义：那个端口上没有程序在监听，也就是服务没跑起来或者已经退出了。
先确认端口状态：

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

Windows 用：

```powershell
netstat -ano | findstr :8000
```

没有输出就是服务没在跑，重新执行上面的启动命令即可。有输出但页面仍打不开，
才需要往端口冲突或代码报错的方向查 —— 这时看启动命令那个终端窗口的输出。

---

## 进度

### 已完成

| # | 功能 | 说明 |
|---|---|---|
| 1 | 项目骨架 | FastAPI 服务 + 原生 HTML 界面，照片上传与预览 |
| 2 | EXIF 解析 | 读 GPS 坐标、拍摄时间、时区、海拔、相机型号；支持 HEIC |
| 3 | 地名解析 | 坐标 → 地名（双轨：行政区名秒回 + 地标名后台补齐）；地名 → 坐标搜索 |
| 4 | 小地图 | 圆形小地图，做旧调色，可调地理范围、色阶、配色、箭头朝向与大小 |
| 5 | HUD 布局 | 整套 HUD 按游戏原作位置摆放：血条、符文、装备槽在左上，希卡圆盘、时间、天气、小地图在右下。整体大小与心心数量可调 |
| 6 | 天气 | 按坐标 + 拍摄时间查 Open-Meteo 的历史实况。天气写在右下的近黑胶囊里（蓝字，无辉光），温度走希卡石板的温度计模块：指针按温度旋转，读数写在盘心 |
| 7 | 地名标题 | 摆在左下角的宋体白字，文字取自地名字段。可开关，大小与左边距、垂直位置都可调，过长时自动收字号避免跑出画面 |
| 8 | 一键导出 | 按原图分辨率把照片和整套 HUD 合成一张 PNG。预览走 DOM、导出走画布，两条路径共用同一份位置与配色常量 |
| 9 | 可分发字体 | 标题改用 Noto Serif SC（SIL OFL）。由 `scripts/fetch_font.py` 抓成本地 woff2 分片，之后完全离线，不再依赖系统字体 |

> 布局数据（各元件在 1920x1080 参考图上的位置）随程序发布，见
> `app/static/ui_layout.json`。默认的重绘模式只需要它，不需要 `ui_source/`。

### 待完成

| # | 功能 | 说明 |
|---|---|---|
| 9 | **天气图标** | 天气目前是文字。原作那条胶囊是三格预报图标，要画成 SVG。`weather.py` 已经把 WMO 代码归类成 clear / partly / cloudy / fog / drizzle / rain / snow / thunder 八种，直接对应图标即可 |

| 11 | **其他游戏模版** | 文档里的拓展功能，架构上预留 |

### 素材来源

**默认的重绘模式不需要 `ui_source/`** —— 每个元件都有代码里的自绘实现，配色是从原件采样得到的；元件的位置尺寸来自 `app/static/ui_layout.json`，那是随程序走的坐标数据。

面板上可以切到「原版」对照，那需要本地有 `ui_source/`；没有时按钮会自动禁用。

原版素材放在 `ui_source/`（已 gitignore），由 `ui_layout.json` 描述每个元件在 1920x1080 参考图上的像素位置与锚点分组。其中标注了 `svg` 的是矢量重绘版本，可用于成品；只有 `png` 的是游戏截图直接抠图，**仅供本地对照排版**。

小地图的箭头形状与配色取自 `Zelda_photo` 项目的 botw 主题（`themes/botw/theme.json` 的 `slots.minimap.pin`）。

---

## 技术选型

**后端 Python + 前端原生 HTML/JS，不引入 Node。** 前端没有构建步骤，改完刷新即可。

**全部数据源无需 API key：**

| 用途 | 服务 | 说明 |
|---|---|---|
| 地图瓦片 | [Carto](https://carto.com/basemaps) `voyager_nolabels` | 无文字标注版本。地名要用我们自己的字体画，底图自带的标注是抠不掉的干扰 |
| 坐标 ⇄ 地名 | [Nominatim](https://nominatim.org/) | OpenStreetMap 官方，限 1 次/秒 |
| 地标名 | [Overpass API](https://overpass-api.de/) | 挖掘附近的知名地标 |
| 天气 | [Open-Meteo](https://open-meteo.com/) | 历史实况可回溯到 1940 年，无需 key 也无需信用卡 |

坐标一律用 WGS-84，与 EXIF 一致，不做 GCJ-02 偏移转换。

---

## 项目结构

```
app/
  main.py          FastAPI 入口与路由
  exif_reader.py   从照片读「在哪、什么时候」
  geo.py           地名解析（Nominatim + Overpass）
  weather.py       查拍摄当时的天气（Open-Meteo）
  minimap.py       瓦片抓取、拼接、做旧调色、圆形边框、玩家箭头
  static/
    index.html
    style.css
    app.js         主逻辑：上传、地点、各面板控制
    hud.js         按 ui_layout.json 摆放整套 HUD
    minimap.js     照片上的小地图部件（底图 img + 箭头 canvas 两层）
    exporter.js    一键导出：原图分辨率合成 PNG
ui_source/         HUD 元件与 ui_layout.json（gitignore，含游戏素材）
    fonts/         Noto Serif SC 的 woff2 分片（gitignore，由脚本抓取）
scripts/
  fetch_font.py    抓取地名标题用的字体
uploads/           上传的照片（gitignore）
cache/             瓦片与地名缓存（gitignore）
```

小地图刻意拆成两层：**底图**只跟坐标有关，要走网络、拼瓦片、做调色，慢；**箭头**只跟朝向有关，放在前端 canvas 上同步画。所以拖朝向和箭头大小滑块是即时的，一次请求都不发。服务端保留了同一套箭头绘制逻辑，供第 9 步导出时按原图分辨率重画。

### API

| 接口 | 说明 |
|---|---|
| `POST /api/upload` | 上传照片，返回 EXIF 解析结果与预览图地址 |
| `GET /api/place?lat=&lon=` | 快速反查行政区名（数百毫秒） |
| `GET /api/landmark?lat=&lon=` | 反查知名地标名（2~15 秒，可能失败） |
| `GET /api/search?q=` | 地名搜索，返回坐标 |
| `GET /api/weather?lat=&lon=&at=` | 查该时刻的天气与温度（`at` 是照片的本地拍摄时间） |
| `GET /api/full/{id}` | 按原图分辨率取一张转正后的 JPEG，导出时打底 |
| `GET /api/palettes` | 小地图可选配色列表 |
| `GET /api/minimap?lat=&lon=&zoom=&size=&palette=&posterize=` | 生成小地图底图 PNG（不含箭头） |

## 已知限制

- **Overpass 不稳定。** 免费公共服务，429 和超时很常见。失败时会明确返回 `ok: false` 而非假装「这里没有地标」，前端退回到行政区名。同一坐标成功查询一次后写入缓存。
- **日本的中文地名不全。** 地标级别没问题（東京鐵塔、清水寺），但街区级别 OSM 缺 `name:zh`，会返回罗马字如 `Shibakōen 4`，需要手动改。
- **地名自动解析不保证准确。** 「最有名」不是一个几何属性，任何自动方法都有失手的时候。地名字段始终可以手动编辑。
- **HUD 里还有 4 个游戏抠图。** 三个希卡圆盘和指北条目前直接用游戏截图裁出来的 PNG，仅供本地对照排版；仓库不包含这些文件（`ui_source/` 已 gitignore）。成品发布前必须重绘，见待完成第 8 项。
- **只在 macOS 上实机验证过。** 干净克隆下起服务、上传照片、生成 HUD、导出成品的完整流程实测通过。Windows 和 Linux 没有实机跑过 —— 已核对的部分：全部依赖都有对应平台的轮子，代码无平台相关写法，前端 113 条静态引用的大小写与真实文件名逐条一致（Linux 区分大小写）。
- **字体在非 macOS 上会退化。** 没跑 `scripts/fetch_font.py` 时，标题会退回系统衬线字体；macOS 有 Songti SC，其他系统会退到各自的默认中文衬线，字形不同但不报错。
- **天气是文字占位。** 右下角的天气条现在只是可手改的文本，还没接真实数据。

---

## 数据来源与署名

地图数据 © [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者，底图样式由 [CARTO](https://carto.com/attributions) 提供。

地名标题使用 [Noto Serif SC](https://fonts.google.com/noto/specimen/Noto+Serif+SC)，SIL Open Font License 1.1。

本项目与任天堂无关。《塞尔达传说》为任天堂的商标。项目的目标是模仿视觉风格，不分发游戏的任何素材、字体或商标 —— 仓库中不包含任何游戏素材。

需要说明的是，开发过程中会用一张游戏截图作为排版参照，从中裁出的元件放在本地的 `ui_source/` 目录（已 gitignore，不会进入版本控制）。默认的重绘模式下不加载其中任何文件；只有手动切到「原版」对照时才会用到。

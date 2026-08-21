/* 按原作布局摆放整套 HUD。
 *
 * ui_layout.json 里的坐标全是相对 1920×1080 截图的像素值。照片什么尺寸都有，
 * 所以换算规则是：
 *   - 缩放系数只取决于照片宽度（scale = 照片宽 / 1920），这样 HUD 自身的
 *     长宽比不会被照片的长宽比拉变形；
 *   - top_left 组按左上角定位，bottom_right 组按右下角定位。
 *     照片比 16:9 更方时，两组会自动往中间靠，不会跑到画面外。
 */

const CANVAS_W = 1920;
const CANVAS_H = 1080;

const overlay = document.getElementById('overlay');
const stage = document.getElementById('stage');

export const hudState = {
  enabled: true,
  scale: 1,          // 用户额外的整体缩放
  hearts: 12,
  heartsFull: 11,
  weatherText: '晴',  // 只放天气，温度走温度表盘
  clockText: '13:35',
  temperature: null, // 摄氏度，null 表示还没查到

  bannerOn: true,
  bannerText: '',
  bannerScale: 1,
  // 左下角。X 是左边缘位置，不是中心 —— 4% 与左上角那组 HUD 的左边距对齐
  // （原作 top_left 组 bbox 从 x=76 起，76/1920 ≈ 0.0396）
  bannerX: 0.04,
  bannerY: 0.88,
};

let layout = null;
let root = null;
// 这些用我们自己的内容替换，不摆游戏原图
const REPLACED = new Set([
  'minimap',              // 换成我们生成的小地图
  'hearts_row',           // 按用户设定的数量重新拼
  'heart_full', 'heart_empty',
  'clock_text',           // 换成照片的拍摄时间
  // 原件的胶囊图里烤死了三个天气图标，直接渲染会和文字叠在一起，
  // 所以底框用 CSS 重画（颜色取自原件），只保留胶囊本身
  'weather_bar',
  'weather_icon_now', 'weather_icon_next', 'weather_icon_last',
  'weather_marker',
  'minimap_player_arrow',   // 我们生成的小地图自带中心指针，会撞
  'minimap_marker_shrine',  // 神庙标记是游戏专有的，照片上没有意义
]);

export async function loadLayout() {
  if (layout) return layout;
  const r = await fetch('/ui_source/ui_layout.json');
  if (!r.ok) throw new Error('读不到 ui_layout.json');
  layout = await r.json();
  return layout;
}

function ensureRoot() {
  if (root) return root;
  root = document.createElement('div');
  root.className = 'hud';
  overlay.appendChild(root);
  return root;
}

/** 元件在照片上的位置和尺寸（CSS px）。 */
function place(box, anchor, scale) {
  const w = box.w * scale;
  const h = box.h * scale;
  if (anchor === 'bottom-right') {
    return {
      right: (CANVAS_W - (box.x + box.w)) * scale,
      bottom: (CANVAS_H - (box.y + box.h)) * scale,
      w, h,
    };
  }
  return { left: box.x * scale, top: box.y * scale, w, h };
}

function styleFor(pos) {
  const s = { width: `${pos.w}px`, height: `${pos.h}px` };
  if (pos.left !== undefined) { s.left = `${pos.left}px`; s.top = `${pos.top}px`; }
  else { s.right = `${pos.right}px`; s.bottom = `${pos.bottom}px`; }
  return s;
}

function applyStyle(node, pos) {
  Object.assign(node.style, styleFor(pos));
}

export function renderHud() {
  if (!layout) return;
  ensureRoot();
  root.hidden = !hudState.enabled;
  if (!hudState.enabled) return;

  const scale = (stage.clientWidth / CANVAS_W) * hudState.scale;
  root.innerHTML = '';

  for (const el of layout.elements) {
    if (REPLACED.has(el.id)) continue;
    // dpad 已经有整簇的图，四个方向键会重复叠上去
    if (el.id.startsWith('dpad_') && el.id !== 'dpad_cluster') continue;

    const src = el.assets?.png_x8 || el.assets?.png;
    if (!src) continue;

    const pos = place(el.box, el.anchor, scale);
    if (el.id.startsWith('disk_')) {
      root.appendChild(blackenedDisk(`/ui_source/${src}`, pos, el.name || el.id));
      continue;
    }

    const img = document.createElement('img');
    img.className = 'hud-item';
    img.src = `/ui_source/${src}`;
    img.alt = el.name || el.id;
    applyStyle(img, pos);
    root.appendChild(img);
  }

  renderBanner(scale);
  renderHearts(scale);
  renderClock(scale);
  renderWeather(scale);
  renderTempDial(scale);
}

/* ---------------- 地名标题 ---------------- */

// ui_layout.json 里没有这个元件 —— 参考截图拍的时候没在进入新区域，
// 画面上自然没有标题。规格改用参考主题的 slots.banner：
// anchor [0.5, 0.135]、fontSize 34、letterSpacing 6，基于 1440x810，
// 换算到我们的 1920x1080 要乘 1.3333。
const BANNER_REF_W = 1440;
const BANNER_FONT = 34;
const BANNER_TRACKING = 6;

function renderBanner(scale) {
  if (!hudState.bannerOn) return;
  const text = (hudState.bannerText || '').trim();
  if (!text) return;

  // scale 是「照片宽 / 1920 × 用户缩放」，这里的字号基于 1440，先补上比值
  const k = scale * (CANVAS_W / BANNER_REF_W) * hudState.bannerScale;

  const node = document.createElement('div');
  node.className = 'hud-banner';
  node.textContent = text;
  node.style.left = `${hudState.bannerX * stage.clientWidth}px`;
  node.style.top = `${hudState.bannerY * stage.clientHeight}px`;
  node.style.fontSize = `${BANNER_FONT * k}px`;
  node.style.letterSpacing = `${BANNER_TRACKING * k}px`;
  // 字间距会在最后一个字右边也留一份，不补掉的话看起来偏左
  node.style.textIndent = `${BANNER_TRACKING * k}px`;
  root.appendChild(node);

  // 长地名配大字号会横着跑出画面（「稻城亚丁国家级自然保护区」在 200%
  // 时宽度到 108%）。这里量一次实际宽度，超了就等比缩，字号和字间距
  // 一起缩，字距比例才不会走样。
  // 上限按左边缘右侧的剩余宽度算，不是整幅宽度 —— 靠右摆时可用空间更少。
  const limit = stage.clientWidth * (1 - hudState.bannerX) * 0.94;
  const actual = node.getBoundingClientRect().width;
  if (actual > limit) {
    const shrink = limit / actual;
    node.style.fontSize = `${BANNER_FONT * k * shrink}px`;
    node.style.letterSpacing = `${BANNER_TRACKING * k * shrink}px`;
    node.style.textIndent = `${BANNER_TRACKING * k * shrink}px`;
  }
}

/* ---------------- 希卡圆盘改黑底 ---------------- */

// 原件的圆盘底色是蓝灰（#3C5A64 一带），和黑底的天气胶囊放一起不统一。
//
// 做法是「减去盘底主色，再把剩下的反差放大」，而不是「压黑底、保留图标」。
// 后者试过两版都不行：感应器那个盘的图标和底色在原件里本来就几乎同色
// （色距只有 20 上下），任何按亮度或按色距的阈值都会把图标一起吃掉。
// 减背景则是保住**相对**反差，底色自然归零，图标该多明显还多明显。
// 主色在运行时按量化直方图统计，不写死。
const DISK_GAIN = 2.2;              // 反差增益
const DISK_FLOOR = [10, 12, 14];    // 垫一点底，让盘面在暗照片上仍是个圆

function dominantColor(d) {
  const bins = new Map();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 200) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  let best = 0, bestKey = 0;
  for (const [k, n] of bins) if (n > best) { best = n; bestKey = k; }
  return [((bestKey >> 8) & 15) * 16 + 8,
          ((bestKey >> 4) & 15) * 16 + 8,
          (bestKey & 15) * 16 + 8];
}

function blackenedDisk(src, pos, alt) {
  const cv = document.createElement('canvas');
  cv.className = 'hud-item';
  cv.title = alt;
  applyStyle(cv, pos);

  const img = new Image();
  img.onload = () => {
    const px = Math.max(24, Math.round(pos.w * (window.devicePixelRatio || 1)));
    cv.width = px;
    cv.height = px;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, px, px);

    const data = ctx.getImageData(0, 0, px, px);
    const d = data.data;
    const bg = dominantColor(d);

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      for (let k = 0; k < 3; k++) {
        const v = (d[i + k] - bg[k]) * DISK_GAIN + DISK_FLOOR[k];
        d[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    ctx.putImageData(data, 0, 0);
  };
  img.src = src;
  return cv;
}

/* ---------------- 温度表盘 ---------------- */

// 盘面直接用游戏原件（外圈 12 段刻度、配色、外框全部保留），
// 只重画会动的部分：盖掉原件里那根固定朝上的指针，换成按温度旋转的，
// 并在下方写出读数。两个颜色都是从原件里采样出来的。
const DIAL_INNER = 'rgb(10,12,14)';  // 与压黑后的盘底一致，用来遮住原指针
const DIAL_NEEDLE = '#88F0F8';  // 原件的指针与文字色

// 实测范围：南极 -50.9°C、撒哈拉 36.3°C。映射到 ±110 度指针摆幅。
const DIAL_MIN = -20;
const DIAL_MAX = 45;
const DIAL_SWEEP = 110;

function tempToAngle(t) {
  const mid = (DIAL_MIN + DIAL_MAX) / 2;
  const half = (DIAL_MAX - DIAL_MIN) / 2;
  const a = ((t - mid) / half) * DIAL_SWEEP;
  return Math.max(-DIAL_SWEEP, Math.min(DIAL_SWEEP, a));
}

function renderTempDial(scale) {
  const t = hudState.temperature;
  if (t === null || t === undefined) return;   // 没查到就让原件原样显示

  const spec = byId('disk_temperature');
  if (!spec) return;
  const pos = place(spec.box, spec.anchor, scale);

  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(24, Math.round(pos.w * dpr));
  const cv = document.createElement('canvas');
  cv.className = 'hud-item hud-dial';
  cv.width = px;
  cv.height = px;
  applyStyle(cv, pos);
  root.appendChild(cv);

  const ctx = cv.getContext('2d');
  const c = px / 2;

  // 盖住原件那根固定指针和 °C 字样，外圈刻度保持原样露出来
  ctx.beginPath();
  ctx.arc(c, c, c * 0.60, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_INNER;
  ctx.fill();

  // 按温度旋转的指针
  const a = ((tempToAngle(t) - 90) * Math.PI) / 180;
  ctx.strokeStyle = DIAL_NEEDLE;
  ctx.lineCap = 'round';
  ctx.lineWidth = px * 0.07;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(a) * c * 0.46, c + Math.sin(a) * c * 0.46);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(c, c, px * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_NEEDLE;
  ctx.fill();

  // 读数写在原件 °C 字样原来的位置。
  // 字号必须按遮盖圆收：写死字号时文字会压到外圈刻度上，负温「-51°」
  // 更宽、超得更多。注意要按文字**角点**到圆心的距离来收 —— 只看基线
  // 那一行的弦长是不够的，文字本身有高度，右下角仍会探出圆外。
  const label = `${Math.round(t)}°`;
  const coverR = c * 0.60;
  const baselineY = px * 0.17;   // 读数中心相对圆心的下移量

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let fontPx = px * 0.22;
  for (let i = 0; i < 12; i++) {
    ctx.font = `700 ${fontPx}px -apple-system, "PingFang SC", sans-serif`;
    const halfW = ctx.measureText(label).width / 2;
    const halfH = fontPx * 0.42;                       // 字形实际高度约为字号的 0.84
    const corner = Math.hypot(halfW, baselineY + halfH);
    if (corner <= coverR * 0.94) break;                // 留一点边距
    fontPx *= 0.9;
  }
  ctx.fillStyle = DIAL_NEEDLE;
  ctx.fillText(label, c, c + baselineY);
}

/** 按设定的数量重拼血条，用单格图铺，而不是整排那张图。 */
function renderHearts(scale) {
  const full = byId('heart_full');
  const empty = byId('heart_empty');
  const row = byId('hearts_row');
  if (!full || !row) return;

  // 原图 12 格占 354px，格距 30px
  const step = 30;
  for (let i = 0; i < hudState.hearts; i++) {
    const isFull = i < hudState.heartsFull;
    const spec = isFull ? full : (empty || full);
    const box = { ...spec.box, x: row.box.x + i * step, y: row.box.y };
    const img = document.createElement('img');
    img.className = 'hud-item';
    img.src = `/ui_source/${spec.assets.png_x8 || spec.assets.png}`;
    img.alt = isFull ? '满心' : '空心';
    applyStyle(img, place(box, 'top-left', scale));
    root.appendChild(img);
  }
}

function renderClock(scale) {
  const spec = byId('clock_text');
  if (!spec) return;
  const node = document.createElement('div');
  node.className = 'hud-text hud-clock';
  node.textContent = hudState.clockText;
  const pos = place(spec.box, spec.anchor, scale);
  applyStyle(node, pos);
  node.style.fontSize = `${pos.h * 1.15}px`;
  root.appendChild(node);
}

/** 只显示天气本身，温度交给温度表盘。 */
function renderWeather(scale) {
  const spec = byId('weather_bar');
  if (!spec) return;
  const node = document.createElement('div');
  node.className = 'hud-text hud-weather';
  node.textContent = hudState.weatherText;

  // 参考主题的 slots.clock.pill 是 124x32、字号 17 —— 字高只占胶囊
  // 高度的 53%，左右留白很宽。之前按 0.62 算字号，字把胶囊塞满了。
  // 宽度改成按内容自适应，这样两个字和四个字都保持同样的留白比例。
  const pos = place(spec.box, spec.anchor, scale);
  const h = pos.h;
  node.style.height = `${h}px`;
  node.style.right = `${pos.right}px`;
  node.style.bottom = `${pos.bottom}px`;
  node.style.fontSize = `${h * 0.46}px`;
  node.style.padding = `0 ${h * 1.05}px`;
  root.appendChild(node);
}

function byId(id) {
  return layout.elements.find((e) => e.id === id);
}

/** 小地图该摆在哪、多大 —— 交给 minimap 模块用。 */
export function minimapSlot() {
  if (!layout) return null;
  const spec = byId('minimap');
  if (!spec) return null;
  const scale = (stage.clientWidth / CANVAS_W) * hudState.scale;
  const pos = place(spec.box, spec.anchor, scale);
  const stageW = stage.clientWidth;
  const stageH = stage.clientHeight;
  return {
    diameter: pos.w / stageW,
    // 换算成小地图模块用的「圆心占比」
    x: (stageW - pos.right - pos.w / 2) / stageW,
    y: (stageH - pos.bottom - pos.h / 2) / stageH,
  };
}

window.addEventListener('resize', () => renderHud());

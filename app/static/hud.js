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

import { ICONS, HUD_ACCENT } from '/icons.js';

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
  // false = 用自绘图标（默认），true = 用 ui_source 里的游戏抠图。
  // 自绘模式完全不碰 ui_source，所以没有那个目录也能正常出图。
  useOriginal: false,

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
  // 布局里另有这两个「激活状态」条目，是上面两个圆盘的另一种状态。
  // 状态切换已由 ACTIVE_DISKS 处理，单独再画一份会重叠，
  // 而且它们没有自绘实现，重绘模式下会退回去加载抠图。
  'sensor_active', 'sound_active',
]);

export async function loadLayout() {
  if (layout) return layout;
  // 布局随程序走，不放在 ui_source/ —— 那个目录是 gitignore 的，
  // 刚克隆的仓库里没有，会导致整套 HUD 都渲染不出来（只剩小地图，
  // 因为它只依赖经纬度）。这份是从截图量出来的坐标数字，不是美术素材。
  const r = await fetch('/ui_layout.json');
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

    const drawer = drawerFor(el.id);
    if (drawer) {
      root.appendChild(drawnItem(drawer, pos, el.name || el.id));
      continue;
    }
    if (el.id.startsWith('disk_')) {
      const act = ACTIVE_DISKS[el.id];
      if (act) {
        const p2 = place(act.box, el.anchor, scale);
        root.appendChild(blackenedDisk(act.src, p2, el.name || el.id, act.glow, act.dim, act.tint));
        continue;
      }
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

/* ---------------- 自己重绘的元件 ---------------- */

/* 这两个原来直接用游戏截图的抠图，现在改成按同样的视觉语言自己画。
 * 尺寸和位置仍取自 ui_layout.json，只是像素不再来自原作。 */

const DIAL_BASE = 'rgb(10,12,14)';        // 盘底，与温度叠加层同色

// 刻度环的着色照原件量出来的分段来，而不是一条连续渐变。
// 第一版画错就错在这里：只判断了每段「偏橙还是偏青」，没量有多浓，
// 于是整圈都上了色。实测 12 段里真正着色的只有 3 段 ——
// 60~120 度橙（彩度 132~143）、240~270 度青（彩度 85），
// 其余 9 段彩度只有 38~58，那是底色蓝灰本身自带的，并非上色。
const DIAL_RING = [74, 100, 115];         // 未着色段的底色
const DIAL_WARM = [189, 118, 46];         // 高温段
const DIAL_COOL = [114, 189, 199];        // 低温段
const DIAL_COOL_DIM = [84, 129, 142];     // 低温段与底色之间的过渡

// 段序号以正上为 0、顺时针每 30 度一段
const DIAL_SECTOR_COLOR = {
  2: DIAL_WARM, 3: DIAL_WARM,
  7: DIAL_COOL_DIM, 8: DIAL_COOL,
};

const COMPASS_FILL = 'rgba(108, 132, 144, 0.92)';
const COMPASS_TEXT = '#C2E9EF';

/** 温度表盘的盘面：近黑底 + 12 段刻度，只有高低温两端着色。 */
function drawTempDialBase(ctx, w) {
  const c = w / 2;
  ctx.clearRect(0, 0, w, w);
  ctx.beginPath();
  ctx.arc(c, c, c * 0.98, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_BASE;
  ctx.fill();

  const inner = c * 0.62;
  const outer = c * 0.93;
  const gap = 3;                     // 段间留缝，才有「刻度」的观感
  for (let i = 0; i < 12; i++) {
    const rgb = DIAL_SECTOR_COLOR[i] || DIAL_RING;
    ctx.fillStyle = `rgb(${rgb.join(',')})`;

    const start = i * 30;
    const a0 = ((start + gap / 2) - 90) * Math.PI / 180;
    const a1 = ((start + 30 - gap / 2) - 90) * Math.PI / 180;
    ctx.beginPath();
    ctx.arc(c, c, outer, a0, a1);
    ctx.arc(c, c, inner, a1, a0, true);
    ctx.closePath();
    ctx.fill();
  }
}

/** 指北条：等腰三角形，顶点在正上中点，底边满宽，中间一个 N。 */
function drawCompassBase(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = COMPASS_FILL;
  ctx.fill();

  ctx.fillStyle = COMPASS_TEXT;
  ctx.font = `600 ${h * 0.52}px ${UI_FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', w / 2, h * 0.62);
}

/* 原版模式下这两个圆盘改用「激活状态」的抠图。
 *
 * 主 ui_layout.json 那份是从第一张截图抠的，感应器和声音计当时都是
 * 熄灭状态，看着很闷。另一份参考素材从沙漠夜景那张截出了点亮状态。
 *
 * box 直接用激活素材自己的坐标（同为 1920x1080 画布、同样右下角锚定）：
 * 感应器那张多留了辉光边距，所以框比圆盘大一圈，用原来的框会被裁掉辉光。
 * 实测圆心对得上 —— 激活版 (1547.6, 813) 正是原框 (1519,784,58,58) 的中心。
 */
const ACTIVE_DISKS = {
  disk_sheikah_sensor: {
    src: '/ui_source/active/sensor_active_x8.png',
    glow: '/ui_source/active/sensor_active_glow_add.png',
    box: { x: 1507, y: 772, w: 82, h: 83 },
    // 素材自带的青比天气文字更亮更偏绿（#8AFFFF 一带），压黑后重新按亮度
    // 染成统一色。染色本身会把峰值归一化，原来那个 dim: 0.6 会被一起
    // 归掉，所以不再需要——亮度现在由 HUD_ACCENT 自己决定。
    tint: HUD_ACCENT,
  },
  disk_sound: {
    src: '/ui_source/active/sound_active_x8.png',
    box: { x: 1518, y: 903, w: 60, h: 60 },
  },
};

// 这两个的自绘实现在本文件里，其余在 icons.js。合起来覆盖全部元件。
const EXTRA_DRAWN = {
  disk_temperature: (ctx, w, h) => drawTempDialBase(ctx, w),
  compass_north: drawCompassBase,
};

/** 当前模式下这个元件该怎么画；返回 null 表示走抠图。
 *
 * 原版模式必须让每个元件都走抠图，包括温度盘和指北条 —— 一开始
 * 把这两个写成了两种模式都用自绘，结果切到原版它们不跟着变。 */
function drawerFor(id) {
  if (hudState.useOriginal) return null;
  return EXTRA_DRAWN[id] || ICONS[id] || null;
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

/** 自绘元件：建一块画布，按显示尺寸画上去。 */
function drawnItem(drawer, pos, alt) {
  const cv = document.createElement('canvas');
  cv.className = 'hud-item';
  cv.title = alt;
  applyStyle(cv, pos);
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(24, Math.round(pos.w * dpr));
  cv.height = Math.max(12, Math.round(pos.h * dpr));
  drawer(cv.getContext('2d'), cv.width, cv.height);
  return cv;
}

/* 把加法辉光叠上去。
 *
 * 辉光素材是「黑底上的亮光」，整张不透明。直接用 lighter 叠会出事：
 * lighter 连 alpha 一起相加，源 alpha 255 + 目标 0 = 255，于是四角
 * 透明的地方被强行变成不透明黑，圆盘外面就多出一个黑方块。
 * 所以先按亮度算出 alpha，黑的地方彻底透明，再叠。
 */
function applyGlow(ctx, glowImg, px) {
  const tmp = document.createElement('canvas');
  tmp.width = px;
  tmp.height = px;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(glowImg, 0, 0, px, px);
  const g = tctx.getImageData(0, 0, px, px);
  const d = g.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i + 3] = Math.max(d[i], d[i + 1], d[i + 2]);
  }
  tctx.putImageData(g, 0, 0);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(tmp, 0, 0);
  ctx.restore();
}

function blackenedDisk(src, pos, alt, glowSrc, dim = 1, tint = null) {
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

    // 辉光必须在压黑之前叠。反过来的话，辉光铺满整个盘面把底色提亮，
    // 压黑已经做完了管不住它，结果这个盘明显比另外两个亮。
    const finish = () => {
      blackenInPlace(ctx, px, dim);
      if (tint) tintInPlace(ctx, px, tint);
    };
    if (!glowSrc) { finish(); return; }
    const g = new Image();
    g.onload = () => { applyGlow(ctx, g, px); finish(); };
    g.onerror = finish;
    g.src = glowSrc;
  };
  img.src = src;
  return cv;
}

/** 就地把画布压成黑底：减去主色再放大反差。 */
/* 按亮度整体缩放，不能逐通道减主色 —— 那样会扭曲色相。
 * 盘底 #284868 的蓝分量比绿多，逐通道减掉后蓝被削得更狠，
 * 青色的感应器纹样就偏绿了（#8AFFFF 变成 #87F8CF）。
 * 整体缩放时三个通道等比例变化，色相不动。 */
function blackenInPlace(ctx, px, dim = 1) {
    const data = ctx.getImageData(0, 0, px, px);
    const d = data.data;
    const bg = dominantColor(d);
    const lumBg = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    const span = Math.max(1, 255 - lumBg);

    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // 亮度落在主色上的像素归零，越亮保留越多
      const k = Math.max(0, (lum - lumBg) / span) * DISK_GAIN;
      for (let c = 0; c < 3; c++) {
        const v = (d[i + c] * k + DISK_FLOOR[c]) * dim;
        d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    ctx.putImageData(data, 0, 0);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 就地把压黑后的画布染成单一色相：按亮度在「盘底」和目标色之间取值。
 *
 * 不能用 globalCompositeOperation 直接乘——素材的青已经把红通道压到接近 0，
 * 再乘任何颜色都出不来目标色的红分量，结果还是原来那个偏绿的青。
 * 按亮度重建三个通道才能真正换色，同时保住纹样形状和辉光的衰减。
 *
 * 峰值按图内实际最大亮度归一化，这样最亮处正好落在目标色上，
 * 不受素材本身亮到什么程度影响。
 */
function tintInPlace(ctx, px, hex) {
  const rgb = hexToRgb(hex);
  const data = ctx.getImageData(0, 0, px, px);
  const d = data.data;

  let peak = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum > peak) peak = lum;
  }
  if (peak <= 0) return;

  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const k = Math.min(1, lum / peak);
    for (let c = 0; c < 3; c++) {
      // 暗处收敛到盘底色，亮处收敛到目标色
      d[i + c] = rgb[c] * k + DISK_FLOOR[c] * (1 - k);
    }
  }
  ctx.putImageData(data, 0, 0);
}

/* ---------------- 温度表盘 ---------------- */

// 盘面直接用游戏原件（外圈 12 段刻度、配色、外框全部保留），
// 只重画会动的部分：盖掉原件里那根固定朝上的指针，换成按温度旋转的，
// 并在下方写出读数。两个颜色都是从原件里采样出来的。
const DIAL_INNER = 'rgb(10,12,14)';  // 与压黑后的盘底一致，用来遮住原指针
const DIAL_NEEDLE = HUD_ACCENT;  // 原件采样是 #88F0F8，改用统一色

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
    const pos = place(box, 'top-left', scale);
    const drawer = drawerFor(spec.id);
    if (drawer) {
      root.appendChild(drawnItem(drawer, pos, isFull ? '满心' : '空心'));
      continue;
    }
    const img = document.createElement('img');
    img.className = 'hud-item';
    img.src = `/ui_source/${spec.assets.png_x8 || spec.assets.png}`;
    img.alt = isFull ? '满心' : '空心';
    applyStyle(img, pos);
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

/* ---------------- 导出：把同一套 HUD 画到画布上 ---------------- */

/* 预览走 DOM、导出走画布，两条路径共用上面的 place()、常量和 hudState，
 * 只有绘制调用不同 —— 位置、配色、比例这些容易出错的东西只有一份。 */

const BANNER_FONT_STACK =
  '"Noto Serif SC", "Songti SC", "Source Han Serif SC", "PT Serif", serif';
// 时间用白色。天气那条有近黑胶囊垫底，蓝字够清楚；时间没有底衬，
// 同样的蓝压在亮天空上就读不清了。
// 改这里要连 style.css 的 .hud-clock 一起改 —— 预览走 CSS、
// 导出走画布，两边各有一份。
const CLOCK_COLOR = '#FFFFFF';

const UI_FONT_STACK =
  '"Trebuchet MS", "Hiragino Sans GB", "PingFang SC", system-ui, sans-serif';

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(`图片加载失败: ${src}`));
    im.src = src;
  });
}

/** 把一张圆盘按黑底规则处理好，返回可直接 drawImage 的画布。 */
function blackenDiskToCanvas(img, px, glowImg, dim = 1, tint = null) {
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, px, px);
  if (glowImg) applyGlow(ctx, glowImg, px);   // 先叠辉光，再压黑
  blackenInPlace(ctx, px, dim);
  if (tint) tintInPlace(ctx, px, tint);
  return cv;
}

function drawDial(ctx, pos, px) {
  const t = hudState.temperature;
  if (t === null || t === undefined) return;
  const c = px / 2;

  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = px;
  const g = cv.getContext('2d');

  g.beginPath();
  g.arc(c, c, c * 0.60, 0, Math.PI * 2);
  g.fillStyle = DIAL_INNER;
  g.fill();

  const a = ((tempToAngle(t) - 90) * Math.PI) / 180;
  g.strokeStyle = DIAL_NEEDLE;
  g.lineCap = 'round';
  g.lineWidth = px * 0.07;
  g.beginPath();
  g.moveTo(c, c);
  g.lineTo(c + Math.cos(a) * c * 0.46, c + Math.sin(a) * c * 0.46);
  g.stroke();
  g.beginPath();
  g.arc(c, c, px * 0.07, 0, Math.PI * 2);
  g.fillStyle = DIAL_NEEDLE;
  g.fill();

  const label = `${Math.round(t)}°`;
  const coverR = c * 0.60;
  const baselineY = px * 0.17;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let fontPx = px * 0.22;
  for (let i = 0; i < 12; i++) {
    g.font = `700 ${fontPx}px ${UI_FONT_STACK}`;
    const halfW = g.measureText(label).width / 2;
    const halfH = fontPx * 0.42;
    if (Math.hypot(halfW, baselineY + halfH) <= coverR * 0.94) break;
    fontPx *= 0.9;
  }
  g.fillStyle = DIAL_NEEDLE;
  g.fillText(label, c, c + baselineY);

  ctx.drawImage(cv, pos.left ?? 0, pos.top ?? 0, pos.w, pos.h);
}

/** 画布版的文字描边阴影，对应 CSS 里的 text-shadow */
function withShadow(ctx, blur, alpha, dy, fn) {
  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetY = dy;
  fn();
  ctx.restore();
}

/**
 * 按给定尺寸把整套 HUD 画到 ctx 上。
 * @param {number} width  目标画布宽（通常是原图宽）
 * @param {number} height 目标画布高
 */
export async function drawHudOnCanvas(ctx, width, height) {
  if (!layout || !hudState.enabled) return;
  const scale = (width / CANVAS_W) * hudState.scale;

  // place() 是按右下角给 right/bottom 的，画布上要换成左上角坐标
  const toXY = (pos) => ({
    x: pos.left !== undefined ? pos.left : width - pos.right - pos.w,
    y: pos.top !== undefined ? pos.top : height - pos.bottom - pos.h,
  });

  for (const el of layout.elements) {
    if (REPLACED.has(el.id)) continue;
    if (el.id.startsWith('dpad_') && el.id !== 'dpad_cluster') continue;
    const src = el.assets?.png_x8 || el.assets?.png;
    if (!src) continue;

    const pos = place(el.box, el.anchor, scale);
    const { x, y } = toXY(pos);

    const drawer = drawerFor(el.id);
    if (drawer) {
      const off = document.createElement('canvas');
      off.width = Math.max(24, Math.round(pos.w));
      off.height = Math.max(12, Math.round(pos.h));
      drawer(off.getContext('2d'), off.width, off.height);
      ctx.drawImage(off, x, y, pos.w, pos.h);
      if (el.id === 'disk_temperature') {
        drawDial(ctx, { left: x, top: y, w: pos.w, h: pos.h }, off.width);
      }
      continue;
    }

    // 原版模式下这两个盘换成激活状态的素材，框也用它自己的
    const act = el.id.startsWith('disk_') ? ACTIVE_DISKS[el.id] : null;
    if (act) {
      const p2 = place(act.box, el.anchor, scale);
      const q = toXY(p2);
      const px = Math.max(24, Math.round(p2.w));
      const base = await loadImage(act.src);
      const glow = act.glow ? await loadImage(act.glow) : null;
      ctx.drawImage(blackenDiskToCanvas(base, px, glow, act.dim, act.tint), q.x, q.y, p2.w, p2.h);
      continue;
    }

    const img = await loadImage(`/ui_source/${src}`);

    if (el.id.startsWith('disk_')) {
      const px = Math.max(24, Math.round(pos.w));
      ctx.drawImage(blackenDiskToCanvas(img, px), x, y, pos.w, pos.h);
      if (el.id === 'disk_temperature') {
        drawDial(ctx, { left: x, top: y, w: pos.w, h: pos.h }, px);
      }
      continue;
    }
    ctx.drawImage(img, x, y, pos.w, pos.h);
  }

  await drawBannerOn(ctx, scale, width, height);
  await drawHeartsOn(ctx, scale, toXY);
  drawClockOn(ctx, scale, toXY);
  drawWeatherOn(ctx, scale, toXY);
}

async function drawBannerOn(ctx, scale, width, height) {
  if (!hudState.bannerOn) return;
  const text = (hudState.bannerText || '').trim();
  if (!text) return;

  const k = scale * (CANVAS_W / BANNER_REF_W) * hudState.bannerScale;
  let fontPx = BANNER_FONT * k;

  // 画布不像 DOM 会等字体到位：字体没加载完就画，会静默用回退字体，
  // 导出的成品和预览对不上。这里按实际文字把需要的分片先加载好。
  try {
    await document.fonts.load(`600 ${fontPx}px "Noto Serif SC"`, text);
  } catch { /* 字体没抓过就用回退，不影响导出 */ }
  let tracking = BANNER_TRACKING * k;

  const measure = () => {
    ctx.font = `600 ${fontPx}px ${BANNER_FONT_STACK}`;
    ctx.letterSpacing = `${tracking}px`;
    return ctx.measureText(text).width;
  };
  // 和预览一样：超出左边缘右侧的可用宽度就等比缩
  const limit = width * (1 - hudState.bannerX) * 0.94;
  if (measure() > limit) {
    const shrink = limit / measure();
    fontPx *= shrink;
    tracking *= shrink;
    measure();
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#FFFFFF';
  withShadow(ctx, fontPx * 0.5, 0.45, 0, () => {
    withShadow(ctx, 3 * k, 0.8, 1 * k, () => {
      ctx.fillText(text, hudState.bannerX * width, hudState.bannerY * height);
    });
  });
  ctx.letterSpacing = '0px';
}

async function drawHeartsOn(ctx, scale, toXY) {
  const full = byId('heart_full');
  const empty = byId('heart_empty');
  const row = byId('hearts_row');
  if (!full || !row) return;

  let fullImg = null, emptyImg = null;
  if (!drawerFor(full.id)) {
    fullImg = await loadImage(`/ui_source/${full.assets.png_x8 || full.assets.png}`);
    emptyImg = empty
      ? await loadImage(`/ui_source/${empty.assets.png_x8 || empty.assets.png}`)
      : fullImg;
  }

  for (let i = 0; i < hudState.hearts; i++) {
    const isFull = i < hudState.heartsFull;
    const spec = isFull ? full : (empty || full);
    const box = { ...spec.box, x: row.box.x + i * 30, y: row.box.y };
    const pos = place(box, 'top-left', scale);
    const { x, y } = toXY(pos);
    const drawer = drawerFor(spec.id);
    if (drawer) {
      const off = document.createElement('canvas');
      off.width = Math.max(12, Math.round(pos.w));
      off.height = Math.max(12, Math.round(pos.h));
      drawer(off.getContext('2d'), off.width, off.height);
      ctx.drawImage(off, x, y, pos.w, pos.h);
      continue;
    }
    ctx.drawImage(isFull ? fullImg : emptyImg, x, y, pos.w, pos.h);
  }
}

function drawClockOn(ctx, scale, toXY) {
  const spec = byId('clock_text');
  if (!spec) return;
  const pos = place(spec.box, spec.anchor, scale);
  const { x, y } = toXY(pos);
  ctx.font = `600 ${pos.h * 1.15}px ${UI_FONT_STACK}`;
  ctx.letterSpacing = `${pos.h * 0.06}px`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = CLOCK_COLOR;
  withShadow(ctx, 3 * scale * 4, 0.75, scale * 4, () => {
    ctx.fillText(hudState.clockText, x, y + pos.h / 2);
  });
  ctx.letterSpacing = '0px';
}

function drawWeatherOn(ctx, scale, toXY) {
  const spec = byId('weather_bar');
  if (!spec) return;
  const pos = place(spec.box, spec.anchor, scale);
  const h = pos.h;
  const fontPx = h * 0.46;
  const padX = h * 1.05;

  ctx.font = `600 ${fontPx}px ${UI_FONT_STACK}`;
  ctx.letterSpacing = `${fontPx * 0.1}px`;
  const textW = ctx.measureText(hudState.weatherText).width;
  const w = textW + padX * 2;

  // 预览里胶囊宽度自适应、右边缘跟着 place() 的 right 走
  const { y } = toXY(pos);
  const right = pos.right !== undefined
    ? ctx.canvas.width - pos.right
    : (pos.left ?? 0) + pos.w;
  const x = right - w;

  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(12,14,16,0.82)';
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = HUD_ACCENT;
  withShadow(ctx, 2 * scale * 4, 0.6, scale * 4, () => {
    ctx.fillText(hudState.weatherText, x + w / 2, y + h / 2);
  });
  ctx.letterSpacing = '0px';
}

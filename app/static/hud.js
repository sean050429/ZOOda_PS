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
};

let layout = null;
let root = null;
// 这些用我们自己的内容替换，不摆游戏原图
const REPLACED = new Set([
  'minimap',              // 换成我们生成的小地图
  'hearts_row',           // 按用户设定的数量重新拼
  'heart_full', 'heart_empty',
  'clock_text',           // 换成照片的拍摄时间
  'weather_bar',          // 天气先用文字占位
  'weather_icon_now', 'weather_icon_next', 'weather_icon_last',
  'weather_marker',
  'minimap_player_arrow',   // 我们生成的小地图自带中心指针，会撞
  'minimap_marker_shrine',  // 神庙标记是游戏专有的，照片上没有意义
  'disk_temperature',       // 换成自己画的温度表盘，见 drawTempDial
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

    const img = document.createElement('img');
    img.className = 'hud-item';
    img.src = `/ui_source/${src}`;
    img.alt = el.name || el.id;
    applyStyle(img, place(el.box, el.anchor, scale));
    root.appendChild(img);
  }

  renderHearts(scale);
  renderClock(scale);
  renderWeather(scale);
  renderTempDial(scale);
}

/* ---------------- 温度表盘 ---------------- */

// 照游戏原件重画：12 段刻度、左青右橙、指针朝上是常温、下方标温度。
// 自己画而不用抠图，顺带把这个元件从「游戏素材」名单里划掉了。
const DIAL_BASE = '#39485A';
const DIAL_RIM = '#22303E';
const DIAL_COLD = [122, 226, 226];
const DIAL_HOT = [242, 138, 24];
const DIAL_NEUTRAL = [74, 92, 110];
const DIAL_NEEDLE = '#BFE4F2';

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

function mix(a, b, t) {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}

function renderTempDial(scale) {
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
  const t = hudState.temperature;

  // 盘面
  ctx.beginPath();
  ctx.arc(c, c, c * 0.94, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_BASE;
  ctx.fill();
  ctx.lineWidth = px * 0.05;
  ctx.strokeStyle = DIAL_RIM;
  ctx.stroke();

  // 12 段刻度：正上方为常温，越往左越冷（青），越往右越热（橙）
  const segs = 12;
  for (let i = 0; i < segs; i++) {
    const from = -90 + (i * 360) / segs + 1.5;
    const to = -90 + ((i + 1) * 360) / segs - 1.5;
    let midDeg = (from + to) / 2 + 90;       // 相对正上方
    if (midDeg > 180) midDeg -= 360;
    // 靠近正上方的几段保持中性，只有偏离够远的才上色 ——
    // 原件里大部分刻度是暗的，只有两侧末端亮着青和橙
    const norm = Math.max(0, Math.min(1, (Math.abs(midDeg) - 55) / 95));
    const cold = midDeg < 0;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, c * 0.9, (from * Math.PI) / 180, (to * Math.PI) / 180);
    ctx.closePath();
    ctx.fillStyle = mix(DIAL_NEUTRAL, cold ? DIAL_COLD : DIAL_HOT, norm);
    ctx.fill();
  }

  // 中心挖空，让刻度只剩外圈一环
  ctx.beginPath();
  ctx.arc(c, c, c * 0.62, 0, Math.PI * 2);
  ctx.fillStyle = DIAL_BASE;
  ctx.fill();

  if (t !== null && t !== undefined) {
    // 指针
    const a = ((tempToAngle(t) - 90) * Math.PI) / 180;
    ctx.save();
    ctx.strokeStyle = DIAL_NEEDLE;
    ctx.lineCap = 'round';
    ctx.lineWidth = px * 0.075;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * c * 0.52, c + Math.sin(a) * c * 0.52);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, px * 0.075, 0, Math.PI * 2);
    ctx.fillStyle = DIAL_NEEDLE;
    ctx.fill();
    ctx.restore();

    // 读数
    ctx.fillStyle = DIAL_NEEDLE;
    ctx.font = `700 ${px * 0.2}px -apple-system, "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(t)}°`, c, c + px * 0.22);
  }
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

/** 只显示天气本身，温度交给温度表盘。图标等后面再画。 */
function renderWeather(scale) {
  const spec = byId('weather_bar');
  if (!spec) return;
  const node = document.createElement('div');
  node.className = 'hud-text hud-weather';
  node.textContent = hudState.weatherText;
  const pos = place(spec.box, spec.anchor, scale);
  applyStyle(node, pos);
  node.style.fontSize = `${pos.h * 0.62}px`;
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

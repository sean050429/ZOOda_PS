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
  scale: 1,        // 用户额外的整体缩放
  hearts: 12,
  heartsFull: 11,
  weatherText: '晴 26°C',
  clockText: '13:35',
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

/** 天气暂时用文字占位，图标等第 6 步接了天气数据再画。 */
function renderWeather(scale) {
  const spec = byId('weather_bar');
  if (!spec) return;
  const node = document.createElement('div');
  node.className = 'hud-text hud-weather';
  node.textContent = hudState.weatherText;
  const pos = place(spec.box, spec.anchor, scale);
  applyStyle(node, pos);
  node.style.fontSize = `${pos.h * 0.42}px`;
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

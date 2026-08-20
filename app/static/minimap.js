/* 照片上那个圆形小地图。
 *
 * 位置由 hud.js 按原作布局算好后写进 mapState，这里只负责渲染 ——
 * 小地图不再支持手动拖动，摆哪儿完全跟随 HUD 布局。
 *
 * 位置和大小一律存成「占照片的比例」而不是像素：预览是缩放后的图，
 * 导出时要按原图尺寸重画，只有比例是两边通用的。
 */

const overlay = document.getElementById('overlay');
const stage = document.getElementById('stage');

export const mapState = {
  enabled: true,
  x: 0.16,        // 圆心位置，占照片宽/高的比例
  y: 0.18,
  diameter: 0.22, // 直径占照片宽度的比例
  zoom: 15,
  posterize: 0,
  palette: 'botw',
  heading: 0,          // 中心箭头朝向，0 = 正上
  markerScale: 1.7,    // 箭头缩放。1 = 游戏原始比例，照片上偏小，默认放大一些
  lat: null,
  lon: null,
};

let el = null;
let imgEl = null;
let markerCanvas = null;
let onStatus = () => {};
let pending = 0;

export function onMapStatus(fn) {
  onStatus = fn;
}

function ensureElement() {
  if (el) return el;
  el = document.createElement('div');
  el.className = 'minimap';
  el.hidden = true;
  imgEl = document.createElement('img');
  imgEl.alt = '小地图';
  el.appendChild(imgEl);

  // 箭头单独一层。它只跟朝向有关，跟坐标无关，所以放在 canvas 上同步画，
  // 拖朝向滑杆能即时看到，一次网络请求都不用发。
  markerCanvas = document.createElement('canvas');
  markerCanvas.className = 'minimap-marker';
  el.appendChild(markerCanvas);
  overlay.appendChild(el);
  return el;
}

function applyLayout() {
  if (!el) return;
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  const d = mapState.diameter * w;
  el.style.width = `${d}px`;
  el.style.height = `${d}px`;
  el.style.left = `${mapState.x * w}px`;
  el.style.top = `${mapState.y * h}px`;
  drawMarker();
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* ---------------- 玩家箭头图层 ---------------- */

// 形状是从游戏截图里凸包拟合量出来的：一个等腰三角形，三个顶点，
// 没有尾部凹口（我一开始画成了四点箭形，错的）。
//
// 注意别拿抠图 PNG 的 15x11 当比例 —— 那是箭头旋转之后的外接矩形，
// 和三角形本身的长宽没有关系。真实比例是底边 : 长 = 0.87，比想象中瘦。
const MARKER_FILL = '#F0F020';
const MARKER_STROKE = 'rgba(96,86,16,0.55)';
// 这两个是游戏原始比例（scale = 1）。原始尺寸在小地图上只占 5%，
// 贴到照片里偏小，所以默认放大 1.7 倍，可通过滑块调整。
const MARKER_BASE_RATIO = 0.050;    // 底边 / 小地图直径
const MARKER_LENGTH_RATIO = 0.058;  // 尖端到底边 / 小地图直径

export function drawMarker() {
  if (!markerCanvas || !el || el.hidden) return;

  const dpr = window.devicePixelRatio || 1;
  const css = mapState.diameter * stage.clientWidth;
  if (css <= 0) return;

  if (markerCanvas.width !== Math.round(css * dpr)) {
    markerCanvas.width = Math.round(css * dpr);
    markerCanvas.height = Math.round(css * dpr);
  }
  const ctx = markerCanvas.getContext('2d');
  const size = markerCanvas.width;
  ctx.clearRect(0, 0, size, size);

  const c = size / 2;
  const a = (mapState.heading || 0) * Math.PI / 180;

  // 朝向光锥：游戏里箭头前方有一小片亮区
  const half = 26 * Math.PI / 180;
  const r = size / 2 * 0.62;
  const g = ctx.createRadialGradient(c, c, 0, c, c, r);
  g.addColorStop(0, 'rgba(255,246,170,0.30)');
  g.addColorStop(1, 'rgba(255,246,170,0)');
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, size / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.arc(c, c, r, a - Math.PI / 2 - half, a - Math.PI / 2 + half);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 箭头本体：等腰三角形，包围盒中心对准小地图中心
  const k = mapState.markerScale || 1;
  const halfB = MARKER_BASE_RATIO * k * size / 2;
  const halfL = MARKER_LENGTH_RATIO * k * size / 2;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(0, -halfL);        // 尖端
  ctx.lineTo(halfB, halfL);     // 底边右角
  ctx.lineTo(-halfB, halfL);    // 底边左角
  ctx.closePath();
  ctx.fillStyle = MARKER_FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, size * 0.003);
  ctx.strokeStyle = MARKER_STROKE;
  ctx.stroke();
  ctx.restore();
}

/* ---------------- 渲染 ---------------- */

export function refresh({ redraw = true } = {}) {
  ensureElement();

  const ready = mapState.enabled && mapState.lat !== null && mapState.lon !== null;
  el.hidden = !ready;
  if (!ready) {
    onStatus(mapState.enabled ? '需要坐标才能生成小地图。' : '');
    return;
  }

  applyLayout();
  if (redraw) fetchImage();
}

function fetchImage() {
  // 按屏幕实际像素请求，高分屏上才不糊；服务端上限 900
  const px = Math.round(mapState.diameter * stage.clientWidth *
                        (window.devicePixelRatio || 1));
  const size = clamp(px, 120, 900);

  const url = `/api/minimap?lat=${mapState.lat}&lon=${mapState.lon}` +
              `&zoom=${mapState.zoom}&size=${size}&posterize=${mapState.posterize}` +
              `&palette=${encodeURIComponent(mapState.palette)}`;

  const token = ++pending;
  el.classList.add('is-loading');
  onStatus('正在生成小地图…');

  const probe = new Image();
  probe.onload = () => {
    if (token !== pending) return; // 已经有更新的请求了，丢弃这次结果
    imgEl.src = probe.src;
    el.classList.remove('is-loading');
    drawMarker();
    onStatus('');
  };
  probe.onerror = () => {
    if (token !== pending) return;
    el.classList.remove('is-loading');
    onStatus('地图瓦片拉取失败，检查网络后再动一下滑块重试。', true);
  };
  probe.src = url;
}

// 窗口缩放时照片显示尺寸变了，位置按比例重算
window.addEventListener('resize', () => applyLayout());

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
  markerScale: 1,      // 箭头缩放。1 = 参考主题的原始比例
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

// 形状与配色照搬 Zelda_photo 的 botw 主题（themes/botw/theme.json 的
// slots.minimap.pin / .sector，路径见 core/minimap/index.js 的 drawPlayerMarker）：
// 四点箭形，尾部带凹口。之前照游戏截图量成了纯三角，这里改回参考实现。
//
// 参考里 pin.size=12、minimap radius=89，所以 p 占直径 12/178 = 6.74%。
const MARKER_FILL = '#FFE24A';
const MARKER_STROKE = '#0E1A24';
const MARKER_P_RATIO = 0.0674;        // pin.size / 小地图直径
const MARKER_STROKE_RATIO = 0.0067;   // strokeWidth 1.2 / 178

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

  // 箭头本体：四点箭形，尾部凹口。旋转原点就是玩家所在位置
  const k = mapState.markerScale || 1;
  const p = MARKER_P_RATIO * size * k;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(a);
  ctx.beginPath();
  ctx.moveTo(0, -p);              // 尖端
  ctx.lineTo(p * 0.72, p * 0.8);  // 右翼
  ctx.lineTo(0, p * 0.4);         // 尾部凹口
  ctx.lineTo(-p * 0.72, p * 0.8); // 左翼
  ctx.closePath();
  ctx.fillStyle = MARKER_FILL;
  ctx.fill();
  ctx.lineWidth = Math.max(1, MARKER_STROKE_RATIO * size * k);
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

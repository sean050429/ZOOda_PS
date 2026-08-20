/* 照片上那个可拖动的圆形小地图。
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
  posterize: 4,
  palette: 'botw',
  heading: 0,     // 中心箭头朝向，0 = 正上
  lat: null,
  lon: null,
};

let el = null;
let imgEl = null;
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
  overlay.appendChild(el);
  attachDrag(el);
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
}

/* ---------------- 拖动 ---------------- */

function attachDrag(node) {
  let dragging = false;

  node.addEventListener('pointerdown', (e) => {
    dragging = true;
    node.setPointerCapture(e.pointerId);
    node.classList.add('is-dragging');
    e.preventDefault();
  });

  node.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    // 夹在照片范围内，别让小地图被拖到画面外面找不回来
    mapState.x = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    mapState.y = clamp((e.clientY - rect.top) / rect.height, 0, 1);
    applyLayout();
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    node.classList.remove('is-dragging');
    try { node.releasePointerCapture(e.pointerId); } catch {}
  };
  node.addEventListener('pointerup', stop);
  node.addEventListener('pointercancel', stop);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
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
              `&palette=${encodeURIComponent(mapState.palette)}` +
              `&heading=${mapState.heading}`;

  const token = ++pending;
  el.classList.add('is-loading');
  onStatus('正在生成小地图…');

  const probe = new Image();
  probe.onload = () => {
    if (token !== pending) return; // 已经有更新的请求了，丢弃这次结果
    imgEl.src = probe.src;
    el.classList.remove('is-loading');
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

import { mapState, refresh as refreshMap, onMapStatus, drawMarker } from '/minimap.js';
import { hudState, loadLayout, renderHud, minimapSlot } from '/hud.js';
import { exportPhoto } from '/exporter.js';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const statusEl = document.getElementById('status');
const workspace = document.getElementById('workspace');
const photoEl = document.getElementById('photo');
const metaEl = document.getElementById('meta');
const resetBtn = document.getElementById('reset');

const sourceBadge = document.getElementById('ctx-source');
const noteEl = document.getElementById('ctx-note');
const latInput = document.getElementById('in-lat');
const lonInput = document.getElementById('in-lon');
const timeInput = document.getElementById('in-time');
const nameInput = document.getElementById('in-name');
const chipsEl = document.getElementById('name-chips');

const qInput = document.getElementById('q');
const qGo = document.getElementById('q-go');
const qResults = document.getElementById('q-results');
const restoreBtn = document.getElementById('restore');
const nudgeMeters = document.getElementById('nudge-m');
const nudgeInfo = document.getElementById('nudge-info');

const bannerPanel = document.getElementById('banner-panel');
const bannerOn = document.getElementById('banner-on');
const sBannerSize = document.getElementById('s-banner-size');
const sBannerX = document.getElementById('s-banner-x');
const sBannerY = document.getElementById('s-banner-y');
const vBannerSize = document.getElementById('v-banner-size');
const vBannerX = document.getElementById('v-banner-x');
const vBannerY = document.getElementById('v-banner-y');

const hudPanel = document.getElementById('hud-panel');
const hudOn = document.getElementById('hud-on');
const hudStatus = document.getElementById('hud-status');
const sHudScale = document.getElementById('s-hud-scale');
const sHearts = document.getElementById('s-hearts');
const sHeartsFull = document.getElementById('s-hearts-full');
const vHudScale = document.getElementById('v-hud-scale');
const vHearts = document.getElementById('v-hearts');
const vHeartsFull = document.getElementById('v-hearts-full');
const inWeather = document.getElementById('in-weather');
const inClock = document.getElementById('in-clock');

const mapPanel = document.getElementById('map-panel');
const mapOn = document.getElementById('map-on');
const mapStatus = document.getElementById('map-status');
const sZoom = document.getElementById('s-zoom');
const sPost = document.getElementById('s-post');
const vZoom = document.getElementById('v-zoom');
const vPost = document.getElementById('v-post');
const sHeading = document.getElementById('s-heading');
const vHeading = document.getElementById('v-heading');
const sMarker = document.getElementById('s-marker');
const vMarker = document.getElementById('v-marker');
const selPalette = document.getElementById('sel-palette');

let current = null;
let place = { lat: null, lon: null, takenAt: null, name: null, source: 'manual' };
// 用户手动改过地名后，后台解析回来的结果就不该再覆盖它
let nameTouchedByUser = false;
let resolveToken = 0;

/* ---------------- 工具 ---------------- */

const setStatus = (text, isError = false) => {
  statusEl.hidden = !text;
  statusEl.textContent = text || '';
  statusEl.classList.toggle('is-error', isError);
};

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const formatBytes = (n) => n < 1024 ? `${n} B`
  : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / 1048576).toFixed(1)} MB`;

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- 地名解析 ---------------- */

function renderChips(items) {
  chipsEl.innerHTML = '';
  items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (i === 0 ? ' is-best' : '');
    b.textContent = item.label;
    b.title = item.hint || '';
    b.addEventListener('click', () => {
      nameInput.value = item.label;
      nameTouchedByUser = true;
      place.name = item.label;
      syncBanner();
    });
    chipsEl.appendChild(b);
  });
}

async function resolveName(lat, lon) {
  const token = ++resolveToken;
  chipsEl.innerHTML = '';
  nameInput.placeholder = '解析中…';

  // 先上快的：Nominatim 几百毫秒就回，把界面点亮
  let quick = [];
  try {
    const r = await fetch(`/api/place?lat=${lat}&lon=${lon}`);
    if (r.ok) {
      const d = await r.json();
      quick = (d.candidates || []).map((n) => ({ label: n, hint: '行政区名' }));
      if (token === resolveToken && !nameTouchedByUser && d.name) {
        nameInput.value = d.name;
        place.name = d.name;
        syncBanner();
      }
    }
  } catch { /* 网络问题，下面的地标查询还有机会 */ }

  if (token !== resolveToken) return;
  renderChips(quick);
  nameInput.placeholder = '填了坐标后自动解析';

  // 再上慢的：Overpass 要 2~15 秒，但能挖出「東京鐵塔」这种真正的地标名
  try {
    const r = await fetch(`/api/landmark?lat=${lat}&lon=${lon}`);
    if (!r.ok) return;
    const d = await r.json();
    if (token !== resolveToken) return;

    if (d.ok === false) {
      renderChips(quick);
      return;
    }
    const marks = (d.candidates || []).map((c) => ({
      label: c.name,
      hint: `${c.kind}${c.distance_m != null ? ` · ${c.distance_m}m` : ' · 所在区域'}`,
    }));
    if (marks.length) {
      renderChips([...marks, ...quick]);
      if (!nameTouchedByUser) {
        nameInput.value = marks[0].label;
        place.name = marks[0].label;
        syncBanner();
      }
    }
  } catch { /* 地标查询是锦上添花，失败就用行政区名 */ }
}

const resolveNameSoon = debounce((lat, lon) => resolveName(lat, lon), 700);
const loadWeatherSoon = debounce(() => loadWeather(), 700);

/* ---------------- 地名搜索 ---------------- */

async function runSearch() {
  const q = qInput.value.trim();
  if (!q) return;

  qResults.hidden = false;
  qResults.innerHTML = '<li class="is-empty">搜索中…</li>';
  try {
    const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    const d = await r.json();
    const hits = d.results || [];
    if (!hits.length) {
      qResults.innerHTML = '<li class="is-empty">没找到，换个说法试试</li>';
      return;
    }
    qResults.innerHTML = '';
    hits.forEach((h) => {
      const li = document.createElement('li');
      li.innerHTML = `<b>${escapeHtml(h.name)}</b>` +
        `<span>${escapeHtml((h.display_name || '').slice(0, 60))}</span>`;
      li.addEventListener('click', () => {
        latInput.value = h.lat.toFixed(6);
        lonInput.value = h.lon.toFixed(6);
        nameInput.value = h.name;
        nameTouchedByUser = true;
        syncBanner();
        qResults.hidden = true;
        syncPlace(current?.context, { skipNameResolve: true });
      });
      qResults.appendChild(li);
    });
  } catch {
    qResults.innerHTML = '<li class="is-empty">搜索失败，检查网络</li>';
  }
}

/* ---------------- 地点状态 ---------------- */

function syncPlace(ctx = null, { skipNameResolve = false } = {}) {
  const lat = latInput.value === '' ? null : Number(latInput.value);
  const lon = lonInput.value === '' ? null : Number(lonInput.value);

  const latBad = lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90);
  const lonBad = lon !== null && (!Number.isFinite(lon) || Math.abs(lon) > 180);
  latInput.classList.toggle('is-invalid', latBad);
  lonInput.classList.toggle('is-invalid', lonBad);

  const prevLat = place.lat;
  const prevLon = place.lon;
  const prevTakenAt = place.takenAt;

  place = {
    lat: latBad ? null : lat,
    lon: lonBad ? null : lon,
    takenAt: timeInput.value || null,
    name: nameInput.value || null,
    source: ctx && ctx.has_gps && lat === ctx.lat && lon === ctx.lon ? 'exif' : 'manual',
  };

  updateBadge(ctx);
  updateNudgeInfo(ctx);
  renderNote(ctx, { latBad, lonBad });

  mapState.lat = place.lat;
  mapState.lon = place.lon;
  mapPanel.hidden = false;
  refreshMap();

  const moved = place.lat !== prevLat || place.lon !== prevLon;
  if (moved && place.lat !== null && place.lon !== null && !skipNameResolve) {
    resolveNameSoon(place.lat, place.lon);
  }
  if (moved || place.takenAt !== prevTakenAt) loadWeatherSoon();
}

/* 徽章要跟着当前值走。原来只在上传时设一次，结果坐标改到别处了
 * 还显示「来自照片」—— 明明已经不是照片记录的位置了。 */
function updateBadge(ctx) {
  const hasPhotoData = Boolean(ctx?.has_gps || ctx?.taken_at);
  if (!hasPhotoData) {
    sourceBadge.textContent = '需要手动填写';
    sourceBadge.className = 'badge is-manual';
    return;
  }
  const sameSpot = ctx.has_gps && place.lat === ctx.lat && place.lon === ctx.lon;
  const sameTime = (timeInput.value || null) === (ctx.taken_at?.slice(0, 19) || null);

  if (sameSpot && sameTime) {
    sourceBadge.textContent = '来自照片';
    sourceBadge.className = 'badge is-exif';
  } else if (sameSpot || sameTime) {
    sourceBadge.textContent = '部分已改';
    sourceBadge.className = 'badge is-manual';
  } else {
    sourceBadge.textContent = '已手动调整';
    sourceBadge.className = 'badge is-manual';
  }
}

function renderNote(ctx, { latBad, lonBad }) {
  const problems = [];
  if (latBad) problems.push('纬度要在 -90 到 90 之间');
  if (lonBad) problems.push('经度要在 -180 到 180 之间');
  if (problems.length) {
    noteEl.className = 'ctx-note is-error';
    noteEl.textContent = problems.join('；');
    return;
  }

  const lines = [];
  if (place.lat === null || place.lon === null) {
    lines.push('还没有坐标 —— 上面搜个地名，或者直接填经纬度。');
  }
  if (!place.takenAt) {
    lines.push('还没有拍摄时间 —— 天气需要它才能查到当时的实况。');
  }
  const extras = [];
  if (ctx?.camera) extras.push(`相机 ${ctx.camera}`);
  if (ctx?.altitude != null) extras.push(`海拔 ${ctx.altitude} m`);
  if (ctx?.utc_offset) extras.push(`时区 UTC${ctx.utc_offset}`);
  if (extras.length) lines.push(extras.join(' · '));

  noteEl.className = 'ctx-note';
  noteEl.textContent = lines.join('\n');
}

function fillContext(ctx) {
  latInput.value = ctx.lat ?? '';
  lonInput.value = ctx.lon ?? '';
  timeInput.value = ctx.taken_at ? ctx.taken_at.slice(0, 19) : '';
  nameInput.value = '';
  nameTouchedByUser = false;
  chipsEl.innerHTML = '';
  syncBanner();

  restoreBtn.hidden = !(ctx.has_gps || ctx.taken_at);

  syncPlace(ctx);
  if (ctx.has_gps) resolveName(ctx.lat, ctx.lon);
}

/* ---------------- HUD ---------------- */

let layoutReady = false;

async function initHud() {
  if (layoutReady) return true;
  try {
    await loadLayout();
    layoutReady = true;
    hudStatus.className = 'ctx-note';
    hudStatus.textContent = '';
    return true;
  } catch {
    hudPanel.hidden = true;
  bannerPanel.hidden = true;
    hudStatus.className = 'ctx-note is-error';
    hudStatus.textContent = '读不到 ui_source/ui_layout.json，HUD 布局不可用。';
    return false;
  }
}

/** 把小地图挪到原作布局里的那个位置和大小。 */
function snapMinimapToLayout() {
  const slot = minimapSlot();
  if (!slot) return;
  mapState.x = slot.x;
  mapState.y = slot.y;
  mapState.diameter = slot.diameter;
  refreshMap();
}

let weatherToken = 0;

/** 有坐标 + 拍摄时间就去查当时的天气，填进 HUD。 */
async function loadWeather() {
  if (!layoutReady) return;
  const { lat, lon, takenAt } = place;
  if (lat === null || lon === null || !takenAt) {
    hudStatus.className = 'ctx-note';
    hudStatus.textContent = '填上坐标和拍摄时间就能查到当时的天气。';
    return;
  }

  const token = ++weatherToken;
  hudStatus.className = 'ctx-note';
  hudStatus.textContent = '正在查询拍摄当时的天气…';
  try {
    const r = await fetch(
      `/api/weather?lat=${lat}&lon=${lon}&at=${encodeURIComponent(takenAt)}`);
    const d = await r.json();
    if (token !== weatherToken) return;
    if (!r.ok || !d.ok) throw new Error(d.detail || d.error || '查询失败');

    hudState.temperature = d.temperature;
    hudState.weatherText = d.text;
    inWeather.value = d.text;
    paintHud();
    hudStatus.textContent =
      `${d.text} · ${d.temperature}°C（${d.time} 实况，来自 Open-Meteo）`;
  } catch (err) {
    if (token !== weatherToken) return;
    hudStatus.className = 'ctx-note is-error';
    hudStatus.textContent = `天气查询失败：${err.message}。天气文字可以手填。`;
  }
}

function paintHud({ snap = false } = {}) {
  if (!layoutReady) return;
  renderHud();
  if (snap) snapMinimapToLayout();
}

/* ---------------- 元信息 ---------------- */

function renderMeta(info) {
  const [ow, oh] = info.original_size;
  const rows = [
    ['文件名', info.filename || '(未命名)'],
    ['格式', info.format || '未知'],
    ['原图尺寸', `${ow} × ${oh}（${(ow * oh / 1e6).toFixed(1)} MP）`],
    ['文件大小', formatBytes(info.bytes)],
    ['预览尺寸', info.preview_size.join(' × ')],
  ];
  metaEl.innerHTML = rows
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

/* ---------------- 上传 ---------------- */

async function uploadPhoto(file) {
  dropzone.classList.add('is-busy');
  setStatus(`正在处理 ${file.name}…`);

  const body = new FormData();
  body.append('photo', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.detail || `上传失败（HTTP ${res.status}）`);

    current = data;
    // 等图片真的解码完，stage 才有尺寸，小地图的比例定位才算得准
    await new Promise((done) => {
      photoEl.onload = done;
      photoEl.onerror = done;
      photoEl.src = data.preview_url;
    });
    renderMeta(data);
    workspace.hidden = false;
    dropzone.classList.add('is-compact');
    fillContext(data.context);

    if (await initHud()) {
      hudPanel.hidden = false;
      bannerPanel.hidden = false;
      // 拍摄时间直接喂给 HUD 的时钟
      if (data.context.taken_at) {
        hudState.clockText = data.context.taken_at.slice(11, 16);
        inClock.value = hudState.clockText;
      }
      paintHud({ snap: true });
      loadWeather();
    }
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    dropzone.classList.remove('is-busy');
  }
}

/* ---------------- 事件 ---------------- */

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) uploadPhoto(file);
  fileInput.value = '';
});

['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragover');
  }));

['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragover');
  }));

dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) uploadPhoto(file);
});

[latInput, lonInput, timeInput].forEach((el) =>
  el.addEventListener('input', () => syncPlace(current?.context)));

nameInput.addEventListener('input', () => {
  nameTouchedByUser = true;
  place.name = nameInput.value || null;
  syncBanner();
});

/** 地名字段是标题的唯一来源，解析出来和手改都走这里。 */
function syncBanner() {
  hudState.bannerText = nameInput.value || '';
  paintHud();
}

/* ---------------- 方向微调 ---------------- */

// 一个纬度约 111320 米，全球基本恒定。
// 经度不是：同样的度数在赤道最宽、越靠近两极越窄，所以要除以 cos(纬度)。
const METERS_PER_DEG_LAT = 111320;

function nudge(dir) {
  const meters = Number(nudgeMeters.value);
  if (!Number.isFinite(meters) || meters <= 0) return;
  if (place.lat === null || place.lon === null) return;

  let lat = place.lat;
  let lon = place.lon;

  if (dir === 'N' || dir === 'S') {
    lat += (dir === 'N' ? meters : -meters) / METERS_PER_DEG_LAT;
    lat = Math.max(-90, Math.min(90, lat));
  } else {
    // 极点附近 cos 趋近 0，一米也会换算出巨大的经度差，这里兜个底
    const shrink = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    lon += (dir === 'E' ? meters : -meters) / (METERS_PER_DEG_LAT * shrink);
    // 跨过换日线要绕回来，否则会填出 181 这种非法值
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
  }

  latInput.value = lat.toFixed(6);
  lonInput.value = lon.toFixed(6);
  syncPlace(current?.context);
}

document.querySelectorAll('.nudge-btn').forEach((btn) =>
  btn.addEventListener('click', () => nudge(btn.dataset.dir)));

/** 显示当前位置离照片原始位置有多远，方便判断微调过头了没。 */
function updateNudgeInfo(ctx) {
  const canNudge = place.lat !== null && place.lon !== null;
  document.querySelectorAll('.nudge-btn').forEach((b) => { b.disabled = !canNudge; });

  if (!canNudge || !ctx?.has_gps) {
    nudgeInfo.textContent = '';
    return;
  }
  const dLat = (place.lat - ctx.lat) * METERS_PER_DEG_LAT;
  const dLon = (place.lon - ctx.lon) * METERS_PER_DEG_LAT *
               Math.cos((ctx.lat * Math.PI) / 180);
  const dist = Math.hypot(dLat, dLon);
  if (dist < 1) {
    nudgeInfo.textContent = '就在照片位置';
    return;
  }
  const ns = dLat >= 0 ? '北' : '南';
  const ew = dLon >= 0 ? '东' : '西';
  const fmt = (m) => m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
  nudgeInfo.textContent =
    `离照片位置 ${fmt(dist)}（${ns}${fmt(Math.abs(dLat))} ${ew}${fmt(Math.abs(dLon))}）`;
}

/* 改过坐标之后要能退回照片自带的那份。fillContext 干的正是这件事，
 * 直接复用 —— 它会一并重置徽章、清掉手改标记并重新解析地名，
 * 后续的小地图、天气、标题都由 syncPlace 连锁触发。 */
restoreBtn.addEventListener('click', () => {
  if (!current?.context) return;
  qResults.hidden = true;
  qInput.value = '';
  fillContext(current.context);
});

qGo.addEventListener('click', runSearch);
qInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
});

async function loadPalettes() {
  try {
    const r = await fetch('/api/palettes');
    const d = await r.json();
    selPalette.innerHTML = d.palettes
      .map((p) => `<option value="${p.key}">${escapeHtml(p.name)}</option>`)
      .join('');
    selPalette.value = mapState.palette;
  } catch {
    selPalette.innerHTML = '<option value="botw">原作深色</option>';
  }
}
loadPalettes();

onMapStatus((text, isError = false) => {
  mapStatus.textContent = text || '';
  mapStatus.className = 'ctx-note' + (isError ? ' is-error' : '');
});

mapOn.addEventListener('change', () => {
  mapState.enabled = mapOn.checked;
  refreshMap({ redraw: mapOn.checked });
});

// 大小只改显示尺寸，不用重新拉瓦片；范围和色阶必须重画
sZoom.addEventListener('input', () => {
  mapState.zoom = Number(sZoom.value);
  vZoom.textContent = `z${sZoom.value}`;
});
sZoom.addEventListener('change', () => refreshMap());

// 箭头在前端 canvas 图层上画，拖动时即时重绘，不发任何请求
sHeading.addEventListener('input', () => {
  mapState.heading = Number(sHeading.value);
  vHeading.textContent = `${sHeading.value}°`;
  drawMarker();
});

// 箭头大小同样只动 canvas 图层，不回服务器
sMarker.addEventListener('input', () => {
  mapState.markerScale = Number(sMarker.value) / 100;
  vMarker.textContent = `${sMarker.value}%`;
  drawMarker();
});

selPalette.addEventListener('change', () => {
  mapState.palette = selPalette.value;
  refreshMap();
});

sPost.addEventListener('input', () => {
  mapState.posterize = Number(sPost.value);
  vPost.textContent = Number(sPost.value) > 1 ? sPost.value : '关';
});
sPost.addEventListener('change', () => refreshMap());

bannerOn.addEventListener('change', () => {
  hudState.bannerOn = bannerOn.checked;
  paintHud();
});

sBannerSize.addEventListener('input', () => {
  hudState.bannerScale = Number(sBannerSize.value) / 100;
  vBannerSize.textContent = `${sBannerSize.value}%`;
  paintHud();
});

sBannerX.addEventListener('input', () => {
  hudState.bannerX = Number(sBannerX.value) / 100;
  vBannerX.textContent = `${sBannerX.value}%`;
  paintHud();
});

sBannerY.addEventListener('input', () => {
  hudState.bannerY = Number(sBannerY.value) / 100;
  vBannerY.textContent = `${sBannerY.value}%`;
  paintHud();
});

hudOn.addEventListener('change', () => {
  hudState.enabled = hudOn.checked;
  paintHud();
});

sHudScale.addEventListener('input', () => {
  hudState.scale = Number(sHudScale.value) / 100;
  vHudScale.textContent = `${sHudScale.value}%`;
  paintHud({ snap: true });
});

sHearts.addEventListener('input', () => {
  hudState.hearts = Number(sHearts.value);
  vHearts.textContent = sHearts.value;
  // 剩余心心不能超过总数
  if (hudState.heartsFull > hudState.hearts) {
    hudState.heartsFull = hudState.hearts;
    sHeartsFull.value = String(hudState.hearts);
    vHeartsFull.textContent = sHeartsFull.value;
  }
  sHeartsFull.max = sHearts.value;
  paintHud();
});

sHeartsFull.addEventListener('input', () => {
  hudState.heartsFull = Math.min(Number(sHeartsFull.value), hudState.hearts);
  sHeartsFull.value = String(hudState.heartsFull);
  vHeartsFull.textContent = sHeartsFull.value;
  paintHud();
});

inWeather.addEventListener('input', () => {
  hudState.weatherText = inWeather.value;
  paintHud();
});

inClock.addEventListener('input', () => {
  hudState.clockText = inClock.value;
  paintHud();
});

const exportBtn = document.getElementById('export');
const exportStatus = document.getElementById('export-status');

exportBtn.addEventListener('click', async () => {
  if (!current) return;
  exportBtn.disabled = true;
  exportStatus.className = 'ctx-note';
  exportStatus.textContent = '正在按原图分辨率合成…';
  try {
    const name = (place.name || '照片').replace(/[\\/:*?"<>|]/g, '_');
    const r = await exportPhoto(current.id, `${name}.png`);
    exportStatus.textContent =
      `已导出 ${r.width}×${r.height}，${(r.bytes / 1048576).toFixed(1)} MB`;
  } catch (err) {
    exportStatus.className = 'ctx-note is-error';
    exportStatus.textContent = `导出失败：${err.message}`;
  } finally {
    exportBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', () => {
  current = null;
  place = { lat: null, lon: null, takenAt: null, name: null, source: 'manual' };
  nameTouchedByUser = false;
  resolveToken++;
  workspace.hidden = true;
  mapPanel.hidden = true;
  hudPanel.hidden = true;
  bannerPanel.hidden = true;
  dropzone.classList.remove('is-compact');
  photoEl.removeAttribute('src');
  [latInput, lonInput, timeInput, nameInput].forEach((el) => {
    el.value = '';
    el.classList.remove('is-invalid');
  });
  chipsEl.innerHTML = '';
  qResults.hidden = true;
  hudState.temperature = null;
  weatherToken++;
  mapState.heading = 0;
  sHeading.value = '0';
  vHeading.textContent = '0°';
  mapState.markerScale = 1;
  sMarker.value = '100';
  vMarker.textContent = '100%';
  drawMarker();
  mapState.lat = mapState.lon = null;
  refreshMap({ redraw: false });
  setStatus('');
  exportStatus.textContent = '';
});

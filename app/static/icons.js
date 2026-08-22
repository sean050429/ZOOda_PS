/* 全部 HUD 元件的自绘实现。
 *
 * 有了这一份，重绘模式就完全不依赖 ui_source/ —— 那个目录里是从游戏
 * 截图裁出来的素材，不进版本库。配色都是从原件采样得到的。
 *
 * 每个函数签名统一为 (ctx, w, h)，画在一块已按显示尺寸开好的画布上，
 * 内部一律用相对坐标，因此预览和导出可以共用。
 */

const RED = '#F03030';          // 满心
const SLATE = '#405060';        // 空心、圆盘底
const CREAM = '#F0F0D0';        // 盾牌、剑
const LIME = '#A0C000';         // 相机符文
const YELLOW = '#F0F030';       // 耐力环
const DPAD_FACE = '#E0F0D0';
const DPAD_MARK = '#7F9BAC';
const DISK_BASE = 'rgb(10,12,14)';
const SENSOR_GLYPH = '#7C93A6';
const SOUND_WAVE = '#9A7BC4';

/** 心形：两个圆弧顶 + 下方尖角。 */
function heartPath(ctx, w, h) {
  const t = h * 0.28;                 // 两个圆弧的圆心高度
  const r = w * 0.26;
  ctx.beginPath();
  ctx.moveTo(w / 2, h * 0.99);
  ctx.bezierCurveTo(w * 0.02, h * 0.55, w * 0.06, t * 0.1, w / 2 - r * 0.02, t * 1.15);
  ctx.bezierCurveTo(w * 0.94, t * 0.1, w * 0.98, h * 0.55, w / 2, h * 0.99);
  ctx.closePath();
}

function drawHeart(ctx, w, h, color) {
  ctx.clearRect(0, 0, w, h);
  heartPath(ctx, w, h);
  ctx.fillStyle = color;
  ctx.fill();
}

/** 相机符文：机身 + 取景凸起 + 镜头环。 */
function drawCamera(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = LIME;
  // 顶部左侧的小凸起
  ctx.beginPath();
  ctx.roundRect(w * 0.12, h * 0.02, w * 0.26, h * 0.20, h * 0.05);
  ctx.fill();
  // 机身
  ctx.beginPath();
  ctx.roundRect(0, h * 0.16, w, h * 0.84, h * 0.14);
  ctx.fill();
  // 镜头挖空
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.60, Math.min(w, h) * 0.24, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // 镜头内圈
  ctx.strokeStyle = LIME;
  ctx.lineWidth = Math.min(w, h) * 0.07;
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.60, Math.min(w, h) * 0.13, 0, Math.PI * 2);
  ctx.stroke();
}

/** 盾牌槽：上方圆肩、下方收成尖，只画描边。 */
function drawShield(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const lw = Math.min(w, h) * 0.16;
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  const x0 = lw / 2, x1 = w - lw / 2, top = lw / 2;
  ctx.beginPath();
  ctx.moveTo(x0, top + h * 0.06);
  ctx.quadraticCurveTo(x0, top, x0 + w * 0.16, top);
  ctx.lineTo(x1 - w * 0.16, top);
  ctx.quadraticCurveTo(x1, top, x1, top + h * 0.06);
  ctx.lineTo(x1, h * 0.58);
  ctx.quadraticCurveTo(x1, h * 0.86, w / 2, h - lw / 2);
  ctx.quadraticCurveTo(x0, h * 0.86, x0, h * 0.58);
  ctx.closePath();
  ctx.stroke();
}

/** 十字键：四个圆钮，每个里面一个三角。 */
function drawDpad(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const r = Math.min(w, h) * 0.19;
  const off = Math.min(w, h) * 0.31;
  const cx = w / 2, cy = h / 2;
  const spots = [[0, -off, 0], [off, 0, 90], [0, off, 180], [-off, 0, 270]];
  for (const [dx, dy, deg] of spots) {
    const x = cx + dx, y = cy + dy;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = DPAD_FACE;
    ctx.fill();
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.46);
    ctx.lineTo(r * 0.42, r * 0.30);
    ctx.lineTo(-r * 0.42, r * 0.30);
    ctx.closePath();
    ctx.fillStyle = DPAD_MARK;
    ctx.fill();
    ctx.restore();
  }
}

/** 武器槽：一把斜指右上的剑。 */
function drawSword(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(Math.PI / 4);   // 原件剑尖指向右上，顺时针转
  const L = Math.min(w, h);
  ctx.fillStyle = CREAM;
  // 剑身
  ctx.beginPath();
  ctx.moveTo(0, -L * 0.52);
  ctx.lineTo(L * 0.10, -L * 0.34);
  ctx.lineTo(L * 0.10, L * 0.12);
  ctx.lineTo(-L * 0.10, L * 0.12);
  ctx.lineTo(-L * 0.10, -L * 0.34);
  ctx.closePath();
  ctx.fill();
  // 护手
  ctx.beginPath();
  ctx.roundRect(-L * 0.28, L * 0.12, L * 0.56, L * 0.10, L * 0.04);
  ctx.fill();
  // 剑柄
  ctx.beginPath();
  ctx.roundRect(-L * 0.07, L * 0.22, L * 0.14, L * 0.24, L * 0.04);
  ctx.fill();
  ctx.restore();
}

/** 耐力环：外缘带齿的黄色圆环。 */
function drawStamina(ctx, w, h) {
  ctx.clearRect(0, 0, w, h);
  const c = Math.min(w, h) / 2;
  const cx = w / 2, cy = h / 2;
  // 原件外缘只是轻微起伏，不是尖齿：用较多的段数和很浅的深度，
  // 再用曲线连起来，避免出现锯齿感
  const bumps = 13;
  const steps = bumps * 12;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
    const rr = c * (0.96 + 0.04 * Math.cos(a * bumps));
    const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = YELLOW;
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(cx, cy, c * 0.40, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function diskBase(ctx, w) {
  ctx.clearRect(0, 0, w, w);
  ctx.beginPath();
  ctx.arc(w / 2, w / 2, w * 0.49, 0, Math.PI * 2);
  ctx.fillStyle = DISK_BASE;
  ctx.fill();
}

/** 希卡感应器：同心弧 + 中心圆点与短柄。 */
function drawSensor(ctx, w) {
  diskBase(ctx, w);
  const cx = w / 2, cy = w * 0.54;
  ctx.strokeStyle = SENSOR_GLYPH;
  ctx.lineCap = 'round';
  for (let i = 1; i <= 3; i++) {
    ctx.lineWidth = w * 0.035;
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.10 * i + w * 0.06, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.fillStyle = SENSOR_GLYPH;
  ctx.beginPath();
  ctx.arc(cx, cy, w * 0.055, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.035, cy);
  ctx.lineTo(cx + w * 0.035, cy);
  ctx.lineTo(cx, cy + w * 0.20);
  ctx.closePath();
  ctx.fill();
}

/** 声音圆盘：一条横贯的紫色波形。 */
function drawSound(ctx, w) {
  diskBase(ctx, w);
  const cy = w / 2;
  ctx.strokeStyle = SOUND_WAVE;
  ctx.lineWidth = w * 0.028;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  // 固定波形，不随机 —— 每次重画都要一样，否则调滑块时会抖
  const amps = [0.005, 0.035, 0.015, 0.055, 0.02, 0.045, 0.01, 0.03, 0.005];
  const x0 = w * 0.14, x1 = w * 0.86;
  for (let i = 0; i < amps.length; i++) {
    const x = x0 + ((x1 - x0) * i) / (amps.length - 1);
    const y = cy + (i % 2 ? amps[i] : -amps[i]) * w;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

/** id → 绘制函数。这张表覆盖了全部还需要素材的元件。 */
export const ICONS = {
  heart_full: (ctx, w, h) => drawHeart(ctx, w, h, RED),
  heart_empty: (ctx, w, h) => drawHeart(ctx, w, h, SLATE),
  rune_camera: drawCamera,
  shield_slot: drawShield,
  dpad_cluster: drawDpad,
  weapon_slot_sword: drawSword,
  stamina_wheel: drawStamina,
  disk_sheikah_sensor: (ctx, w) => drawSensor(ctx, w),
  disk_sound: (ctx, w) => drawSound(ctx, w),
};

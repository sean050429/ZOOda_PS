/* 一键导出：按原图分辨率把照片和整套 HUD 合成一张 PNG。
 *
 * 底图不用预览那张（最长边只有 2000px），而是找服务端要一张按 EXIF
 * 方向转正的全尺寸 JPEG —— 原图可能是 HEIC，浏览器直接解不了。
 */

import { drawHudOnCanvas } from '/hud.js';
import { drawMinimapOnCanvas } from '/minimap.js';

export async function exportPhoto(photoId, filename = 'zelda.png') {
  if (!photoId) throw new Error('还没有照片');

  const photo = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('原图加载失败'));
    im.src = `/api/full/${photoId}`;
  });

  const cv = document.createElement('canvas');
  cv.width = photo.naturalWidth;
  cv.height = photo.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.drawImage(photo, 0, 0);

  // 顺序要和预览一致：小地图在 HUD 之下
  await drawMinimapOnCanvas(ctx, cv.width, cv.height);
  await drawHudOnCanvas(ctx, cv.width, cv.height);

  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  if (!blob) throw new Error('画布导出失败');

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return { width: cv.width, height: cv.height, bytes: blob.size };
}

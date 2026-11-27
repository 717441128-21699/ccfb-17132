// 栅格图像工具：缩放、采样、统计、邻域、mask 填充。纯 TypedArray，环境无关。
import type { Raster } from './types';

export type { Raster } from './types';

export function createRaster(width: number, height: number, fill = 0): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill !== 0) data.fill(fill);
  return { width, height, data };
}

export function getPixel(img: Raster, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function setPixel(img: Raster, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** 区域均值降采样（box），输出整数倍缩小的图 */
export function downsampleBox(img: Raster, factor: number): Raster {
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const out = createRaster(w, h);
  const f2 = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < factor; sy++) {
        const srcRow = (y * factor + sy) * img.width;
        for (let sx = 0; sx < factor; sx++) {
          const i = (srcRow + x * factor + sx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / f2;
      out.data[o + 1] = g / f2;
      out.data[o + 2] = b / f2;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 缩放到指定尺寸（面积采样，目标更小或相近时使用） */
export function resizeTo(img: Raster, dstW: number, dstH: number): Raster {
  const out = createRaster(dstW, dstH);
  const sxRatio = img.width / dstW;
  const syRatio = img.height / dstH;
  for (let y = 0; y < dstH; y++) {
    const sy0 = Math.floor(y * syRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * syRatio));
    for (let x = 0; x < dstW; x++) {
      const sx0 = Math.floor(x * sxRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * sxRatio));
      let r = 0;
      let g = 0;
      let b = 0;
      let cnt = 0;
      for (let sy = sy0; sy < Math.min(sy1, img.height); sy++) {
        for (let sx = sx0; sx < Math.min(sx1, img.width); sx++) {
          const i = (sy * img.width + sx) * 4;
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          cnt++;
        }
      }
      const o = (y * dstW + x) * 4;
      out.data[o] = r / cnt;
      out.data[o + 1] = g / cnt;
      out.data[o + 2] = b / cnt;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 转灰度（Rec.601） */
export function toGray(img: Raster): Float64Array {
  const gray = new Float64Array(img.width * img.height);
  for (let i = 0, p = 0; i < img.data.length; i += 4, p++) {
    gray[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return gray;
}

/** 双线性采样（坐标可越界，越界返回 null） */
export function sampleBilinear(img: Raster, x: number, y: number): [number, number, number] | null {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  if (x0 < 0 || y0 < 0 || x1 >= img.width || y1 >= img.height) return null;
  const fx = x - x0;
  const fy = y - y0;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + img.width * 4;
  const i11 = i01 + 4;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = img.data[i00 + c] * (1 - fx) + img.data[i10 + c] * fx;
    const bot = img.data[i01 + c] * (1 - fx) + img.data[i11 + c] * fx;
    out[c] = top * (1 - fy) + bot * fy;
  }
  return out;
}

/** 3x3 邻域均值（用于盐花/泥斑的空间连通判断） */
export function localMean(img: Raster, x: number, y: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= img.height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= img.width) continue;
      const i = (yy * img.width + xx) * 4;
      r += img.data[i];
      g += img.data[i + 1];
      b += img.data[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** 将一张源图按整数偏移写入目标（alpha 混合权重 0..1），返回权重图（Uint8, 0..255） */
export function blendInto(
  dst: Raster,
  src: Raster,
  offsetX: number,
  offsetY: number,
  weight: Uint8Array | null,
  globalAlpha: number,
): void {
  const x0 = Math.max(0, offsetX);
  const y0 = Math.max(0, offsetY);
  const x1 = Math.min(dst.width, offsetX + src.width);
  const y1 = Math.min(dst.height, offsetY + src.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const sx = x - offsetX;
      const sy = y - offsetY;
      const si = (sy * src.width + sx) * 4;
      const di = (y * dst.width + x) * 4;
      const wPx = weight ? weight[sy * src.width + sx] / 255 : 1;
      const a = globalAlpha * wPx;
      if (a <= 0) continue;
      dst.data[di] = dst.data[di] * (1 - a) + src.data[si] * a;
      dst.data[di + 1] = dst.data[di + 1] * (1 - a) + src.data[si + 1] * a;
      dst.data[di + 2] = dst.data[di + 2] * (1 - a) + src.data[si + 2] * a;
      dst.data[di + 3] = 255;
    }
  }
}

/** 简单直方图（单通道） */
export function histogram(channel: Uint8ClampedArray | Float64Array, bins: number, min = 0, max = 255): number[] {
  const h = new Array(bins).fill(0);
  const scale = bins / (max - min);
  for (let i = 0; i < channel.length; i++) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((channel[i] - min) * scale)));
    h[b]++;
  }
  return h;
}

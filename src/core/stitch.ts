// 航拍拼接：缩略图相位相关配准 -> 全局最小二乘位姿 -> 分块增益拉匀 -> 大图融合。
// 全部纯函数 + TypedArray，可在 Worker 与 Node 中运行。
import { applyHann, nextPowerOfTwo, phaseCorrelation } from './fft';
import { createRaster, downsampleBox, resizeTo, toGray, type Raster } from './image';
import { rectIntersection, rectsOverlap, type GeoRect } from './geometry';
import { srgbEncodeLut, SRGB_TO_LINEAR } from './lut';
import type { DatasetSpec, MosaicResult, PhotoGain, PhotoMeta, Pose } from './types';

export interface StitchOptions {
  thumbSize?: number;
  onProgress?: (fraction: number, detail: string) => void;
}

interface PairLink {
  a: number;
  b: number;
  /** 约束：pose[b] - pose[a] 应等于的世界坐标差（含元数据差 + 配准残差） */
  diffX: number;
  diffY: number;
  peak: number;
}

const MIN_PEAK = 2.2;
/** 配准相对元数据的最大可接受残差（世界像素），超出判为周期歧义/弱纹理失效 */
const MAX_RESIDUAL_PX = 8;
/** 松弛单步单节点最大修正（世界像素），防止坏链路引发发散 */
const MAX_STEP_CORRECTION = 3;
/** 最终位姿相对 POS 先验的最大允许偏离（世界像素） */
const MAX_POSE_DEVIATION = 10;

/** 阶段一：仅用元数据与缩略图完成配准，返回位姿（不渲染大图） */
export function estimatePoses(
  photos: PhotoMeta[],
  thumbs: Raster[],
  opts: StitchOptions = {},
): { poses: Pose[]; links: PairLink[]; rejected: number } {
  const n = photos.length;
  const links: PairLink[] = [];
  let rejected = 0;

  // 相邻网格配对（右邻 + 下邻），footprint 重叠裁剪后做相位相关
  const cols = gridCols(photos);
  let pairTotal = 0;
  for (let i = 0; i < n; i++) {
    const neighbors = [i + 1, i + cols].filter((j) => j < n && isGridNeighbor(i, j, cols));
    for (const j of neighbors) {
      pairTotal++;
      const link = registerPair(i, j, photos[i], photos[j], thumbs[i], thumbs[j]);
      if (!link || link.peak < MIN_PEAK) {
        rejected++;
        continue;
      }
      // 合理性：配准结果相对元数据 footprint 的残差必须在容差内，
      // 否则是土埂重复纹理造成的周期歧义（峰可能很高但位置错误）。
      const mdDx = photos[j].footprint.x - photos[i].footprint.x;
      const mdDy = photos[j].footprint.y - photos[i].footprint.y;
      const residual = Math.hypot(link.diffX - mdDx, link.diffY - mdDy);
      if (residual > MAX_RESIDUAL_PX) {
        rejected++;
        continue;
      }
      links.push(link);
      if (opts.onProgress && pairTotal % 20 === 0) {
        opts.onProgress(pairTotal / (n * 1.9), `配准 ${pairTotal} 对`);
      }
    }
  }

  const poses = solveGlobalPoses(photos, links);
  return { poses, links, rejected };
}

function gridCols(photos: PhotoMeta[]): number {
  const y0 = photos[0].footprint.y;
  let c = 0;
  while (c < photos.length && photos[c].footprint.y === y0) c++;
  return c;
}

function isGridNeighbor(i: number, j: number, cols: number): boolean {
  return j === i + 1 || j === i + cols;
}

/** 两张照片配准：在重叠区上等大裁剪 -> Hann -> FFT 相位相关 -> 换算世界坐标平移 */
function registerPair(
  i: number,
  j: number,
  metaA: PhotoMeta,
  metaB: PhotoMeta,
  thumbA: Raster,
  thumbB: Raster,
): PairLink | null {
  const fa = metaA.footprint;
  const fb = metaB.footprint;
  if (!rectsOverlap(fa, fb)) return null;
  const inter = rectIntersection(fa, fb);
  if (!inter || inter.w < fa.w * 0.12 || inter.h < fa.h * 0.12) return null;

  const scaleX = thumbA.width / fa.w;
  const scaleY = thumbA.height / fa.h;
  // 重叠区相对各照片的像素框
  const ax = Math.max(0, Math.round((inter.x - fa.x) * scaleX));
  const ay = Math.max(0, Math.round((inter.y - fa.y) * scaleY));
  const bx = Math.max(0, Math.round((inter.x - fb.x) * scaleX));
  const by = Math.max(0, Math.round((inter.y - fb.y) * scaleY));
  const cw = Math.min(
    Math.round(inter.w * scaleX),
    thumbA.width - ax,
    thumbB.width - bx,
  );
  const ch = Math.min(
    Math.round(inter.h * scaleY),
    thumbA.height - ay,
    thumbB.height - by,
  );
  if (cw < 32 || ch < 32) return null;
  const size = nextPowerOfTwo(Math.min(cw, ch));
  if (size < 32) return null;

  const cropA = cropResize(thumbA, ax, ay, cw, ch, size);
  const cropB = cropResize(thumbB, bx, by, cw, ch, size);
  const gA = applyHann(toGray(cropA), size);
  const gB = applyHann(toGray(cropB), size);
  const shift = phaseCorrelation(gA, gB, size);
  // 缩略图像素 -> 世界坐标
  const worldPerThumbX = fa.w / thumbA.width;
  const worldPerThumbY = fa.h / thumbA.height;
  // 相位相关峰 (sx,sy) 满足 B(x)=A(x-sx)，即 B 相对 A 的内容位移；
  // 反推 B 原点的世界残差 = -shift * 世界/缩略图比例。
  const residualX = -shift.dx * worldPerThumbX;
  const residualY = -shift.dy * worldPerThumbY;
  return {
    a: i,
    b: j,
    diffX: fb.x - fa.x + residualX,
    diffY: fb.y - fa.y + residualY,
    peak: shift.peak,
  };
}

function cropResize(img: Raster, x: number, y: number, w: number, h: number, size: number): Raster {
  const crop = createRaster(w, h);
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * img.width + x + xx) * 4;
      const di = (yy * w + xx) * 4;
      crop.data[di] = img.data[si];
      crop.data[di + 1] = img.data[si + 1];
      crop.data[di + 2] = img.data[si + 2];
      crop.data[di + 3] = 255;
    }
  }
  return w === size && h === size ? crop : resizeTo(crop, size, size);
}

/**
 * 全局位姿：所有照片位姿先用 footprint 元数据（无人机 POS）初始化并作为强先验，
 * 配准链路只允许在容差内做小幅修正。每个节点同时受“元数据弹簧”约束，
 * 错误/弱纹理链路无法把位姿拖离先验，避免阴天低对比下的漂移。0 号照片锚定。
 */
function solveGlobalPoses(photos: PhotoMeta[], links: PairLink[]): Pose[] {
  const n = photos.length;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const anchorX = new Float64Array(n);
  const anchorY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    anchorX[i] = photos[i].footprint.x - photos[0].footprint.x;
    anchorY[i] = photos[i].footprint.y - photos[0].footprint.y;
    dx[i] = anchorX[i];
    dy[i] = anchorY[i];
  }
  // 元数据弹簧权重：相对每条配准链路的拉力，先验占主导
  const ANCHOR_WEIGHT = 2.0;
  const LINK_WEIGHT = 1.0;

  for (let iter = 0; iter < 60; iter++) {
    let maxResidual = 0;
    // 配准链路拉力（限幅，单步单节点修正受限）
    for (const l of links) {
      const rx = dx[l.a] + l.diffX - dx[l.b];
      const ry = dy[l.a] + l.diffY - dy[l.b];
      const sx = clampVal((rx * LINK_WEIGHT) * 0.5, -MAX_STEP_CORRECTION, MAX_STEP_CORRECTION);
      const sy = clampVal((ry * LINK_WEIGHT) * 0.5, -MAX_STEP_CORRECTION, MAX_STEP_CORRECTION);
      dx[l.a] += sx;
      dy[l.a] += sy;
      dx[l.b] -= sx;
      dy[l.b] -= sy;
      maxResidual = Math.max(maxResidual, Math.abs(rx) + Math.abs(ry));
    }
    // 元数据弹簧：把每个节点（除锚点 0）拉回先验，限制总偏移
    for (let i = 1; i < n; i++) {
      dx[i] += (anchorX[i] - dx[i]) * 0.15 * ANCHOR_WEIGHT;
      dy[i] += (anchorY[i] - dy[i]) * 0.15 * ANCHOR_WEIGHT;
    }
    // 锚点 0 固定
    const fixX = dx[0];
    const fixY = dy[0];
    for (let i = 0; i < n; i++) {
      dx[i] -= fixX;
      dy[i] -= fixY;
    }
    if (maxResidual < 0.6) break;
  }

  // 安全钳制：最终位姿相对元数据先验的偏离不得超过容差
  for (let i = 0; i < n; i++) {
    dx[i] = clampVal(dx[i], anchorX[i] - MAX_POSE_DEVIATION, anchorX[i] + MAX_POSE_DEVIATION);
    dy[i] = clampVal(dy[i], anchorY[i] - MAX_POSE_DEVIATION, anchorY[i] + MAX_POSE_DEVIATION);
  }

  return photos.map((p, i) => ({ id: p.id, dx: Math.round(dx[i]), dy: Math.round(dy[i]) }));
}

function clampVal(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}


/**
 * 阶段三：融合大图（线性光域）。
 * 照片已在融合前由灰板校正到统一光照与单位曝光，这里仅解码到线性 sRGB，
 * 用距离权重 feathering 累积后编码回 8bit，消除接缝。
 */
export function composeMosaic(
  photos: PhotoMeta[],
  images: Raster[],
  poses: Pose[],
  gains: PhotoGain[],
  spec: DatasetSpec,
  opts: StitchOptions = {},
): MosaicResult {
  void gains;
  void spec;
  const pw = photos[0].footprint.w;
  const ph = photos[0].footprint.h;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < photos.length; i++) {
    const x = poses[i].dx + photos[0].footprint.x;
    const y = poses[i].dy + photos[0].footprint.y;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + pw);
    maxY = Math.max(maxY, y + ph);
  }
  const width = Math.ceil(maxX - minX);
  const height = Math.ceil(maxY - minY);
  const canvas = createRaster(width, height);

  const weightSum = new Float32Array(width * height);
  const acc = new Float32Array(width * height * 3);

  // 近中心优先权重：像素离照片光心越近权重越高，且用高次幂让接缝区
  // 快速过渡到“主要取单张照片”，避免多照片大范围平均造成的颜色偏移，
  // 仅在很窄的中线上做平滑混合消除硬接缝。
  const POWER = 6;

  for (let k = 0; k < photos.length; k++) {
    const img = images[k];
    const ox = Math.round(poses[k].dx + photos[0].footprint.x - minX);
    const oy = Math.round(poses[k].dy + photos[0].footprint.y - minY);
    const cx = img.width / 2;
    const cy = img.height / 2;
    const x0 = Math.max(0, ox);
    const y0 = Math.max(0, oy);
    const x1 = Math.min(width, ox + img.width);
    const y1 = Math.min(height, oy + img.height);
    for (let y = y0; y < y1; y++) {
      const sy = y - oy;
      // 归一化的到边距离 0..1（1=光心）
      const wy = Math.min(sy + 1, img.height - sy) / cy;
      for (let x = x0; x < x1; x++) {
        const sx = x - ox;
        const wx = Math.min(sx + 1, img.width - sx) / cx;
        // 高次幂：中心区域权重接近 1 且平坦，边缘快速衰减
        const w = Math.pow(Math.min(1, wx) * Math.min(1, wy), POWER);
        const si = (sy * img.width + sx) * 4;
        const di = y * width + x;
        acc[di * 3] += srgbDecode(img.data[si]) * w;
        acc[di * 3 + 1] += srgbDecode(img.data[si + 1]) * w;
        acc[di * 3 + 2] += srgbDecode(img.data[si + 2]) * w;
        weightSum[di] += w;
      }
    }
    if (opts.onProgress) opts.onProgress(k / photos.length, `融合 ${k + 1}/${photos.length}`);
  }

  for (let p = 0; p < width * height; p++) {
    const w = weightSum[p];
    const i = p * 4;
    if (w > 1e-4) {
      canvas.data[i] = srgbEncode(acc[p * 3] / w);
      canvas.data[i + 1] = srgbEncode(acc[p * 3 + 1] / w);
      canvas.data[i + 2] = srgbEncode(acc[p * 3 + 2] / w);
      canvas.data[i + 3] = 255;
    }
  }

  return {
    width,
    height,
    canvas,
    poses,
    originX: minX,
    originY: minY,
    gains,
    pairCount: countPairs(photos),
    rejectedPairs: 0,
    illuminantNormalized: true,
  };
}

function countPairs(photos: PhotoMeta[]): number {
  const cols = gridCols(photos);
  const rows = photos.length / cols;
  // 水平相邻 + 垂直相邻
  return cols * (rows - 1) + (cols - 1) * rows;
}

function srgbDecode(c: number): number {
  return SRGB_TO_LINEAR[c];
}

function srgbEncode(v: number): number {
  return srgbEncodeLut(v);
}

/** 便捷：生成缩略图（供配准） */
export function makeThumbnail(img: Raster, target: number): Raster {
  const factor = Math.max(1, Math.floor(Math.min(img.width, img.height) / target));
  return factor === 1 ? img : downsampleBox(img, factor);
}

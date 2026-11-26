// 航拍拼接核心（与 DOM 无关，可在 Worker / Node 测试中运行）：
//  1) 以土埂本色为光照锚，估计每张照片的分通道增益，统一曝光/色温（早晚校正）
//  2) 土埂像素投票 -> 规则直线网格 -> 按“照片内土埂与网格贴合”搜索精修位姿
//  3) 羽化加权融合成一张大图，重叠区把同一块池子的亮度拉匀
import { isRidgePixel } from './classify';
import { median } from './color';
import { detectGrid, detectRegularLines, segmentPans, smooth1d, type Grid } from './segment';
import type { Pan, Photo, PhotoPose, StitchResult } from './types';

// 规范光照下的土埂参考色（光照锚）。合成世界的土埂中值围绕该值。
export const CANONICAL_RIDGE = { r: 184, g: 160, b: 128 };

export interface PhotoLighting {
  gain: { r: number; g: number; b: number };
  /** 照片局部坐标的土埂点，扁平 [x0,y0,x1,y1,...] */
  ridgePts: number[];
  ridgeCount: number;
}

export interface StitchOutput extends StitchResult {
  grid: Grid;
  pans: Pan[];
}

type Progress = (frac: number, label: string) => void;

const noProgress: Progress = () => {};

/** 估计单张照片的光照增益并抽取空间均匀的土埂对齐点（蓄水池采样，覆盖全图） */
export function analyzePhotoLighting(photo: Photo): PhotoLighting {
  const { data, width: w, height: h } = photo;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const CAP = 520;
  const pts: number[] = [];
  let seen = 0;
  let ridgeCount = 0;

  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (isRidgePixel(r, g, b)) {
        ridgeCount++;
        rs.push(r);
        gs.push(g);
        bs.push(b);
        // 蓄水池采样：保证点在整张照片上空间均匀，而不是堆在顶部
        seen++;
        if (pts.length / 2 < CAP) {
          pts.push(x, y);
        } else {
          const j = Math.floor(hash01(seen) * seen);
          if (j < CAP) {
            pts[j * 2] = x;
            pts[j * 2 + 1] = y;
          }
        }
      }
    }
  }

  let gain = { r: 1, g: 1, b: 1 };
  if (rs.length >= 24) {
    const mr = median(rs);
    const mg = median(gs);
    const mb = median(bs);
    gain = {
      r: clampGain(CANONICAL_RIDGE.r / Math.max(8, mr)),
      g: clampGain(CANONICAL_RIDGE.g / Math.max(8, mg)),
      b: clampGain(CANONICAL_RIDGE.b / Math.max(8, mb)),
    };
  }
  return { gain, ridgePts: pts, ridgeCount };
}

function clampGain(v: number): number {
  return v < 0.6 ? 0.6 : v > 1.7 ? 1.7 : v;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 用初始位姿把土埂点投入世界，形成列/行投票（直接累加进投影数组，省一张大图） */
function accumulateRidgeVotes(
  photos: Photo[],
  lighting: PhotoLighting[],
  width: number,
  height: number,
): { col: Float32Array; row: Float32Array } {
  const col = new Float32Array(width);
  const row = new Float32Array(height);
  photos.forEach((p, idx) => {
    const pose = p.pose;
    const cos = Math.cos(pose.rotation);
    const sin = Math.sin(pose.rotation);
    const hw = p.width / 2;
    const hh = p.height / 2;
    const pts = lighting[idx].ridgePts;
    for (let k = 0; k < pts.length; k += 2) {
      const lx = (pts[k] - hw) * pose.scale;
      const ly = (pts[k + 1] - hh) * pose.scale;
      const wx = pose.cx + (lx * cos - ly * sin);
      const wy = pose.cy + (lx * sin + ly * cos);
      const xi = wx | 0;
      const yi = wy | 0;
      if (xi >= 0 && xi < width) col[xi] += 1;
      if (yi >= 0 && yi < height) row[yi] += 1;
    }
  });
  return { col, row };
}

function nearestLineDist(v: number, lines: number[]): number {
  let d = Infinity;
  for (const l of lines) {
    const a = Math.abs(v - l);
    if (a < d) d = a;
  }
  return d;
}

/** 搜索每张照片的平移修正，使照片内土埂最贴近全局直线网格 */
function refinePoseToGrid(
  photo: Photo,
  light: PhotoLighting,
  grid: Grid,
): { pose: PhotoPose; score: number } {
  const pose = { ...photo.pose };
  const cos = Math.cos(pose.rotation);
  const sin = Math.sin(pose.rotation);
  const hw = photo.width / 2;
  const hh = photo.height / 2;
  const pts = light.ridgePts;
  // 抽稀到至多 ~260 点
  const step = Math.max(2, Math.floor(pts.length / 2 / 260) * 2 || 2);

  const scoreAt = (dx: number, dy: number): number => {
    let s = 0;
    let n = 0;
    const cx = pose.cx + dx;
    const cy = pose.cy + dy;
    for (let k = 0; k < pts.length; k += step) {
      const lx = (pts[k] - hw) * pose.scale;
      const ly = (pts[k + 1] - hh) * pose.scale;
      const wx = cx + (lx * cos - ly * sin);
      const wy = cy + (lx * sin + ly * cos);
      const d = Math.min(nearestLineDist(wx, grid.gridX), nearestLineDist(wy, grid.gridY));
      s += Math.exp(-(d * d) / (2 * 4.5 * 4.5));
      n++;
    }
    return n ? s / n : 0;
  };

  let bestDx = 0;
  let bestDy = 0;
  let bestScore = scoreAt(0, 0);
  const score0 = bestScore;
  for (let dx = -7; dx <= 7; dx += 2) {
    for (let dy = -7; dy <= 7; dy += 2) {
      const s = scoreAt(dx, dy);
      if (s > bestScore) {
        bestScore = s;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // 细搜
  const cdx = bestDx;
  const cdy = bestDy;
  for (let dx = cdx - 2; dx <= cdx + 2.001; dx += 1) {
    for (let dy = cdy - 2; dy <= cdy + 2.001; dy += 1) {
      const s = scoreAt(dx, dy);
      if (s > bestScore) {
        bestScore = s;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }
  // 门控：贴合度没有显著提升就保留原 GPS 位姿，避免被噪声网格带偏
  if (bestScore > score0 + 0.015 && bestScore >= score0 * 1.05) {
    pose.cx += bestDx;
    pose.cy += bestDy;
  }
  return { pose, score: bestScore };
}

function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** 羽化加权融合所有（已校正增益、已精修位姿）照片 */
function composeMosaic(
  photos: Photo[],
  lighting: PhotoLighting[],
  poses: PhotoPose[],
  width: number,
  height: number,
): Uint8ClampedArray {
  const accR = new Float32Array(width * height);
  const accG = new Float32Array(width * height);
  const accB = new Float32Array(width * height);
  const accW = new Float32Array(width * height);
  const FEATHER = 16;

  photos.forEach((photo, idx) => {
    const pose = poses[idx];
    const gain = lighting[idx].gain;
    const cos = Math.cos(pose.rotation);
    const sin = Math.sin(pose.rotation);
    const hw = photo.width / 2;
    const hh = photo.height / 2;

    // 旋转后足迹的世界包围盒
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([lx, ly]) => {
      const wx = pose.cx + (lx * pose.scale * cos - ly * pose.scale * sin);
      const wy = pose.cy + (lx * pose.scale * sin + ly * pose.scale * cos);
      return [wx, wy];
    });
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[0]))));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(...corners.map((c) => c[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((c) => c[1]))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...corners.map((c) => c[1]))));

    for (let wy = minY; wy <= maxY; wy++) {
      for (let wx = minX; wx <= maxX; wx++) {
        const dx = wx + 0.5 - pose.cx;
        const dy = wy + 0.5 - pose.cy;
        // 世界 -> 照片局部（逆旋转）
        const lxw = dx * cos + dy * sin;
        const lyw = -dx * sin + dy * cos;
        const px = lxw / pose.scale + hw;
        const py = lyw / pose.scale + hh;
        if (px < 0 || py < 0 || px > photo.width - 1 || py > photo.height - 1) continue;

        const x0 = px | 0;
        const y0 = py | 0;
        const tx = px - x0;
        const ty = py - y0;
        const at = (xx: number, yy: number) => {
          const cx = xx < 0 ? 0 : xx >= photo.width ? photo.width - 1 : xx;
          const cy = yy < 0 ? 0 : yy >= photo.height ? photo.height - 1 : yy;
          const i = (cy * photo.width + cx) * 4;
          return [photo.data[i], photo.data[i + 1], photo.data[i + 2]] as const;
        };
        const c00 = at(x0, y0);
        const c10 = at(x0 + 1, y0);
        const c01 = at(x0, y0 + 1);
        const c11 = at(x0 + 1, y0 + 1);
        const r =
          (c00[0] * (1 - tx) + c10[0] * tx) * (1 - ty) +
          (c01[0] * (1 - tx) + c11[0] * tx) * ty;
        const g =
          (c00[1] * (1 - tx) + c10[1] * tx) * (1 - ty) +
          (c01[1] * (1 - tx) + c11[1] * tx) * ty;
        const b =
          (c00[2] * (1 - tx) + c10[2] * tx) * (1 - ty) +
          (c01[2] * (1 - tx) + c11[2] * tx) * ty;

        const edge = Math.min(px, photo.width - 1 - px, py, photo.height - 1 - py);
        const w = smoothstep01(edge / FEATHER);
        if (w <= 0) continue;

        const oi = wy * width + wx;
        accR[oi] += r * gain.r * w;
        accG[oi] += g * gain.g * w;
        accB[oi] += b * gain.b * w;
        accW[oi] += w;
      }
    }
  });

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const w = accW[i];
    if (w > 1e-4) {
      out[o] = accR[i] / w;
      out[o + 1] = accG[i] / w;
      out[o + 2] = accB[i] / w;
    } else {
      // 未覆盖区：中性滩地色
      out[o] = 168;
      out[o + 1] = 152;
      out[o + 2] = 122;
    }
    out[o + 3] = 255;
  }
  return out;
}

export interface StitchOptions {
  width: number;
  height: number;
  rows: number;
  cols: number;
  onProgress?: Progress;
}

/** 完整拼接流程 */
export function stitchPhotos(photos: Photo[], opts: StitchOptions): StitchOutput {
  const t0 =
    typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const onProgress = opts.onProgress ?? noProgress;
  const { width, height, rows, cols } = opts;

  onProgress(0.05, '估计每张照片光照与土埂锚点');
  const lighting = photos.map(analyzePhotoLighting);

  // 第一遍：用机载近似位姿直接融合，得到对抖动零均值平均的干净网格
  onProgress(0.2, '初拼并拟合土埂直线网格');
  const rawPoses = photos.map((p) => p.pose);
  const preliminary = composeMosaic(photos, lighting, rawPoses, width, height);
  const roughGrid = detectGrid(preliminary, width, height, rows, cols);

  // 以初拼网格为目标，按照片内土埂做平移精修（带门控）
  onProgress(0.42, '按土埂直线精修每张照片位姿');
  const poses: PhotoPose[] = photos.map(
    (p, i) => refinePoseToGrid(p, lighting[i], roughGrid).pose,
  );

  // 第二遍：精修位姿下融合，边沿更锐、同池亮度更匀
  onProgress(0.6, '羽化融合与亮度拉匀');
  const data = composeMosaic(photos, lighting, poses, width, height);

  onProgress(0.88, '在大图上拟合最终网格并吸附土埂内沿');
  const finalGrid = detectGrid(data, width, height, rows, cols);
  const pans = segmentPans(data, width, height, finalGrid);

  // 对齐误差（相对合成真实位姿）
  let se = 0;
  let n = 0;
  photos.forEach((p, i) => {
    if (p.truePose) {
      const dx = poses[i].cx - p.truePose.cx;
      const dy = poses[i].cy - p.truePose.cy;
      se += dx * dx + dy * dy;
      n++;
    }
  });
  const alignRmse = n ? Math.sqrt(se / n) : 0;

  const elapsedMs =
    (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - t0;
  onProgress(1, '拼接完成');

  return {
    width,
    height,
    data,
    gains: lighting.map((l, i) => ({ id: photos[i].id, ...l.gain })),
    alignRmse,
    poses,
    grid: finalGrid,
    pans,
    elapsedMs,
  };
}

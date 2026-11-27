// 合成航拍数据集：按天气、飞行时段、藻类颜色生成带波美真值的盐场航拍照片。
// 输出纯 Raster（无 DOM 依赖），浏览器端通过 putImageData 显示，Node 端可直接跑流水线。
import { GLINT_LAB, zoneBaumeRange } from './brine';
import {
  clampByte,
  labToSrgb,
  mixLab,
  type Lab,
  type RGB,
} from './color';
import { srgbEncodeLut, SRGB_TO_LINEAR } from './lut';
import { createRaster, type Raster } from './image';
import { pointInPolygon } from './geometry';
import { Rng } from './random';
import { buildMaterialMap, MaterialMap } from './material-map';
import type {
  Blob,
  DatasetSpec,
  FlightTime,
  GeoRect,
  PhotoMeta,
  PondDef,
  PondZone,
  ReferencePanel,
  Weather,
} from './types';

export interface GeneratorOptions {
  seed?: number;
  weather?: Weather;
  flightTime?: FlightTime;
  photoWidth?: number;
  photoHeight?: number;
  /** 每行/列照片数（重叠由间距自动产生） */
  gridCols?: number;
  gridRows?: number;
  /** 相邻照片 footprint 的重叠率 0..1 */
  overlap?: number;
  pondCols?: number;
  pondRows?: number;
  /** 随机让一个池子“变淡”（模拟渗漏/进雨水），值为变淡的 Bé 幅度 */
  anomalyDilute?: number;
  /** 池子多边形边角抖动幅度（世界像素），检验边界贴合 */
  jitter?: number;
}

const DEFAULT_PHOTO = 320;
const RIDGE_WIDTH = 26;

export interface GeneratedDataset {
  spec: DatasetSpec;
  /** 惰性取图：根据 photo id 渲染一张 Raster（浏览器/Worker/Node 均可） */
  renderPhoto: (id: number) => Raster;
  /** 直接渲染一张覆盖全场的真值参考图（用于验证，不参与流水线） */
  renderGroundTruth: () => Raster;
}

export function generateDataset(opts: GeneratorOptions = {}): GeneratedDataset {
  const seed = opts.seed ?? 20261128;
  const rng = new Rng(seed);
  const weather: Weather = opts.weather ?? 'sunny';
  const flightTime: FlightTime = opts.flightTime ?? 'morning';
  const pw = opts.photoWidth ?? DEFAULT_PHOTO;
  const ph = opts.photoHeight ?? DEFAULT_PHOTO;
  const cols = opts.gridCols ?? 25;
  const rows = opts.gridRows ?? 20;
  const overlap = opts.overlap ?? 0.55;
  const pondCols = opts.pondCols ?? 6;
  const pondRows = opts.pondRows ?? 4;
  const jitter = opts.jitter ?? 5;

  const stepX = Math.round(pw * (1 - overlap));
  const stepY = Math.round(ph * (1 - overlap));
  const worldWidth = stepX * (cols - 1) + pw;
  const worldHeight = stepY * (rows - 1) + ph;

  const illuminant = buildIlluminant(weather, flightTime, rng);

  // ---- 池子布局：网格状矩形蒸发池，外留埂道 ----
  const margin = 60;
  const gap = RIDGE_WIDTH + 14;
  const cellW = (worldWidth - margin * 2 - gap * (pondCols - 1)) / pondCols;
  const cellH = (worldHeight - margin * 2 - gap * (pondRows - 1)) / pondRows;
  const ponds: PondDef[] = [];
  let pondId = 0;
  const anomalyId = opts.anomalyDilute ? rng.int(0, pondCols * pondRows - 1) : -1;

  for (let r = 0; r < pondRows; r++) {
    for (let c = 0; c < pondCols; c++) {
      const idx = r * pondCols + c;
      const x0 = margin + c * (cellW + gap);
      const y0 = margin + r * (cellH + gap);
      const poly = jitteredRect(x0, y0, cellW, cellH, jitter, rng);
      const zone: PondZone = r < 1 ? 'reservoir' : r >= pondRows - 1 ? 'crystallizer' : 'evaporator';
      const [bLo, bHi] = zoneBaumeRange(zone);
      let baume = rng.range(bLo, bHi);
      if (idx === anomalyId) baume = Math.max(2.5, baume - (opts.anomalyDilute ?? 6));
      // 藻类强度随浓度升高，带散度
      const natural = Math.max(0, (baume - 11) / 15);
      const algaeStrength = Math.min(1, Math.max(0, natural + rng.range(-0.25, 0.25)));
      const saltFraction = zone === 'crystallizer' ? rng.range(0.06, 0.2) : rng.range(0, 0.02);
      const mudFraction = rng.range(0.005, 0.04);
      const saltBlobs = makeBlobs(poly, saltFraction, rng, zone === 'crystallizer' ? 26 : 12);
      const mudBlobs = makeBlobs(poly, mudFraction, rng, 20);
      ponds.push({
        id: pondId,
        name: `${zone === 'reservoir' ? '贮' : zone === 'evaporator' ? '蒸' : '结'}-${String(r + 1).padStart(2, '0')}${String(c + 1).padStart(2, '0')}`,
        polygon: poly,
        baume,
        zone,
        algaeStrength,
        saltFraction,
        mudFraction,
        saltBlobs,
        mudBlobs,
      });
      pondId++;
    }
  }

  // ---- 照片 footprint 网格 ----
  const photos: PhotoMeta[] = [];
  let pid = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const footprint: GeoRect = { x: c * stepX, y: r * stepY, w: pw, h: ph };
      // 曝光差异：单张 EV 抖动 ±9%
      const exposure = rng.range(0.91, 1.09);
      photos.push({
        id: pid++,
        name: `DJI_${String(pid).padStart(4, '0')}.jpg`,
        footprint,
        sunAzimuth: illuminant.azimuth,
        sunElevation: illuminant.elevation,
        weather,
        flightTime,
        exposure,
        seed: rng.int(1, 2 ** 30),
      });
    }
  }

  const spec: DatasetSpec = {
    id: `saltfield-${weather}-${flightTime}-${seed}`,
    weather,
    flightTime,
    worldWidth,
    worldHeight,
    photoWidth: pw,
    photoHeight: ph,
    photos,
    ponds,
    references: buildReferences(worldWidth),
    illuminant: illuminant.scene,
    seed,
  };

  // 世界材质图只构建一次，所有照片共享采样
  const materialMap = buildMaterialMap(spec);

  const renderPhoto = (id: number): Raster =>
    renderPhotoImpl(spec, photos[id], new Rng(photos[id].seed ^ 0x9e3779b9), materialMap);

  const renderGroundTruth = (): Raster => {
    const full = createRaster(worldWidth, worldHeight);
    // 分块渲染并拼接，避免单照片覆盖不到的区域无真值
    const step = 4;
    for (let ty = 0; ty < worldHeight; ty += ph * step) {
      for (let tx = 0; tx < worldWidth; tx += pw * step) {
        const meta: PhotoMeta = {
          id: -1,
          name: 'gt',
          footprint: { x: tx, y: ty, w: Math.min(pw * step, worldWidth - tx), h: Math.min(ph * step, worldHeight - ty) },
          sunAzimuth: illuminant.azimuth,
          sunElevation: illuminant.elevation,
          weather,
          flightTime,
          exposure: 1,
          seed: seed ^ (tx * 7 + ty),
        };
        const tile = renderPhotoImpl(spec, meta, new Rng(meta.seed), materialMap);
        for (let y = 0; y < tile.height; y++) {
          for (let x = 0; x < tile.width; x++) {
            const si = (y * tile.width + x) * 4;
            const di = ((ty + y) * worldWidth + tx + x) * 4;
            full.data[di] = tile.data[si];
            full.data[di + 1] = tile.data[si + 1];
            full.data[di + 2] = tile.data[si + 2];
            full.data[di + 3] = 255;
          }
        }
      }
    }
    return full;
  };

  return { spec, renderPhoto, renderGroundTruth };
}

interface Illuminant {
  azimuth: number;
  elevation: number;
  scene: DatasetSpec['illuminant'];
}

function buildIlluminant(weather: Weather, flightTime: FlightTime, rng: Rng): Illuminant {
  const timeMap: Record<FlightTime, { az: number; el: number; warm: number }> = {
    morning: { az: 82, el: 28, warm: 0.22 },
    noon: { az: 175, el: 68, warm: 0.02 },
    evening: { az: 268, el: 22, warm: 0.32 },
  };
  const t = timeMap[flightTime];
  const cloudy = weather === 'cloudy';
  // 线性 RGB 白点：傍晚偏暖（R 高 B 低），阴天略冷
  const rgb: [number, number, number] = cloudy
    ? [0.96, 1.0, 1.08]
    : [1 + t.warm, 1, 1 - t.warm * 0.9];
  return {
    azimuth: t.az + rng.range(-4, 4),
    elevation: t.el + rng.range(-2, 2),
    scene: {
      rgb,
      ambient: cloudy ? 0.78 : 0.42,
      intensity: cloudy ? 0.62 : 1.0,
    },
  };
}

/** 三块标准灰板，沿盐场顶边均匀铺在埂上，中性灰 L*=53 */
function buildReferences(worldWidth: number): ReferencePanel[] {
  const size = 48;
  const y = 18;
  return [0.2, 0.5, 0.8].map((f, i) => ({
    id: i,
    x: Math.round(worldWidth * f - size / 2),
    y,
    size,
    targetLab: [53, 0, 0] as [number, number, number],
  }));
}

function jitteredRect(x: number, y: number, w: number, h: number, j: number, rng: Rng): [number, number][] {
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  return corners.map(([cx, cy]) => [cx + rng.range(-j, j), cy + rng.range(-j, j)]);
}

function makeBlobs(poly: [number, number][], fraction: number, rng: Rng, maxRadius: number): Blob[] {
  if (fraction <= 0) return [];
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const area = (maxX - minX) * (maxY - minY);
  const target = area * fraction;
  const blobs: Blob[] = [];
  let covered = 0;
  let guard = 0;
  while (covered < target && guard++ < 400) {
    const rx = rng.range(maxRadius * 0.35, maxRadius);
    const ry = rng.range(maxRadius * 0.35, maxRadius);
    const x = rng.range(minX + rx, maxX - rx);
    const y = rng.range(minY + ry, maxY - ry);
    if (!pointInPolygon(x, y, poly)) continue;
    blobs.push({ x, y, rx, ry, angle: rng.range(0, Math.PI) });
    covered += Math.PI * rx * ry;
  }
  return blobs;
}

/**
 * 单张照片渲染：从预计算的世界材质图采样材质 Lab，叠加本照片的水面微波、
 * 镜面反光后做相机着色。不含任何多边形判断（已在材质图阶段一次性完成）。
 */
function renderPhotoImpl(spec: DatasetSpec, meta: PhotoMeta, rng: Rng, materialMap: MaterialMap): Raster {
  const { footprint, exposure } = meta;
  const img = createRaster(footprint.w, footprint.h);
  const { illuminant } = spec;

  // 镜面高光位置（照片局部坐标，顺太阳方位的水面亮斑），只在晴天出现
  const glints: { x: number; y: number; rx: number; ry: number }[] = [];
  if (spec.weather === 'sunny') {
    const count = rng.int(1, 2);
    for (let i = 0; i < count; i++) {
      glints.push({
        x: rng.range(0, footprint.w),
        y: rng.range(0, footprint.h),
        rx: rng.range(26, 70),
        ry: rng.range(10, 26),
      });
    }
  }

  for (let py = 0; py < footprint.h; py++) {
    const wy = footprint.y + py;
    for (let px = 0; px < footprint.w; px++) {
      const wx = footprint.x + px;
      const mat = materialMap.sample(wx, wy);
      // 水面微波噪声（确定性空间函数，随照片种子变化，制造同池不同照片的亮度差）
      const wave =
        Math.sin(wx * 0.11 + meta.seed * 0.001) * 0.7 +
        Math.cos(wy * 0.13 + meta.seed * 0.0013) * 0.7;
      let lab: Lab = [mat[0] + wave, mat[1], mat[2]];

      // 镜面反光覆盖在材质之上
      if (spec.weather === 'sunny') {
        let glintStrength = 0;
        for (const g of glints) {
          const dx = px - g.x;
          const dy = py - g.y;
          const d2 = (dx * dx) / (g.rx * g.rx) + (dy * dy) / (g.ry * g.ry);
          if (d2 < 1) glintStrength = Math.max(glintStrength, (1 - d2) * (1 - d2) * 0.92);
        }
        if (glintStrength > 0) lab = mixLab(lab, GLINT_LAB, glintStrength);
      }

      const rgb = shadeToCamera(lab, illuminant, exposure, rng);
      const i = (py * footprint.w + px) * 4;
      img.data[i] = rgb[0];
      img.data[i + 1] = rgb[1];
      img.data[i + 2] = rgb[2];
      img.data[i + 3] = 255;
    }
  }
  return img;
}

/**
 * 场景 Lab（D65 参考下的材质颜色）-> 相机 sRGB。
 * 采用纯乘性光照模型（色温 × 有效强度 × 曝光），保证灰板的 von Kries 校正可完全反演：
 *   有效强度 = 直射强度 + 环境光贡献（环境光经同一色温与强度缩放，不引入加性偏置）。
 * 最后加传感器高斯噪声并 gamma 编码。
 */
function shadeToCamera(
  lab: Lab,
  ill: DatasetSpec['illuminant'],
  exposure: number,
  rng: Rng,
): RGB {
  const srgb = labToSrgb(lab);
  const linRgb: RGB = [SRGB_TO_LINEAR[srgb[0]], SRGB_TO_LINEAR[srgb[1]], SRGB_TO_LINEAR[srgb[2]]];
  const gain = ill.rgb;
  // 环境光按比例叠加到有效强度上（乘性），阴天强度低但环境占比高，整体亮度仍合理
  const effectiveIntensity = ill.intensity * (1 - ill.ambient) + ill.ambient * 0.55;
  const k = effectiveIntensity * exposure;
  const lit: RGB = [
    linRgb[0] * gain[0] * k,
    linRgb[1] * gain[1] * k,
    linRgb[2] * gain[2] * k,
  ];
  // 传感器高斯噪声（编码域 sigma ≈ 1.6/255，查表实现）
  return [
    clampByte(srgbEncodeLut(lit[0]) + rng.gaussianFast(0, 1.6)),
    clampByte(srgbEncodeLut(lit[1]) + rng.gaussianFast(0, 1.6)),
    clampByte(srgbEncodeLut(lit[2]) + rng.gaussianFast(0, 1.6)),
  ];
}

function byteToLinear(c: number): number {
  return SRGB_TO_LINEAR[c];
}

function linearToByte(v: number): number {
  return srgbEncodeLut(v);
}

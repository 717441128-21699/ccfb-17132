// 参考灰板颜色校正：从原始照片（而非融合大图）中定位已知中性灰板，估计光照的
// 色温乘子与强度，在线性 sRGB 域把每张照片校正到 D65 等能白参考光照。
// 必须在融合前做：融合时的 feathering 加权会把高对比小灰板与周围埂土混合，污染估计。
import { labToSrgb, type RGB } from './color';
import { srgbEncodeLut, SRGB_TO_LINEAR } from './lut';
import type { PhotoMeta, ReferencePanel } from './types';
import type { Raster } from './image';

export interface ColorCorrection {
  /** 线性域每通道增益（色温） */
  channelGain: RGB;
  /** 全局强度增益（曝光/直射强度归一） */
  intensityGain: number;
  /** 灰板实测线性 RGB（校正前，跨照片中位） */
  measuredLinear: RGB;
  /** 灰板目标线性 RGB */
  targetLinear: RGB;
  detectedPanels: number;
  /** 参与估计的照片-灰板采样数 */
  samples: number;
}

function srgbToLinear(c: number): number {
  return SRGB_TO_LINEAR[c];
}

function linearToByte(v: number): number {
  return srgbEncodeLut(v);
}

/**
 * 从覆盖灰板的原始照片中采样灰板线性 RGB。
 * 每张照片先按自身 exposure 归一，再汇总，使不同曝光的照片可一起估计色温。
 */
export function estimateColorCorrection(
  photos: PhotoMeta[],
  images: Raster[],
  references: ReferencePanel[],
): ColorCorrection {
  const targetSrgb = labToSrgb(references[0].targetLab);
  const targetLinear: RGB = [
    srgbToLinear(targetSrgb[0]),
    srgbToLinear(targetSrgb[1]),
    srgbToLinear(targetSrgb[2]),
  ];

  const measured: RGB[] = [];
  const detected = new Set<number>();
  for (let pi = 0; pi < photos.length; pi++) {
    const meta = photos[pi];
    for (const ref of references) {
      // 灰板中心是否落在该照片 footprint 内（留边距，避开照片边缘）
      const cx = ref.x + ref.size / 2;
      const cy = ref.y + ref.size / 2;
      const m = 8;
      if (
        cx < meta.footprint.x + m ||
        cx > meta.footprint.x + meta.footprint.w - m ||
        cy < meta.footprint.y + m ||
        cy > meta.footprint.y + meta.footprint.h - m
      ) {
        continue;
      }
      const sample = samplePanelInPhoto(images[pi], meta, ref);
      if (sample) {
        // 归一掉该照片曝光，得到“单位曝光下”的灰板颜色
        const ex = meta.exposure || 1;
        measured.push([sample[0] / ex, sample[1] / ex, sample[2] / ex]);
        detected.add(ref.id);
      }
    }
  }

  if (measured.length === 0) {
    return {
      channelGain: [1, 1, 1],
      intensityGain: 1,
      measuredLinear: targetLinear,
      targetLinear,
      detectedPanels: 0,
      samples: 0,
    };
  }

  const measuredLinear: RGB = [
    median(measured.map((v) => v[0])),
    median(measured.map((v) => v[1])),
    median(measured.map((v) => v[2])),
  ];
  // 色温：逐通道增益（先把单位曝光灰板拉到目标色）
  const channelGain: RGB = [
    targetLinear[0] / measuredLinear[0],
    targetLinear[1] / measuredLinear[1],
    targetLinear[2] / measuredLinear[2],
  ];
  // 强度：色温校正后整体亮度与目标的比值（理论上接近 1，因强度已含在测量中）
  const adapted: RGB = [
    measuredLinear[0] * channelGain[0],
    measuredLinear[1] * channelGain[1],
    measuredLinear[2] * channelGain[2],
  ];
  const intensityGain =
    (targetLinear[0] + targetLinear[1] + targetLinear[2]) /
    (adapted[0] + adapted[1] + adapted[2]);

  return {
    channelGain,
    intensityGain,
    measuredLinear,
    targetLinear,
    detectedPanels: detected.size,
    samples: measured.length,
  };
}

/** 在单张照片的 footprint 坐标系内采样灰板中心区域的线性 RGB 均值 */
function samplePanelInPhoto(img: Raster, meta: PhotoMeta, ref: ReferencePanel): RGB | null {
  const ox = ref.x - meta.footprint.x;
  const oy = ref.y - meta.footprint.y;
  const x0 = Math.max(0, Math.floor(ox) + 6);
  const y0 = Math.max(0, Math.floor(oy) + 6);
  const x1 = Math.min(img.width, Math.ceil(ox + ref.size) - 6);
  const y1 = Math.min(img.height, Math.ceil(oy + ref.size) - 6);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * 4;
      r += srgbToLinear(img.data[i]);
      g += srgbToLinear(img.data[i + 1]);
      b += srgbToLinear(img.data[i + 2]);
      n++;
    }
  }
  if (n < 8) return null;
  return [r / n, g / n, b / n];
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 把校正参数（含曝光归一）应用到单张照片（原地），编码回 8bit sRGB */
export function applyCorrectionToPhoto(img: Raster, c: ColorCorrection, exposure: number): void {
  const d = img.data;
  const ex = exposure || 1;
  for (let i = 0; i < d.length; i += 4) {
    const lin: RGB = [
      srgbToLinear(d[i]) * c.channelGain[0] * c.intensityGain / ex,
      srgbToLinear(d[i + 1]) * c.channelGain[1] * c.intensityGain / ex,
      srgbToLinear(d[i + 2]) * c.channelGain[2] * c.intensityGain / ex,
    ];
    d[i] = linearToByte(lin[0]);
    d[i + 1] = linearToByte(lin[1]);
    d[i + 2] = linearToByte(lin[2]);
  }
}

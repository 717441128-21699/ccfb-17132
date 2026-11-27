// 颜色科学：sRGB / XYZ / CIE-Lab 互转、色差、光照自适应（Bradford 色适应）。
// 参考：IEC 61966-2-1, CIE 15:2004，D65 标准白点。
// 热路径（srgbToLab 等）使用 lut.ts 预计算表提速。
import { labFLut, srgbEncodeLut, SRGB_TO_LINEAR } from './lut';

export type RGB = [number, number, number];
export type Lab = [number, number, number];
export type XYZ = [number, number, number];

const D65: XYZ = [0.95047, 1.0, 1.08883];

export function srgbToLinear(c: number): number {
  return SRGB_TO_LINEAR[Math.max(0, Math.min(255, Math.round(c)))];
}

export function linearToSrgbValue(c: number): number {
  return srgbEncodeLut(c);
}

function linearToSrgb(c: number): number {
  return srgbEncodeLut(c);
}

export function srgbToXyz(rgb: RGB): XYZ {
  const [r, g, b] = rgb.map(srgbToLinear);
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.072175 * b,
    0.0193339 * r + 0.119192 * g + 0.9503041 * b,
  ];
}

export function xyzToSrgb(xyz: XYZ): RGB {
  const [x, y, z] = xyz;
  const r = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const g = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const b = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [linearToSrgb(r), linearToSrgb(g), linearToSrgb(b)];
}

function labF(t: number): number {
  return labFLut(t);
}

function labFInv(t: number): number {
  const d = 6 / 29;
  return t > d ? t * t * t : 3 * d * d * (t - 4 / 29);
}

export function xyzToLab(xyz: XYZ, white: XYZ = D65): Lab {
  const fx = labF(xyz[0] / white[0]);
  const fy = labF(xyz[1] / white[1]);
  const fz = labF(xyz[2] / white[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToXyz(lab: Lab, white: XYZ = D65): XYZ {
  const [L, a, b] = lab;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  return [labFInv(fx) * white[0], labFInv(fy) * white[1], labFInv(fz) * white[2]];
}

export function srgbToLab(rgb: RGB, white?: XYZ): Lab {
  return xyzToLab(srgbToXyz(rgb), white);
}

export function labToSrgb(lab: Lab, white?: XYZ): RGB {
  return xyzToSrgb(labToXyz(lab, white));
}

/** CIE76 色差 ΔE（本项目采样噪声小，76 足够；避免 CIEDE2000 的额外开销） */
export function deltaE(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// ---- 光照自适应：von Kries 通道增益（线性 sRGB 域） ----

/**
 * 生成从 srcWhite 到 D65 的 von Kries 通道增益（在线性 sRGB 空间应用）。
 * srcWhiteLinear 为场景白点的线性 RGB；输出增益使白点归一到等能白。
 * 早晚两次飞行的光照差用该增益校正到同一参考光照。
 */
export function chromaticAdaptation(srcWhiteLinear: RGB): RGB {
  const w = srcWhiteLinear;
  const mean = (w[0] + w[1] + w[2]) / 3 || 1;
  return [mean / w[0], mean / w[1], mean / w[2]];
}

/** 对一组 8bit sRGB 像素应用线性增益并做曝光归一化 */
export function applyLinearGain(rgb: RGB, gain: RGB, exposure = 1): RGB {
  const lin: RGB = [
    srgbToLinear(rgb[0]) * gain[0] * exposure,
    srgbToLinear(rgb[1]) * gain[1] * exposure,
    srgbToLinear(rgb[2]) * gain[2] * exposure,
  ];
  return xyzToSrgb(srgbToXyz(lin));
}

/** Lab 空间欧氏距离加权均值（颜色均值在 Lab 中做，避免 sRGB gamma 偏差） */
export function meanLab(samples: Lab[]): Lab {
  if (samples.length === 0) return [0, 0, 0];
  let L = 0;
  let a = 0;
  let b = 0;
  for (const s of samples) {
    L += s[0];
    a += s[1];
    b += s[2];
  }
  const n = samples.length;
  return [L / n, a / n, b / n];
}

export function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Lab 线性混合 */
export function mixLab(a: Lab, b: Lab, t: number): Lab {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

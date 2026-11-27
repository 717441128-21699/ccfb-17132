// 颜色/噪声查找表：用预计算 LUT 替换热路径上的 Math.pow / Math.cbrt / Box-Muller，
// 这是 500 张照片级流水线的主要提速手段（精度损失可忽略，<0.1 个 8bit 级）。

/** sRGB 8bit -> 线性光，256 项 */
export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  SRGB_TO_LINEAR[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 线性光 [0,1] -> sRGB 8bit，4096 项精细 LUT */
const ENC_BINS = 4096;
const LINEAR_TO_SRGB = new Uint8ClampedArray(ENC_BINS + 1);
for (let i = 0; i <= ENC_BINS; i++) {
  const v = i / ENC_BINS;
  const e = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(e * 255);
}

export function srgbDecodeLut(c: number): number {
  return SRGB_TO_LINEAR[c];
}

export function srgbEncodeLut(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  return LINEAR_TO_SRGB[Math.round(v * ENC_BINS)];
}

/**
 * CIE-Lab 的 f(t) 查找表（t 覆盖 0..1.6，含 D65 归一化后的 XYZ 分量范围）。
 * f(t) = t > δ³ ? cbrt(t) : t/(3δ²) + 4/29，δ=6/29。
 */
const LAB_F_BINS = 2048;
const LAB_F_MAX = 1.6;
const LAB_F_LUT = new Float32Array(LAB_F_BINS + 1);
const DELTA = 6 / 29;
for (let i = 0; i <= LAB_F_BINS; i++) {
  const t = (i / LAB_F_BINS) * LAB_F_MAX;
  LAB_F_LUT[i] = t > DELTA * DELTA * DELTA ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29;
}

export function labFLut(t: number): number {
  if (t <= 0) return LAB_F_LUT[0];
  if (t >= LAB_F_MAX) return Math.cbrt(t);
  return LAB_F_LUT[Math.round((t / LAB_F_MAX) * LAB_F_BINS)];
}

/** 预计算标准正态样本表（初始化时用 Box-Muller 算好，热路径零超越函数） */
const GAUSS_BINS = 4096;
const GAUSS_TABLE = new Float32Array(GAUSS_BINS);
{
  let spare: number | null = null;
  for (let i = 0; i < GAUSS_BINS; i++) {
    if (spare !== null) {
      GAUSS_TABLE[i] = spare;
      spare = null;
      continue;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u));
    GAUSS_TABLE[i] = mag * Math.cos(2 * Math.PI * v);
    spare = mag * Math.sin(2 * Math.PI * v);
  }
}

/** 由 [0,1) 均匀值查表得标准高斯样本 */
export function gaussLut(u: number): number {
  return GAUSS_TABLE[Math.min(GAUSS_BINS - 1, Math.max(0, (u * GAUSS_BINS) | 0))];
}

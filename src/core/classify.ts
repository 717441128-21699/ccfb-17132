// 像素地物分类：池水 / 白色盐花结晶 / 露出泥 / 水面反光 / 土埂。
// 关键：粉红藻色靠高彩度 + 红轴识别，发白结晶靠高亮度 + 低彩度识别，二者互斥不互相干扰。
import { rgbToHsv } from './color';

export type PixelClass = 'water' | 'salt' | 'mud' | 'glint' | 'ridge';

export interface HSV {
  h: number;
  s: number;
  v: number;
}

export function hsv(r: number, g: number, b: number): HSV {
  return rgbToHsv(r, g, b);
}

/** 土埂/砾石/干硬泥土：低-中饱和、暖棕或近灰，明度居中 */
export function isRidgePixel(r: number, g: number, b: number): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < 0.3 || v > 0.9) return false;
  if (s < 0.17 && v >= 0.34 && v <= 0.82) return true; // 灰砾石
  return h >= 17 && h <= 49 && s >= 0.16 && s <= 0.55 && v >= 0.32 && v <= 0.82;
}

/** 水面强反光/太阳耀斑：极高明度、极低饱和、接近通道削顶 */
export function isGlintPixel(r: number, g: number, b: number): boolean {
  const { s, v } = rgbToHsv(r, g, b);
  const mn = Math.min(r, g, b);
  const mx = Math.max(r, g, b);
  return v >= 0.965 && s <= 0.2 && mn >= 236 && mx - mn <= 26;
}

/** 白色盐花/结晶：高明度、低饱和的暖白（比耀斑稍暗、不削顶） */
export function isSaltPixel(r: number, g: number, b: number): boolean {
  const { s, v } = rgbToHsv(r, g, b);
  if (isGlintPixel(r, g, b)) return false;
  return v >= 0.8 && s <= 0.24;
}

/** 露出的池底泥：暖棕、中低饱和、中等偏暗；与高饱和黄褐卤水区分 */
export function isMudPixel(r: number, g: number, b: number): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (v < 0.3 || v > 0.78) return false;
  if (h < 18 || h > 46) return false;
  return s >= 0.16 && s <= 0.52;
}

/**
 * 综合分类。优先级：反光 > 盐花 > 泥 > 土埂 > 水。
 * 粉红藻色彩度高，不会落入盐花/反光的低彩度门限。
 */
export function classifyPixel(r: number, g: number, b: number): PixelClass {
  if (isGlintPixel(r, g, b)) return 'glint';
  if (isSaltPixel(r, g, b)) return 'salt';
  if (isMudPixel(r, g, b)) return 'mud';
  if (isRidgePixel(r, g, b)) return 'ridge';
  return 'water';
}

/** 粉红藻色门限（用于异常/成分提示），与白色指数互斥 */
export function isPinkAlgae(r: number, g: number, b: number): boolean {
  const { h, s, v } = rgbToHsv(r, g, b);
  if (s < 0.34 || v < 0.35) return false;
  // 红-品红区间（约 315-355°），或满足红/品红通道关系
  const pinkHue = h >= 312 && h <= 356;
  const redMagenta = r > g * 1.28 && b > g * 0.85 && r >= b * 0.8;
  return pinkHue || redMagenta;
}

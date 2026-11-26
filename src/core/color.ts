// 颜色空间工具：sRGB <-> linear <-> XYZ(D65) <-> Lab，以及稳健平均与颜色特征
import type { Lab, RGB } from './types';

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** sRGB 通道(0-255) -> 线性(0-1) */
export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  const x = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return clamp(x, 0, 1) * 255;
}

// D65 参考白
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

export function rgbToLab(rgb: RGB): Lab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  // linear sRGB -> XYZ
  let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375;
  let y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  let z = r * 0.0193339 + g * 0.119192 + b * 0.9503041;
  x /= XN;
  y /= YN;
  z /= ZN;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

export function labToRgb(lab: Lab): RGB {
  const fy = (lab.L + 16) / 116;
  const fx = lab.a / 500 + fy;
  const fz = fy - lab.b / 200;
  const finv = (t: number) => {
    const t3 = t * t * t;
    return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
  };
  const x = XN * finv(fx);
  const y = YN * finv(fy);
  const z = ZN * finv(fz);
  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  const gl = x * -0.969266 + y * 1.8760108 + z * 0.041556;
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
  return {
    r: clamp255(linearToSrgb(rl)),
    g: clamp255(linearToSrgb(gl)),
    b: clamp255(linearToSrgb(bl)),
  };
}

export function labDistance(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/** 色相（Lab a/b 平面角度，弧度）与彩度 */
export function labChroma(lab: Lab): { chroma: number; hue: number } {
  const chroma = Math.sqrt(lab.a * lab.a + lab.b * lab.b);
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { chroma, hue };
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

/** 中位数（会复制并排序数组） */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length & 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 分位数 */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  return sorted[base];
}

/** 由一批 RGB 像素做分通道稳健均值（截尾均值），避免反光/盐花残留拉动 */
export function trimmedMeanRgb(
  pixels: ArrayLike<number>,
  stride: number,
  indices: number[],
  trim = 0.12,
): RGB {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (const idx of indices) {
    const o = idx * stride;
    rs.push(pixels[o]);
    gs.push(pixels[o + 1]);
    bs.push(pixels[o + 2]);
  }
  return {
    r: trimmedMean(rs, trim),
    g: trimmedMean(gs, trim),
    b: trimmedMean(bs, trim),
  };
}

export function trimmedMean(values: number[], trim = 0.12): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const k = Math.floor(sorted.length * trim);
  let sum = 0;
  let n = 0;
  for (let i = k; i < sorted.length - k; i++) {
    sum += sorted[i];
    n++;
  }
  return n > 0 ? sum / n : sorted[sorted.length >> 1];
}

/** 波美度 -> 浓度图配色（海水青绿 -> 黄绿 -> 粉 -> 红 -> 结晶白） */
export function baumeToColor(t: number): RGB {
  // 分段色标，与合成器/标定曲线保持同一套语义颜色
  const stops: Array<[number, RGB]> = [
    [0, { r: 28, g: 110, b: 138 }], // 刚进海水：青蓝
    [4, { r: 34, g: 150, b: 148 }], // 发青发绿
    [8, { r: 86, g: 176, b: 120 }], // 绿
    [12, { r: 176, g: 196, b: 84 }], // 黄绿
    [16, { r: 214, g: 178, b: 74 }], // 黄褐
    [20, { r: 224, g: 128, b: 96 }], // 橙粉过渡
    [23, { r: 219, g: 86, b: 138 }], // 粉红（嗜盐藻）
    [26, { r: 176, g: 40, b: 96 }], // 红
    [29, { r: 236, g: 226, b: 238 }], // 结晶泛白
  ];
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return {
        r: Math.round(c0.r + (c1.r - c0.r) * f),
        g: Math.round(c0.g + (c1.g - c0.g) * f),
        b: Math.round(c0.b + (c1.b - c0.b) * f),
      };
    }
  }
  return stops[stops.length - 1][1];
}

export function rgbCss(c: RGB, alpha = 1): string {
  return `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${alpha})`;
}

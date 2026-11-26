// 卤水“波美度 -> 标准颜色”曲线。合成器用它生成带真值的照片，
// 标定/反演用它做颜色投影，保证颜色-浓度关系一致、可验证。
import { clamp, labToRgb, rgbToLab } from './color';
import type { AlgaeKind, Lab, RGB } from './types';

interface CurveStop {
  baume: number;
  rgb: RGB;
}

// 与浓度图色标同一套语义：海水青绿 -> 绿 -> 黄绿 -> 黄褐 -> 橙 -> 粉 -> 红 -> 结晶
const CURVE_STOPS: CurveStop[] = [
  { baume: 1.5, rgb: { r: 30, g: 104, b: 132 } },
  { baume: 3.5, rgb: { r: 33, g: 142, b: 146 } },
  { baume: 6, rgb: { r: 52, g: 168, b: 132 } },
  { baume: 9, rgb: { r: 96, g: 180, b: 112 } },
  { baume: 12, rgb: { r: 168, g: 196, b: 86 } },
  { baume: 15, rgb: { r: 206, g: 184, b: 72 } },
  { baume: 18, rgb: { r: 220, g: 150, b: 66 } },
  { baume: 21, rgb: { r: 224, g: 116, b: 84 } },
  { baume: 24, rgb: { r: 214, g: 74, b: 128 } },
  { baume: 27, rgb: { r: 178, g: 40, b: 98 } },
  { baume: 29.5, rgb: { r: 140, g: 34, b: 84 } },
];

const LAB_STOPS = CURVE_STOPS.map((s) => ({ baume: s.baume, lab: rgbToLab(s.rgb) }));

export const BAUME_MIN = 2;
export const BAUME_MAX = 29;

export function algaeAmount(a: AlgaeKind): number {
  return a === 'none' ? 0.12 : a === 'medium' ? 0.55 : 1.0;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 标准卤水颜色（未受光照/藻华偏移的基准），Lab 插值更符合人眼均匀性 */
export function canonicalBrineLab(baume: number): Lab {
  const b = clamp(baume, CURVE_STOPS[0].baume, CURVE_STOPS[CURVE_STOPS.length - 1].baume);
  let i = 0;
  while (i < LAB_STOPS.length - 2 && b > LAB_STOPS[i + 1].baume) i++;
  const p0 = LAB_STOPS[i];
  const p1 = LAB_STOPS[i + 1];
  const t = clamp((b - p0.baume) / (p1.baume - p0.baume), 0, 1);
  return {
    L: lerp(p0.lab.L, p1.lab.L, t),
    a: lerp(p0.lab.a, p1.lab.a, t),
    b: lerp(p0.lab.b, p1.lab.b, t),
  };
}

export function canonicalBrineRGB(baume: number): RGB {
  return labToRgb(canonicalBrineLab(baume));
}

/**
 * 实际池水颜色：在标准曲线上叠加嗜盐藻带来的粉红偏移。
 * 藻越盛、浓度越高，粉红/品红越强。结晶白不在此处理，由分类器剔除白盐花。
 */
export function brineAppearanceLab(baume: number, algae: AlgaeKind): Lab {
  const base = canonicalBrineLab(baume);
  const amt = algaeAmount(algae);
  const ramp = smoothstep(13.5, 23.5, baume);
  const pinkStrength = ramp * (0.18 + 0.62 * amt);
  // 嗜盐藻的粉红/品红方向：+a（红），并把 +b（黄）往蓝/品红方向拉一点
  const pinkA = 42;
  const pinkB = -6;
  return {
    L: base.L - ramp * 4 * amt, // 藻密度让水色略深
    a: lerp(base.a, pinkA, pinkStrength),
    b: lerp(base.b, pinkB, pinkStrength * 0.85),
  };
}

export function brineAppearanceRGB(baume: number, algae: AlgaeKind): RGB {
  return labToRgb(brineAppearanceLab(baume, algae));
}

/** 粉红藻色指数：a 通道红/绿轴 + 彩度，越大越像嗜盐藻粉红 */
export function pinkIndexOfLab(lab: Lab): number {
  const chroma = Math.hypot(lab.a, lab.b);
  // a 明显偏红、且有足够彩度、色相在红-品红区间
  const redness = clamp((lab.a - 4) / 34, 0, 1);
  const chromaGate = clamp((chroma - 14) / 26, 0, 1);
  return clamp(redness * (0.45 + 0.55 * chromaGate), 0, 1);
}

/** 发白结晶指数：高亮度 + 低彩度，越大越像白盐花/结晶 */
export function whiteIndexOfLab(lab: Lab): number {
  const chroma = Math.hypot(lab.a, lab.b);
  const light = clamp((lab.L - 78) / 16, 0, 1);
  const lowChroma = clamp((20 - chroma) / 16, 0, 1);
  return clamp(light * lowChroma, 0, 1);
}

/**
 * 把观测 Lab 投影到“当前藻类档位”的卤水轨迹上，返回轨迹波美度。
 * 用密集采样 + 最近邻，稳健、单调、可解释；标定模型再在此基础上做实测校正。
 */
export function projectToBrineCurve(lab: Lab, algae: AlgaeKind): { baume: number; residual: number } {
  let bestB = BAUME_MIN;
  let bestD = Infinity;
  const STEPS = 270;
  for (let i = 0; i <= STEPS; i++) {
    const b = BAUME_MIN + ((BAUME_MAX - BAUME_MIN) * i) / STEPS;
    const c = brineAppearanceLab(b, algae);
    // 给亮度稍低权重：光照/盐花残留对 L 影响更大，a/b 色度更稳定
    const dL = (lab.L - c.L) * 0.7;
    const da = lab.a - c.a;
    const db = lab.b - c.b;
    const d = dL * dL + da * da + db * db;
    if (d < bestD) {
      bestD = d;
      bestB = b;
    }
  }
  return { baume: bestB, residual: Math.sqrt(bestD) };
}

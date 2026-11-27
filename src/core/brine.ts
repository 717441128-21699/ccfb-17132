// 卤水颜色物理模型：波美度 → CIE-Lab 颜色轨迹。
// 真实盐场规律：低浓度海水青绿 → 中浓度黄绿/橄榄 → 高浓度因嗜盐藻（杜氏盐藻、
// 嗜盐杆菌）呈粉红至红色；无藻高浓度卤水则偏黄褐。两条路径按藻类强度插值。
import type { Lab } from './color';
import type { PondZone } from './types';

interface Key {
  baume: number;
  lab: Lab;
}

/** 满藻路径（嗜盐藻旺盛，高浓度段粉红→红） */
const ALGAE_PATH: Key[] = [
  { baume: 3, lab: [60, -14, -4] },
  { baume: 7, lab: [58, -12, 0] },
  { baume: 11, lab: [55, -7, 6] },
  { baume: 15, lab: [52, -1, 10] },
  { baume: 19, lab: [50, 8, 12] },
  { baume: 22, lab: [48, 16, 13] },
  { baume: 25, lab: [46, 24, 14] },
  { baume: 28, lab: [44, 30, 15] },
];

/** 无藻路径（高浓度仍为黄褐/橄榄色） */
const NO_ALGAE_PATH: Key[] = [
  { baume: 3, lab: [60, -14, -4] },
  { baume: 7, lab: [58, -11, 2] },
  { baume: 11, lab: [56, -5, 9] },
  { baume: 15, lab: [54, 0, 13] },
  { baume: 19, lab: [52, 4, 16] },
  { baume: 22, lab: [50, 7, 18] },
  { baume: 25, lab: [49, 9, 19] },
  { baume: 28, lab: [48, 10, 20] },
];

function lerpLab(a: Lab, b: Lab, t: number): Lab {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function samplePath(path: Key[], baume: number): Lab {
  if (baume <= path[0].baume) return [...path[0].lab] as Lab;
  const last = path[path.length - 1];
  if (baume >= last.baume) return [...last.lab] as Lab;
  for (let i = 0; i < path.length - 1; i++) {
    const k0 = path[i];
    const k1 = path[i + 1];
    if (baume >= k0.baume && baume <= k1.baume) {
      const t = (baume - k0.baume) / (k1.baume - k0.baume);
      return lerpLab(k0.lab, k1.lab, t);
    }
  }
  return [...last.lab] as Lab;
}

/**
 * 给定波美度与藻类强度（0..1），返回卤水在 D65 下的理想 Lab。
 */
export function brineLab(baume: number, algaeStrength: number): Lab {
  const full = samplePath(ALGAE_PATH, baume);
  const none = samplePath(NO_ALGAE_PATH, baume);
  return lerpLab(none, full, Math.min(1, Math.max(0, algaeStrength)));
}

/** 土埂（湿土+枯草）典型 Lab */
export const RIDGE_LAB: Lab = [44, 6, 20];
/** 池底露出的泥斑 */
export const MUDDY_BOTTOM_LAB: Lab = [33, 9, 16];
/** 白色盐花（漫反射白，非镜面） */
export const SALT_FLOWER_LAB: Lab = [91, -1, 3];
/** 镜面反光高光（接近中性白，亮度更高） */
export const GLINT_LAB: Lab = [97, 0, 1];

export function zoneBaumeRange(zone: PondZone): [number, number] {
  switch (zone) {
    case 'reservoir':
      return [3, 10];
    case 'evaporator':
      return [10, 21];
    case 'crystallizer':
      return [21, 27];
  }
}

export function zoneLabel(zone: PondZone): string {
  switch (zone) {
    case 'reservoir':
      return '贮水池';
    case 'evaporator':
      return '蒸发池';
    case 'crystallizer':
      return '结晶池';
  }
}

/**
 * 生成标定用的理论密集采样（覆盖 3..27°Bé 与不同藻类强度），
 * 作为内置默认标定模型的数据基础。
 */
export function theoreticalCalibrationSamples(): { baume: number; lab: Lab; algae: number }[] {
  const out: { baume: number; lab: Lab; algae: number }[] = [];
  for (let b = 3; b <= 27.5; b += 0.5) {
    // 藻类强度随浓度自然上升，并保留 0.35 的散度以覆盖不同藻况
    const natural = Math.max(0, (b - 12) / 14);
    for (const algae of [
      Math.max(0, natural - 0.3),
      natural,
      Math.min(1, natural + 0.25),
    ]) {
      out.push({ baume: b, lab: brineLab(b, algae), algae });
    }
  }
  return out;
}

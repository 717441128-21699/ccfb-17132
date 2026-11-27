// 池子颜色分析：在大图上按池子多边形采样，剔除盐花/泥斑/镜面反光/埂像素，
// 对剩余卤水像素做 Lab 稳健均值，再由标定模型反演波美度并标记异常。
import { GLINT_LAB, MUDDY_BOTTOM_LAB, RIDGE_LAB, SALT_FLOWER_LAB } from './brine';
import { deltaE, labToSrgb, meanLab, srgbToLab, type Lab } from './color';
import { asTuple, insetPolygon, pointInPolygon, polygonBounds, type Pt } from './geometry';
import { inferBaumeTable, type FittedModel } from './calibration';
import type { MosaicResult, PondDef, PondResult } from './types';

export interface AnalysisOptions {
  /** 沿土埂内沿向内收缩的世界像素数，保证不采到埂与边坡 */
  insetPx?: number;
  /** 采样步长（大图像素），越大越快 */
  sampleStep?: number;
  onProgress?: (fraction: number, detail: string) => void;
}

interface PixelClass {
  valid: Lab[];
  /** 兜底样本：剔除高光/盐花后的所有像素（含被泥/埂判定的暗色像素），有效样本为空时启用 */
  fallback: Lab[];
  salt: number;
  mud: number;
  glint: number;
  ridge: number;
  total: number;
}

// 各类非卤水地物与卤水的判别阈值（Lab 距离 / 亮度）
const GLINT_L_MIN = 86;
const GLINT_CHROMA_MAX = 8;
const SALT_L_MIN = 78;
const SALT_CHROMA_MAX = 10;
const MUDDY_L_MAX = 38;
const RIDGE_L_MAX = 50;
/** 距池子多边形边界的安全收缩量（世界像素 ≈ 大图像素） */
const DEFAULT_INSET = 16;

export function analyzePonds(
  mosaic: MosaicResult,
  ponds: PondDef[],
  fitted: FittedModel,
  opts: AnalysisOptions = {},
  previous?: Map<number, number>,
): PondResult[] {
  const inset = opts.insetPx ?? DEFAULT_INSET;
  const step = opts.sampleStep ?? 2;
  const img = mosaic.canvas;
  const results: PondResult[] = [];
  interface Pre {
    pond: PondDef;
    worldPoly: [number, number][];
    cls: PixelClass;
    robust: Lab;
    meanRgb: [number, number, number];
    baumeEst: number;
  }
  const pre: Pre[] = [];

  // 第一遍：分类 + 稳健均值 + Bé 反演
  for (let pi = 0; pi < ponds.length; pi++) {
    const pond = ponds[pi];
    const worldPoly = pond.polygon.map(([x, y]) => [
      x - mosaic.originX,
      y - mosaic.originY,
    ]) as [number, number][];
    const inner = insetPolygon(worldPoly, inset);
    const cls = classifyPixels(img, asTuple(inner), step);
    // 有效卤水样本过少时，启用兜底样本（仅剔除高光/盐花），避免无样本导致荒谬反演
    const source = cls.valid.length >= 12 ? cls.valid : cls.fallback;
    const robust = robustMeanLab(source);
    const meanRgb = labToSrgb(robust);
    const baumeEst = inferBaumeTable(fitted.table, robust);
    pre.push({ pond, worldPoly, cls, robust, meanRgb, baumeEst });
    opts.onProgress?.((pi + 1) / ponds.length / 2, `分析池子 ${pi + 1}/${ponds.length}`);
  }

  // 第二遍：异常检测（此时所有池子估计均已知）
  for (let pi = 0; pi < pre.length; pi++) {
    const { pond, worldPoly, cls, robust, meanRgb, baumeEst } = pre[pi];
    const validFraction = cls.total > 0 ? cls.valid.length / cls.total : 0;
    const anomalies: PondResult['anomalies'] = [];

    // 异常 1：与历史（前一天/上一架次）相比突然变淡
    if (previous?.has(pond.id)) {
      const drop = (previous.get(pond.id) ?? 0) - baumeEst;
      if (drop >= 3) {
        anomalies.push({
          code: 'sudden-drop',
          message: `浓度较上次下降 ${drop.toFixed(1)}°Bé，疑似渗漏或进雨水`,
        });
      }
    }

    // 异常 2：同区最近 3 个相邻池子中位数偏离 >3°
    const zoneMates = pre.filter((p) => p.pond.zone === pond.zone && p.pond.id !== pond.id);
    if (zoneMates.length >= 2) {
      const neighborEst = zoneMates
        .map((p) => ({ est: p.baumeEst, d: polyDistance(worldPoly, p.worldPoly) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((n) => n.est);
      const med = median(neighborEst);
      if (Math.abs(baumeEst - med) > 3) {
        anomalies.push({
          code: 'neighbor-deviation',
          message: `偏离同区相邻池子中位数 ${(baumeEst - med).toFixed(1)}°Bé`,
        });
      }
    }

    // 异常 3：有效像素占比过低 / 反光占比过高
    if (validFraction < 0.55) {
      anomalies.push({
        code: 'low-valid-fraction',
        message: `有效卤水像素仅 ${(validFraction * 100).toFixed(0)}%，盐花/泥斑/反光遮挡过多`,
      });
    }
    const glintFraction = cls.total > 0 ? cls.glint / cls.total : 0;
    if (glintFraction > 0.25) {
      anomalies.push({
        code: 'high-glint',
        message: `镜面反光占比 ${(glintFraction * 100).toFixed(0)}%，建议重飞或人工复核`,
      });
    }

    const status: PondResult['status'] =
      anomalies.some((a) => a.code === 'sudden-drop') ? 'alert' : anomalies.length > 0 ? 'warning' : 'normal';

    results.push({
      pondId: pond.id,
      name: pond.name,
      zone: pond.zone,
      polygon: worldPoly,
      meanRGB: meanRgb,
      meanLab: robust,
      baumeEst,
      baumeTrue: pond.baume,
      validFraction,
      saltFraction: cls.total > 0 ? cls.salt / cls.total : 0,
      glintFraction,
      mudFraction: cls.total > 0 ? cls.mud / cls.total : 0,
      ridgeFraction: cls.total > 0 ? cls.ridge / cls.total : 0,
      sampleCount: cls.valid.length,
      status,
      anomalies,
    });
    opts.onProgress?.(0.5 + ((pi + 1) / pre.length) / 2, `异常检测 ${pi + 1}/${pre.length}`);
  }
  return results;
}

/** 逐像素分类：返回卤水 Lab 样本与各类计数 */
function classifyPixels(img: MosaicResult['canvas'], inner: [number, number][], step: number): PixelClass {
  const b = polygonBounds(inner);
  const out: PixelClass = { valid: [], fallback: [], salt: 0, mud: 0, glint: 0, ridge: 0, total: 0 };
  const x0 = Math.max(0, Math.ceil(b.x));
  const y0 = Math.max(0, Math.ceil(b.y));
  const x1 = Math.min(img.width - 1, Math.floor(b.x + b.w));
  const y1 = Math.min(img.height - 1, Math.floor(b.y + b.h));

  for (let y = y0; y <= y1; y += step) {
    for (let x = x0; x <= x1; x += step) {
      if (!pointInPolygon(x, y, inner)) continue;
      out.total++;
      const i = (y * img.width + x) * 4;
      const lab = srgbToLab([img.data[i], img.data[i + 1], img.data[i + 2]]);
      const cls = classifyOne(lab);
      switch (cls) {
        case 'glint':
          out.glint++;
          break;
        case 'salt':
          out.salt++;
          break;
        case 'mud':
          out.mud++;
          out.fallback.push(lab);
          break;
        case 'ridge':
          out.ridge++;
          out.fallback.push(lab);
          break;
        default:
          out.valid.push(lab);
          out.fallback.push(lab);
      }
    }
  }
  return out;
}

/**
 * 单像素地物分类。判别按“高置信地物优先、卤水兜底”的顺序，保证中高浓度
 * 粉红/红褐卤水（明度低、彩度高）不会被误判成泥或埂。
 * 关键：粉红藻色（高 a*）与白色结晶（高明度低彩度）走完全不同的分支，互不干扰。
 */
function classifyOne(lab: Lab): 'brine' | 'salt' | 'glint' | 'mud' | 'ridge' {
  const [L, a, bChroma] = lab;
  const chroma = Math.hypot(a, bChroma);

  // 1) 镜面反光：极高明度 + 近乎中性（盐花也是中性白，但反光更亮，先判反光）
  if (L >= GLINT_L_MIN && chroma < GLINT_CHROMA_MAX) return 'glint';
  // 2) 白色盐花：高明度 + 低彩度。粉红藻色 chroma 普遍 >10，不会落到这里
  if (L >= SALT_L_MIN && chroma < SALT_CHROMA_MAX) return 'salt';
  // 3) 池底泥斑：必须同时满足低明度、暖色、与泥色足够接近（高彩度红卤水被排除）
  if (L <= MUDDY_L_MAX && chroma < 18 && deltaE(lab, MUDDY_BOTTOM_LAB) < 11) return 'mud';
  // 4) 埂土：中低明度、低 a*（埂土偏黄褐，a* 明显低于粉红藻色）、b* 暖黄且与埂色接近。
  //    粉红/红色藻卤 a* 常 >8，用 a* 上限严格排除，避免高浓度藻池被误判成埂。
  if (L <= RIDGE_L_MAX && a < 8 && bChroma > 10 && deltaE(lab, RIDGE_LAB) < 10) return 'ridge';
  // 5) 其余一律视为卤水（含粉红/红色藻色、青绿低浓度、黄褐无藻高浓度）
  return 'brine';
}

/** Lab 稳健均值：先普通均值，再剔除 ΔE > 2.5 MAD 的离群像素后重算 */
function robustMeanLab(samples: Lab[]): Lab {
  if (samples.length === 0) return [0, 0, 0];
  const first = meanLab(samples);
  if (samples.length < 12) return first;
  const dists = samples.map((s) => deltaE(s, first));
  const med = median(dists);
  const kept = samples.filter((_, i) => dists[i] <= Math.max(2.5, med * 2.5));
  return meanLab(kept.length >= 8 ? kept : samples);
}

function median(v: number[]): number {
  const s = [...v].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function polyDistance(a: [number, number][], b: [number, number][]): number {
  const ca = centroid(a);
  const cb = centroid(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

function centroid(poly: [number, number][]): { x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const [px, py] of poly) {
    x += px;
    y += py;
  }
  return { x: x / poly.length, y: y / poly.length };
}

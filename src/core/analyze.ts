// 池子颜色分析核心：剔除盐花/泥/反光/土埂 -> 稳健平均水色 -> 标定模型反演波美度
// -> 空间趋势异常检测 -> 评测（对当天实测/合成真值）-> 生成浓度标注层。
import { classifyPixel } from './classify';
import { median, rgbToLab, trimmedMean, baumeToColor } from './color';
import { pinkIndexOfLab } from './brine';
import { CalibrationModel, uid } from './calibration';
import type {
  AnalysisResult,
  CalibSample,
  EvalSummary,
  Pan,
  PanColorStats,
  RGB,
} from './types';

type Progress = (frac: number, label: string) => void;

/** 把合成真值/当天实测按池号合并到分割出的池子上 */
export function mergeTruth(detected: Pan[], truth: Pan[]): Pan[] {
  const byId = new Map(truth.map((p) => [p.id, p]));
  return detected.map((p) => {
    const t = byId.get(p.id);
    if (!t) return p;
    return {
      ...p,
      trueBaume: t.trueBaume,
      measuredBaume: t.measuredBaume,
      measuredAt: t.measuredAt,
      note: t.note,
    };
  });
}

/** 第一阶段：逐池剔除干扰并提取稳健水色（不依赖标定模型） */
export function extractPanColors(
  mosaic: Uint8ClampedArray,
  W: number,
  H: number,
  pans: Pan[],
  onProgress?: Progress,
): PanColorStats[] {
  const noop: Progress = () => {};
  const prog = onProgress ?? noop;
  const stats: PanColorStats[] = [];

  pans.forEach((pan, pi) => {
    const inset = 3;
    const x0 = Math.max(0, Math.round(pan.bbox.minX) + inset);
    const x1 = Math.min(W - 1, Math.round(pan.bbox.maxX) - inset);
    const y0 = Math.max(0, Math.round(pan.bbox.minY) + inset);
    const y1 = Math.min(H - 1, Math.round(pan.bbox.maxY) - inset);

    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    let nTotal = 0;
    let nWater = 0;
    let nSalt = 0;
    let nMad = 0;
    let nGlint = 0;
    let nRidge = 0;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * W + x) * 4;
        const r = mosaic[i];
        const g = mosaic[i + 1];
        const b = mosaic[i + 2];
        nTotal++;
        const cls = classifyPixel(r, g, b);
        if (cls === 'water') {
          nWater++;
          if (rs.length < 24000) {
            rs.push(r);
            gs.push(g);
            bs.push(b);
          } else if ((x * 3 + y) % 3 === 0) {
            // 超出上限后做蓄水池式稀疏替换，保留空间代表性
            const j = Math.floor(hash01(nWater) * 24000);
            rs[j] = r;
            gs[j] = g;
            bs[j] = b;
          }
        } else if (cls === 'salt') nSalt++;
        else if (cls === 'mud') nMad++;
        else if (cls === 'glint') nGlint++;
        else nRidge++;
      }
    }

    const denom = Math.max(1, nTotal);
    let medianRGB: RGB = { r: 0, g: 0, b: 0 };
    let meanRGB: RGB = { r: 0, g: 0, b: 0 };
    if (rs.length > 30) {
      medianRGB = { r: median(rs), g: median(gs), b: median(bs) };
      meanRGB = { r: trimmedMean(rs, 0.1), g: trimmedMean(gs, 0.1), b: trimmedMean(bs, 0.1) };
    }

    const fSalt = nSalt / denom;
    stats.push({
      panId: pan.id,
      waterPixels: nWater,
      saltPixels: nSalt,
      mudPixels: nMad,
      glintPixels: nGlint,
      ridgePixels: nRidge,
      fractions: {
        water: nWater / denom,
        salt: fSalt,
        mud: nMad / denom,
        glint: nGlint / denom,
        ridge: nRidge / denom,
      },
      meanRGB,
      medianRGB,
      meanLab: rgbToLab(medianRGB),
      pinkIndex: rs.length > 30 ? pinkIndexOfLab(rgbToLab(medianRGB)) : 0,
      whiteIndex: Math.min(1, fSalt / 0.16),
      baume: NaN,
      anomaly: false,
      anomalyReasons: [],
      confidence: rs.length > 30 ? 0.9 : 0.15,
    });

    if (pi % 8 === 0) prog(0.08 + 0.5 * (pi / pans.length), `提取池水颜色 ${pi + 1}/${pans.length}`);
  });

  return stats;
}

function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 用当天部分舀样池的“校正后影像水色 + 波美计实测值”生成盐场自己的标定样本。
 * 按实测浓度排序后等距抽取，保证覆盖整个浓度区间；这些样本与待预测池走同一处理链路，
 * 因而能消去光照校正/合成链路的系统偏差。
 */
export function buildSurveyCalibration(
  pans: Pan[],
  stats: PanColorStats[],
  every = 2,
): CalibSample[] {
  const byId = new Map(pans.map((p) => [p.id, p]));
  const usable = stats
    .filter((s) => {
      const p = byId.get(s.panId);
      return p && p.measuredBaume != null && s.waterPixels > 200;
    })
    .map((s) => ({ s, b: byId.get(s.panId)!.measuredBaume as number }))
    .sort((a, b) => a.b - b.b);

  const samples: CalibSample[] = [];
  usable.forEach((u, i) => {
    if (i % every !== 0 && i !== usable.length - 1) return;
    samples.push({
      id: uid('cal'),
      baume: Math.round(u.b * 10) / 10,
      rgb: { ...u.s.medianRGB },
      source: '当日舀样标定',
      date: new Date().toISOString().slice(0, 10),
    });
  });
  return samples;
}

function fitTrendPlane(stats: PanColorStats[], pans: Pan[]) {
  const byId = new Map(pans.map((p) => [p.id, p]));
  let n = 0;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sz = 0, Sxz = 0, Syz = 0;
  for (const s of stats) {
    const p = byId.get(s.panId);
    if (!p || !Number.isFinite(s.baume)) continue;
    const x = p.col;
    const y = p.row;
    const z = s.baume;
    n++;
    Sx += x; Sy += y; Sxx += x * x; Syy += y * y; Sxy += x * y;
    Sz += z; Sxz += x * z; Syz += y * z;
  }
  if (n < 6) return () => 0;
  const M = [
    [n, Sx, Sy, Sz],
    [Sx, Sxx, Sxy, Sxz],
    [Sy, Sxy, Syy, Syz],
  ];
  for (let c = 0; c < 3; c++) {
    let piv = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const pv = M[c][c] || 1e-9;
    for (let k = c; k <= 3; k++) M[c][k] /= pv;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let k = c; k <= 3; k++) M[r][k] -= f * M[c][k];
    }
  }
  const a = M[0][3];
  const b = M[1][3];
  const cc = M[2][3];
  return (col: number, row: number) => a + b * col + cc * row;
}

/** 第二阶段：用标定模型反演波美度、检异常、出标注层与评测 */
export function finalizeAnalysis(
  stats: PanColorStats[],
  pans: Pan[],
  model: CalibrationModel,
  W: number,
  H: number,
  startedAt?: number,
  onProgress?: Progress,
): AnalysisResult {
  const prog = onProgress ?? (() => {});

  prog(0.62, '标定关系反演波美度');
  for (const s of stats) {
    if (s.waterPixels <= 30) {
      s.baume = NaN;
      s.confidence = 0.1;
      continue;
    }
    const pred = model.predict(s.meanLab);
    s.baume = Math.round(pred.baume * 10) / 10;
    s.confidence = Math.round(pred.confidence * (0.75 + 0.25 * Math.min(1, s.fractions.water + 0.2)) * 100) / 100;
    const pan = pans.find((p) => p.id === s.panId);
    if (pan?.measuredBaume != null) {
      s.errorVsMeasured = Math.round(Math.abs(s.baume - pan.measuredBaume) * 100) / 100;
    }
  }

  prog(0.7, '检测颜色异常池子');
  const trend = fitTrendPlane(stats, pans);
  for (const s of stats) {
    const pan = pans.find((p) => p.id === s.panId);
    if (!pan || !Number.isFinite(s.baume)) continue;
    const expected = trend(pan.col, pan.row);
    const deficit = expected - s.baume;
    if (deficit >= 3.4) {
      s.anomaly = true;
      s.anomalyReasons.push(`较盐田浓度趋势偏低 ${deficit.toFixed(1)}°Bé，疑似渗漏/雨水变淡`);
    }
    if (s.fractions.glint > 0.12) {
      s.anomalyReasons.push('水面反光占比偏高，结论需结合复飞');
    }
    if (s.confidence < 0.45) {
      s.anomalyReasons.push('有效水色像素偏少/标定距离远，置信度低');
    }
  }

  prog(0.82, '绘制浓度标注层');
  const overlay = buildOverlay(W, H, pans, stats);

  prog(0.92, '汇总精度评测');
  const evaluation = evaluate(pans, stats);

  // 统一使用 Date 时钟，保证 Worker 传入的 startedAt 与这里一致
  const elapsedMs = Date.now() - (startedAt ?? Date.now());
  prog(1, '分析完成');

  return { pans, stats, overlay, width: W, height: H, elapsedMs, evaluation };
}

export interface AnalyzeOptions {
  mosaic: Uint8ClampedArray;
  width: number;
  height: number;
  pans: Pan[];
  model: CalibrationModel;
  onProgress?: Progress;
}

/** 一次性分析（使用外部传入的标定模型） */
export function analyzeMosaic(opts: AnalyzeOptions): AnalysisResult {
  const startedAt = Date.now();
  const stats = extractPanColors(opts.mosaic, opts.width, opts.height, opts.pans, opts.onProgress);
  return finalizeAnalysis(
    stats,
    opts.pans,
    opts.model,
    opts.width,
    opts.height,
    startedAt,
    opts.onProgress,
  );
}

function blend(data: Uint8ClampedArray, i: number, c: RGB, a: number) {
  data[i] = data[i] * (1 - a) + c.r * a;
  data[i + 1] = data[i + 1] * (1 - a) + c.g * a;
  data[i + 2] = data[i + 2] * (1 - a) + c.b * a;
  data[i + 3] = 255;
}

function buildOverlay(W: number, H: number, pans: Pan[], stats: PanColorStats[]): Uint8ClampedArray {
  const ov = new Uint8ClampedArray(W * H * 4);
  const byId = new Map(stats.map((s) => [s.panId, s]));

  for (const pan of pans) {
    const s = byId.get(pan.id);
    if (!s || !Number.isFinite(s.baume)) continue;
    const color = baumeToColor(s.baume);
    const { minX, minY, maxX, maxY } = pan.bbox;
    for (let y = Math.max(0, Math.ceil(minY) + 2); y <= Math.min(H - 1, Math.floor(maxY) - 2); y++) {
      for (let x = Math.max(0, Math.ceil(minX) + 2); x <= Math.min(W - 1, Math.floor(maxX) - 2); x++) {
        const i = (y * W + x) * 4;
        ov[i] = color.r;
        ov[i + 1] = color.g;
        ov[i + 2] = color.b;
        ov[i + 3] = 96;
      }
    }
    const edge: RGB = s.anomaly ? { r: 255, g: 45, b: 45 } : { r: 255, g: 255, b: 255 };
    const thick = s.anomaly ? 4 : 2;
    for (let t = 0; t < thick; t++) {
      for (let x = Math.round(minX); x <= Math.round(maxX); x++) {
        for (const yy of [Math.round(minY) + t, Math.round(maxY) - t]) {
          if (yy < 0 || yy >= H || x < 0 || x >= W) continue;
          blend(ov, (yy * W + x) * 4, edge, 0.95);
        }
      }
      for (let y = Math.round(minY); y <= Math.round(maxY); y++) {
        for (const xx of [Math.round(minX) + t, Math.round(maxX) - t]) {
          if (xx < 0 || xx >= W || y < 0 || y >= H) continue;
          blend(ov, (y * W + xx) * 4, edge, 0.95);
        }
      }
    }
  }
  return ov;
}

export function evaluate(pans: Pan[], stats: PanColorStats[], tolerance = 1.5): EvalSummary {
  const byId = new Map(pans.map((p) => [p.id, p]));
  let withM = 0;
  let within = 0;
  let maxErr = 0;
  let sumAbs = 0;
  let sq = 0;

  let trueN = 0;
  let trueWithin = 0;
  let trueMax = 0;
  let trueSum = 0;

  for (const s of stats) {
    const p = byId.get(s.panId);
    if (!p || !Number.isFinite(s.baume)) continue;
    if (p.measuredBaume != null) {
      const e = Math.abs(s.baume - p.measuredBaume);
      withM++;
      sumAbs += e;
      sq += e * e;
      maxErr = Math.max(maxErr, e);
      if (e <= tolerance + 1e-9) within++;
    }
    if (p.trueBaume != null) {
      const e = Math.abs(s.baume - p.trueBaume);
      trueN++;
      trueSum += e;
      trueMax = Math.max(trueMax, e);
      if (e <= tolerance + 1e-9) trueWithin++;
    }
  }
  return {
    total: stats.length,
    withMeasurement: withM,
    withinTolerance: within,
    tolerance,
    maxAbsError: Math.round(maxErr * 100) / 100,
    meanAbsError: withM ? Math.round((sumAbs / withM) * 100) / 100 : 0,
    rmse: withM ? Math.round(Math.sqrt(sq / withM) * 100) / 100 : 0,
    trueWithinTolerance: trueN ? trueWithin : undefined,
    trueMaxAbsError: trueN ? Math.round(trueMax * 100) / 100 : undefined,
    trueMeanAbsError: trueN ? Math.round((trueSum / trueN) * 100) / 100 : undefined,
  };
}

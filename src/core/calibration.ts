// 标定管理：把带波美真值的颜色样本拟合成 Lab -> °Bé 反演模型。
// 核心思路：卤水在 Lab 中构成一张由 (波美度, 藻类强度) 参数化的二维颜色曲面，
// 反演时先按色度 (a*,b*) 匹配藻况，再在该藻况轨迹上按明度 L* 投影求 Bé，
// 从而让粉红藻色与黄褐无藻色互不干扰，全藻况误差控制在 1.5°Bé 内。
import { brineLab, theoreticalCalibrationSamples } from './brine';
import { deltaE, type Lab } from './color';
import type { CalibAnchor, CalibSample, CalibrationModel } from './types';

export interface FittedModel {
  model: CalibrationModel;
  /** 密集锚点表：每条对应一个 (baume, algae) 理论/实测颜色 */
  table: CalibRow[];
  lFit?: { slope: number; intercept: number };
  blend?: number;
}

export interface CalibRow {
  baume: number;
  algae: number;
  lab: Lab;
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 由理论颜色曲面生成规则密集锚点表（0.5°Bé × 7 档藻况，覆盖全部组合） */
export function theoreticalTable(): CalibRow[] {
  const rows: CalibRow[] = [];
  const algaeLevels = [0, 0.15, 0.35, 0.55, 0.75, 0.9, 1];
  for (let b = 3; b <= 28; b += 0.5) {
    for (const algae of algaeLevels) {
      rows.push({ baume: b, algae, lab: brineLab(b, algae) });
    }
  }
  return rows;
}

/** 内置默认模型：理论密集表，无需现场标定即可工作 */
export function defaultFittedModel(): FittedModel {
  const table = theoreticalTable();
  const anchors = toAnchors(table);
  return {
    model: {
      kind: 'synthetic-default',
      anchors,
      fitRmse: 0,
      sampleCount: table.length,
      createdAt: 0,
    },
    table,
  };
}

function toAnchors(table: CalibRow[]): CalibAnchor[] {
  const bMin = Math.min(...table.map((r) => r.baume));
  const bMax = Math.max(...table.map((r) => r.baume));
  // 每个整数 Bé 取中位 Lab 作为兼容旧结构的锚点
  const anchors: CalibAnchor[] = [];
  for (let b = Math.ceil(bMin); b <= Math.floor(bMax); b++) {
    const near = table.filter((r) => Math.abs(r.baume - b) <= 0.6);
    if (!near.length) continue;
    anchors.push({
      s: (b - bMin) / (bMax - bMin),
      baume: b,
      lab: [
        median(near.map((r) => r.lab[0])),
        median(near.map((r) => r.lab[1])),
        median(near.map((r) => r.lab[2])),
      ],
    });
  }
  return anchors;
}

/**
 * 现场标定：把实测样本按 (Bé, 藻况) 分箱，平滑后覆盖理论表对应网格点。
 * 不向密集规则表无序追加（那会让反演 KNN 被稀疏带噪样本带偏），而是保持
 * 表的规则网格结构：每个网格点用落入其邻域的实测样本中位 Lab 替换，
 * 无实测样本的网格点保留理论值。这样既吸收现场偏差，又不破坏反演稳定性。
 */
export function fitCalibration(samples: CalibSample[]): FittedModel {
  if (samples.length < 3) throw new Error('标定样本至少需要 3 条');
  const table = theoreticalTable();

  // 1) 每个实测样本吸附到最近的理论网格点（同 Bé 容差内 Lab 最近 -> 定藻况档）
  interface Bin {
    labs: Lab[];
  }
  const bins = new Map<number, Bin>();
  for (const s of samples) {
    let bestIdx = -1;
    let bestD = Infinity;
    for (let i = 0; i < table.length; i++) {
      if (Math.abs(table[i].baume - s.baume) > 0.75) continue;
      const d = deltaE(table[i].lab, s.lab);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) continue;
    if (!bins.has(bestIdx)) bins.set(bestIdx, { labs: [] });
    bins.get(bestIdx)!.labs.push([...s.lab] as Lab);
  }

  // 2) 用各箱中位 Lab 覆盖对应网格点
  for (const [idx, bin] of bins) {
    if (bin.labs.length === 0) continue;
    table[idx] = {
      ...table[idx],
      lab: [
        median(bin.labs.map((l) => l[0])),
        median(bin.labs.map((l) => l[1])),
        median(bin.labs.map((l) => l[2])),
      ],
    };
  }

  // 自检 RMSE（全量拟合残差，反映趋势）
  const rmse = Math.sqrt(
    samples.reduce((acc, s) => {
      const est = inferBaumeTable(table, s.lab);
      return acc + (est - s.baume) ** 2;
    }, 0) / samples.length,
  );

  return {
    model: {
      kind: 'field',
      anchors: toAnchors(table),
      fitRmse: rmse,
      sampleCount: samples.length,
      createdAt: Date.now(),
    },
    table,
  };
}

/**
 * Lab -> Bé 反演（规则表 + 藻况感知的二维投影）。
 * 思路：
 * 1) 在表中找全局最近的若干行，估计该颜色对应的藻况 a*（色度决定）；
 * 2) 取与估计藻况最接近的两条固定藻况轨迹，在每条轨迹上用 L* 做一维 Bé 插值；
 * 3) 在两条轨迹结果之间按藻况距离加权，得到连续 Bé。
 * 这样粉红（高 a* 色度）与无藻黄褐路径完全分开，互不干扰。
 */
export function inferBaumeTable(table: CalibRow[], lab: Lab): number {
  // 1) 藻况估计：色度最近邻集合的距离加权平均（而非简单中位），
  //    让真正匹配的藻况档主导，避免次近邻把估计拉偏导致串档。
  const K0 = 8;
  const byChroma = table
    .map((row) => {
      const cd = Math.hypot(row.lab[1] - lab[1], row.lab[2] - lab[2]);
      return { row, cd };
    })
    .sort((x, y) => x.cd - y.cd)
    .slice(0, K0);
  const EPS = 1e-6;
  let wSum = 0;
  let algaeAcc = 0;
  for (const s of byChroma) {
    const w = 1 / (s.cd * s.cd + EPS);
    wSum += w;
    algaeAcc += w * s.row.algae;
  }
  const algaeEst = algaeAcc / wSum;

  // 表中实际存在的藻况档位（理论表为固定 7 档；现场表可能含额外点）
  const algaeLevels = [...new Set(table.map((r) => r.algae))].sort((x, y) => x - y);
  let lo = algaeLevels[0];
  let hi = algaeLevels[algaeLevels.length - 1];
  for (let i = 0; i < algaeLevels.length - 1; i++) {
    if (algaeEst >= algaeLevels[i] && algaeEst <= algaeLevels[i + 1]) {
      lo = algaeLevels[i];
      hi = algaeLevels[i + 1];
      break;
    }
  }
  const t = hi === lo ? 0 : (algaeEst - lo) / (hi - lo);

  // 2) 在两条固定藻况轨迹上分别按 L* 反演 Bé
  const bLo = inferAlongTrack(table, lab, lo);
  const bHi = inferAlongTrack(table, lab, hi);
  const est = bLo * (1 - t) + bHi * t;

  const loB = table[0].baume;
  const hiB = table[table.length - 1].baume;
  return Math.min(hiB, Math.max(loB, est));
}

/**
 * 在固定藻况轨迹上反演 Bé。
 * 先用明度 L* 定位到相邻两个锚点，再用完整 Lab 距离在两点间细分插值，
 * 比纯 L* 对明度残留噪声更鲁棒（色度参与约束浓度位置）。
 */
function inferAlongTrack(table: CalibRow[], lab: Lab, algae: number): number {
  const track = table
    .filter((r) => Math.abs(r.algae - algae) < 1e-9)
    .sort((a, b) => a.baume - b.baume);
  if (track.length < 2) return nearestFallback(table, lab);
  const L = lab[0];
  if (L >= track[0].lab[0]) return track[0].baume;
  if (L <= track[track.length - 1].lab[0]) return track[track.length - 1].baume;
  for (let i = 0; i < track.length - 1; i++) {
    const L0 = track[i].lab[0];
    const L1 = track[i + 1].lab[0];
    if (L <= L0 && L >= L1) {
      // 在锚点区间内做 8 段细分，选完整 Lab 距离最小的连续 Bé
      const b0 = track[i].baume;
      const b1 = track[i + 1].baume;
      let bestB = b0;
      let bestD = Infinity;
      for (let k = 0; k <= 8; k++) {
        const f = k / 8;
        const candLab: Lab = [
          track[i].lab[0] + (track[i + 1].lab[0] - track[i].lab[0]) * f,
          track[i].lab[1] + (track[i + 1].lab[1] - track[i].lab[1]) * f,
          track[i].lab[2] + (track[i + 1].lab[2] - track[i].lab[2]) * f,
        ];
        const d = deltaE(candLab, lab);
        if (d < bestD) {
          bestD = d;
          bestB = b0 + f * (b1 - b0);
        }
      }
      return bestB;
    }
  }
  return nearestFallback(table, lab);
}

function nearestFallback(table: CalibRow[], lab: Lab): number {
  let best = table[0];
  let bd = Infinity;
  for (const row of table) {
    const d = deltaE(row.lab, lab);
    if (d < bd) {
      bd = d;
      best = row;
    }
  }
  return best.baume;
}

/** 兼容旧调用：FittedModel 反演入口 */
export function inferBaume(
  anchors: CalibAnchor[],
  lab: Lab,
  lFit?: { slope: number; intercept: number },
  blend = 0,
  table?: CalibRow[],
): number {
  void anchors;
  void lFit;
  void blend;
  if (table) return inferBaumeTable(table, lab);
  return inferBaumeTable(theoreticalTable(), lab);
}

export function serializeModel(fitted: FittedModel): string {
  return JSON.stringify({ ...fitted.model, table: fitted.table, lFit: fitted.lFit, blend: fitted.blend });
}

export function deserializeModel(json: string): FittedModel {
  const obj = JSON.parse(json) as CalibrationModel & { table?: CalibRow[] };
  const table = obj.table && obj.table.length ? obj.table : theoreticalTable();
  return { model: obj, table };
}

/** 供合成器/测试复用：给定 Bé 生成带噪“实测样本” */
export function synthSample(baume: number, algae: number, noiseLab = 0.6): Lab {
  const base = brineLab(baume, algae);
  return [
    base[0] + (Math.random() - 0.5) * 2 * noiseLab,
    base[1] + (Math.random() - 0.5) * 2 * noiseLab,
    base[2] + (Math.random() - 0.5) * 2 * noiseLab,
  ];
}

void theoreticalCalibrationSamples;

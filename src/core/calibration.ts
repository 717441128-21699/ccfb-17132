// 标定管理：盐场波美计实测样本 <-> 池水颜色。
// 模型 = Lab 特征二次岭回归（给出全局平滑关系/外推）+ K 近邻局部加权（保证密集标定段精度）。
import { rgbToLab } from './color';
import { brineAppearanceRGB } from './brine';
import type { AlgaeKind, CalibSample, Lab, RGB } from './types';

let seq = 0;
export function uid(prefix = 'id'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 生成盐场自己的波美计实测标定数据（按几种藻类颜色），带测量噪声 */
export function makeDefaultCalibration(algae: AlgaeKind, seed = 20240517): CalibSample[] {
  let s = seed >>> 0;
  const rnd = () => {
    // mulberry32
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 0.5;

  const samples: CalibSample[] = [];
  // 从海水到结晶区间，约每 1 度一个实测点，覆盖到 30°Bé
  for (let b = 2; b <= 30; b += 1) {
    const trueB = b + (rnd() - 0.5) * 0.4;
    const baume = Math.round((trueB + gauss() * 0.28) * 10) / 10;
    const c = brineAppearanceRGB(trueB, algae);
    const noisy: RGB = {
      r: clampByte(c.r + gauss() * 5),
      g: clampByte(c.g + gauss() * 5),
      b: clampByte(c.b + gauss() * 5),
    };
    samples.push({
      id: uid('cal'),
      baume: Math.max(0, Math.round(baume * 10) / 10),
      rgb: noisy,
      source: '波美计实测',
      date: `2024-05-${String(10 + (b % 18)).padStart(2, '0')}`,
    });
  }
  return samples;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------- 线性代数：高斯消元解 Ax=b ----------
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col] || 1e-12;
    for (let c = col; c <= n; c++) M[col][c] /= pv;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/** 二次特征（含交互），并做标准化 */
function features(lab: Lab, mean: number[], std: number[]): number[] {
  const x0 = (lab.L - mean[0]) / std[0];
  const x1 = (lab.a - mean[1]) / std[1];
  const x2 = (lab.b - mean[2]) / std[2];
  return [1, x0, x1, x2, x0 * x0, x1 * x1, x2 * x2, x0 * x1, x1 * x2, x0 * x2];
}

export interface FitScore {
  r2: number;
  rmse: number;
  mae: number;
}

export class CalibrationModel {
  samples: CalibSample[];
  private coef: number[] = [];
  private mean = [50, 0, 0];
  private std = [20, 20, 20];
  private fitted = false;

  constructor(samples: CalibSample[]) {
    this.samples = samples;
    this.fit();
  }

  fit(): void {
    const labs = this.samples.map((s) => rgbToLab(s.rgb));
    if (labs.length >= 3) {
      const m = [0, 0, 0];
      for (const l of labs) {
        m[0] += l.L;
        m[1] += l.a;
        m[2] += l.b;
      }
      m.forEach((_, i) => (m[i] /= labs.length));
      const sd = [0, 0, 0];
      for (const l of labs) {
        sd[0] += (l.L - m[0]) ** 2;
        sd[1] += (l.a - m[1]) ** 2;
        sd[2] += (l.b - m[2]) ** 2;
      }
      this.mean = m;
      this.std = sd.map((v) => Math.max(4, Math.sqrt(v / labs.length)));
    }

    if (this.samples.length < 6) {
      // 样本太少：退化为线性 L/a/b
      this.coef = this.fitLinear();
      this.fitted = this.samples.length >= 2;
      return;
    }

    const p = 10;
    const A: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
    const rhs = new Array(p).fill(0);
    const lambda = 1.2; // 岭正则，抑制共线
    for (const s of this.samples) {
      const x = features(rgbToLab(s.rgb), this.mean, this.std);
      for (let i = 0; i < p; i++) {
        rhs[i] += x[i] * s.baume;
        for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j];
      }
    }
    for (let i = 1; i < p; i++) A[i][i] += lambda; // 不正则截距
    try {
      this.coef = solveLinear(A, rhs);
      this.fitted = true;
    } catch {
      this.coef = this.fitLinear();
      this.fitted = this.samples.length >= 2;
    }
  }

  private fitLinear(): number[] {
    // 最简：返回 [均值, 0...]，predict 走近邻
    const meanB = this.samples.reduce((a, s) => a + s.baume, 0) / Math.max(1, this.samples.length);
    return [meanB, 0, 0, 0];
  }

  polyPredict(lab: Lab): number {
    if (!this.fitted) return this.nearest(lab);
    if (this.coef.length === 10) {
      const x = features(lab, this.mean, this.std);
      let y = 0;
      for (let i = 0; i < 10; i++) y += this.coef[i] * x[i];
      return y;
    }
    return this.coef[0] ?? this.nearest(lab);
  }

  private labDistanceW(a: Lab, b: Lab): number {
    // 亮度权重低：光照残余主要影响 L，色度 a/b 更可信
    const dL = (a.L - b.L) * 0.55;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return Math.sqrt(dL * dL + da * da + db * db);
  }

  nearest(lab: Lab): number {
    if (this.samples.length === 0) return NaN;
    let best = this.samples[0];
    let bd = Infinity;
    for (const s of this.samples) {
      const d = this.labDistanceW(lab, rgbToLab(s.rgb));
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best.baume;
  }

  /** 综合预测：密集标定段用局部加权，远离标定流形时用多项式并降置信度 */
  predict(lab: Lab): { baume: number; confidence: number; nearestDist: number } {
    if (this.samples.length === 0) {
      return { baume: NaN, confidence: 0, nearestDist: Infinity };
    }
    const withDist = this.samples
      .map((s) => ({ s, d: this.labDistanceW(lab, rgbToLab(s.rgb)) }))
      .sort((a, b) => a.d - b.d);
    const nearestDist = withDist[0].d;
    const K = Math.min(5, withDist.length);
    // 反距离平方加权：密集盐场标定下让最近样本主导，避免高曲率颜色轨迹被远端邻居拉偏
    let wsum = 0;
    let vsum = 0;
    for (let i = 0; i < K; i++) {
      const { s, d } = withDist[i];
      const w = 1 / ((d + 0.8) * (d + 0.8));
      wsum += w;
      vsum += w * s.baume;
    }
    const local = vsum / wsum;
    const poly = this.polyPredict(lab);

    // 距离很近：信局部；中等：局部与多项式融合；很远：信多项式（外推）并降置信
    let baume: number;
    let confidence: number;
    if (nearestDist < 5) {
      baume = local;
      confidence = 0.97;
    } else if (nearestDist < 14) {
      const t = (nearestDist - 5) / 9;
      baume = local * (1 - t) + poly * t;
      confidence = 0.9 - t * 0.25;
    } else {
      baume = poly;
      confidence = Math.max(0.35, 0.65 - (nearestDist - 14) / 60);
    }
    baume = Math.max(0, Math.min(32, baume));
    return { baume, confidence, nearestDist };
  }

  /** 留一/自拟合评分（标定页图表用） */
  score(): FitScore {
    if (this.samples.length === 0) return { r2: 0, rmse: 0, mae: 0 };
    const mean = this.samples.reduce((a, s) => a + s.baume, 0) / this.samples.length;
    let ssRes = 0;
    let ssTot = 0;
    let ae = 0;
    for (const s of this.samples) {
      const p = this.polyPredict(rgbToLab(s.rgb));
      ssRes += (p - s.baume) ** 2;
      ssTot += (s.baume - mean) ** 2;
      ae += Math.abs(p - s.baume);
    }
    const rmse = Math.sqrt(ssRes / this.samples.length);
    return { r2: ssTot > 0 ? 1 - ssRes / ssTot : 1, rmse, mae: ae / this.samples.length };
  }
}

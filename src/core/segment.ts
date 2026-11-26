// 从拼接大图检测笔直土埂网格，并把每块池子的四条边吸附到土埂内沿。
import { isRidgePixel } from './classify';
import { rectQuad } from './field';
import type { Pan } from './types';

export interface Grid {
  gridX: number[];
  gridY: number[];
}

export function smooth1d(a: Float32Array, radius: number): Float32Array {
  const n = a.length;
  const out = new Float32Array(n);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += a[Math.min(n - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    out[i] = sum / (radius * 2 + 1);
    const remove = i - radius;
    const add = i + radius + 1;
    sum -= a[Math.min(n - 1, Math.max(0, remove))];
    sum += a[Math.min(n - 1, Math.max(0, add))];
  }
  return out;
}

/** 统计每一列/行的土埂像素密度 */
export function ridgeProfiles(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): { col: Float32Array; row: Float32Array } {
  const col = new Float32Array(W);
  const row = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (isRidgePixel(data[i], data[i + 1], data[i + 2])) {
        col[x]++;
        row[y]++;
      }
    }
  }
  for (let x = 0; x < W; x++) col[x] /= H;
  for (let y = 0; y < H; y++) row[y] /= W;
  return { col: smooth1d(col, 7), row: smooth1d(row, 7) };
}

/** 在一条规则等距直线网格先验下，搜索最优间距与起点，再把每条线吸附到局部峰值 */
export function detectRegularLines(profile: Float32Array, count: number, length: number): number[] {
  if (count <= 1) return [];
  const expected = (length - 120) / (count - 1);
  const sLo = expected * 0.82;
  const sHi = expected * 1.18;
  let bestScore = -Infinity;
  let bestO = 40;
  let bestS = expected;

  for (let s = sLo; s <= sHi; s += 1) {
    const maxO = length - 40 - (count - 1) * s;
    for (let o = 36; o <= Math.max(36, maxO); o += 2) {
      let score = 0;
      for (let i = 0; i < count; i++) {
        const x = Math.round(o + i * s);
        let v = 0;
        for (let d = -3; d <= 3; d++) {
          const xx = x + d;
          if (xx >= 0 && xx < length && profile[xx] > v) v = profile[xx];
        }
        score += v;
      }
      if (score > bestScore) {
        bestScore = score;
        bestO = o;
        bestS = s;
      }
    }
  }

  const lines: number[] = [];
  for (let i = 0; i < count; i++) {
    const center = bestO + i * bestS;
    let bi = Math.round(center);
    let bv = -Infinity;
    for (let d = -9; d <= 9; d++) {
      const x = Math.round(center) + d;
      if (x < 0 || x >= length) continue;
      if (profile[x] > bv) {
        bv = profile[x];
        bi = x;
      }
    }
    lines.push(bi);
  }
  return lines;
}

export function detectGrid(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  rows: number,
  cols: number,
): Grid {
  const { col, row } = ridgeProfiles(data, W, H);
  return {
    gridX: detectRegularLines(col, cols + 1, W),
    gridY: detectRegularLines(row, rows + 1, H),
  };
}

// ---------- 内沿精定位：颜色梯度峰 + 位置先验 ----------

/** 竖直边（x 变化）的颜色梯度剖面，grad[x - xFrom] */
function verticalGradProfile(
  data: Uint8ClampedArray,
  W: number,
  y0: number,
  y1: number,
  xFrom: number,
  xTo: number,
): Float32Array {
  const len = xTo - xFrom + 1;
  const p = new Float32Array(len);
  for (let x = xFrom; x <= xTo; x++) {
    let sum = 0;
    let n = 0;
    for (let y = y0; y <= y1; y += 2) {
      const i1 = (y * W + Math.max(0, x - 2)) * 4;
      const i2 = (y * W + Math.min(W - 1, x + 2)) * 4;
      sum +=
        Math.abs(data[i2] - data[i1]) +
        Math.abs(data[i2 + 1] - data[i1 + 1]) +
        Math.abs(data[i2 + 2] - data[i1 + 2]);
      n++;
    }
    p[x - xFrom] = sum / Math.max(1, n);
  }
  return smooth1d(p, 2);
}

function horizontalGradProfile(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  x0: number,
  x1: number,
  yFrom: number,
  yTo: number,
): Float32Array {
  const len = yTo - yFrom + 1;
  const p = new Float32Array(len);
  for (let y = yFrom; y <= yTo; y++) {
    let sum = 0;
    let n = 0;
    const ya = Math.max(0, y - 2);
    const yb = Math.min(H - 1, y + 2);
    for (let x = x0; x <= x1; x += 2) {
      const a = (ya * W + x) * 4;
      const b = (yb * W + x) * 4;
      sum +=
        Math.abs(data[b] - data[a]) +
        Math.abs(data[b + 1] - data[a + 1]) +
        Math.abs(data[b + 2] - data[a + 2]);
      n++;
    }
    p[y - yFrom] = sum / Math.max(1, n);
  }
  return smooth1d(p, 2);
}

/** 在期望位置附近，用梯度峰并叠加高斯位置先验，返回绝对坐标 */
function locateEdge(profile: Float32Array, from: number, expectedAbs: number, priorSigma = 5.5): number {
  const expectedIdx = expectedAbs - from;
  let bestIdx = expectedIdx;
  let bestVal = -Infinity;
  const lo = Math.max(1, expectedIdx - 11);
  const hi = Math.min(profile.length - 2, expectedIdx + 11);
  let maxG = 1;
  for (let i = lo; i <= hi; i++) maxG = Math.max(maxG, profile[i]);
  for (let i = lo; i <= hi; i++) {
    const prior = Math.exp(-((i - expectedIdx) ** 2) / (2 * priorSigma * priorSigma));
    const val = (profile[i] / maxG) * (0.55 + 0.45 * prior) + prior * 0.12;
    if (val > bestVal) {
      bestVal = val;
      bestIdx = i;
    }
  }
  // 二次插值求亚像素
  const y0 = profile[bestIdx - 1] ?? profile[bestIdx];
  const y1 = profile[bestIdx];
  const y2 = profile[bestIdx + 1] ?? profile[bestIdx];
  const denom = y0 - 2 * y1 + y2;
  let sub = 0;
  if (Math.abs(denom) > 1e-6) sub = (0.5 * (y0 - y2)) / denom;
  sub = Math.max(-1, Math.min(1, sub));
  return from + bestIdx + sub;
}

const HALF_RIDGE = 12;

/** 依据网格线把每块池子四边吸附到土埂内沿，输出 Pan[] */
export function segmentPans(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  grid: Grid,
): Pan[] {
  const pans: Pan[] = [];
  const rows = grid.gridY.length - 1;
  const cols = grid.gridX.length - 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx0 = grid.gridX[c];
      const gx1 = grid.gridX[c + 1];
      const gy0 = grid.gridY[r];
      const gy1 = grid.gridY[r + 1];
      if ([gx0, gx1, gy0, gy1].some((v) => Number.isNaN(v))) continue;

      // 用池子中段 62% 区域做边检测，避开四角交汇
      const my0 = Math.round(gy0 + (gy1 - gy0) * 0.19);
      const my1 = Math.round(gy1 - (gy1 - gy0) * 0.19);
      const mx0 = Math.round(gx0 + (gx1 - gx0) * 0.19);
      const mx1 = Math.round(gx1 - (gx1 - gx0) * 0.19);

      const leftExp = gx0 + HALF_RIDGE + 1;
      const rightExp = gx1 - HALF_RIDGE - 1;
      const topExp = gy0 + HALF_RIDGE + 1;
      const bottomExp = gy1 - HALF_RIDGE - 1;

      const lFrom = Math.round(leftExp - 12);
      const lTo = Math.round(leftExp + 12);
      const left = locateEdge(verticalGradProfile(data, W, my0, my1, lFrom, lTo), lFrom, leftExp);

      const rFrom = Math.round(rightExp - 12);
      const rTo = Math.round(rightExp + 12);
      const right = locateEdge(verticalGradProfile(data, W, my0, my1, rFrom, rTo), rFrom, rightExp);

      const tFrom = Math.round(topExp - 12);
      const tTo = Math.round(topExp + 12);
      const top = locateEdge(horizontalGradProfile(data, W, H, mx0, mx1, tFrom, tTo), tFrom, topExp);

      const bFrom = Math.round(bottomExp - 12);
      const bTo = Math.round(bottomExp + 12);
      const bottom = locateEdge(horizontalGradProfile(data, W, H, mx0, mx1, bFrom, bTo), bFrom, bottomExp);

      const id = `P${String(r + 1).padStart(2, '0')}-${String(c + 1).padStart(2, '0')}`;
      const quad = rectQuad(left, top, right, bottom);
      pans.push({
        id,
        row: r,
        col: c,
        quad,
        bbox: { minX: left, minY: top, maxX: right, maxY: bottom },
      });
    }
  }
  return pans;
}

/** 边界贴合评测：分割边 vs 合成真值内沿，返回平均/最大绝对偏差(px) */
export function evaluateBoundaries(
  detected: Pan[],
  truth: Pan[],
): { meanPx: number; maxPx: number; perPan: Record<string, number> } {
  const truthById = new Map(truth.map((p) => [p.id, p]));
  let sum = 0;
  let n = 0;
  let max = 0;
  const perPan: Record<string, number> = {};
  for (const p of detected) {
    const t = truthById.get(p.id);
    if (!t) continue;
    const e = p.bbox;
    const q = t.bbox;
    const d =
      (Math.abs(e.minX - q.minX) +
        Math.abs(e.maxX - q.maxX) +
        Math.abs(e.minY - q.minY) +
        Math.abs(e.maxY - q.maxY)) /
      4;
    perPan[p.id] = Math.round(d * 100) / 100;
    sum += d;
    n++;
    max = Math.max(max, d);
  }
  return { meanPx: n ? sum / n : NaN, maxPx: max, perPan };
}

// 盐田网格布局与浓度真值。土埂是笔直的网格线，池子是网格内沿围成的矩形。
import { Rng } from './rng';
import type { BBox, Pan, Point, Quad } from './types';

export const WORLD_W = 2800;
export const WORLD_H = 1800;
export const FIELD_MARGIN = 64;
export const RIDGE_WIDTH = 24; // 土埂宽度（大图 px）
export const FIELD_ROWS = 6;
export const FIELD_COLS = 10;

export interface FieldLayout {
  width: number;
  height: number;
  rows: number;
  cols: number;
  /** 竖直土埂中心线 x（cols+1 条） */
  gridX: number[];
  /** 水平土埂中心线 y（rows+1 条） */
  gridY: number[];
  pans: Pan[];
  /** 异常（突然变淡）池子 id */
  anomalyIds: string[];
  seed: number;
}

export function rectQuad(x0: number, y0: number, x1: number, y1: number): Quad {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

export function quadBBox(q: Quad): BBox {
  const xs = q.map((p) => p.x);
  const ys = q.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

/** 生成盐田布局与每块池子的真值波美度、当天实测、异常标记 */
export function buildField(seed = 20240517, injectAnomalies = true): FieldLayout {
  const rng = new Rng(seed);
  const rows = FIELD_ROWS;
  const cols = FIELD_COLS;
  const x0 = FIELD_MARGIN;
  const y0 = FIELD_MARGIN;
  const cellW = (WORLD_W - FIELD_MARGIN * 2) / cols;
  const cellH = (WORLD_H - FIELD_MARGIN * 2) / rows;

  const gridX = Array.from({ length: cols + 1 }, (_, c) => x0 + c * cellW);
  const gridY = Array.from({ length: rows + 1 }, (_, r) => y0 + r * cellH);

  // 选 2 个中高浓度区池子注入“突然变淡”（渗漏/雨水）
  const anomalyCells = new Set<string>();
  if (injectAnomalies) {
    const a1 = { r: 1 + rng.int(0, rows - 3), c: 2 + rng.int(0, Math.floor(cols * 0.45)) };
    const a2 = { r: rng.int(0, rows - 1), c: Math.floor(cols * 0.45) + rng.int(0, 2) };
    anomalyCells.add(`${a1.r}-${a1.c}`);
    anomalyCells.add(`${a2.r}-${a2.c}`);
  }

  const pans: Pan[] = [];
  const anomalyIds: string[] = [];
  const half = RIDGE_WIDTH / 2;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const id = `P${String(r + 1).padStart(2, '0')}-${String(c + 1).padStart(2, '0')}`;
      // 浓度沿 col 方向（进水口 -> 结晶区）总体升高，行间有迂回
      const gradient = 2.5 + (c / (cols - 1)) * 23.5;
      const rowMeander = Math.sin(r * 1.7 + c * 0.6) * 1.6 + (r - rows / 2) * 0.5;
      let trueBaume = gradient + rowMeander + rng.gauss() * 1.1;
      trueBaume = Math.max(2, Math.min(29, trueBaume));

      const isAnomaly = anomalyCells.has(`${r}-${c}`);
      if (isAnomaly) {
        // 突然变淡：比应有浓度低 7~11 度
        trueBaume = Math.max(2.5, gradient - rng.range(7, 11));
        anomalyIds.push(id);
      }

      // 当天波美计舀样实测 = 真值 + 观测噪声（波美计读数误差约 ±0.3）
      const measured = Math.round((trueBaume + rng.gauss() * 0.3) * 10) / 10;

      const ix0 = gridX[c] + half + 1;
      const ix1 = gridX[c + 1] - half - 1;
      const iy0 = gridY[r] + half + 1;
      const iy1 = gridY[r + 1] - half - 1;
      const quad = rectQuad(ix0, iy0, ix1, iy1);

      pans.push({
        id,
        row: r,
        col: c,
        quad,
        bbox: quadBBox(quad),
        trueBaume: Math.round(trueBaume * 10) / 10,
        measuredBaume: measured,
        measuredAt: '当日 07:40 舀样',
        note: isAnomaly ? '合成异常：突然变淡（疑似渗漏/雨水）' : undefined,
      });
    }
  }

  return {
    width: WORLD_W,
    height: WORLD_H,
    rows,
    cols,
    gridX,
    gridY,
    pans,
    anomalyIds,
    seed,
  };
}

/** 点是否在四边形内（轴对齐矩形场景直接用 bbox，这里保留通用能力） */
export function pointInQuad(p: Point, q: Quad): boolean {
  // 叉积同号判定（凸四边形）
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s = cross >= 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

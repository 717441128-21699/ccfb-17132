// 世界材质图：对整个盐场世界只计算一次“每个世界像素的材质 Lab”（卤水/盐花/泥斑/埂/灰板/边坡），
// 各张照片渲染时仅按 footprint 采样并做相机着色，避免对同一世界位置重复做数百次多边形判断。
import { brineLab, GLINT_LAB, MUDDY_BOTTOM_LAB, RIDGE_LAB, SALT_FLOWER_LAB } from './brine';
import { mixLab, type Lab } from './color';
import { pointInPolygon } from './geometry';
import type { DatasetSpec, PondDef } from './types';

export class MaterialMap {
  readonly width: number;
  readonly height: number;
  /** 每像素 3 个 float（L,a,b），紧凑存储 */
  readonly lab: Float32Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.lab = new Float32Array(width * height * 3);
  }

  /** 取世界坐标处材质 Lab，越界返回埂色 */
  sample(wx: number, wy: number): Lab {
    if (wx < 0 || wy < 0 || wx >= this.width || wy >= this.height) return RIDGE_LAB;
    const i = (wy * this.width + wx) * 3;
    return [this.lab[i], this.lab[i + 1], this.lab[i + 2]];
  }
}

const RIDGE_BAND = 26 * 0.55;

/** 一次性构建世界材质图（仅在数据集生成时调用一次） */
export function buildMaterialMap(spec: DatasetSpec): MaterialMap {
  const map = new MaterialMap(spec.worldWidth, spec.worldHeight);
  const { ponds, references } = spec;

  // 空间网格索引：每个网格记录候选池子，避免每像素遍历全部池子
  const CELL = 64;
  const cols = Math.ceil(spec.worldWidth / CELL);
  const rows = Math.ceil(spec.worldHeight / CELL);
  const grid: number[][][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => [] as number[]));
  ponds.forEach((p, idx) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of p.polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const c0 = Math.max(0, Math.floor(minX / CELL));
    const c1 = Math.min(cols - 1, Math.floor(maxX / CELL));
    const r0 = Math.max(0, Math.floor(minY / CELL));
    const r1 = Math.min(rows - 1, Math.floor(maxY / CELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) grid[r][c].push(idx);
  });

  for (let wy = 0; wy < spec.worldHeight; wy++) {
    const gc = Math.min(rows - 1, Math.floor(wy / CELL));
    for (let wx = 0; wx < spec.worldWidth; wx++) {
      const gr = Math.min(cols - 1, Math.floor(wx / CELL));
      let lab: Lab;

      // 灰板优先
      const ref = references.find((r) => wx >= r.x && wx < r.x + r.size && wy >= r.y && wy < r.y + r.size);
      if (ref) {
        const uneven = Math.sin(wx * 0.4) * 0.5 + Math.cos(wy * 0.35) * 0.5;
        lab = [ref.targetLab[0] + uneven, ref.targetLab[1], ref.targetLab[2]];
      } else {
        const candidates = grid[gc][gr];
        const pond = candidates.map((idx) => ponds[idx]).find((p) => pointInPolygon(wx, wy, p.polygon));
        if (pond) {
          lab = pondMaterial(wx, wy, pond);
        } else {
          // 土埂：确定性杂物斑点（基于世界坐标，照片间一致）
          const debris = hash2(wx, wy) < 0.012 ? (hash2(wx + 7, wy + 3) - 0.5) * 22 : 0;
          lab = [RIDGE_LAB[0] + debris, RIDGE_LAB[1], RIDGE_LAB[2] + (hash2(wx + 11, wy + 5) - 0.5) * 4];
        }
      }

      const i = (wy * spec.worldWidth + wx) * 3;
      map.lab[i] = lab[0];
      map.lab[i + 1] = lab[1];
      map.lab[i + 2] = lab[2];
    }
  }
  return map;
}

/** 单个池子内某世界坐标的材质（含边坡混色、泥斑、盐花、卤水） */
function pondMaterial(wx: number, wy: number, pond: PondDef): Lab {
  if (insideBlob(wx, wy, pond.mudBlobs)) return MUDDY_BOTTOM_LAB;
  if (insideBlob(wx, wy, pond.saltBlobs)) return SALT_FLOWER_LAB;
  const base = brineLab(pond.baume, pond.algaeStrength);
  const edgeMix = edgeProximity(wx, wy, pond.polygon);
  return edgeMix > 0 ? mixLab(base, RIDGE_LAB, edgeMix * 0.85) : base;
}

function edgeProximity(x: number, y: number, poly: [number, number][]): number {
  let minD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    minD = Math.min(minD, pointToSegment(x, y, ax, ay, bx, by));
  }
  return minD < RIDGE_BAND ? 1 - minD / RIDGE_BAND : 0;
}

function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideBlob(x: number, y: number, blobs: PondDef['mudBlobs']): boolean {
  for (const b of blobs) {
    const dx = x - b.x;
    const dy = y - b.y;
    const ca = Math.cos(-b.angle);
    const sa = Math.sin(-b.angle);
    const lx = dx * ca - dy * sa;
    const ly = dx * sa + dy * ca;
    if ((lx * lx) / (b.rx * b.rx) + (ly * ly) / (b.ry * b.ry) <= 1) return true;
  }
  return false;
}

/** 确定性二维哈希 [0,1)，用于埂杂物等空间噪声 */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

void GLINT_LAB;

// 二维几何：多边形、矩形重叠、点在多边形内、内沿收缩。
import type { GeoRect } from './types';

export type { GeoRect } from './types';

export type Pt = { x: number; y: number };
export type Poly = readonly (readonly [number, number])[];

export function asPt(poly: Poly): Pt[] {
  return poly.map(([x, y]) => ({ x, y }));
}
export function asTuple(poly: Pt[]): [number, number][] {
  return poly.map((p) => [p.x, p.y]);
}

export function rectsOverlap(a: GeoRect, b: GeoRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectIntersection(a: GeoRect, b: GeoRect): GeoRect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x || y2 <= y) return null;
  return { x, y, w: x2 - x, h: y2 - y };
}

/** 射线法判断点是否在多边形内 */
export function pointInPolygon(px: number, py: number, poly: Poly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** 多边形面积（ shoelace ） */
export function polygonArea(poly: Poly): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  }
  return Math.abs(a) / 2;
}

export function polygonBounds(poly: Poly): GeoRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * 将多边形沿每条边向内部偏移 d 像素（对凸多边形精确；池子均为近矩形凸多边形）。
 * 用于沿土埂内沿收缩采样区，保证边界与内沿贴合且不采到埂上杂物。
 */
export function insetPolygon(poly: Poly, d: number): Pt[] {
  const pts = asPt(poly);
  const n = pts.length;
  const result: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    // 两条相邻边的内法线
    const n1 = inwardNormal(prev, cur, pts);
    const n2 = inwardNormal(cur, next, pts);
    // 相邻边各自平移 d 后求交
    const p1 = { x: cur.x + n1.x * d, y: cur.y + n1.y * d };
    const p2 = { x: cur.x + n2.x * d, y: cur.y + n2.y * d };
    const d1 = { x: cur.x - prev.x, y: cur.y - prev.y };
    const d2 = { x: next.x - cur.x, y: next.y - cur.y };
    const hit = rayIntersection(p1, d1, p2, d2);
    result.push(hit ?? { x: cur.x + (n1.x + n2.x) * d * 0.5, y: cur.y + (n1.y + n2.y) * d * 0.5 });
  }
  return result;
}

function inwardNormal(a: Pt, b: Pt, poly: Pt[]): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  // 右法线
  let nx = dy / len;
  let ny = -dx / len;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const test = { x: mid.x + nx * 10, y: mid.y + ny * 10 };
  if (!pointInPolygon(test.x, test.y, asTuple(poly))) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

function rayIntersection(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/** 多边形整体平移 */
export function translatePolygon(poly: Poly, dx: number, dy: number): [number, number][] {
  return poly.map(([x, y]) => [x + dx, y + dy]);
}

/** 曼哈顿/整数网格上的直线迭代（Bresenham） */
export function* bresenham(x0: number, y0: number, x1: number, y1: number): Generator<[number, number]> {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const xe = Math.round(x1);
  const ye = Math.round(y1);
  const dx = Math.abs(xe - x);
  const dy = Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    yield [x, y];
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

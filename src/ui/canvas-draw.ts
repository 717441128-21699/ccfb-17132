// Canvas 绘制：大图（叠加池子边界/编号）与浓度热力图。全部纯 Canvas 2D。
import { zoneLabel } from '../core/brine';
import type { PondResult } from '../core/types';
import { baumeToCss } from './color-ramp';

export interface DrawMosaicOpts {
  showBoundary: boolean;
  showLabel: boolean;
  /** 等比缩放到的最大边长（0 = 原始尺寸） */
  maxEdge?: number;
}

/** 把 RGBA buffer 画到 canvas，可选叠加池子多边形边界（贴合土埂内沿） */
export function drawMosaic(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  buffer: ArrayBuffer,
  ponds: PondResult[],
  opts: DrawMosaicOpts,
): void {
  const scale = opts.maxEdge ? Math.min(1, opts.maxEdge / Math.max(width, height)) : 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(buffer), width, height);
  // 离屏承载原始大图，再缩放绘制，保证清晰
  const off = document.createElement('canvas');
  off.width = width;
  off.height = height;
  off.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

  if (opts.showBoundary) {
    for (const p of ponds) {
      ctx.beginPath();
      p.polygon.forEach(([x, y], i) => {
        const px = x * scale;
        const py = y * scale;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();
      const color = p.status === 'alert' ? '#f85149' : p.status === 'warning' ? '#e3a008' : '#4cc2ff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (opts.showLabel) {
        const cx = p.polygon.reduce((s, q) => s + q[0], 0) / p.polygon.length * scale;
        const cy = p.polygon.reduce((s, q) => s + q[1], 0) / p.polygon.length * scale;
        ctx.font = '600 13px sans-serif';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.fillText(p.name, cx, cy);
      }
    }
  }
}

/** 画浓度热力图：每个池子按估计 Bé 填色，标注 Bé 数值与状态 */
export function drawConcentrationMap(
  canvas: HTMLCanvasElement,
  worldWidth: number,
  worldHeight: number,
  originX: number,
  originY: number,
  ponds: PondResult[],
  maxEdge = 1400,
): void {
  const scale = Math.min(1, maxEdge / Math.max(worldWidth, worldHeight));
  canvas.width = Math.round(worldWidth * scale);
  canvas.height = Math.round(worldHeight * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0a0f15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const p of ponds) {
    // polygon 已是大图坐标（含 origin 偏移），直接缩放
    ctx.beginPath();
    p.polygon.forEach(([x, y], i) => {
      const px = x * scale;
      const py = y * scale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = baumeToCss(p.baumeEst);
    ctx.fill();
    ctx.strokeStyle = p.status === 'alert' ? '#f85149' : p.status === 'warning' ? '#e3a008' : 'rgba(255,255,255,0.55)';
    ctx.lineWidth = p.status === 'normal' ? 1 : 2.5;
    ctx.stroke();

    const cx = p.polygon.reduce((s, q) => s + q[0], 0) / p.polygon.length * scale;
    const cy = p.polygon.reduce((s, q) => s + q[1], 0) / p.polygon.length * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.72)';
    const label = p.baumeEst.toFixed(1);
    ctx.font = '700 15px sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillRect(cx - tw / 2 - 5, cy - 12, tw + 10, 20);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx, cy + 3);
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText(zoneLabel(p.zone), cx, cy + 18);
  }
  void originX;
  void originY;
}

// 支持缩放/平移、底图 + 叠加层 + 矢量标注的 Canvas 查看器
export type VectorFn = (g: CanvasRenderingContext2D, zoom: number) => void;

function imageToCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

export class MapCanvas {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private base: HTMLCanvasElement | null = null;
  private overlay: HTMLCanvasElement | null = null;
  private overlayAlpha = 0.9;
  baseAlpha = 1;
  private vector: VectorFn | null = null;
  zoom = 0.3;
  panX = 0;
  panY = 0;
  readonly worldW: number;
  readonly worldH: number;
  onPick: ((wx: number, wy: number) => void) | null = null;
  onHover: ((wx: number | null, wy: number | null) => void) | null = null;

  private dragging = false;
  private moved = 0;
  private lx = 0;
  private ly = 0;

  constructor(private container: HTMLElement, worldW: number, worldH: number) {
    this.worldW = worldW;
    this.worldH = worldH;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;

    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(container);

    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.handleDown);
    window.addEventListener('pointermove', this.handleMove);
    window.addEventListener('pointerup', this.handleUp);
    this.fit();
  }

  setBase(img: ImageData | null): void {
    this.base = img ? imageToCanvas(img) : null;
    this.render();
  }

  setOverlay(img: ImageData | null, alpha = 0.9): void {
    this.overlay = img ? imageToCanvas(img) : null;
    this.overlayAlpha = alpha;
    this.render();
  }

  setOverlayAlpha(alpha: number): void {
    this.overlayAlpha = alpha;
    this.render();
  }

  setVector(fn: VectorFn | null): void {
    this.vector = fn;
    this.render();
  }

  fit(): void {
    const cw = this.container.clientWidth || 800;
    const ch = this.container.clientHeight || 520;
    this.zoom = Math.min(cw / this.worldW, ch / this.worldH) * 0.98;
    this.panX = (cw - this.worldW * this.zoom) / 2;
    this.panY = (ch - this.worldH * this.zoom) / 2;
    this.render();
  }

  zoomBy(f: number): void {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    this.zoomAt(f, cw / 2, ch / 2);
  }

  private zoomAt(f: number, cx: number, cy: number): void {
    const nz = Math.max(0.05, Math.min(8, this.zoom * f));
    const k = nz / this.zoom;
    this.panX = cx - (cx - this.panX) * k;
    this.panY = cy - (cy - this.panY) * k;
    this.zoom = nz;
    this.render();
  }

  private handleWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    this.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
  };

  private handleDown = (e: PointerEvent): void => {
    this.dragging = true;
    this.moved = 0;
    this.lx = e.clientX;
    this.ly = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private handleMove = (e: PointerEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (this.dragging) {
      const dx = e.clientX - this.lx;
      const dy = e.clientY - this.ly;
      this.moved += Math.abs(dx) + Math.abs(dy);
      this.panX += dx;
      this.panY += dy;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.render();
    } else if (inside && this.onHover) {
      const w = this.toWorld(e.clientX, e.clientY);
      this.onHover(w?.x ?? null, w?.y ?? null);
    }
  };

  private handleUp = (e: PointerEvent): void => {
    if (this.dragging && this.moved < 6) {
      const w = this.toWorld(e.clientX, e.clientY);
      if (w && this.onPick) this.onPick(w.x, w.y);
    }
    this.dragging = false;
  };

  toWorld(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const cssX = clientX - rect.left;
    const cssY = clientY - rect.top;
    return { x: (cssX - this.panX) / this.zoom, y: (cssY - this.panY) / this.zoom };
  }

  render(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = this.container.clientWidth || 800;
    const ch = this.container.clientHeight || 520;
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
      this.canvas.style.width = `${cw}px`;
      this.canvas.style.height = `${ch}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0e1b22';
    g.fillRect(0, 0, cw, ch);

    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    if (this.base) {
      g.globalAlpha = this.baseAlpha;
      g.drawImage(this.base, this.panX, this.panY, this.worldW * this.zoom, this.worldH * this.zoom);
      g.globalAlpha = 1;
    }
    if (this.overlay) {
      g.globalAlpha = this.overlayAlpha;
      g.drawImage(this.overlay, this.panX, this.panY, this.worldW * this.zoom, this.worldH * this.zoom);
      g.globalAlpha = 1;
    }
    if (this.vector) {
      g.save();
      g.translate(this.panX, this.panY);
      g.scale(this.zoom, this.zoom);
      this.vector(g, this.zoom);
      g.restore();
    }
  }

  destroy(): void {
    this.ro.disconnect();
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('pointerdown', this.handleDown);
    window.removeEventListener('pointermove', this.handleMove);
    window.removeEventListener('pointerup', this.handleUp);
    this.canvas.remove();
  }
}

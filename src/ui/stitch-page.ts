// 拼接大图页：在 Worker 中拼接，Canvas 查看大图、土埂网格/内沿边界与照片覆盖
import { h, clear, statCard, fmtMs } from './dom';
import { ProgressBar, choiceGroup } from './widgets';
import { MapCanvas } from './canvas-kit';
import { state, set, showToast, type MissionFilter } from '../state/store';
import { stitchJob } from '../state/jobs';
import { evaluateBoundaries } from '../core/segment';
import type { StitchOutput } from '../core/stitch';

export function createStitchPage(): { el: HTMLElement; show: () => void; start: () => void } {
  const progress = new ProgressBar();
  const canvasHost = h('div', { class: 'canvas-host' });
  const stats = h('div', { class: 'stat-row wrap' });
  let mc: MapCanvas | null = null;
  let boundaryEval: { meanPx: number; maxPx: number } | null = null;
  const toggles = { grid: true, boundary: true, footprints: false };

  const layerBtns = h('div', { class: 'chip-row' },
    ...([
      ['boundary', '池子内沿'],
      ['grid', '土埂中线'],
      ['footprints', '照片覆盖框'],
    ] as const).map(([key, label]) =>
      h('button', {
        type: 'button',
        class: `chip toggle ${toggles[key] ? 'active' : ''}`,
        onClick: (e: Event) => {
          toggles[key] = !toggles[key];
          (e.currentTarget as HTMLButtonElement).classList.toggle('active', toggles[key]);
          mc?.render();
        },
      }, label),
    ),
  );

  const missionGroup = choiceGroup<MissionFilter>('架次', [
    { value: 'all', label: '全部校正融合' },
    { value: 'morning', label: '早晨架次' },
    { value: 'evening', label: '傍晚架次' },
  ], state.mission, (v) => set({ mission: v }));

  function ensureCanvas(): void {
    if (mc || canvasHost.clientWidth === 0) return;
    const W = state.manifest?.worldWidth ?? 2800;
    const H = state.manifest?.worldHeight ?? 1800;
    mc = new MapCanvas(canvasHost, W, H);
    mc.setVector(drawVector);
    if (state.stitch) presentStitch(state.stitch);
  }

  function drawVector(g: CanvasRenderingContext2D, zoom: number): void {
    const st = state.stitch;
    if (!st) return;
    const lw = 1.6 / zoom;
    if (toggles.grid) {
      g.save();
      g.strokeStyle = 'rgba(255,196,64,0.55)';
      g.lineWidth = 1 / zoom;
      g.setLineDash([10 / zoom, 8 / zoom]);
      g.beginPath();
      for (const x of st.grid.gridX) { g.moveTo(x, 0); g.lineTo(x, st.height); }
      for (const y of st.grid.gridY) { g.moveTo(0, y); g.lineTo(st.width, y); }
      g.stroke();
      g.restore();
    }
    if (toggles.footprints) {
      g.save();
      g.strokeStyle = 'rgba(120,220,255,0.35)';
      g.lineWidth = 0.8 / zoom;
      for (const p of state.photos) {
        if (state.mission !== 'all' && p.mission !== state.mission) continue;
        const w = p.width * p.pose.scale;
        const h = p.height * p.pose.scale;
        g.strokeRect(p.pose.cx - w / 2, p.pose.cy - h / 2, w, h);
      }
      g.restore();
    }
    if (toggles.boundary) {
      g.save();
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = lw;
      for (const pan of st.pans) {
        const b = pan.bbox;
        g.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      }
      g.restore();
    }
  }

  function presentStitch(st: StitchOutput): void {
    const img = new ImageData(new Uint8ClampedArray(st.data), st.width, st.height);
    mc?.setBase(img);
    mc?.setVector(drawVector);
    mc?.fit();
    renderStats(st);
  }

  function renderStats(st: StitchOutput): void {
    clear(stats);
    const gains = st.gains;
    const gr = gains.map((g) => g.r);
    const gb = gains.map((g) => g.b);
    const gainRange = `${Math.min(...gr).toFixed(2)}–${Math.max(...gr).toFixed(2)}`;
    stats.append(
      statCard('拼接耗时', fmtMs(st.elapsedMs), 'Web Worker 两遍融合'),
      statCard('对齐残差', st.alignRmse ? `${st.alignRmse.toFixed(2)} px` : '—', '相对合成真实位姿'),
      statCard('红通道增益', gainRange, `蓝增益 ${Math.min(...gb).toFixed(2)}–${Math.max(...gb).toFixed(2)}`),
      statCard('分割池子', `${st.pans.length}`, '四边吸附土埂内沿'),
    );
    if (boundaryEval) {
      stats.append(statCard('边界贴合误差', `${boundaryEval.meanPx.toFixed(2)} px`, `最大 ${boundaryEval.maxPx.toFixed(1)} px（对合成真值）`, boundaryEval.meanPx < 3.5 ? 'good' : 'warn'));
    }
  }

  async function start(): Promise<void> {
    if (state.stitching.running) return;
    if (state.photos.length === 0) {
      showToast('err', '请先在“航拍导入”页合成或导入照片');
      return;
    }
    ensureCanvas();
    const photos = state.photos.filter((p) => state.mission === 'all' || p.mission === state.mission);
    const dims = {
      width: state.field?.width ?? state.manifest?.worldWidth ?? 2800,
      height: state.field?.height ?? state.manifest?.worldHeight ?? 1800,
      rows: state.field?.rows ?? 6,
      cols: state.field?.cols ?? 10,
    };
    set({ stitching: { running: true, frac: 0.02, label: '启动拼接 Worker…' } });
    progress.update(state.stitching);
    try {
      const st = await stitchJob(photos, dims, (frac, label) => {
        set({ stitching: { running: true, frac, label } });
        progress.update(state.stitching);
      });
      boundaryEval = state.field ? evaluateBoundaries(st.pans, state.field.pans) : null;
      set({ stitch: st, stitching: { running: false, frac: 1, label: '拼接完成' }, analysis: null });
      progress.update(state.stitching);
      ensureCanvas();
      presentStitch(st);
      showToast('ok', `拼接完成：${photos.length} 张，耗时 ${fmtMs(st.elapsedMs)}`);
    } catch (e) {
      set({ stitching: { running: false, frac: 0, label: '' } });
      progress.update(state.stitching);
      showToast('err', `拼接失败：${(e as Error).message}`);
    }
  }

  const startBtn = h('button', { class: 'btn primary', type: 'button', onClick: start }, '🧩 开始拼接');
  const fitBtn = h('button', { class: 'btn ghost icon', type: 'button', title: '适应窗口', onClick: () => mc?.fit() }, '适应');
  const zinBtn = h('button', { class: 'btn ghost icon', type: 'button', onClick: () => mc?.zoomBy(1.25) }, '＋');
  const zoutBtn = h('button', { class: 'btn ghost icon', type: 'button', onClick: () => mc?.zoomBy(0.8) }, '－');
  const downloadBtn = h('button', {
    class: 'btn ghost', type: 'button', onClick: () => {
      if (!state.stitch) return;
      const c = document.createElement('canvas');
      c.width = state.stitch.width;
      c.height = state.stitch.height;
      c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(state.stitch.data), c.width, c.height), 0, 0);
      c.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'yantian-mosaic.png';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
    },
  }, '下载大图 PNG');

  const nextBtn = h('button', {
    class: 'btn primary', type: 'button',
    onClick: () => window.dispatchEvent(new CustomEvent('app:nav', { detail: { tab: 'map', run: 'analysis' } })),
  }, '下一步：浓度图 →');

  const el = h('div', { class: 'page stitch-page' },
    h('header', { class: 'page-head row-between' },
      h('div', null,
        h('h1', null, '拼接大图'),
        h('p', { class: 'page-desc' }, '以笔直土埂为直线基准对齐数百张照片，按土埂本色锚定分通道增益，把同一块池在不同照片里的亮度、以及早晚太阳角度差异拉到同一光照下，再羽化融合。')),
    ),
    h('div', { class: 'toolbar card' },
      startBtn,
      h('div', { class: 'toolbar-group' }, h('span', { class: 'tool-label' }, '架次'), missionGroup),
      h('div', { class: 'toolbar-group' }, h('span', { class: 'tool-label' }, '图层'), layerBtns),
      h('div', { class: 'toolbar-group push' }, zoutBtn, zinBtn, fitBtn, downloadBtn, nextBtn),
    ),
    progress.el,
    stats,
    h('section', { class: 'card canvas-card' }, canvasHost),
  );

  function show(): void {
    requestAnimationFrame(() => {
      ensureCanvas();
      if (mc) {
        mc.fit();
        mc.render();
      }
    });
    progress.update(state.stitching);
  }

  return { el, show, start };
}

// 拼接大图页：Canvas 展示拼接结果，叠加贴合土埂内沿的池子边界/编号，可切换图层。
import { store } from './store';
import { drawMosaic } from './canvas-draw';

export function renderMosaicPage(root: HTMLElement): void {
  const s = store.get();
  root.innerHTML = `
    <h2 class="page-title">拼接大图</h2>
    <p class="page-desc">数百张航拍照片经相位相关配准、灰板光照校正与线性光域融合后的全场大图，蓝/黄/红线为贴合土埂内沿的池子边界。</p>
    <div class="card" id="mosaic-controls">
      <div class="row" style="align-items:flex-end">
        <label class="field" style="flex:0 0 200px"><span>显示图层</span>
          <select id="m-layer">
            <option value="both">大图 + 池子边界</option>
            <option value="boundary">仅边界标注</option>
            <option value="raw">仅原始大图</option>
          </select>
        </label>
        <label class="field" style="flex:0 0 200px"><span>显示池子编号</span>
          <select id="m-label">
            <option value="on">开启</option>
            <option value="off">关闭</option>
          </select>
        </label>
      </div>
      <div class="stat-grid" id="mosaic-stats" style="margin-top:14px"></div>
    </div>
    <div class="card">
      <div class="canvas-host"><canvas id="mosaic-canvas"></canvas></div>
      <div class="legend">
        <span><i style="background:#4cc2ff"></i>正常池边界</span>
        <span><i style="background:#e3a008"></i>预警池边界</span>
        <span><i style="background:#f85149"></i>告警（渗漏/雨水）池边界</span>
      </div>
      <div class="hint" id="empty-hint">尚未运行流水线。请先到「航拍导入」页生成数据并运行。</div>
    </div>
  `;

  const statsEl = root.querySelector('#mosaic-stats') as HTMLElement;
  const canvas = root.querySelector('#mosaic-canvas') as HTMLCanvasElement;
  const layerSel = root.querySelector('#m-layer') as HTMLSelectElement;
  const labelSel = root.querySelector('#m-label') as HTMLSelectElement;
  const hint = root.querySelector('#empty-hint') as HTMLElement;

  function refresh(): void {
    const st = store.get();
    if (!st.mosaic || !st.mosaic.buffer) {
      hint.hidden = false;
      return;
    }
    hint.hidden = true;
    const layer = layerSel.value;
    drawMosaic(
      canvas,
      st.mosaic.width,
      st.mosaic.height,
      st.mosaic.buffer,
      st.ponds,
      {
        showBoundary: layer !== 'raw',
        showLabel: labelSel.value === 'on',
        maxEdge: 1600,
      },
    );
    const cc = st.colorCorrection;
    statsEl.innerHTML = `
      <div class="stat"><div class="k">大图尺寸</div><div class="v">${st.mosaic.width}×${st.mosaic.height}</div></div>
      <div class="stat"><div class="k">配准链路</div><div class="v">${st.mosaic.pairCount}</div></div>
      <div class="stat"><div class="k">剔除坏对</div><div class="v">${st.mosaic.rejectedPairs}</div></div>
      <div class="stat"><div class="k">灰板/采样</div><div class="v">${cc?.detectedPanels ?? '-'} / ${cc?.samples ?? '-'}</div></div>
      <div class="stat"><div class="k">总耗时</div><div class="v">${(st.elapsedMs / 1000).toFixed(1)}s</div></div>
    `;
  }

  layerSel.addEventListener('change', refresh);
  labelSel.addEventListener('change', refresh);
  store.subscribe(refresh);
  refresh();
}

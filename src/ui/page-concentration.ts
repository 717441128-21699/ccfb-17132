// 池子浓度图页：Canvas 浓度热力图 + 每池 Bé/误差/状态明细表 + 异常清单。
import { store } from './store';
import { drawConcentrationMap } from './canvas-draw';
import { zoneLabel } from '../core/brine';
import { legendStops } from './color-ramp';

export function renderConcentrationPage(root: HTMLElement): void {
  root.innerHTML = `
    <h2 class="page-title">池子浓度图</h2>
    <p class="page-desc">按每池卤水平均颜色反演波美度并填色。盐花、泥斑、镜面反光与埂像素已剔除，粉红藻色与白色结晶分别处理。</p>
    <div class="card">
      <div class="canvas-host"><canvas id="conc-canvas"></canvas></div>
      <div class="legend" id="conc-legend"></div>
    </div>
    <div class="card">
      <h3>异常池清单</h3>
      <div id="anomaly-list" class="hint">无异常。</div>
    </div>
    <div class="card">
      <h3>池子明细（含真值对照）</h3>
      <div style="overflow-x:auto">
        <table id="pond-table">
          <thead><tr>
            <th>池子</th><th>类型</th><th>估计 °Bé</th><th>实测真值</th><th>误差</th>
            <th>有效像素</th><th>盐花</th><th>反光</th><th>泥斑</th><th>状态</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;

  const legend = root.querySelector('#conc-legend') as HTMLElement;
  legend.innerHTML =
    legendStops()
      .map((s) => `<span><i style="background:${s.css}"></i>${s.b}°Bé</span>`)
      .join('') +
    `<span><i style="background:#f85149"></i>告警</span><span><i style="background:#e3a008"></i>预警</span>`;

  function refresh(): void {
    const st = store.get();
    const canvas = root.querySelector('#conc-canvas') as HTMLCanvasElement;
    const tbody = root.querySelector('#pond-table tbody') as HTMLElement;
    const anomalyList = root.querySelector('#anomaly-list') as HTMLElement;

    if (!st.mosaic || st.ponds.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" class="hint">尚未运行流水线。</td></tr>`;
      return;
    }

    drawConcentrationMap(
      canvas,
      st.mosaic.width,
      st.mosaic.height,
      st.mosaic.originX,
      st.mosaic.originY,
      st.ponds,
    );

    const anomalies = st.ponds.filter((p) => p.anomalies.length > 0);
    anomalyList.innerHTML = anomalies.length
      ? anomalies
          .map((p) => `<div><b class="badge ${p.status}">${p.name}</b> ${p.anomalies.map((a) => a.message).join('；')}</div>`)
          .join('')
      : '无异常。';

    tbody.innerHTML = st.ponds
      .map((p) => {
        const err = p.baumeTrue != null ? p.baumeEst - p.baumeTrue : null;
        const statusText = p.status === 'alert' ? '告警' : p.status === 'warning' ? '预警' : '正常';
        return `<tr class="${p.status}">
          <td>${p.name}</td>
          <td>${zoneLabel(p.zone)}</td>
          <td class="mono"><b>${p.baumeEst.toFixed(2)}</b></td>
          <td class="mono">${p.baumeTrue != null ? p.baumeTrue.toFixed(2) : '—'}</td>
          <td class="mono">${err != null ? (err >= 0 ? '+' : '') + err.toFixed(2) : '—'}</td>
          <td class="mono">${(p.validFraction * 100).toFixed(0)}%</td>
          <td class="mono">${(p.saltFraction * 100).toFixed(0)}%</td>
          <td class="mono">${(p.glintFraction * 100).toFixed(0)}%</td>
          <td class="mono">${(p.mudFraction * 100).toFixed(0)}%</td>
          <td><span class="badge ${p.status}">${statusText}</span></td>
        </tr>`;
      })
      .join('');
  }

  store.subscribe(refresh);
  refresh();
}

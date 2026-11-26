// 标定管理页：盐场波美计实测 <-> 池水颜色样本的增删改、拟合诊断与颜色曲线
import { h, clear, statCard } from './dom';
import { state, set, saveCalibration, showToast } from '../state/store';
import { CalibrationModel, makeDefaultCalibration, uid } from '../core/calibration';
import { buildSurveyCalibration } from '../core/analyze';
import { rgbToLab, rgbCss } from '../core/color';
import { brineAppearanceRGB } from '../core/brine';
import type { CalibSample, RGB } from '../core/types';

function rgbToHex(c: RGB): string {
  const p = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(c.r)}${p(c.g)}${p(c.b)}`;
}
function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function createCalibrationPage(): { el: HTMLElement; show: () => void } {
  const chartCanvas = h('canvas', { class: 'chart-canvas', width: 760, height: 440 }) as HTMLCanvasElement;
  const curveCanvas = h('canvas', { class: 'curve-canvas', width: 760, height: 90 }) as HTMLCanvasElement;
  const metrics = h('div', { class: 'stat-row wrap' });
  const tableBody = h('tbody', null);

  function commit(samples: CalibSample[]): void {
    set({ calibration: samples });
    saveCalibration(samples);
    renderAll();
  }

  function updateSample(id: string, patch: Partial<CalibSample>): void {
    commit(state.calibration.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function renderTable(): void {
    clear(tableBody);
    const sorted = [...state.calibration].sort((a, b) => a.baume - b.baume);
    for (const s of sorted) {
      const colorInput = h('input', {
        type: 'color', value: rgbToHex(s.rgb), class: 'color-input',
        onInput: (e: Event) => updateSample(s.id, { rgb: hexToRgb((e.target as HTMLInputElement).value) }),
      }) as HTMLInputElement;
      const baumeInput = h('input', {
        type: 'number', step: '0.1', value: String(s.baume), class: 'num-input',
        onChange: (e: Event) => updateSample(s.id, { baume: Number((e.target as HTMLInputElement).value) || 0 }),
      }) as HTMLInputElement;
      tableBody.append(h('tr', null,
        h('td', null, colorInput),
        h('td', null, baumeInput),
        h('td', null, h('input', {
          class: 'text-input', value: s.source,
          onChange: (e: Event) => updateSample(s.id, { source: (e.target as HTMLInputElement).value }),
        })),
        h('td', { class: 'mono muted' }, s.date),
        h('td', null, h('button', {
          class: 'btn tiny danger', type: 'button',
          onClick: () => commit(state.calibration.filter((x) => x.id !== s.id)),
        }, '删除')),
      ));
    }
  }

  function drawChart(model: CalibrationModel): void {
    const g = chartCanvas.getContext('2d')!;
    const W = chartCanvas.width;
    const H = chartCanvas.height;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0f1d25';
    g.fillRect(0, 0, W, H);
    const pad = 56;
    const xmin = 0;
    const xmax = 31;
    const ymin = 0;
    const ymax = 31;
    const X = (v: number) => pad + ((v - xmin) / (xmax - xmin)) * (W - pad * 1.4);
    const Y = (v: number) => H - pad - ((v - ymin) / (ymax - ymin)) * (H - pad * 1.5);

    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.fillStyle = 'rgba(220,235,242,0.7)';
    g.font = '12px system-ui';
    g.lineWidth = 1;
    for (let v = 0; v <= 30; v += 5) {
      g.beginPath(); g.moveTo(X(v), pad * 0.5); g.lineTo(X(v), H - pad); g.stroke();
      g.fillText(String(v), X(v) - 6, H - pad + 18);
      g.beginPath(); g.moveTo(pad, Y(v)); g.lineTo(W - pad * 0.4, Y(v)); g.stroke();
      g.fillText(String(v), 24, Y(v) + 4);
    }
    g.fillStyle = 'rgba(220,235,242,0.85)';
    g.font = '13px system-ui';
    g.fillText('实测波美度 °Bé（X） vs 模型回算 °Bé（Y）', pad, 24);

    // y=x
    g.strokeStyle = 'rgba(255,210,90,0.7)';
    g.setLineDash([7, 6]);
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(30), Y(30)); g.stroke();
    g.setLineDash([]);

    // 拟合曲线（在颜色轨迹上采样不便，改为画样本点 + 误差）
    let se = 0;
    let ae = 0;
    let within = 0;
    for (const s of state.calibration) {
      const pred = model.predict(rgbToLab(s.rgb)).baume;
      const e = pred - s.baume;
      se += e * e;
      ae += Math.abs(e);
      if (Math.abs(e) <= 1.5) within++;
      g.beginPath();
      g.arc(X(s.baume), Y(pred), 6, 0, Math.PI * 2);
      g.fillStyle = rgbCss(s.rgb);
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.stroke();
    }
    const n = Math.max(1, state.calibration.length);
    const rmse = Math.sqrt(se / n);
    const mae = ae / n;

    // 误差带 ±1.5 示意
    g.strokeStyle = 'rgba(80,220,170,0.35)';
    g.beginPath(); g.moveTo(X(0), Y(1.5)); g.lineTo(X(30), Y(31.5)); g.stroke();
    g.beginPath(); g.moveTo(X(0), Y(-1.5)); g.lineTo(X(30), Y(28.5)); g.stroke();

    clear(metrics);
    metrics.append(
      statCard('标定样本', String(state.calibration.length), '波美计实测 ↔ 水色'),
      statCard('回算 RMSE', rmse.toFixed(2), `MAE ${mae.toFixed(2)} °Bé`),
      statCard('残差 ≤1.5', `${within}/${n}`, '标定拟合精度', within === n ? 'good' : 'warn'),
      statCard('拟合 R²', model.score().r2.toFixed(3), '二次岭回归', model.score().r2 > 0.97 ? 'good' : ''),
    );
  }

  function drawCurve(): void {
    const g = curveCanvas.getContext('2d')!;
    const W = curveCanvas.width;
    const H = curveCanvas.height;
    g.clearRect(0, 0, W, H);
    const algae = state.scenario.algae;
    for (let x = 0; x < W; x++) {
      const b = 2 + (x / W) * 27.5;
      const c = brineAppearanceRGB(b, algae);
      g.fillStyle = rgbCss(c);
      g.fillRect(x, 18, 1, H - 40);
    }
    g.fillStyle = 'rgba(225,238,245,0.85)';
    g.font = '12px system-ui';
    for (let b = 3; b <= 29; b += 3) {
      const x = ((b - 2) / 27.5) * W;
      g.fillText(`${b}°`, x - 8, H - 8);
    }
    g.fillText('海水青绿 → 黄绿 → 黄褐 → 嗜盐藻粉红/红 → 结晶', 12, 14);
  }

  function renderAll(): void {
    const model = new CalibrationModel(state.calibration);
    renderTable();
    drawChart(model);
    drawCurve();
  }

  const addBaume = h('input', { type: 'number', step: '0.1', value: '12', class: 'num-input' }) as HTMLInputElement;
  const addColor = h('input', { type: 'color', value: '#6fb46a', class: 'color-input' }) as HTMLInputElement;
  const addSource = h('input', { class: 'text-input', value: '波美计实测', placeholder: '来源/备注' }) as HTMLInputElement;

  const el = h('div', { class: 'page calib-page' },
    h('header', { class: 'page-head' },
      h('h1', null, '标定管理'),
      h('p', { class: 'page-desc' }, '维护盐场自己的波美计实测与池水颜色对应关系。浓度反演使用二次岭回归给出全局曲线，并用邻近标定样本做局部加权；数据保存在本机浏览器。')),
    h('div', { class: 'grid-calib' },
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '拟合诊断'), h('span', { class: 'muted' }, '散点越贴近黄色 y=x 越准，绿色带为 ±1.5°Bé')),
        metrics,
        h('div', { class: 'chart-scroll' }, chartCanvas),
        h('h3', null, '颜色—波美度轨迹（随当前合成藻色表型）'),
        curveCanvas),
      h('section', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, '实测样本')),
        h('div', { class: 'add-row' }, addColor, addBaume, addSource,
          h('button', {
            class: 'btn primary', type: 'button',
            onClick: () => {
              const b = Number(addBaume.value);
              if (!Number.isFinite(b)) return showToast('err', '请输入波美度');
              commit([...state.calibration, {
                id: uid('cal'), baume: b, rgb: hexToRgb(addColor.value),
                source: addSource.value || '波美计实测', date: new Date().toISOString().slice(0, 10),
              }]);
              showToast('ok', '已新增标定样本');
            },
          }, '新增')),
        h('div', { class: 'table-scroll calib-table' },
          h('table', { class: 'pan-table' },
            h('thead', null, h('tr', null, h('th', null, '颜色'), h('th', null, '波美度'), h('th', null, '来源'), h('th', null, '日期'), h('th', null, ''))),
            tableBody)),
        h('div', { class: 'calib-actions' },
          h('button', {
            class: 'btn ghost', type: 'button',
            onClick: () => commit(makeDefaultCalibration(state.scenario.algae)),
          }, '恢复为该藻色的默认实测标定'),
          h('button', {
            class: 'btn ghost', type: 'button',
            onClick: () => {
              if (!state.analysis) return showToast('err', '请先在“池子浓度图”运行分析');
              const survey = buildFromAnalysis();
              if (survey.length < 4) return showToast('err', '可用的当天舀样不足');
              commit(survey);
              showToast('ok', `已用当前各池水色重建 ${survey.length} 条标定`);
            },
          }, '用当前浓度图水色+舀样重建'),
          h('button', {
            class: 'btn danger ghost', type: 'button',
            onClick: () => { if (confirmClear()) commit([]); },
          }, '清空')))),
  );

  function show(): void {
    renderAll();
  }
  renderAll();
  return { el, show };
}

function confirmClear(): boolean {
  return window.confirm('确定清空全部标定样本？清空后浓度反演将不可用。');
}

function buildFromAnalysis(): CalibSample[] {
  const a = state.analysis!;
  return buildSurveyCalibration(a.pans, a.stats, 1);
}

// 池子浓度图页：运行颜色分析 Worker，Canvas 画浓度图/标注，展示精度、异常与逐池明细
import { h, clear, statCard, fmtMs } from './dom';
import { ProgressBar, choiceGroup } from './widgets';
import { MapCanvas } from './canvas-kit';
import { state, set, showToast, saveCalibration } from '../state/store';
import { analyzeJob } from '../state/jobs';
import { mergeTruth } from '../core/analyze';
import { baumeToColor, rgbCss } from '../core/color';
import type { Pan, PanColorStats } from '../core/types';

type ViewMode = 'map' | 'overlay' | 'raw';
type SortKey = 'id' | 'baume' | 'error';

export function createMapPage(): { el: HTMLElement; show: () => void; start: () => Promise<void> } {
  const progress = new ProgressBar();
  const canvasHost = h('div', { class: 'canvas-host map-host' });
  const summary = h('div', { class: 'stat-row wrap' });
  const detail = h('div', { class: 'detail-panel' }, h('div', { class: 'empty-hint' }, '运行分析后，点击浓度图上的池子查看水色成分与标定细节。'));
  const anomalyBox = h('div', { class: 'anomaly-box' });
  const tableWrap = h('div', { class: 'table-wrap' });
  let mc: MapCanvas | null = null;
  let mode: ViewMode = 'map';
  let sortKey: SortKey = 'id';

  function ensureCanvas(): void {
    if (mc || canvasHost.clientWidth === 0) return;
    const W = state.stitch?.width ?? state.manifest?.worldWidth ?? 2800;
    const H = state.stitch?.height ?? state.manifest?.worldHeight ?? 1800;
    mc = new MapCanvas(canvasHost, W, H);
    mc.onPick = (wx, wy) => {
      const pan = state.analysis?.pans.find((p) => wx >= p.bbox.minX && wx <= p.bbox.maxX && wy >= p.bbox.minY && wy <= p.bbox.maxY);
      if (pan) {
        set({ activePanId: pan.id });
        renderDetail();
        highlightRow(pan.id);
        mc?.render();
      }
    };
    mc.setVector(drawLabels);
    if (state.stitch) {
      mc.setBase(new ImageData(new Uint8ClampedArray(state.stitch.data), W, H));
    }
    if (state.analysis) presentAnalysis();
  }

  function drawLabels(g: CanvasRenderingContext2D, zoom: number): void {
    const a = state.analysis;
    if (!a) return;
    const byId = new Map(a.stats.map((s) => [s.panId, s]));
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const pan of a.pans) {
      const s = byId.get(pan.id);
      if (!s || !Number.isFinite(s.baume)) continue;
      const cx = (pan.bbox.minX + pan.bbox.maxX) / 2;
      const cy = (pan.bbox.minY + pan.bbox.maxY) / 2;
      const fs = 13 / zoom;
      g.font = `700 ${fs}px system-ui, sans-serif`;
      const label = s.baume.toFixed(1);
      g.lineWidth = 3.2 / zoom;
      g.strokeStyle = 'rgba(8,20,28,0.85)';
      g.strokeText(label, cx, cy);
      g.fillStyle = '#fff';
      g.fillText(label, cx, cy);
      if (s.anomaly) {
        const r = 16 / zoom;
        g.beginPath();
        g.arc(pan.bbox.maxX - 4 / zoom - r * 0, pan.bbox.minY + 16 / zoom, 9 / zoom, 0, Math.PI * 2);
        g.fillStyle = '#ff3b30';
        g.fill();
        g.fillStyle = '#fff';
        g.font = `800 ${13 / zoom}px system-ui`;
        g.fillText('!', pan.bbox.maxX - 13 / zoom, pan.bbox.minY + 16 / zoom + 0.5 / zoom);
      }
      if (state.activePanId === pan.id) {
        g.strokeStyle = '#00e5ff';
        g.lineWidth = 3 / zoom;
        g.strokeRect(pan.bbox.minX - 2 / zoom, pan.bbox.minY - 2 / zoom, pan.bbox.maxX - pan.bbox.minX + 4 / zoom, pan.bbox.maxY - pan.bbox.minY + 4 / zoom);
      }
    }
  }

  function presentAnalysis(): void {
    const a = state.analysis;
    if (!a || !mc) return;
    mc.setOverlay(new ImageData(new Uint8ClampedArray(a.overlay), a.width, a.height), mode === 'overlay' ? 0.6 : 1);
    applyMode();
    mc.setVector(drawLabels);
    renderSummary();
    renderAnomalies();
    renderTable();
    renderDetail();
  }

  function applyMode(): void {
    if (!mc) return;
    if (mode === 'map') {
      mc.baseAlpha = 0.28;
      mc.setOverlayAlpha?.(1);
    } else if (mode === 'overlay') {
      mc.baseAlpha = 1;
      mc.setOverlayAlpha?.(0.55);
    } else {
      mc.baseAlpha = 1;
      mc.setOverlayAlpha?.(0);
    }
    mc.render();
  }

  function renderSummary(): void {
    clear(summary);
    const a = state.analysis;
    if (!a) return;
    const e = a.evaluation;
    const pipelineMs = a.elapsedMs + (state.stitch?.elapsedMs ?? 0);
    summary.append(
      statCard('浓度分析耗时', fmtMs(a.elapsedMs), 'Web Worker'),
      statCard('出图总耗时(拼接+分析)', fmtMs(pipelineMs), `500 张预算 60s，余量 ${Math.max(0, 60000 - pipelineMs) / 1000 | 0}s`, pipelineMs < 60000 ? 'good' : 'bad'),
    );
    if (e && e.withMeasurement > 0) {
      const all = e.withinTolerance === e.withMeasurement;
      summary.append(
        statCard('对当天实测 ≤1.5°Bé', `${e.withinTolerance}/${e.withMeasurement}`, all ? '全部达标' : '存在超差', all ? 'good' : 'bad'),
        statCard('最大绝对误差', `${e.maxAbsError.toFixed(2)} °Bé`, `平均 ${e.meanAbsError.toFixed(2)} · RMSE ${e.rmse.toFixed(2)}`, e.maxAbsError <= 1.5 ? 'good' : 'warn'),
      );
    }
    if (e?.trueWithinTolerance != null) {
      summary.append(statCard('对合成真值 ≤1.5', `${e.trueWithinTolerance}/${e.total}`, `最大 ${e.trueMaxAbsError} · 均值 ${e.trueMeanAbsError}`, (e.trueMaxAbsError ?? 9) <= 1.5 ? 'good' : 'warn'));
    }
    const nAnom = a.stats.filter((s) => s.anomaly).length;
    summary.append(statCard('颜色异常池', `${nAnom}`, '突然变淡 / 置信度 / 反光', nAnom ? 'warn' : ''));
  }

  function renderAnomalies(): void {
    clear(anomalyBox);
    const a = state.analysis;
    if (!a) return;
    const list = a.stats.filter((s) => s.anomaly);
    anomalyBox.append(h('h3', null, `异常预警（${list.length}）`));
    if (list.length === 0) {
      anomalyBox.append(h('div', { class: 'muted small' }, '未发现显著偏离盐田浓度趋势的池子。'));
      return;
    }
    for (const s of list) {
      anomalyBox.append(
        h('button', {
          class: 'anomaly-item',
          type: 'button',
          onClick: () => { set({ activePanId: s.panId }); renderDetail(); highlightRow(s.panId); },
        },
          h('span', { class: 'anom-id' }, `⚠ ${s.panId}`),
          h('span', { class: 'anom-text' }, s.anomalyReasons[0] ?? '颜色异常')),
      );
    }
  }

  function compositionBar(s: PanColorStats): HTMLElement {
    const f = s.fractions;
    const segs: Array<[number, string, string]> = [
      [f.water, '#2bb3a3', '水'],
      [f.salt, '#f4f2ec', '盐'],
      [f.mud, '#8a6a44', '泥'],
      [f.glint, '#bfe9ff', '反'],
      [f.ridge, '#a98c66', '埂'],
    ];
    return h('div', { class: 'comp-bar', title: `水${pct(f.water)} 盐花${pct(f.salt)} 泥${pct(f.mud)} 反光${pct(f.glint)} 埂${pct(f.ridge)}` },
      ...segs.map(([v, c]) => h('i', { style: `width:${(v * 100).toFixed(2)}%;background:${c}` })));
  }

  function renderDetail(): void {
    clear(detail);
    const a = state.analysis;
    const id = state.activePanId;
    if (!a || !id) {
      detail.append(h('div', { class: 'empty-hint' }, '点击浓度图上的池子查看水色成分与标定细节。'));
      return;
    }
    const s = a.stats.find((x) => x.panId === id);
    const pan = a.pans.find((p) => p.id === id);
    if (!s || !pan) return;
    const c = baumeToColor(s.baume);
    detail.append(
      h('div', { class: 'detail-head' },
        h('div', { class: 'baume-swatch', style: `background:${rgbCss(c)}` }),
        h('div', null,
          h('div', { class: 'detail-id' }, id),
          h('div', { class: 'detail-baume' }, Number.isFinite(s.baume) ? s.baume.toFixed(1) : '—', h('span', { class: 'unit' }, ' °Bé')))),
      h('div', { class: 'detail-grid' },
        detailRow('当天舀样实测', pan.measuredBaume != null ? `${pan.measuredBaume.toFixed(1)} °Bé` : '无'),
        detailRow('与实测误差', s.errorVsMeasured != null ? `${s.errorVsMeasured.toFixed(2)} °Bé` : '—', (s.errorVsMeasured ?? 0) <= 1.5 ? 'ok-text' : 'bad-text'),
        detailRow('合成真值', pan.trueBaume != null ? `${pan.trueBaume.toFixed(1)} °Bé` : '—'),
        detailRow('置信度', `${(s.confidence * 100) | 0}%`),
        detailRow('稳健水色 RGB', `${s.medianRGB.r | 0},${s.medianRGB.g | 0},${s.medianRGB.b | 0}`),
        detailRow('Lab', `${s.meanLab.L.toFixed(1)}, ${s.meanLab.a.toFixed(1)}, ${s.meanLab.b.toFixed(1)}`),
        detailRow('粉红藻色指数', s.pinkIndex.toFixed(2)),
        detailRow('发白结晶指数', s.whiteIndex.toFixed(2))),
      h('div', { class: 'comp-legend' },
        h('span', null, '成分占比（已从水色剔除盐花/泥/反光/埂）'),
        compositionBar(s),
        h('div', { class: 'legend-row' },
          legendDot('#2bb3a3', `池水 ${pct(s.fractions.water)}`),
          legendDot('#f4f2ec', `盐花 ${pct(s.fractions.salt)}`),
          legendDot('#8a6a44', `泥 ${pct(s.fractions.mud)}`),
          legendDot('#bfe9ff', `反光 ${pct(s.fractions.glint)}`),
          legendDot('#a98c66', `埂 ${pct(s.fractions.ridge)}`))),
      ...(s.anomalyReasons.length
        ? [h('div', { class: 'anom-reasons' }, ...s.anomalyReasons.map((r) => h('div', null, `• ${r}`)))]
        : []),
    );
  }

  function highlightRow(id: string): void {
    tableWrap.querySelectorAll('tr[data-pan]').forEach((tr) => tr.classList.toggle('selected', (tr as HTMLElement).dataset.pan === id));
  }

  function renderTable(): void {
    clear(tableWrap);
    const a = state.analysis;
    if (!a) return;
    const panById = new Map(a.pans.map((p) => [p.id, p]));
    const rows = [...a.stats];
    rows.sort((x, y) => {
      const px = panById.get(x.panId)!;
      const py = panById.get(y.panId)!;
      if (sortKey === 'baume') return y.baume - x.baume;
      if (sortKey === 'error') return (y.errorVsMeasured ?? -1) - (x.errorVsMeasured ?? -1);
      return px.row - py.row || px.col - py.col;
    });

    const th = (key: SortKey | null, label: string, cls = '') =>
      h('th', { class: cls, onClick: key ? () => { sortKey = key; renderTable(); } : undefined }, label + (key && sortKey === key ? ' ▾' : ''));

    const table = h('table', { class: 'pan-table' },
      h('thead', null, h('tr', null,
        th('id', '池号'), th('baume', '预测 °Bé'), th(null, '舀样实测'), th('error', '误差'),
        th(null, '置信'), th(null, '水色成分'), th(null, '状态'))),
      h('tbody', null,
        ...rows.map((s) => {
          const p = panById.get(s.panId) as Pan;
          const c = baumeToColor(s.baume);
          const err = s.errorVsMeasured;
          const ok = err == null || err <= 1.5;
          return h('tr', {
            'data-pan': s.panId,
            class: `${state.activePanId === s.panId ? 'selected' : ''} ${s.anomaly ? 'anom-row' : ''}`,
            onClick: () => { set({ activePanId: s.panId }); renderDetail(); highlightRow(s.panId); mc?.render(); },
          },
            h('td', { class: 'mono' }, s.panId),
            h('td', null, h('span', { class: 'baume-pill', style: `background:${rgbCss(c)};color:${luma(c) > 150 ? '#123' : '#fff'}` }, Number.isFinite(s.baume) ? s.baume.toFixed(1) : '—')),
            h('td', { class: 'mono' }, p.measuredBaume != null ? p.measuredBaume.toFixed(1) : '—'),
            h('td', { class: `mono ${ok ? 'ok-text' : 'bad-text'}` }, err != null ? err.toFixed(2) : '—'),
            h('td', null, `${(s.confidence * 100) | 0}%`),
            h('td', null, h('div', { class: 'comp-bar mini' }, ...[
              [s.fractions.water, '#2bb3a3'], [s.fractions.salt, '#f4f2ec'], [s.fractions.mud, '#8a6a44'],
              [s.fractions.glint, '#bfe9ff'], [s.fractions.ridge, '#a98c66'],
            ].map(([v, col]) => h('i', { style: `width:${(v as number * 100).toFixed(2)}%;background:${col}` })))),
            h('td', null, s.anomaly ? h('span', { class: 'tag warn' }, '异常') : ok ? h('span', { class: 'tag good' }, '达标') : h('span', { class: 'tag bad' }, '超差')));
        })));
    tableWrap.append(table);
  }

  async function start(): Promise<void> {
    if (state.analyzing.running) return;
    if (!state.stitch) {
      showToast('err', '请先在“拼接大图”页完成拼接');
      return;
    }
    ensureCanvas();
    const pans = state.field ? mergeTruth(state.stitch.pans, state.field.pans) : state.stitch.pans;
    set({ analyzing: { running: true, frac: 0.02, label: '启动颜色分析 Worker…' } });
    progress.update(state.analyzing);
    try {
      const { result, survey } = await analyzeJob(
        state.stitch.data,
        { width: state.stitch.width, height: state.stitch.height },
        pans,
        state.calibration,
        state.useSurvey,
        (frac, label) => {
          set({ analyzing: { running: true, frac, label } });
          progress.update(state.analyzing);
        },
      );
      if (survey && survey.length >= 4) {
        set({ calibration: survey });
        saveCalibration(survey);
      }
      set({ analysis: result, analyzing: { running: false, frac: 1, label: '分析完成' } });
      progress.update(state.analyzing);
      ensureCanvas();
      const W = state.stitch.width;
      const H = state.stitch.height;
      mc?.setBase(new ImageData(new Uint8ClampedArray(state.stitch.data), W, H));
      presentAnalysis();
      const e = result.evaluation;
      showToast(e && e.maxAbsError <= 1.5 ? 'ok' : 'err',
        e ? `浓度图完成：对当天实测 ${e.withinTolerance}/${e.withMeasurement} ≤1.5°Bé，耗时 ${fmtMs(result.elapsedMs)}` : '浓度图完成');
    } catch (err) {
      set({ analyzing: { running: false, frac: 0, label: '' } });
      progress.update(state.analyzing);
      showToast('err', `分析失败：${(err as Error).message}`);
    }
  }

  const modeGroup = choiceGroup<ViewMode>('显示', [
    { value: 'map', label: '浓度图' },
    { value: 'overlay', label: '叠加原图' },
    { value: 'raw', label: '原图+边界' },
  ], mode, (v) => { mode = v; if (state.analysis) applyMode(); });

  const surveyCheck = h('input', {
    type: 'checkbox', checked: state.useSurvey,
    onChange: (e: Event) => set({ useSurvey: (e.target as HTMLInputElement).checked }),
  }) as HTMLInputElement;

  const runBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => void start() }, '🎨 计算浓度图');
  const exportBtn = h('button', {
    class: 'btn ghost', type: 'button', onClick: exportCsv,
  }, '导出 CSV');

  function exportCsv(): void {
    const a = state.analysis;
    if (!a) return;
    const head = 'pan,baume_pred,measured,true,abs_err,confidence,pink,white,water_frac,salt_frac,mud_frac,glint_frac,anomaly\n';
    const lines = a.stats.map((s) => {
      const p = a.pans.find((x) => x.id === s.panId);
      return [s.panId, s.baume, p?.measuredBaume ?? '', p?.trueBaume ?? '', s.errorVsMeasured ?? '', s.confidence,
        s.pinkIndex.toFixed(3), s.whiteIndex.toFixed(3), s.fractions.water.toFixed(3), s.fractions.salt.toFixed(3),
        s.fractions.mud.toFixed(3), s.fractions.glint.toFixed(3), s.anomaly ? 1 : 0].join(',');
    });
    const blob = new Blob(['﻿' + head + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = 'yantian-concentration.csv';
    aEl.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  const el = h('div', { class: 'page map-page' },
    h('header', { class: 'page-head' },
      h('h1', null, '池子浓度图'),
      h('p', { class: 'page-desc' }, '剔除水面反光、白色盐花、露出泥和土埂后取稳健平均水色，按波美计实测标定反演每池波美度；粉红藻色与发白结晶走互斥通道，互不干扰。')),
    h('div', { class: 'toolbar card' },
      runBtn,
      h('label', { class: 'check compact' }, surveyCheck, '用当天舀样实测标定'),
      h('div', { class: 'toolbar-group' }, modeGroup),
      h('div', { class: 'push' }),
      exportBtn),
    progress.el,
    summary,
    h('div', { class: 'map-layout' },
      h('section', { class: 'card canvas-card map-canvas-card' }, canvasHost),
      h('aside', { class: 'side-col' },
        h('section', { class: 'card' }, detail),
        h('section', { class: 'card' }, anomalyBox))),
    h('section', { class: 'card table-card' }, h('div', { class: 'card-head' }, h('h2', null, '逐池波美度与误差')), tableWrap),
  );

  function show(): void {
    requestAnimationFrame(() => { ensureCanvas(); mc?.fit(); mc?.render(); });
    if (state.analysis) { renderSummary(); renderAnomalies(); renderTable(); renderDetail(); }
  }

  return { el, show, start };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}
function luma(c: { r: number; g: number; b: number }): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}
function detailRow(label: string, value: string, cls = ''): HTMLElement {
  return h('div', { class: 'detail-row' }, h('span', { class: 'muted' }, label), h('span', { class: `mono ${cls}` }, value));
}
function legendDot(color: string, text: string): HTMLElement {
  return h('span', { class: 'legend-item' }, h('i', { style: `background:${color}` }), text);
}

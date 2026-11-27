// 航拍导入页：选择天气/时段/网格规模，生成带真值的合成航拍数据集并启动 Worker 流水线。
import { generateDataset, type GeneratorOptions } from '../core/dataset';
import type { DatasetSpec, FlightTime, Weather } from '../core/types';
import { store } from './store';
import { runInWorker } from './worker-client';
import { Rng } from '../core/random';

export function renderImportPage(root: HTMLElement): void {
  root.innerHTML = `
    <h2 class="page-title">航拍数据导入</h2>
    <p class="page-desc">按天气、飞行时段与航线网格生成带波美真值的合成航拍照片（含嗜盐藻粉/红色、白色盐花、泥斑、水面反光与土埂）。</p>
    <div class="card">
      <h3>飞行参数</h3>
      <div class="row">
        <label class="field"><span>天气</span>
          <select id="f-weather">
            <option value="sunny">晴天（有镜面反光）</option>
            <option value="cloudy">阴天（漫射光、低对比）</option>
          </select>
        </label>
        <label class="field"><span>飞行时段（太阳角度）</span>
          <select id="f-time">
            <option value="morning">早晨（低角度、偏暖）</option>
            <option value="noon" selected>中午（高角度、近中性）</option>
            <option value="evening">傍晚（低角度、强暖调）</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label class="field"><span>航线列数（每张重叠约 55%）</span><input id="f-cols" type="number" value="25" min="2" max="40"></label>
        <label class="field"><span>航线行数</span><input id="f-rows" type="number" value="20" min="2" max="40"></label>
        <label class="field"><span>随机种子</span><input id="f-seed" type="number" value="20261128"></label>
      </div>
      <div class="row">
        <label class="field"><span>异常注入（模拟渗漏/进雨水变淡）</span>
          <select id="f-anomaly">
            <option value="0">无</option>
            <option value="7">随机一池变淡 7°Bé</option>
          </select>
        </label>
      </div>
      <div class="hint">提示：25×20 = 500 张照片，用于验证“一分钟出浓度图”的性能指标。小网格（如 8×6）用于快速预览。</div>
      <div style="margin-top:16px; display:flex; gap:10px;">
        <button class="btn" id="btn-run">生成并运行流水线</button>
        <button class="btn secondary" id="btn-preview">仅生成数据集（不分析）</button>
      </div>
    </div>
    <div class="card" id="run-status" hidden>
      <h3>运行进度</h3>
      <div class="progress-wrap"><div class="progress-bar" id="prog-bar" style="width:0%"></div></div>
      <div class="progress-text mono" id="prog-text">等待开始…</div>
    </div>
    <div class="card" id="dataset-info" hidden></div>
  `;

  const btnRun = root.querySelector('#btn-run') as HTMLButtonElement;
  const btnPreview = root.querySelector('#btn-preview') as HTMLButtonElement;

  function readOpts(): GeneratorOptions {
    return {
      seed: Number((root.querySelector('#f-seed') as HTMLInputElement).value),
      weather: (root.querySelector('#f-weather') as HTMLSelectElement).value as Weather,
      flightTime: (root.querySelector('#f-time') as HTMLSelectElement).value as FlightTime,
      gridCols: Number((root.querySelector('#f-cols') as HTMLInputElement).value),
      gridRows: Number((root.querySelector('#f-rows') as HTMLInputElement).value),
      anomalyDilute: Number((root.querySelector('#f-anomaly') as HTMLSelectElement).value) || undefined,
    };
  }

  function showInfo(spec: DatasetSpec): void {
    const card = root.querySelector('#dataset-info') as HTMLElement;
    card.hidden = false;
    const baumes = spec.ponds.map((p) => p.baume);
    card.innerHTML = `
      <h3>数据集概览</h3>
      <div class="stat-grid">
        <div class="stat"><div class="k">照片数量</div><div class="v">${spec.photos.length}</div></div>
        <div class="stat"><div class="k">池子数量</div><div class="v">${spec.ponds.length}</div></div>
        <div class="stat"><div class="k">世界画布</div><div class="v">${spec.worldWidth}×${spec.worldHeight}</div></div>
        <div class="stat"><div class="k">参考灰板</div><div class="v">${spec.references.length} 块</div></div>
        <div class="stat"><div class="k">真值 Bé 范围</div><div class="v">${Math.min(...baumes).toFixed(1)}–${Math.max(...baumes).toFixed(1)}</div></div>
        <div class="stat"><div class="k">天气/时段</div><div class="v">${spec.weather}/${spec.flightTime}</div></div>
      </div>
      <div class="hint">数据集含真值波美度、藻况强度、盐花/泥斑斑块坐标与标准灰板，供精度核验。</div>
    `;
  }

  btnPreview.addEventListener('click', () => {
    const ds = generateDataset(readOpts());
    store.set({ spec: ds.spec });
    showInfo(ds.spec);
  });

  btnRun.addEventListener('click', async () => {
    const opts = readOpts();
    const ds = generateDataset(opts);
    store.set({ spec: ds.spec });
    showInfo(ds.spec);
    const statusCard = root.querySelector('#run-status') as HTMLElement;
    const bar = root.querySelector('#prog-bar') as HTMLElement;
    const text = root.querySelector('#prog-text') as HTMLElement;
    statusCard.hidden = false;
    btnRun.disabled = true;

    await runInWorker(opts, store.get().fitted, {
      onProgress: (stage, fraction, detail) => {
        bar.style.width = `${Math.round(fraction * 100)}%`;
        text.textContent = `${stageLabel(stage)} ${Math.round(fraction * 100)}% ${detail ? '· ' + detail : ''}`;
      },
      onDone: (result) => {
        store.setResult(ds.spec, result);
        btnRun.disabled = false;
        text.textContent = `完成，总耗时 ${(result.elapsedMs / 1000).toFixed(1)}s`;
      },
      onError: (msg) => {
        btnRun.disabled = false;
        text.textContent = '运行失败：' + msg;
      },
    });
  });
}

const STAGE_LABELS: Record<string, string> = {
  'render-thumbs': '渲染照片',
  register: '相位配准',
  'color-correct': '光照校正',
  compose: '大图融合',
  analyze: '池子分析',
  done: '完成',
};

function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

void Rng;

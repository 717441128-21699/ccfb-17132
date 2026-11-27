// 标定管理页：录入“波美计实测 Bé + 航拍 Lab 颜色”样本，拟合现场标定模型并持久化。
import { fitCalibration } from '../core/calibration';
import { brineLab } from '../core/brine';
import { srgbToLab } from '../core/color';
import type { CalibSample, Weather, FlightTime } from '../core/types';
import { store } from './store';

const SAMPLE_KEY = 'saltfield.calib-samples.v1';

interface StoredSample extends CalibSample {}

function loadSamples(): StoredSample[] {
  try {
    return JSON.parse(localStorage.getItem(SAMPLE_KEY) ?? '[]') as StoredSample[];
  } catch {
    return [];
  }
}

function saveSamples(samples: StoredSample[]): void {
  localStorage.setItem(SAMPLE_KEY, JSON.stringify(samples));
}

export function renderCalibrationPage(root: HTMLElement): void {
  let samples = loadSamples();

  root.innerHTML = `
    <h2 class="page-title">标定管理</h2>
    <p class="page-desc">把盐场波美计实测的 °Bé 与对应航拍颜色（可直接取池平均 Lab，或填 sRGB 自动换算）录入，拟合“颜色→浓度”模型。模型按藻况分轨迹，粉红藻色与无藻黄褐互不干扰。</p>

    <div class="card">
      <h3>录入标定样本</h3>
      <div class="row">
        <label class="field"><span>实测波美度 °Bé</span><input id="c-baume" type="number" step="0.1" min="2" max="28"></label>
        <label class="field"><span>天气</span>
          <select id="c-weather"><option value="sunny">晴</option><option value="cloudy">阴</option></select>
        </label>
        <label class="field"><span>时段</span>
          <select id="c-time"><option value="morning">早</option><option value="noon" selected>午</option><option value="evening">晚</option></select>
        </label>
      </div>
      <div class="row">
        <label class="field"><span>颜色输入方式</span>
          <select id="c-mode">
            <option value="lab">直接填 Lab（L,a,b）</option>
            <option value="srgb">填 sRGB（0-255，自动换算 Lab）</option>
            <option value="theory">按 Bé 理论颜色（演示用）</option>
          </select>
        </label>
      </div>
      <div class="row" id="lab-inputs">
        <label class="field"><span>L*</span><input id="c-L" type="number" step="0.1"></label>
        <label class="field"><span>a*</span><input id="c-a" type="number" step="0.1"></label>
        <label class="field"><span>b*</span><input id="c-b" type="number" step="0.1"></label>
      </div>
      <div class="row" id="srgb-inputs" hidden>
        <label class="field"><span>R</span><input id="c-R" type="number" min="0" max="255"></label>
        <label class="field"><span>G</span><input id="c-G" type="number" min="0" max="255"></label>
        <label class="field"><span>B</span><input id="c-B" type="number" min="0" max="255"></label>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px">
        <button class="btn" id="c-add">添加样本</button>
        <button class="btn secondary" id="c-fit">拟合并应用模型</button>
        <button class="btn secondary" id="c-demo">生成演示样本集</button>
        <button class="btn secondary" id="c-reset">恢复内置默认模型</button>
      </div>
      <div class="hint" id="c-msg"></div>
    </div>

    <div class="card">
      <h3>当前模型</h3>
      <div id="model-info" class="stat-grid"></div>
    </div>

    <div class="card">
      <h3>已录样本（<span id="sample-count">0</span>）</h3>
      <div style="overflow-x:auto">
        <table><thead><tr><th>°Bé</th><th>L*</th><th>a*</th><th>b*</th><th>天气</th><th>时段</th><th></th></tr></thead>
        <tbody id="sample-body"></tbody></table>
      </div>
    </div>
  `;

  const msg = root.querySelector('#c-msg') as HTMLElement;
  const modeSel = root.querySelector('#c-mode') as HTMLSelectElement;
  const labInputs = root.querySelector('#lab-inputs') as HTMLElement;
  const srgbInputs = root.querySelector('#srgb-inputs') as HTMLElement;

  modeSel.addEventListener('change', () => {
    const theory = modeSel.value === 'theory';
    labInputs.hidden = modeSel.value === 'srgb' || theory;
    srgbInputs.hidden = modeSel.value !== 'srgb';
  });

  function readLab(): [number, number, number] | null {
    const baume = Number((root.querySelector('#c-baume') as HTMLInputElement).value);
    if (!(baume >= 2 && baume <= 28)) {
      msg.textContent = '请先填写有效的波美度（2–28）。';
      return null;
    }
    if (modeSel.value === 'theory') {
      // 演示：用该 Bé 的自然藻况理论颜色
      const natural = Math.max(0, (baume - 11) / 16);
      return brineLab(baume, natural);
    }
    if (modeSel.value === 'srgb') {
      const R = Number((root.querySelector('#c-R') as HTMLInputElement).value);
      const G = Number((root.querySelector('#c-G') as HTMLInputElement).value);
      const B = Number((root.querySelector('#c-B') as HTMLInputElement).value);
      if ([R, G, B].some((v) => Number.isNaN(v))) {
        msg.textContent = '请填写完整的 sRGB。';
        return null;
      }
      return srgbToLab([R, G, B]);
    }
    const L = Number((root.querySelector('#c-L') as HTMLInputElement).value);
    const a = Number((root.querySelector('#c-a') as HTMLInputElement).value);
    const b = Number((root.querySelector('#c-b') as HTMLInputElement).value);
    if ([L, a, b].some((v) => Number.isNaN(v))) {
      msg.textContent = '请填写完整的 Lab。';
      return null;
    }
    return [L, a, b];
  }

  function renderSamples(): void {
    (root.querySelector('#sample-count') as HTMLElement).textContent = String(samples.length);
    (root.querySelector('#sample-body') as HTMLElement).innerHTML = samples
      .map(
        (s, i) => `<tr>
        <td class="mono">${s.baume.toFixed(1)}</td>
        <td class="mono">${s.lab[0].toFixed(1)}</td>
        <td class="mono">${s.lab[1].toFixed(1)}</td>
        <td class="mono">${s.lab[2].toFixed(1)}</td>
        <td>${s.weather === 'sunny' ? '晴' : '阴'}</td>
        <td>${s.weather ? s.flightTime : ''}</td>
        <td><button class="btn secondary" data-del="${i}" style="padding:3px 10px">删</button></td>
      </tr>`,
      )
      .join('');
    root.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        samples.splice(Number(btn.dataset.del), 1);
        saveSamples(samples);
        renderSamples();
      });
    });
  }

  function renderModel(): void {
    const m = store.get().fitted.model;
    (root.querySelector('#model-info') as HTMLElement).innerHTML = `
      <div class="stat"><div class="k">模型类型</div><div class="v" style="font-size:15px">${m.kind === 'field' ? '现场标定' : '内置默认'}</div></div>
      <div class="stat"><div class="k">锚点/表行数</div><div class="v">${store.get().fitted.table.length}</div></div>
      <div class="stat"><div class="k">样本数</div><div class="v">${m.sampleCount}</div></div>
      <div class="stat"><div class="k">拟合 RMSE</div><div class="v">${m.fitRmse.toFixed(2)}°</div></div>
    `;
  }

  (root.querySelector('#c-add') as HTMLElement).addEventListener('click', () => {
    const baume = Number((root.querySelector('#c-baume') as HTMLInputElement).value);
    const lab = readLab();
    if (!lab) return;
    samples.push({
      id: `u${Date.now()}-${samples.length}`,
      pondName: '现场',
      baume,
      lab,
      weather: (root.querySelector('#c-weather') as HTMLSelectElement).value as Weather,
      flightTime: (root.querySelector('#c-time') as HTMLSelectElement).value as FlightTime,
      createdAt: Date.now(),
    });
    saveSamples(samples);
    renderSamples();
    msg.textContent = `已添加样本（${samples.length} 条）。`;
  });

  (root.querySelector('#c-fit') as HTMLElement).addEventListener('click', () => {
    if (samples.length < 3) {
      msg.textContent = '至少需要 3 条样本才能拟合。';
      return;
    }
    const fitted = fitCalibration(samples);
    store.saveCalibration(fitted);
    renderModel();
    msg.textContent = `拟合完成，RMSE=${fitted.model.fitRmse.toFixed(2)}°Bé，已应用并保存。`;
  });

  (root.querySelector('#c-demo') as HTMLElement).addEventListener('click', () => {
    const demo: StoredSample[] = [];
    let k = 0;
    for (let b = 4; b <= 26; b += 2) {
      const natural = Math.max(0, (b - 11) / 16);
      for (const algae of [Math.max(0, natural - 0.2), natural, Math.min(1, natural + 0.2)]) {
        demo.push({
          id: `d${k++}`,
          pondName: '演示',
          baume: b,
          lab: brineLab(b, algae),
          weather: 'sunny',
          flightTime: 'noon',
          createdAt: Date.now(),
        });
      }
    }
    samples = demo;
    saveSamples(samples);
    renderSamples();
    msg.textContent = `已生成 ${demo.length} 条演示样本，可点击“拟合并应用模型”。`;
  });

  (root.querySelector('#c-reset') as HTMLElement).addEventListener('click', () => {
    store.resetCalibration();
    renderModel();
    msg.textContent = '已恢复内置默认标定模型。';
  });

  renderSamples();
  renderModel();
}

// 航拍导入页：选择天气/藻类/光照/架次/数量，合成带浓度真值的数据集；也支持导入实拍照片
import { h, clear, statCard } from './dom';
import { ProgressBar, choiceGroup } from './widgets';
import { state, set, showToast, type ScenarioOptions } from '../state/store';
import { generateJob } from '../state/jobs';
import { PHOTO_W, PHOTO_H } from '../core/synth';
import type { AlgaeKind, LightingKind, WeatherKind } from '../core/types';

function thumbUrl(data: Uint8ClampedArray, w: number, h: number): string {
  const c = document.createElement('canvas');
  c.width = 120;
  c.height = Math.round((120 * h) / w);
  const g = c.getContext('2d')!;
  const img = new ImageData(new Uint8ClampedArray(data), w, h);
  // 缩到缩略尺寸
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  tmp.getContext('2d')!.putImageData(img, 0, 0);
  g.drawImage(tmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.7);
}

export function createImportPage(): { el: HTMLElement; show: () => void } {
  const progress = new ProgressBar();
  const preview = h('div', { class: 'thumb-grid' });
  const summary = h('div', { class: 'import-summary' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' }) as HTMLInputElement;

  async function doGenerate(): Promise<void> {
    if (state.generating.running) return;
    const options: ScenarioOptions = { ...state.scenario };
    set({ generating: { running: true, frac: 0.02, label: '准备合成…' } });
    progress.update(state.generating);
    try {
      const done = await generateJob(options, (frac, label) => {
        set({ generating: { running: true, frac, label } });
        progress.update(state.generating);
      });
      set({
        field: done.field,
        photos: done.photos,
        manifest: done.manifest,
        stitch: null,
        analysis: null,
        activePanId: null,
        generating: { running: false, frac: 1, label: '合成完成' },
      });
      progress.update(state.generating);
      showToast('ok', `已合成 ${done.photos.length} 张带真值航拍照片，覆盖 ${done.field.pans.length} 块蒸发池`);
      renderPreview();
    } catch (e) {
      set({ generating: { running: false, frac: 0, label: '' } });
      progress.update(state.generating);
      showToast('err', `合成失败：${(e as Error).message}`);
    }
  }

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    try {
      const photos = await importRealPhotos(Array.from(files));
      set({
        photos,
        field: null,
        manifest: {
          id: `real_${Date.now()}`,
          createdAt: new Date().toISOString(),
          weather: 'sunny',
          algae: 'bloom',
          photoCount: photos.length,
          panCount: 60,
          missions: 1,
          worldWidth: 2800,
          worldHeight: 1800,
          seed: 0,
        },
        stitch: null,
        analysis: null,
      });
      showToast('ok', `已导入 ${photos.length} 张实拍照片，将按航线顺序排布近似位姿`);
      renderPreview();
    } catch (e) {
      showToast('err', `导入失败：${(e as Error).message}`);
    }
  }

  function renderPreview(): void {
    clear(preview);
    const photos = state.photos;
    if (photos.length === 0) {
      preview.append(h('div', { class: 'empty-hint' }, '尚未载入照片。点击“合成航拍数据集”生成带波美度真值的照片，或导入实拍。'));
    } else {
      const head = photos.slice(0, 72);
      for (const p of head) {
        const url = thumbUrl(p.data, p.width, p.height);
        preview.append(
          h('div', { class: `thumb mission-${p.mission}` },
            h('img', { src: url, alt: p.name, loading: 'lazy' }),
            h('span', { class: 'thumb-id' }, p.id),
          ),
        );
      }
      if (photos.length > head.length) {
        preview.append(h('div', { class: 'thumb-more' }, `其余 ${photos.length - head.length} 张已载入，拼接时全部参与`));
      }
    }
    renderSummary();
  }

  function renderSummary(): void {
    clear(summary);
    const f = state.field;
    const m = state.manifest;
    if (!m) {
      summary.append(h('p', { class: 'muted' }, '合成数据包含：规则网格盐田、笔直土埂、天气与太阳光照、嗜盐藻华、白色盐花、泥斑、水面反光，以及每块池的波美度真值和当天舀样实测。'));
      return;
    }
    const baumes = f ? f.pans.map((p) => p.trueBaume ?? 0) : [];
    summary.append(
      h('div', { class: 'stat-row' },
        statCard('照片', String(m.photoCount), m.missions === 2 ? '含早晚双架次' : '单架次'),
        statCard('蒸发池', String(m.panCount), f ? `${f.rows} 行 × ${f.cols} 列` : ''),
        statCard('波美度范围', baumes.length ? `${Math.min(...baumes).toFixed(1)}–${Math.max(...baumes).toFixed(1)} °Bé` : '—'),
        statCard('合成异常', f ? `${f.anomalyIds.length} 池` : '—', f ? f.anomalyIds.join('、') : '', 'warn'),
      ),
    );
    summary.append(
      h('div', { class: 'next-row' },
        h('button', {
          class: 'btn primary big',
          type: 'button',
          disabled: state.photos.length === 0,
          onClick: () => window.dispatchEvent(new CustomEvent('app:nav', { detail: { tab: 'stitch', run: 'stitch' } })),
        }, '下一步：拼接大图 →'),
        h('span', { class: 'muted' }, '拼接与颜色分析均在 Web Worker 中运行，不阻塞界面。'),
      ),
    );
  }

  // ---- 控件 ----
  const s = state.scenario;
  const countChips = [48, 96, 160, 320, 500];
  const countGroup = h('div', { class: 'chip-row' },
    ...countChips.map((n) => h('button', {
      type: 'button',
      class: `chip ${s.count === n ? 'active' : ''}`,
      onClick: (e: Event) => {
        set({ scenario: { ...state.scenario, count: n } });
        countGroup.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c.textContent === String(n)));
        void e;
      },
    }, n === 500 ? '500 张（压力验证）' : `${n} 张`)),
  );

  const weatherGroup = choiceGroup<WeatherKind>('天气', [
    { value: 'sunny', label: '晴', hint: '强光·反光强' },
    { value: 'cloudy', label: '多云', hint: '散射柔和' },
    { value: 'overcast', label: '阴', hint: '冷调·低反差' },
  ], s.weather, (v) => set({ scenario: { ...state.scenario, weather: v } }));

  const algaeGroup = choiceGroup<AlgaeKind>('藻色', [
    { value: 'none', label: '寡藻', hint: '黄褐卤水' },
    { value: 'medium', label: '中等', hint: '尾部泛粉' },
    { value: 'bloom', label: '嗜盐藻华', hint: '粉红→红' },
  ], s.algae, (v) => set({ scenario: { ...state.scenario, algae: v } }));

  const lightGroup = choiceGroup<LightingKind>('太阳角度', [
    { value: 'morning', label: '早晨', hint: '低角暖光' },
    { value: 'noon', label: '正午', hint: '中性顶光' },
    { value: 'evening', label: '傍晚', hint: '强暖长梯度' },
  ], s.lighting, (v) => set({ scenario: { ...state.scenario, lighting: v } }));

  const eveningCheck = h('input', {
    type: 'checkbox',
    checked: s.withEvening,
    onChange: (e: Event) => set({ scenario: { ...state.scenario, withEvening: (e.target as HTMLInputElement).checked } }),
  }) as HTMLInputElement;

  const seedInput = h('input', {
    type: 'number',
    value: String(s.seed),
    class: 'seed-input',
    onChange: (e: Event) => set({ scenario: { ...state.scenario, seed: Number((e.target as HTMLInputElement).value) || 1 } }),
  }) as HTMLInputElement;

  const generateBtn = h('button', { class: 'btn primary big block', type: 'button', onClick: doGenerate }, '🛰 合成带浓度真值的航拍数据集');

  fileInput.addEventListener('change', () => handleFiles(fileInput.files));

  const dropZone = h('div', {
    class: 'dropzone',
    onClick: () => fileInput.click(),
    onDragover: (e: DragEvent) => { e.preventDefault(); dropZone.classList.add('drag'); },
    onDragleave: () => dropZone.classList.remove('drag'),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      dropZone.classList.remove('drag');
      handleFiles(e.dataTransfer?.files ?? null);
    },
  }, h('div', { class: 'dz-title' }, '导入实拍航拍照片'), h('div', { class: 'muted' }, '点击选择或拖拽多张 JPG/PNG；将按文件名/选择顺序排布近似航线位姿'));

  const el = h('div', { class: 'page import-page' },
    h('header', { class: 'page-head' },
      h('h1', null, '航拍导入'),
      h('p', { class: 'page-desc' }, '每天清晨一架次，数百张照片覆盖几十块蒸发池。可一键合成按天气与藻类颜色参数化、带波美度真值的航拍照片，用于验证整条精度链路。'),
    ),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card controls-card' },
        h('h2', null, '合成场景参数'),
        h('div', { class: 'field' }, h('label', null, '照片数量'), countGroup),
        h('div', { class: 'field' }, h('label', null, '天气'), weatherGroup),
        h('div', { class: 'field' }, h('label', null, '藻类颜色表型'), algaeGroup),
        h('div', { class: 'field' }, h('label', null, '太阳角度 / 光照'), lightGroup),
        h('div', { class: 'field inline' },
          h('label', { class: 'check' }, eveningCheck, ' 同时合成傍晚第二架次（验证早晚光照统一）'),
        ),
        h('div', { class: 'field inline' }, h('label', null, '随机种子'), seedInput,
          h('button', { class: 'btn ghost', type: 'button', onClick: () => set({ scenario: { ...state.scenario, seed: Math.floor(Math.random() * 1e9) } }) }, '随机换一批')),
        generateBtn,
        progress.el,
        h('div', { class: 'divider' }),
        dropZone,
        fileInput,
      ),
      h('section', { class: 'card preview-card' },
        h('div', { class: 'card-head' }, h('h2', null, '照片预览'), h('span', { class: 'muted' }, `单张 ${PHOTO_W}×${PHOTO_H}`)),
        summary,
        h('div', { class: 'thumb-scroll' }, preview),
      ),
    ),
  );

  function show(): void {
    renderPreview();
    progress.update(state.generating);
  }
  renderPreview();
  return { el, show };
}

/** 读取实拍图片 -> 统一尺寸 ImageData，并沿蛇形航线分配近似位姿 */
async function importRealPhotos(files: File[]): Promise<import('../core/types').Photo[]> {
  const W = 2800;
  const H = 1800;
  const n = files.length;
  const rows = Math.max(1, Math.round(Math.sqrt((n * H) / W)));
  const perStrip = Math.ceil(n / rows);
  const sx = W / perStrip;
  const sy = H / rows;
  const footprintW = sx / 0.42;
  const footprintH = sy / 0.42;
  const scale = Math.max(footprintW / PHOTO_W, footprintH / PHOTO_H);

  const photos: import('../core/types').Photo[] = [];
  let emitted = 0;
  for (let r = 0; r < rows && emitted < n; r++) {
    const y = (r + 0.5) * sy;
    const ltr = r % 2 === 0;
    for (let k = 0; k < perStrip && emitted < n; k++) {
      const kk = ltr ? k : perStrip - 1 - k;
      const x = (kk + 0.5) * sx;
      const file = files[emitted];
      const bmp = await loadImage(file);
      const c = document.createElement('canvas');
      c.width = PHOTO_W;
      c.height = PHOTO_H;
      const g = c.getContext('2d')!;
      g.drawImage(bmp, 0, 0, PHOTO_W, PHOTO_H);
      const data = g.getImageData(0, 0, PHOTO_W, PHOTO_H).data;
      photos.push({
        id: `REAL-${String(emitted + 1).padStart(4, '0')}`,
        name: file.name,
        width: PHOTO_W,
        height: PHOTO_H,
        data: new Uint8ClampedArray(data),
        lighting: 'morning',
        weather: 'sunny',
        algae: 'bloom',
        pose: { cx: x, cy: y, scale, rotation: 0 },
        mission: 'morning',
      });
      emitted++;
    }
  }
  return photos;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = reject;
    img.src = url;
  });
}

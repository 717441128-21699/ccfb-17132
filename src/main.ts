// 应用入口：侧边导航 + 四个页面切换。
import './ui/styles.css';
import { renderImportPage } from './ui/page-import';
import { renderMosaicPage } from './ui/page-mosaic';
import { renderConcentrationPage } from './ui/page-concentration';
import { renderCalibrationPage } from './ui/page-calibration';

type PageId = 'import' | 'mosaic' | 'concentration' | 'calibration';

const PAGES: { id: PageId; label: string }[] = [
  { id: 'import', label: '航拍导入' },
  { id: 'mosaic', label: '拼接大图' },
  { id: 'concentration', label: '池子浓度图' },
  { id: 'calibration', label: '标定管理' },
];

const app = document.querySelector('#app') as HTMLElement;

function renderNav(active: PageId): void {
  app.innerHTML = `
    <aside class="sidebar">
      <h1>盐田卤水浓度估测</h1>
      ${PAGES.map(
        (p) =>
          `<button class="nav-item ${p.id === active ? 'active' : ''}" data-page="${p.id}">${p.label}</button>`,
      ).join('')}
      <div class="hint" style="padding:16px 18px;position:absolute;bottom:0">
        无人机航拍 · 相位配准 · 灰板校正<br>Web Worker + Canvas + TypeScript
      </div>
    </aside>
    <main class="main" id="page-root"></main>
  `;
  app.querySelectorAll<HTMLButtonElement>('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.page as PageId));
  });
}

function navigate(page: PageId): void {
  renderNav(page);
  const root = document.querySelector('#page-root') as HTMLElement;
  switch (page) {
    case 'import':
      renderImportPage(root);
      break;
    case 'mosaic':
      renderMosaicPage(root);
      break;
    case 'concentration':
      renderConcentrationPage(root);
      break;
    case 'calibration':
      renderCalibrationPage(root);
      break;
  }
}

navigate('import');

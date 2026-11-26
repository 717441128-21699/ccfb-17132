// 盐瞳 · 盐田航拍波美度分析系统 —— 应用入口与四页导航
import './styles.css';
import { h } from './ui/dom';
import { state, set, subscribe } from './state/store';
import { createImportPage } from './ui/import-page';
import { createStitchPage } from './ui/stitch-page';
import { createMapPage } from './ui/map-page';
import { createCalibrationPage } from './ui/calibration-page';
import type { TabId } from './state/store';

const tabs: Array<{ id: TabId; label: string; icon: string; sub: string }> = [
  { id: 'import', label: '航拍导入', icon: '🛰', sub: '合成 / 导入数百张带真值照片' },
  { id: 'stitch', label: '拼接大图', icon: '🧩', sub: '土埂直线对齐 · 光照拉匀' },
  { id: 'map', label: '池子浓度图', icon: '🎨', sub: '去反光盐花泥 · 波美度反演 · 异常预警' },
  { id: 'calib', label: '标定管理', icon: '📏', sub: '波美计实测 ↔ 颜色关系' },
];

const importPage = createImportPage();
const stitchPage = createStitchPage();
const mapPage = createMapPage();
const calibPage = createCalibrationPage();
const pageMap: Record<TabId, { el: HTMLElement; show: () => void }> = {
  import: importPage,
  stitch: stitchPage,
  map: mapPage,
  calib: calibPage,
};

const navBtns = new Map<TabId, HTMLButtonElement>();
const nav = h('nav', { class: 'tabs' },
  ...tabs.map((t) => {
    const b = h('button', {
      class: `tab ${state.tab === t.id ? 'active' : ''}`,
      type: 'button',
      onClick: () => go(t.id),
    }, h('span', { class: 'tab-icon' }, t.icon), h('span', { class: 'tab-text' }, t.label)) as HTMLButtonElement;
    navBtns.set(t.id, b);
    return b;
  }),
);

const badge = h('span', { class: 'env-badge' }, 'TypeScript · Web Worker · Canvas');

const header = h('header', { class: 'app-header' },
  h('div', { class: 'brand' },
    h('div', { class: 'logo' }, '盐瞳'),
    h('div', null,
      h('div', { class: 'brand-title' }, '盐田航拍波美度分析系统'),
      h('div', { class: 'brand-sub' }, '海盐蒸发池无人机巡检 · 拼接 / 颜色分析 / 浓度制图')),
  ),
  h('div', { class: 'header-right' }, badge, nav),
);

const main = h('main', { class: 'app-main' },
  ...tabs.map((t) => {
    const wrap = h('div', { class: `page-wrap ${state.tab === t.id ? 'active' : ''}`, 'data-tab': t.id }, pageMap[t.id].el);
    return wrap;
  }),
);

const toastEl = h('div', { class: 'toast-wrap' });

const app = h('div', { class: 'app-shell' }, header, main, toastEl);
document.getElementById('app')!.replaceChildren(app);

function go(tab: TabId, run?: string): void {
  set({ tab });
  navBtns.forEach((b, id) => b.classList.toggle('active', id === tab));
  main.querySelectorAll('.page-wrap').forEach((w) => w.classList.toggle('active', (w as HTMLElement).dataset.tab === tab));
  // 等一帧让容器获得尺寸后再刷新 Canvas
  requestAnimationFrame(() => pageMap[tab].show());
  if (run === 'stitch') void stitchPage.start();
  if (run === 'analysis') void mapPage.start();
}

window.addEventListener('app:nav', ((e: CustomEvent<{ tab: TabId; run?: string }>) => {
  go(e.detail.tab, e.detail.run);
}) as EventListener);

subscribe((s) => {
  if (s.toast) {
    toastEl.replaceChildren(h('div', { class: `toast ${s.toast.kind}` }, s.toast.text));
  } else {
    toastEl.replaceChildren();
  }
});

// 首次显示导入页
requestAnimationFrame(() => importPage.show());

import { h } from './dom';
import type { ProgressState } from '../state/store';

export class ProgressBar {
  readonly el: HTMLElement;
  private fill: HTMLElement;
  private label: HTMLElement;
  private pct: HTMLElement;
  constructor() {
    this.fill = h('div', { class: 'progress-fill' });
    this.label = h('div', { class: 'progress-label' }, '');
    this.pct = h('div', { class: 'progress-pct' }, '0%');
    this.el = h('div', { class: 'progress-wrap hidden' },
      h('div', { class: 'progress-track' }, this.fill),
      h('div', { class: 'progress-meta' }, this.label, this.pct),
    );
  }
  update(p: ProgressState): void {
    this.el.classList.toggle('hidden', !p.running && p.frac === 0);
    if (p.running) this.el.classList.remove('hidden');
    this.fill.style.width = `${Math.round(p.frac * 100)}%`;
    this.pct.textContent = `${Math.round(p.frac * 100)}%`;
    this.label.textContent = p.label;
    if (!p.running && p.frac >= 1) {
      window.setTimeout(() => this.el.classList.add('hidden'), 600);
    }
  }
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** 分段选择卡片组 */
export function choiceGroup<T extends string>(
  name: string,
  choices: Choice<T>[],
  value: T,
  onChange: (v: T) => void,
): HTMLElement {
  const wrap = h('div', { class: 'choice-group', role: 'radiogroup', 'aria-label': name });
  const btns: HTMLButtonElement[] = [];
  for (const c of choices) {
    const b = h('button', {
      type: 'button',
      class: `choice ${c.value === value ? 'active' : ''}`,
      onClick: () => {
        onChange(c.value);
        btns.forEach((x) => x.classList.toggle('active', x.dataset.value === c.value));
      },
    }, h('span', { class: 'choice-label' }, c.label), c.hint ? h('span', { class: 'choice-hint' }, c.hint) : null) as HTMLButtonElement;
    b.dataset.value = c.value;
    btns.push(b);
    wrap.append(b);
  }
  return wrap;
}

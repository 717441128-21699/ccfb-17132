// 轻量全局状态 + 订阅。四个页面共享同一份数据集/拼接/分析/标定状态。
import { makeDefaultCalibration } from '../core/calibration';
import type { FieldLayout } from '../core/field';
import type {
  AlgaeKind,
  AnalysisResult,
  CalibSample,
  DatasetManifest,
  LightingKind,
  Photo,
  WeatherKind,
} from '../core/types';
import type { StitchOutput } from '../core/stitch';

export type TabId = 'import' | 'stitch' | 'map' | 'calib';
export type MissionFilter = 'all' | 'morning' | 'evening';

export interface ScenarioOptions {
  count: number;
  weather: WeatherKind;
  algae: AlgaeKind;
  lighting: LightingKind;
  withEvening: boolean;
  seed: number;
}

export interface ProgressState {
  running: boolean;
  frac: number;
  label: string;
}

export interface AppState {
  tab: TabId;
  scenario: ScenarioOptions;
  generating: ProgressState;
  field: FieldLayout | null;
  photos: Photo[];
  manifest: DatasetManifest | null;

  mission: MissionFilter;
  stitching: ProgressState;
  stitch: StitchOutput | null;

  calibration: CalibSample[];
  useSurvey: boolean;

  analyzing: ProgressState;
  analysis: AnalysisResult | null;
  activePanId: string | null;

  toast: { kind: 'ok' | 'err'; text: string } | null;
}

const CALIB_KEY = 'yantong.calibration.v1';

function loadCalibration(): CalibSample[] {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CalibSample[];
      if (Array.isArray(parsed) && parsed.length >= 3) return parsed;
    }
  } catch {
    /* ignore */
  }
  return makeDefaultCalibration('bloom');
}

export function saveCalibration(samples: CalibSample[]): void {
  try {
    localStorage.setItem(CALIB_KEY, JSON.stringify(samples));
  } catch {
    /* ignore */
  }
}

export const state: AppState = {
  tab: 'import',
  scenario: {
    count: 160,
    weather: 'sunny',
    algae: 'bloom',
    lighting: 'morning',
    withEvening: false,
    seed: 20240517,
  },
  generating: { running: false, frac: 0, label: '' },
  field: null,
  photos: [],
  manifest: null,

  mission: 'all',
  stitching: { running: false, frac: 0, label: '' },
  stitch: null,

  calibration: loadCalibration(),
  useSurvey: true,

  analyzing: { running: false, frac: 0, label: '' },
  analysis: null,
  activePanId: null,

  toast: null,
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 更新状态并通知；UI 采用局部命令式刷新，这里只驱动角标/进度等 */
export function set(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const fn of listeners) fn(state);
}

let toastTimer: number | undefined;
export function showToast(kind: 'ok' | 'err', text: string): void {
  set({ toast: { kind, text } });
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => set({ toast: null }), 3600);
}

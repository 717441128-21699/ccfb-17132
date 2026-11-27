// 应用全局状态：跨页面共享数据集、拼接结果、池子结果与标定模型，localStorage 持久化。
import { defaultFittedModel, deserializeModel, serializeModel, type FittedModel } from '../core/calibration';
import type { DatasetSpec, PipelineResult, PondResult } from '../core/types';
import type { ColorCorrectionInfo } from '../core/pipeline';

export interface AppState {
  spec: DatasetSpec | null;
  mosaic: {
    width: number;
    height: number;
    originX: number;
    originY: number;
    buffer: ArrayBuffer | null;
    pairCount: number;
    rejectedPairs: number;
  } | null;
  ponds: PondResult[];
  colorCorrection: ColorCorrectionInfo | null;
  elapsedMs: number;
  fitted: FittedModel;
  running: boolean;
  progress: { stage: string; fraction: number; detail?: string };
}

type Listener = (state: AppState) => void;

const CALIB_KEY = 'saltfield.calibration.v1';

function loadCalibration(): FittedModel {
  try {
    const raw = localStorage.getItem(CALIB_KEY);
    if (raw) return deserializeModel(raw);
  } catch {
    /* ignore */
  }
  return defaultFittedModel();
}

class Store {
  private state: AppState = {
    spec: null,
    mosaic: null,
    ponds: [],
    colorCorrection: null,
    elapsedMs: 0,
    fitted: loadCalibration(),
    running: false,
    progress: { stage: '', fraction: 0 },
  };
  private listeners = new Set<Listener>();

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  setProgress(stage: string, fraction: number, detail?: string): void {
    this.state = { ...this.state, running: true, progress: { stage, fraction, detail } };
    this.emit();
  }

  setResult(spec: DatasetSpec, result: PipelineResult & { colorCorrection: ColorCorrectionInfo }): void {
    this.state = {
      ...this.state,
      spec,
      mosaic: {
        width: result.mosaic.width,
        height: result.mosaic.height,
        originX: result.mosaic.originX,
        originY: result.mosaic.originY,
        buffer: result.mosaic.canvas.data.buffer as ArrayBuffer,
        pairCount: result.mosaic.pairCount,
        rejectedPairs: result.mosaic.rejectedPairs,
      },
      ponds: result.ponds,
      colorCorrection: result.colorCorrection,
      elapsedMs: result.elapsedMs,
      running: false,
      progress: { stage: 'done', fraction: 1 },
    };
    this.emit();
  }

  saveCalibration(fitted: FittedModel): void {
    this.state = { ...this.state, fitted };
    try {
      localStorage.setItem(CALIB_KEY, serializeModel(fitted));
    } catch {
      /* ignore */
    }
    this.emit();
  }

  resetCalibration(): void {
    const fitted = defaultFittedModel();
    try {
      localStorage.removeItem(CALIB_KEY);
    } catch {
      /* ignore */
    }
    this.state = { ...this.state, fitted };
    this.emit();
  }
}

export const store = new Store();

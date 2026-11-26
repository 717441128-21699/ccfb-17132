// Worker 任务的 Promise 封装
import SynthWorker from '../workers/synth.worker?worker';
import StitchWorker from '../workers/stitch.worker?worker';
import AnalysisWorker from '../workers/analysis.worker?worker';
import type { AnalyzeDone, GenDoneMsg, WorkerResponse } from '../core/protocol';
import type { SynthOptions } from '../core/synth';
import type { StitchOutput } from '../core/stitch';
import type { AnalysisResult, CalibSample, Pan, Photo } from '../core/types';

function wire<T>(
  worker: Worker,
  post: () => void,
  onProgress: (frac: number, label: string) => void,
  resolveDone: (m: WorkerResponse) => T,
  resolve: (v: T) => void,
  reject: (e: Error) => void,
): void {
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const m = ev.data;
    if (m.type === 'progress') onProgress(m.frac, m.label);
    else if (m.type === 'error') {
      worker.terminate();
      reject(new Error(m.message));
    } else {
      try {
        resolve(resolveDone(m));
      } finally {
        worker.terminate();
      }
    }
  };
  worker.onerror = (e) => {
    worker.terminate();
    reject(new Error(e.message || 'Worker 运行错误'));
  };
  post();
}

export function generateJob(
  options: SynthOptions,
  onProgress: (frac: number, label: string) => void,
): Promise<GenDoneMsg> {
  return new Promise((resolve, reject) => {
    const w = new SynthWorker();
    wire(
      w,
      () => w.postMessage({ type: 'generate', options }),
      onProgress,
      (m) => m as GenDoneMsg,
      resolve,
      reject,
    );
  });
}

export function stitchJob(
  photos: Photo[],
  dims: { width: number; height: number; rows: number; cols: number },
  onProgress: (frac: number, label: string) => void,
): Promise<StitchOutput> {
  return new Promise((resolve, reject) => {
    const w = new StitchWorker();
    wire(
      w,
      () => w.postMessage({ type: 'stitch', photos, ...dims }),
      onProgress,
      (m) => (m as unknown as { type: 'done'; result: StitchOutput }).result,
      resolve,
      reject,
    );
  });
}

export function analyzeJob(
  mosaic: Uint8ClampedArray,
  dims: { width: number; height: number },
  pans: Pan[],
  calibration: CalibSample[],
  useSurvey: boolean,
  onProgress: (frac: number, label: string) => void,
): Promise<{ result: AnalysisResult; survey?: CalibSample[] }> {
  return new Promise((resolve, reject) => {
    const w = new AnalysisWorker();
    // 复制一份 mosaic 给 Worker，保留主线程原件以便重复分析
    const copy = new Uint8ClampedArray(mosaic);
    wire(
      w,
      () =>
        w.postMessage(
          { type: 'analyze', mosaic: copy, ...dims, pans, calibration, useSurvey },
          [copy.buffer],
        ),
      onProgress,
      (m) => {
        const d = m as AnalyzeDone;
        return { result: d.result, survey: d.survey };
      },
      resolve,
      reject,
    );
  });
}

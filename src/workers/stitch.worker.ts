// Web Worker：把拼接与颜色分析放到后台线程，避免阻塞主线程 UI。
// 复用与 Node 验证完全相同的核心流水线，保证浏览器结果与测试一致。
import { runPipeline, type RunOptions } from '../core/pipeline';
import { generateDataset, type GeneratorOptions } from '../core/dataset';
import type { FittedModel } from '../core/calibration';

export interface WorkerRequest {
  type: 'run';
  /** 完整数据集生成参数（Worker 内据此确定性重建，与主线程同种子同结果） */
  generator: GeneratorOptions;
  fitted?: FittedModel;
  previous?: [number, number][];
  thumbSize?: number;
  sampleStep?: number;
}

export interface WorkerProgress {
  type: 'progress';
  stage: string;
  fraction: number;
  detail?: string;
}

export interface WorkerDone {
  type: 'done';
  mosaicBuffer: ArrayBuffer;
  mosaicWidth: number;
  mosaicHeight: number;
  originX: number;
  originY: number;
  ponds: import('../core/types').PondResult[];
  colorCorrection: import('../core/pipeline').ColorCorrectionInfo;
  rejectedPairs: number;
  pairCount: number;
  elapsedMs: number;
}

export interface WorkerError {
  type: 'error';
  message: string;
}

export type WorkerResponse = WorkerProgress | WorkerDone | WorkerError;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type !== 'run') return;
  try {
    // 同种子确定性重建数据集（含材质图），避免把数百张照片通过主线程传输
    const ds = generateDataset(msg.generator);
    const previous = msg.previous ? new Map(msg.previous) : undefined;
    const opts: RunOptions = {
      fitted: msg.fitted,
      previous,
      thumbSize: msg.thumbSize,
      sampleStep: msg.sampleStep,
      onProgress: (stage, fraction, detail) => {
        const p: WorkerProgress = { type: 'progress', stage, fraction, detail };
        ctx.postMessage(p);
      },
    };

    const result = await runPipeline(ds.spec, { renderPhoto: ds.renderPhoto }, opts);
    const buffer = result.mosaic.canvas.data.buffer as ArrayBuffer;
    const done: WorkerDone = {
      type: 'done',
      mosaicBuffer: buffer,
      mosaicWidth: result.mosaic.width,
      mosaicHeight: result.mosaic.height,
      originX: result.mosaic.originX,
      originY: result.mosaic.originY,
      ponds: result.ponds,
      colorCorrection: result.colorCorrection,
      rejectedPairs: result.mosaic.rejectedPairs,
      pairCount: result.mosaic.pairCount,
      elapsedMs: result.elapsedMs,
    };
    ctx.postMessage(done, [buffer]);
  } catch (err) {
    const e: WorkerError = { type: 'error', message: err instanceof Error ? err.message : String(err) };
    ctx.postMessage(e);
  }
};

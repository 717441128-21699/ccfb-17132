// Worker 客户端封装：加载 ES Worker、收发进度/结果，把 transfer 的大图 buffer 交回主线程。
import type { FittedModel } from '../core/calibration';
import type { GeneratorOptions } from '../core/dataset';
import type { MosaicResult, PondResult, Raster } from '../core/types';
import type { ColorCorrectionInfo } from '../core/pipeline';
import type { WorkerDone, WorkerProgress, WorkerResponse } from '../workers/stitch.worker';

export interface WorkerResult {
  mosaic: MosaicResult;
  ponds: PondResult[];
  colorCorrection: ColorCorrectionInfo;
  elapsedMs: number;
}

interface Handlers {
  onProgress: (stage: string, fraction: number, detail?: string) => void;
  onDone: (result: WorkerResult) => void;
  onError: (message: string) => void;
}

export function runInWorker(
  generator: GeneratorOptions,
  fitted: FittedModel,
  handlers: Handlers,
): void {
  const worker = new Worker(new URL('../workers/stitch.worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
    const msg = ev.data;
    if (msg.type === 'progress') {
      const p = msg as WorkerProgress;
      handlers.onProgress(p.stage, p.fraction, p.detail);
    } else if (msg.type === 'done') {
      const d = msg as WorkerDone;
      const raster: Raster = {
        width: d.mosaicWidth,
        height: d.mosaicHeight,
        data: new Uint8ClampedArray(d.mosaicBuffer),
      };
      const mosaic: MosaicResult = {
        width: d.mosaicWidth,
        height: d.mosaicHeight,
        canvas: raster,
        poses: [],
        originX: d.originX,
        originY: d.originY,
        gains: [],
        pairCount: d.pairCount,
        rejectedPairs: d.rejectedPairs,
        illuminantNormalized: true,
      };
      handlers.onDone({
        mosaic,
        ponds: d.ponds,
        colorCorrection: d.colorCorrection,
        elapsedMs: d.elapsedMs,
      });
      worker.terminate();
    } else if (msg.type === 'error') {
      handlers.onError(msg.message);
      worker.terminate();
    }
  };
  worker.onerror = (ev) => {
    handlers.onError(ev.message);
    worker.terminate();
  };

  worker.postMessage({
    type: 'run',
    generator,
    fitted,
  });
}

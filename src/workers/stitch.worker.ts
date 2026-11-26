/// 拼接 Worker：土埂对齐、光照拉匀、加权融合都在这里跑，不阻塞 UI
import { stitchPhotos, type StitchOutput } from '../core/stitch';
import type { StitchRequest, WorkerResponse } from '../core/protocol';

interface MinimalWorker {
  onmessage: ((ev: MessageEvent<StitchRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as MinimalWorker;

ctx.onmessage = (ev) => {
  const req = ev.data;
  if (req.type !== 'stitch') return;
  try {
    const result: StitchOutput = stitchPhotos(req.photos, {
      width: req.width,
      height: req.height,
      rows: req.rows,
      cols: req.cols,
      onProgress: (frac, label) => ctx.postMessage({ type: 'progress', frac, label }),
    });
    ctx.postMessage(
      { type: 'done', result },
      [result.data.buffer] as Transferable[],
    );
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

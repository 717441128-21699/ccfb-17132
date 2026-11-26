/// 合成 Worker：生成带浓度真值的航拍照片，避免数百张照片的像素合成卡住 UI
import { generateDataset } from '../core/synth';
import type { GenRequest, WorkerResponse } from '../core/protocol';
import type { DatasetManifest } from '../core/types';

interface MinimalWorker {
  onmessage: ((ev: MessageEvent<GenRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as MinimalWorker;

ctx.onmessage = (ev) => {
  const req = ev.data;
  if (req.type !== 'generate') return;
  try {
    ctx.postMessage({ type: 'progress', frac: 0.05, label: '正在渲染盐田与浓度真值…' });
    const t0 = Date.now();
    const ds = generateDataset(req.options);
    const manifest: DatasetManifest = {
      id: `ds_${req.options.seed ?? 20240517}`,
      createdAt: new Date().toISOString(),
      weather: req.options.weather,
      algae: req.options.algae,
      photoCount: ds.photos.length,
      panCount: ds.field.pans.length,
      missions: req.options.withEvening ? 2 : 1,
      worldWidth: ds.field.width,
      worldHeight: ds.field.height,
      seed: req.options.seed ?? 20240517,
    };
    // world 不回传（UI 用拼接结果即可），只转移照片像素缓冲
    const transfers = ds.photos.map((p) => p.data.buffer) as Transferable[];
    ctx.postMessage({ type: 'done', field: ds.field, photos: ds.photos, manifest }, transfers);
    void t0;
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

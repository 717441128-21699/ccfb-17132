// 端到端流水线编排：渲染照片 -> 缩略配准 -> 增益估计 -> 大图融合 -> 灰板颜色校正 -> 池分析。
// 不直接依赖 Worker / DOM，浏览器端由 worker 调用，Node 端由验证脚本调用。
import { analyzePonds, type AnalysisOptions } from './analysis';
import { defaultFittedModel, type FittedModel } from './calibration';
import { applyCorrectionToPhoto, estimateColorCorrection } from './color-correction';
import { createRaster, type Raster } from './image';
import { composeMosaic, estimatePoses, makeThumbnail } from './stitch';
import type {
  DatasetSpec,
  MosaicResult,
  PipelineResult,
  PondResult,
} from './types';

export interface ColorCorrectionInfo {
  detectedPanels: number;
  samples: number;
  channelGain: [number, number, number];
  intensityGain: number;
}

export interface PipelineResultExt extends PipelineResult {
  colorCorrection: ColorCorrectionInfo;
}

export interface RunOptions {
  onProgress?: (stage: string, fraction: number, detail?: string) => void;
  /** 配准缩略图目标边长 */
  thumbSize?: number;
  /** 分析采样步长 */
  sampleStep?: number;
  fitted?: FittedModel;
  previous?: Map<number, number>;
}

export interface RunContext {
  renderPhoto: (id: number) => Raster;
}

export async function runPipeline(
  spec: DatasetSpec,
  ctx: RunContext,
  opts: RunOptions = {},
): Promise<PipelineResultExt> {
  const t0 = now();
  const onProgress = opts.onProgress ?? (() => {});
  const thumbTarget = opts.thumbSize ?? 96;
  const photos = spec.photos;

  // 1) 渲染缩略图（配准用，避免对全分辨率做 FFT）
  onProgress('render-thumbs', 0, `渲染 ${photos.length} 张照片`);
  const thumbs: Raster[] = [];
  const fullImages: Raster[] = new Array(photos.length);
  let thumbFactor = 1;
  for (let i = 0; i < photos.length; i++) {
    const full = ctx.renderPhoto(i);
    fullImages[i] = full;
    const thumb = makeThumbnail(full, thumbTarget);
    thumbs.push(thumb);
    if (i === 0) thumbFactor = full.width / thumb.width;
    if (i % 25 === 0) onProgress('render-thumbs', i / photos.length, `渲染 ${i}/${photos.length}`);
    await tick();
  }

  // 2) 相位相关配准 + 全局位姿
  onProgress('register', 0, '相位相关配准');
  const { poses, rejected } = estimatePoses(photos, thumbs, {
    onProgress: (f, d) => onProgress('register', f, d),
  });
  onProgress('register', 1, `配准完成，剔除坏对 ${rejected}`);

  // 3) 参考灰板颜色校正（在融合前、对原始照片做，避免 feathering 污染小灰板）
  onProgress('color-correct', 0, '灰板光照校正');
  const correction = estimateColorCorrection(photos, fullImages, spec.references);
  for (let i = 0; i < photos.length; i++) {
    applyCorrectionToPhoto(fullImages[i], correction, photos[i].exposure);
  }
  onProgress('color-correct', 1, `检测到 ${correction.detectedPanels} 块灰板 / ${correction.samples} 个采样`);

  // 4) 线性光域融合大图（照片已校正到统一光照与单位曝光，直接 feather 累积）
  onProgress('compose', 0, '大图融合');
  const gains = photos.map((p) => ({ id: p.id, rgb: [1, 1, 1] as [number, number, number] }));
  const mosaic: MosaicResult = composeMosaic(photos, fullImages, poses, gains, spec, {
    onProgress: (f, d) => onProgress('compose', f, d),
  });
  mosaic.rejectedPairs = rejected;

  // 5) 池子分析
  onProgress('analyze', 0, '池子颜色分析');
  const fitted = opts.fitted ?? defaultFittedModel();
  const analysisOpts: AnalysisOptions = {
    sampleStep: opts.sampleStep ?? 2,
    onProgress: (f, d) => onProgress('analyze', f, d),
  };
  const ponds: PondResult[] = analyzePonds(mosaic, spec.ponds, fitted, analysisOpts, opts.previous);

  const elapsedMs = now() - t0;
  onProgress('done', 1, `完成，耗时 ${elapsedMs} ms`);
  return {
    mosaic,
    ponds,
    elapsedMs,
    colorCorrection: {
      detectedPanels: correction.detectedPanels,
      samples: correction.samples,
      channelGain: correction.channelGain,
      intensityGain: correction.intensityGain,
    },
  };
}

/** 允许 Worker 事件循环插入消息处理 */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof queueMicrotask === 'function') queueMicrotask(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Node/Worker 均可用的空渲染上下文（测试时由合成器提供） */
export function syntheticContext(render: (id: number) => Raster): RunContext {
  return { renderPhoto: render };
}

export function emptyRaster(w: number, h: number): Raster {
  return createRaster(w, h);
}

// Worker 消息协议（主线程 <-> 合成/拼接/分析 Worker）
import type { SynthOptions } from './synth';
import type { FieldLayout } from './field';
import type {
  AnalysisResult,
  CalibSample,
  DatasetManifest,
  Pan,
  Photo,
  StitchResult,
} from './types';

export interface ProgressMsg {
  type: 'progress';
  frac: number;
  label: string;
}
export interface ErrorMsg {
  type: 'error';
  message: string;
}

// 合成
export interface GenRequest {
  type: 'generate';
  options: SynthOptions;
}
export interface GenDoneMsg {
  type: 'done';
  field: FieldLayout;
  photos: Photo[];
  manifest: DatasetManifest;
}

// 拼接
export interface StitchRequest {
  type: 'stitch';
  photos: Photo[];
  width: number;
  height: number;
  rows: number;
  cols: number;
}
export type StitchDone = { type: 'done'; result: StitchResult & { pans: Pan[] } };

// 分析
export interface AnalyzeRequest {
  type: 'analyze';
  mosaic: Uint8ClampedArray;
  width: number;
  height: number;
  pans: Pan[];
  calibration: CalibSample[];
  useSurvey: boolean;
}
export type AnalyzeDone = {
  type: 'done';
  result: AnalysisResult;
  survey?: CalibSample[];
};

export type WorkerResponse = ProgressMsg | ErrorMsg | GenDoneMsg | StitchDone | AnalyzeDone;

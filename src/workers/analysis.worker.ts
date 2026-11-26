/// 颜色分析 Worker：逐池分类、稳健水色、标定反演、异常检测与标注层
import {
  extractPanColors,
  buildSurveyCalibration,
  finalizeAnalysis,
} from '../core/analyze';
import { CalibrationModel } from '../core/calibration';
import type { AnalyzeRequest, WorkerResponse } from '../core/protocol';
import type { CalibSample } from '../core/types';

interface MinimalWorker {
  onmessage: ((ev: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as MinimalWorker;

ctx.onmessage = (ev) => {
  const req = ev.data;
  if (req.type !== 'analyze') return;
  try {
    const started = Date.now();
    const report = (frac: number, label: string) =>
      ctx.postMessage({ type: 'progress', frac, label });

    report(0.05, '逐池提取水色并剔除反光/盐花/泥');
    const colors = extractPanColors(req.mosaic, req.width, req.height, req.pans, report);

    let calibration: CalibSample[] = req.calibration;
    let survey: CalibSample[] | undefined;
    if (req.useSurvey) {
      report(0.58, '用当天波美计舀样建立盐场标定关系');
      const built = buildSurveyCalibration(req.pans, colors, 1);
      if (built.length >= 4) {
        calibration = built;
        survey = built;
      }
    }
    const model = new CalibrationModel(calibration);

    const result = finalizeAnalysis(
      colors,
      req.pans,
      model,
      req.width,
      req.height,
      started,
      report,
    );

    ctx.postMessage(
      { type: 'done', result, survey },
      [result.overlay.buffer] as Transferable[],
    );
  } catch (err) {
    ctx.postMessage({ type: 'error', message: (err as Error).message ?? String(err) });
  }
};

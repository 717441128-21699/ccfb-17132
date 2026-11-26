import { describe, expect, it } from 'vitest';
import { generateDataset } from '../src/core/synth';
import { stitchPhotos } from '../src/core/stitch';
import {
  mergeTruth,
  extractPanColors,
  buildSurveyCalibration,
  finalizeAnalysis,
} from '../src/core/analyze';
import { CalibrationModel } from '../src/core/calibration';

describe('500 photos budget', () => {
  it('stitch + analysis produce concentration map within 60s and ±1.5 °Bé', () => {
    const genT0 = Date.now();
    const ds = generateDataset({ count: 500, weather: 'sunny', algae: 'bloom', lighting: 'morning', seed: 42 });
    const genMs = Date.now() - genT0;

    const pipeT0 = Date.now();
    const st = stitchPhotos(ds.photos, { width: ds.field.width, height: ds.field.height, rows: 6, cols: 10 });
    const pans = mergeTruth(st.pans, ds.field.pans);
    const colors = extractPanColors(st.data, st.width, st.height, pans);
    const survey = buildSurveyCalibration(pans, colors, 1);
    const result = finalizeAnalysis(colors, pans, new CalibrationModel(survey), st.width, st.height);
    const pipeMs = Date.now() - pipeT0;

    // 供人工核查的性能数字
    console.log(`[perf500] generate=${genMs}ms stitch=${st.elapsedMs.toFixed(0)}ms analysis=${result.elapsedMs.toFixed(0)}ms pipeline=${pipeMs}ms`);
    console.log(`[perf500] eval=${JSON.stringify(result.evaluation)}`);

    expect(ds.photos.length).toBe(500);
    expect(pipeMs).toBeLessThan(60_000);
    expect(result.evaluation!.withinTolerance).toBe(60);
    expect(result.evaluation!.maxAbsError).toBeLessThanOrEqual(1.5);
  }, 180_000);
});

import { describe, expect, it } from 'vitest';
import { generateDataset } from '../src/core/synth';
import { stitchPhotos } from '../src/core/stitch';
import { mergeTruth, extractPanColors, buildSurveyCalibration, finalizeAnalysis } from '../src/core/analyze';
import { CalibrationModel } from '../src/core/calibration';

describe('morning / evening illumination alignment', () => {
  it('a calibration fit on morning transfers to the evening flight within tolerance', () => {
    const ds = generateDataset({ count: 96, weather: 'sunny', algae: 'bloom', withEvening: true, seed: 20240517 });
    const field = ds.field;

    const runMission = (mission: 'morning' | 'evening') => {
      const photos = ds.photos.filter((p) => p.mission === mission);
      const st = stitchPhotos(photos, { width: field.width, height: field.height, rows: 6, cols: 10 });
      const pans = mergeTruth(st.pans, field.pans);
      const colors = extractPanColors(st.data, st.width, st.height, pans);
      return { st, pans, colors };
    };

    const morning = runMission('morning');
    const sharedModel = new CalibrationModel(buildSurveyCalibration(morning.pans, morning.colors, 1));
    const morningRes = finalizeAnalysis(morning.colors, morning.pans, sharedModel, morning.st.width, morning.st.height);

    const evening = runMission('evening');
    const eveningRes = finalizeAnalysis(evening.colors, evening.pans, sharedModel, evening.st.width, evening.st.height);

    expect(morningRes.evaluation!.withinTolerance).toBe(60);
    // 傍晚不重新标定，直接共用早晨模型，仍须全部 ≤1.5
    expect(eveningRes.evaluation!.withinTolerance).toBe(60);
    expect(eveningRes.evaluation!.maxAbsError).toBeLessThanOrEqual(1.5);

    const mMap = new Map(morningRes.stats.map((s) => [s.panId, s.baume]));
    let maxDelta = 0;
    for (const s of eveningRes.stats) {
      maxDelta = Math.max(maxDelta, Math.abs(s.baume - (mMap.get(s.panId) ?? s.baume)));
    }
    expect(maxDelta).toBeLessThan(1.5);
  }, 240000);
});

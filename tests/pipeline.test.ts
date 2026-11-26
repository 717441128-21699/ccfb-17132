import { describe, expect, it } from 'vitest';
import { generateDataset } from '../src/core/synth';
import { stitchPhotos } from '../src/core/stitch';
import {
  mergeTruth,
  extractPanColors,
  buildSurveyCalibration,
  finalizeAnalysis,
} from '../src/core/analyze';
import { evaluateBoundaries } from '../src/core/segment';
import { CalibrationModel } from '../src/core/calibration';
import type { WeatherKind, AlgaeKind, LightingKind } from '../src/core/types';

function run(count: number, weather: WeatherKind, algae: AlgaeKind, lighting: LightingKind, seed = 20240517) {
  const ds = generateDataset({ count, weather, algae, lighting, seed });
  const st = stitchPhotos(ds.photos, { width: ds.field.width, height: ds.field.height, rows: 6, cols: 10 });
  const boundary = evaluateBoundaries(st.pans, ds.field.pans);
  const pans = mergeTruth(st.pans, ds.field.pans);
  const colors = extractPanColors(st.data, st.width, st.height, pans);
  const survey = buildSurveyCalibration(pans, colors, 1);
  const result = finalizeAnalysis(colors, pans, new CalibrationModel(survey), st.width, st.height);
  return { ds, st, boundary, result };
}

describe('end-to-end Baumé accuracy', () => {
  it('sunny + pink algae: every pan within 1.5 °Bé of scoop measurement', () => {
    const { result, boundary, ds } = run(96, 'sunny', 'bloom', 'morning');
    const e = result.evaluation!;
    expect(e.total).toBe(60);
    expect(e.withMeasurement).toBe(60);
    expect(e.withinTolerance).toBe(60);
    expect(e.maxAbsError).toBeLessThanOrEqual(1.5);
    expect(e.meanAbsError).toBeLessThan(0.6);
    // 对合成真值同样成立
    expect(e.trueWithinTolerance).toBe(60);
    // 边界贴合土埂内沿：平均 < 4 大图 px
    expect(boundary.meanPx).toBeLessThan(4);
    // 异常池（突然变淡）全部检出
    const detected = result.stats.filter((s) => s.anomaly).map((s) => s.panId).sort();
    expect(detected).toEqual([...ds.field.anomalyIds].sort());
  }, 200000);

  it('cloudy + medium algae + noon stays within tolerance', () => {
    const { result } = run(72, 'cloudy', 'medium', 'noon', 99);
    expect(result.evaluation!.withinTolerance).toBe(60);
    expect(result.evaluation!.maxAbsError).toBeLessThanOrEqual(1.5);
  }, 200000);

  it('overcast + no algae + evening warm light is normalized and stays accurate', () => {
    const { result } = run(72, 'overcast', 'none', 'evening', 123);
    expect(result.evaluation!.withinTolerance).toBe(60);
    expect(result.evaluation!.maxAbsError).toBeLessThanOrEqual(1.5);
  }, 200000);
});

describe('feature separation', () => {
  it('detects white salt in crystallizers while keeping pink index high', () => {
    const { result } = run(96, 'sunny', 'bloom', 'morning');
    const salty = result.stats.filter((s) => s.fractions.salt > 0.02);
    expect(salty.length).toBeGreaterThanOrEqual(2);
    // 最右列结晶/高浓度池应有盐花
    const lastColSalt = result.stats.filter((s) => s.panId.endsWith('-10')).some((s) => s.fractions.salt > 0.02);
    expect(lastColSalt).toBe(true);
    // 高浓度粉池粉红指数高
    const pinkPans = result.stats.filter((s) => s.baume >= 22);
    expect(pinkPans.some((s) => s.pinkIndex > 0.7)).toBe(true);
    // 盐花指数与粉红指数不会同时占主导（来自互斥像素集）
    for (const s of result.stats) {
      if (s.whiteIndex > 0.6) expect(s.fractions.salt).toBeGreaterThan(0.05);
    }
  }, 200000);
});

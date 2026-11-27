// 端到端验证：合成数据集 -> 完整流水线 -> 断言精度/边界/剔除/耗时。
// 运行：npm test
import { generateDataset, type GeneratorOptions } from '../src/core/dataset';
import { runPipeline } from '../src/core/pipeline';
import { defaultFittedModel, fitCalibration, inferBaume, type FittedModel } from '../src/core/calibration';
import { brineLab } from '../src/core/brine';
import { Rng } from '../src/core/random';
import type { CalibSample, FlightTime, Weather } from '../src/core/types';

interface CaseResult {
  name: string;
  weather: Weather;
  flightTime: FlightTime;
  photoCount: number;
  pondCount: number;
  elapsedMs: number;
  maxAbsErr: number;
  meanAbsErr: number;
  within15: number;
  total: number;
  meanValidFraction: number;
  saltExcluded: boolean;
  mudExcluded: boolean;
  boundaryFit: number;
  anomalies: number;
}

function makeFittedFromSynthetic(): FittedModel {
  // 模拟盐场用波美计实测后录入的标定样本：覆盖 3..27°Bé、多种藻况与天气。
  // 用确定性种子 RNG 产生小幅测量噪声（真实标定会多次采样平均，噪声更小），保证可复现。
  const rng = new Rng(777);
  const samples: CalibSample[] = [];
  let k = 0;
  for (const weather of ['sunny', 'cloudy'] as Weather[]) {
    for (const flight of ['morning', 'noon', 'evening'] as FlightTime[]) {
      for (let b = 3; b <= 27; b += 2) {
        const natural = Math.max(0, (b - 12) / 14);
        for (const algae of [Math.max(0, natural - 0.3), natural, Math.min(1, natural + 0.25)]) {
          const lab = brineLab(b, algae);
          samples.push({
            id: `s${k++}`,
            pondName: `标定-${b}`,
            baume: b,
            lab: [
              lab[0] + rng.gaussian(0, 0.5),
              lab[1] + rng.gaussian(0, 0.5),
              lab[2] + rng.gaussian(0, 0.5),
            ],
            weather,
            flightTime: flight,
            createdAt: Date.now(),
          });
        }
      }
    }
  }
  return fitCalibration(samples);
}

async function runCase(label: string, genOpts: GeneratorOptions): Promise<CaseResult> {
  const ds = generateDataset(genOpts);
  const fitted = makeFittedFromSynthetic();
  const result = await runPipeline(ds.spec, { renderPhoto: ds.renderPhoto }, {
    fitted,
    onProgress: () => {},
  });

  const errors = result.ponds.map((p) => Math.abs(p.baumeEst - (p.baumeTrue ?? NaN)));
  const maxAbsErr = Math.max(...errors);
  const meanAbsErr = errors.reduce((a, b) => a + b, 0) / errors.length;
  const within15 = errors.filter((e) => e <= 1.5).length;

  // 盐花/泥斑排除验证：结晶池盐花占比应被识别且有效像素均值颜色接近卤水而非白色
  const crystallizers = result.ponds.filter((p) => p.zone === 'crystallizer');
  const saltExcluded = crystallizers.every((p) => {
    if (p.saltFraction < 0.01) return true;
    // 平均颜色明度必须显著低于盐花白（L*<80），说明白色没混进均值
    return p.meanLab[0] < 78;
  });
  const mudExcluded = result.ponds.every((p) => p.meanLab[0] > 30);

  // 边界贴合：估计多边形与真值多边形顶点最大偏差（大图坐标）
  let maxBoundary = 0;
  for (const r of result.ponds) {
    const truth = ds.spec.ponds.find((p) => p.id === r.pondId)!;
    const mapped = truth.polygon.map(([x, y]) => [
      x - result.mosaic.originX,
      y - result.mosaic.originY,
    ]);
    for (let i = 0; i < mapped.length; i++) {
      maxBoundary = Math.max(
        maxBoundary,
        Math.hypot(mapped[i][0] - r.polygon[i][0], mapped[i][1] - r.polygon[i][1]),
      );
    }
  }

  return {
    name: label,
    weather: ds.spec.weather,
    flightTime: ds.spec.flightTime,
    photoCount: ds.spec.photos.length,
    pondCount: result.ponds.length,
    elapsedMs: Math.round(result.elapsedMs),
    maxAbsErr,
    meanAbsErr,
    within15,
    total: errors.length,
    meanValidFraction: mean(result.ponds.map((p) => p.validFraction)),
    saltExcluded,
    mudExcluded,
    boundaryFit: maxBoundary,
    anomalies: result.ponds.reduce((a, p) => a + p.anomalies.length, 0),
  };
}

function mean(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`❌ 断言失败: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`✅ ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log('=== 盐场无人机卤水浓度估测：端到端验证 ===\n');

  const cases: { label: string; opts: GeneratorOptions }[] = [
    { label: '晴天-早晨', opts: { seed: 101, weather: 'sunny', flightTime: 'morning', gridCols: 8, gridRows: 6 } },
    { label: '晴天-中午', opts: { seed: 102, weather: 'sunny', flightTime: 'noon', gridCols: 8, gridRows: 6 } },
    { label: '晴天-傍晚', opts: { seed: 103, weather: 'sunny', flightTime: 'evening', gridCols: 8, gridRows: 6 } },
    { label: '阴天-早晨', opts: { seed: 104, weather: 'cloudy', flightTime: 'morning', gridCols: 8, gridRows: 6 } },
    { label: '阴天-傍晚', opts: { seed: 105, weather: 'cloudy', flightTime: 'evening', gridCols: 8, gridRows: 6 } },
    { label: '渗漏异常池', opts: { seed: 106, weather: 'sunny', flightTime: 'morning', gridCols: 8, gridRows: 6, anomalyDilute: 7 } },
  ];

  const results: CaseResult[] = [];
  for (const c of cases) {
    const r = await runCase(c.label, c.opts);
    results.push(r);
  }

  console.log('\n--- 各场景结果 ---');
  console.table(
    results.map((r) => ({
      场景: r.name,
      照片: r.photoCount,
      池子: r.pondCount,
      耗时ms: r.elapsedMs,
      最大误差: r.maxAbsErr.toFixed(2),
      平均误差: r.meanAbsErr.toFixed(2),
      '≤1.5°占比': `${r.within15}/${r.total}`,
      有效像素: (r.meanValidFraction * 100).toFixed(1) + '%',
      边界偏差px: r.boundaryFit.toFixed(1),
      异常标记: r.anomalies,
    })),
  );

  // ---- 硬性断言 ----
  console.log('\n--- 硬性断言 ---');
  for (const r of results) {
    assert(r.maxAbsErr <= 1.5, `[${r.name}] 所有池子波美度误差 ≤1.5°（实际最大 ${r.maxAbsErr.toFixed(2)}）`);
    assert(r.within15 === r.total, `[${r.name}] ${r.within15}/${r.total} 池子达标`);
    assert(r.saltExcluded, `[${r.name}] 白色盐花未混入池水颜色（结晶池均值 L*<78）`);
    assert(r.mudExcluded, `[${r.name}] 池底泥斑未混入池水颜色`);
    assert(r.boundaryFit <= 1.0, `[${r.name}] 池子边界与土埂内沿贴合（偏差 ${r.boundaryFit.toFixed(1)}px）`);
    assert(r.meanValidFraction > 0.7, `[${r.name}] 有效卤水像素占比 >70%（${(r.meanValidFraction * 100).toFixed(1)}%）`);
  }

  const anomalyCase = results.find((r) => r.name === '渗漏异常池');
  assert((anomalyCase?.anomalies ?? 0) >= 1, '变淡池子被标记为异常（渗漏/雨水）');

  // 默认模型自检（无现场标定时也可用）
  const def = defaultFittedModel();
  let defMax = 0;
  for (let b = 4; b <= 26; b += 2) {
    for (const algae of [0, 0.5, 1]) {
      const lab = brineLab(b, algae);
      const est = inferBaume(def.model.anchors, lab, def.lFit, def.blend);
      defMax = Math.max(defMax, Math.abs(est - b));
    }
  }
  assert(defMax <= 1.0, `内置默认标定模型全藻况反演误差 ≤1.0°（实际 ${defMax.toFixed(2)}）`);

  console.log(`\n最大单场景耗时: ${Math.max(...results.map((r) => r.elapsedMs))} ms（小数据集功能验证）`);
  console.log('\n完成。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

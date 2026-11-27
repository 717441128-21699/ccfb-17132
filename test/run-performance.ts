// 性能验证：500 张照片端到端出浓度图，断言总耗时 <= 60s，并复核精度不退化。
import { generateDataset } from '../src/core/dataset';
import { runPipeline } from '../src/core/pipeline';
import { defaultFittedModel } from '../src/core/calibration';

async function main(): Promise<void> {
  const COLS = 25;
  const ROWS = 20;
  const N = COLS * ROWS;
  console.log(`=== 性能验证：${N} 张照片（${COLS}×${ROWS}）端到端 ===`);
  const ds = generateDataset({
    seed: 909,
    weather: 'sunny',
    flightTime: 'morning',
    gridCols: COLS,
    gridRows: ROWS,
  });
  console.log(`世界画布 ${ds.spec.worldWidth}×${ds.spec.worldHeight}，池子 ${ds.spec.ponds.length} 个`);

  const stages: Record<string, number> = {};
  const t0 = Date.now();
  const result = await runPipeline(ds.spec, { renderPhoto: ds.renderPhoto }, {
    fitted: defaultFittedModel(),
    onProgress: (stage, frac, detail) => {
      if (frac >= 1) stages[stage] = Date.now();
      if (stage === 'done') return;
      if (Math.round(frac * 100) % 25 === 0 && detail) {
        // 仅在终端显示稀疏进度
      }
    },
  });
  const wall = Date.now() - t0;

  const errors = result.ponds.map((p) => Math.abs(p.baumeEst - (p.baumeTrue ?? NaN)));
  const maxErr = Math.max(...errors);
  const meanErr = errors.reduce((a, b) => a + b, 0) / errors.length;
  const within = errors.filter((e) => e <= 1.5).length;

  console.log('\n--- 结果 ---');
  console.log(`照片数:        ${N}`);
  console.log(`总耗时:        ${wall} ms （${(wall / 1000).toFixed(2)} s）`);
  console.log(`大图尺寸:      ${result.mosaic.width}×${result.mosaic.height}`);
  console.log(`配准链路/剔除: ${result.mosaic.pairCount} 对 / ${result.mosaic.rejectedPairs} 剔除`);
  console.log(`灰板检测:      ${result.colorCorrection.detectedPanels} 块，${result.colorCorrection.samples} 个采样`);
  console.log(`最大 Bé 误差:  ${maxErr.toFixed(2)}°`);
  console.log(`平均 Bé 误差:  ${meanErr.toFixed(2)}°`);
  console.log(`达标池子:      ${within}/${errors.length}`);

  const passTime = wall <= 60000;
  const passAcc = maxErr <= 1.5;
  console.log('\n--- 断言 ---');
  console.log(passTime ? `✅ 500 张出图 <= 60s（实际 ${(wall / 1000).toFixed(1)}s）` : `❌ 超时：${wall}ms`);
  console.log(passAcc ? `✅ 精度仍 <=1.5°（最大 ${maxErr.toFixed(2)}°）` : `❌ 精度退化：${maxErr.toFixed(2)}°`);
  if (!passTime || !passAcc) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

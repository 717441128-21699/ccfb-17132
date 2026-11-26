// 真实 Chrome 下验证 500 张照片端到端出图时间 < 60s 且 60/60 达标
import { chromium } from 'playwright-core';

const BASE = process.env.SMOKE_BASE || 'http://localhost:48231';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text()); });

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.import-page');
  await page.locator('.chip', { hasText: '500' }).first().click();

  let t0 = Date.now();
  await page.getByRole('button', { name: /合成带浓度真值/ }).click();
  await page.waitForSelector('.next-row .btn', { timeout: 180000 });
  console.log('generate 500 photos:', ((Date.now() - t0) / 1000).toFixed(1), 's');

  t0 = Date.now();
  await page.locator('.next-row .btn').click();
  await page.waitForFunction(() => document.body.innerText.includes('拼接耗时'), null, { timeout: 180000 });
  const stitchWall = Date.now() - t0;
  const stitchCard = await page.locator('.stat-card', { hasText: '拼接耗时' }).locator('.stat-value').innerText();
  console.log('stitch wall:', (stitchWall / 1000).toFixed(1), 's; card:', stitchCard);

  await page.locator('.tab', { hasText: '池子浓度图' }).click();
  t0 = Date.now();
  await page.getByRole('button', { name: /计算浓度图/ }).click();
  await page.waitForFunction(() => /60\/60/.test(document.body.innerText), null, { timeout: 180000 });
  const analyzeWall = Date.now() - t0;
  console.log('analysis wall:', (analyzeWall / 1000).toFixed(1), 's');

  const totalCard = await page.locator('.stat-card', { hasText: '出图总耗时' }).locator('.stat-value').innerText();
  const maxErr = await page.locator('.stat-card', { hasText: '最大绝对误差' }).locator('.stat-value').innerText();
  console.log('total card:', totalCard, '| max err:', maxErr);
  console.log('WALL stitch+analysis:', ((stitchWall + analyzeWall) / 1000).toFixed(1), 's (budget 60s)');

  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'smoke-shots/500-map.png' });

  if (stitchWall + analyzeWall > 60000) {
    console.error('PERF FAIL: pipeline exceeded 60s');
    process.exitCode = 1;
  } else {
    console.log('PERF OK');
  }
  if (errors.length) {
    console.error('BROWSER ERRORS:', errors.slice(0, 5).join('\n'));
    process.exitCode = 1;
  }
} catch (e) {
  console.error('PERF SCRIPT FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}

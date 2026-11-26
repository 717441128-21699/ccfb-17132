// 真实浏览器冒烟：启动 vite preview，用本机 Chrome 走通 合成->拼接->浓度图->标定
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PORT = 4399;
const BASE = process.env.SMOKE_BASE || `http://localhost:${PORT}`;
const EXTERNAL = Boolean(process.env.SMOKE_BASE);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
mkdirSync(path.join(root, 'smoke-shots'), { recursive: true });

function startServer() {
  const srv = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
  });
  return srv;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('preview server did not start');
}

let srv = null;
if (!EXTERNAL) {
  srv = startServer();
  await waitServer();
}
const errors = [];
try {
  await waitServer();
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 980 } });
  page.on('console', (m) => {
    if (m.type() === 'error') {
      const t = m.text();
      if (!/favicon|Download the React DevTools/i.test(t)) errors.push('console.error: ' + t);
    }
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('.import-page', { timeout: 15000 });
  console.log('✓ import page rendered');

  // 选 48 张快速冒烟
  await page.locator('.chip', { hasText: '48 张' }).first().click();
  await page.getByRole('button', { name: /合成带浓度真值/ }).click();
  await page.waitForSelector('.next-row .btn', { timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('.thumb').length > 0, { timeout: 30000 });
  console.log('✓ dataset generated, thumbnails:', await page.locator('.thumb').count());
  await page.screenshot({ path: 'smoke-shots/1-import.png', fullPage: false });

  // 下一步自动拼接
  await page.locator('.next-row .btn').click();
  await page.waitForSelector('.stitch-page.active', { timeout: 10000 }).catch(() => {});
  await page.waitForFunction(() => document.body.innerText.includes('拼接耗时'), null, { timeout: 120000 });
  console.log('✓ stitch finished');
  await sleep(800);
  await page.screenshot({ path: 'smoke-shots/2-stitch.png' });

  // 浓度图页
  await page.locator('.tab', { hasText: '池子浓度图' }).click();
  await page.getByRole('button', { name: /计算浓度图/ }).click();
  await page.waitForFunction(() => document.body.innerText.includes('对当天实测'), null, { timeout: 120000 });
  await page.waitForFunction(() => /60\/60/.test(document.body.innerText), null, { timeout: 30000 });
  console.log('✓ analysis shows 60/60 within tolerance');
  await sleep(1000);
  await page.screenshot({ path: 'smoke-shots/3-map.png' });

  // 点第一行池子，确认详情
  await page.locator('.pan-table tbody tr').first().click();
  await sleep(300);
  const detail = await page.locator('.detail-baume').first().innerText().catch(() => '');
  console.log('✓ pan detail baume:', detail.replace(/\s+/g, ' ').trim());

  // 标定页
  await page.locator('.tab', { hasText: '标定管理' }).click();
  await page.waitForSelector('.calib-page.active', { timeout: 10000 }).catch(() => {});
  await sleep(600);
  const rows = await page.locator('.calib-table tbody tr').count();
  console.log('✓ calibration rows:', rows);
  await page.screenshot({ path: 'smoke-shots/4-calib.png' });

  await browser.close();

  if (errors.length) {
    console.error('BROWSER ERRORS:\n' + errors.slice(0, 12).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('SMOKE OK: no console/page errors');
  }
} catch (e) {
  console.error('SMOKE FAILED:', e);
  try {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const p = await browser.newPage();
    await p.goto(BASE).catch(() => {});
    await p.screenshot({ path: 'smoke-shots/error.png' }).catch(() => {});
    await browser.close();
  } catch {}
  process.exitCode = 1;
} finally {
  srv?.kill();
  setTimeout(() => process.exit(process.exitCode ?? 0), 300);
}

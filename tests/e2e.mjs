import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createSystem } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) {
  console.error('未找到 Chrome/Edge。设置 CHROME_PATH 后重试。');
  process.exit(1);
}

const silentLogger = { info() {}, warn() {}, error() {} };
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'eye-of-god-e2e-'));
const artifactsDir = path.resolve('tests/artifacts');
fs.mkdirSync(artifactsDir, { recursive: true });
const config = {
  ...loadConfig(),
  host: '127.0.0.1',
  httpsPort: 0,
  httpPort: 0,
  dataDir: path.join(tempRoot, 'data'),
  certDir: path.join(tempRoot, 'certs'),
  quiet: true,
};
let system;
let browser;

const checks = [];
function ok(name) {
  checks.push(name);
  console.log(`  ✓ ${name}`);
}

try {
  system = await createSystem(config, { logger: silentLogger });
  await system.start();
  const info = system.getInfo();
  const origin = `https://127.0.0.1:${info.httpsPort}`;

  browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      '--ignore-certificate-errors',
    ],
  });

  const errors = [];
  const adminContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const admin = await adminContext.newPage();
  admin.on('pageerror', (error) => errors.push(`admin pageerror: ${error.message}`));
  admin.on('console', (message) => {
    if (message.type() === 'error') errors.push(`admin console: ${message.text()}`);
  });

  await admin.goto(`${origin}/login`, { waitUntil: 'networkidle' });
  await admin.locator('#setup-form').waitFor({ state: 'visible' });
  await admin.screenshot({ path: path.join(artifactsDir, '01-first-run.png'), fullPage: true });
  ok('首次启动进入初始化模式');

  await admin.locator('#setup-code').fill(system.getSetupCode());
  await admin.locator('#new-password').fill('correct-horse-battery');
  await admin.locator('#confirm-password').fill('correct-horse-battery');
  await admin.locator('#setup-submit').click();
  await admin.waitForURL('**/app');
  await admin.locator('#wall-empty').waitFor({ state: 'visible' });
  ok('管理员初始化并进入监控墙');

  await admin.locator('#add-camera').click();
  await admin.locator('#camera-name').fill('E2E 测试机位');
  await admin.locator('#camera-location').fill('自动化测试');
  await admin.locator('#add-camera-submit').click();
  await admin.locator('#modal-pairing.is-open').waitFor();
  const code = (await admin.locator('#pairing-code').innerText()).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  const captureHref = await admin.locator('#pairing-capture-link').getAttribute('href');
  assert.ok(captureHref.includes('#c='));
  await admin.screenshot({ path: path.join(artifactsDir, '02-pairing.png') });
  ok('创建摄像机并生成一次性接入码与二维码');

  const localCapture = new URL(captureHref);
  localCapture.hostname = '127.0.0.1';
  localCapture.port = String(info.httpsPort);

  const phoneContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  await phoneContext.grantPermissions(['camera'], { origin });
  const phone = await phoneContext.newPage();
  phone.on('pageerror', (error) => errors.push(`camera pageerror: ${error.message}`));
  phone.on('console', (message) => {
    if (message.type() === 'error') errors.push(`camera console: ${message.text()}`);
  });

  await phone.goto(localCapture.toString(), { waitUntil: 'networkidle' });
  await phone.locator('#camera-view').waitFor({ state: 'visible' });
  assert.equal(await phone.locator('#pairing-view').isVisible(), false);
  await phone.screenshot({ path: path.join(artifactsDir, '03-camera-idle.png'), fullPage: false });
  ok('二维码自动填充接入码，手机端完成绑定');

  await phone.locator('#start-button').click();
  await phone.locator('#live-indicator').waitFor({ state: 'visible', timeout: 5000 });
  await phone.waitForTimeout(1800);
  const captureStats = {
    fps: await phone.locator('#stat-fps').innerText(),
    resolution: await phone.locator('#stat-resolution').innerText(),
    bitrate: await phone.locator('#stat-bitrate').innerText(),
  };
  assert.notEqual(captureStats.fps, '0.0 fps');
  assert.match(captureStats.resolution, /^\d+×\d+$/);
  await phone.screenshot({ path: path.join(artifactsDir, '04-camera-live.png'), fullPage: false });
  ok(`手机端开始直播（${captureStats.fps} · ${captureStats.resolution} · ${captureStats.bitrate}）`);

  await admin.locator('.cam-tile').first().waitFor({ state: 'visible' });
  await admin.locator('.cam-state.live').first().waitFor({ state: 'visible', timeout: 5000 });
  await admin.waitForTimeout(1200);
  const pixel = await admin.evaluate(() => {
    const canvas = document.querySelector('.cam-canvas');
    const context = canvas.getContext('2d');
    const data = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return [...data];
  });
  assert.ok(pixel[3] === 255 && (pixel[0] + pixel[1] + pixel[2] > 30), '监控画面应有可见像素');
  await admin.locator('#modal-pairing [data-close="modal-pairing"]').last().click();
  await admin.locator('#modal-pairing').waitFor({ state: 'hidden' });
  await admin.waitForTimeout(300);
  await admin.screenshot({ path: path.join(artifactsDir, '05-dashboard-live.png'), fullPage: false });
  ok('管理端监控墙收到实时视频帧');

  await admin.locator('.cam-tile').first().click();
  await admin.locator('#modal-player.is-open').waitFor();
  await admin.waitForTimeout(600);
  await admin.screenshot({ path: path.join(artifactsDir, '06-player.png') });
  ok('播放器放大显示画面');

  await admin.locator('#player-stop').click();
  await admin.locator('#modal-confirm.is-open').waitFor();
  await admin.locator('#confirm-action').click();
  await phone.locator('#live-indicator').waitFor({ state: 'hidden', timeout: 5000 });
  assert.match(await phone.locator('#start-button .start-label').innerText(), /开始直播/);
  ok('管理员停止直播后，手机摄像头立即停止');

  await phone.locator('#unbind-button').click();
  await phone.locator('#modal-unbind.is-open').waitFor();
  await phone.locator('#confirm-unbind').click();
  await phone.locator('#pairing-view').waitFor({ state: 'visible' });
  ok('手机端解除绑定并回到接入页');

  if (errors.length) {
    console.error('\n浏览器错误：');
    for (const error of errors) console.error(`  - ${error}`);
    throw new Error('浏览器运行期间出现错误');
  }

  console.log(`\n端到端测试通过，共 ${checks.length} 项检查。`);
  console.log(`截图目录：${artifactsDir}`);
} finally {
  await browser?.close().catch(() => {});
  await system?.stop().catch(() => {});
  await fsp.rm(tempRoot, { recursive: true, force: true });
}

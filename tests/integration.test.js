import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createSystem } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { isPrivateAddress } from '../server/net.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const jpeg = fs.readFileSync(new URL('./fixtures/frame.jpg', import.meta.url));

let system;
let base;
let httpBase;
let setupCode;
let adminCookie = '';
let cameraCookie = '';
let cameraId = '';
let tempRoot = '';

function request(method, requestPath, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const url = new URL(requestPath, base);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* non-json */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpGet(requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${httpBase}${requestPath}`, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

function cookiePair(setCookie) {
  if (!setCookie) return '';
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return first.split(';')[0];
}

function openSocket(pathname, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${new URL(base).port}${pathname}`, {
      rejectUnauthorized: false,
      headers: { Cookie: cookie, Origin: base },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WebSocket open timeout'));
    }, 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextBinary(ws) {
  return new Promise((resolve) => {
    const handler = (data, isBinary) => {
      if (!isBinary) return;
      ws.off('message', handler);
      resolve(Buffer.from(data));
    };
    ws.on('message', handler);
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return false;
}

before(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'eye-of-god-test-'));
  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    host: '127.0.0.1',
    httpsPort: 0,
    httpPort: 0,
    dataDir: path.join(tempRoot, 'data'),
    certDir: path.join(tempRoot, 'certs'),
    quiet: true,
  };
  system = await createSystem(config, { logger: silentLogger });
  await system.start();
  const info = system.getInfo();
  base = `https://127.0.0.1:${info.httpsPort}`;
  httpBase = `http://127.0.0.1:${info.httpPort}`;
  setupCode = system.getSetupCode();
});

after(async () => {
  await system?.stop();
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

test('rejects public and malformed hosts', async () => {
  assert.equal(isPrivateAddress('192.168.1.4'), true);
  assert.equal(isPrivateAddress('10.0.0.8'), true);
  assert.equal(isPrivateAddress('100.101.2.3'), true);
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('172.32.0.1'), false);

  const response = await request('GET', '/api/bootstrap', { headers: { Host: 'evil.example' } });
  assert.equal(response.status, 421);
});

test('serves first-run state and the certificate trust page', async () => {
  const bootstrap = await request('GET', '/api/bootstrap');
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.setupRequired, true);
  assert.equal(bootstrap.json.secure, true);

  const loginPage = await request('GET', '/login');
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /初始化/);

  const appPage = await request('GET', '/app');
  assert.equal(appPage.status, 302);
  assert.equal(appPage.headers.location, '/login');

  const trustPage = await httpGet('/trust');
  assert.equal(trustPage.status, 200);
  assert.match(trustPage.body.toString(), /安装 iOS 描述文件/);
  assert.doesNotMatch(trustPage.body.toString(), /\{\{[A-Z_]+\}\}/);

  const profile = await httpGet('/trust/eye-of-god.mobileconfig');
  assert.equal(profile.status, 200);
  assert.match(profile.headers['content-type'], /application\/x-apple-aspen-config/);
  assert.match(profile.body.toString(), /com\.apple\.security\.root/);

  const cert = await httpGet('/trust/eye-of-god-ca.crt');
  assert.equal(cert.status, 200);
  assert.match(cert.body.toString(), /BEGIN CERTIFICATE/);
});

test('rejects a bad setup code, then initializes the administrator', async () => {
  const wrong = await request('POST', '/api/setup', {
    body: { setupCode: 'WRONG1', password: 'correct-horse-battery' },
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.code, 'INVALID_SETUP_CODE');

  const weak = await request('POST', '/api/setup', {
    body: { setupCode, password: 'short' },
  });
  assert.equal(weak.status, 400);

  const setup = await request('POST', '/api/setup', {
    body: { setupCode, password: 'correct-horse-battery' },
  });
  assert.equal(setup.status, 200);
  adminCookie = cookiePair(setup.headers['set-cookie']);
  assert.match(adminCookie, /^goe_admin=/);

  const again = await request('POST', '/api/setup', {
    body: { setupCode, password: 'another-long-password' },
  });
  assert.equal(again.status, 409);
});

test('requires the admin session for management APIs', async () => {
  const anonymous = await request('GET', '/api/cameras');
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.json.code, 'AUTH_REQUIRED');

  const wrongPassword = await request('POST', '/api/login', { body: { password: 'nope-nope-nope' } });
  assert.equal(wrongPassword.status, 401);

  const login = await request('POST', '/api/login', { body: { password: 'correct-horse-battery' } });
  assert.equal(login.status, 200);
  adminCookie = cookiePair(login.headers['set-cookie']);
  const me = await request('GET', '/api/me', { cookie: adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.role, 'admin');
});

test('creates a camera and pairs one device with a one-time code', async () => {
  const created = await request('POST', '/api/cameras', {
    cookie: adminCookie,
    body: { name: '测试摄像机', location: '测试台' },
  });
  assert.equal(created.status, 201);
  cameraId = created.json.camera.id;
  assert.match(cameraId, /^[a-f0-9]{12}$/);
  assert.equal(created.json.camera.paired, false);
  assert.match(created.json.pairing.code, /^[A-Z2-9]{6}$/);
  assert.match(created.json.pairing.qrDataUrl, /^data:image\/png;base64,/);
  assert.match(created.json.pairing.captureUrl, /\/capture#c=/);

  const pair = await request('POST', '/api/camera/pair', {
    body: { code: created.json.pairing.code },
  });
  assert.equal(pair.status, 200);
  cameraCookie = cookiePair(pair.headers['set-cookie']);
  assert.match(cameraCookie, /^goe_camera=/);

  const reuse = await request('POST', '/api/camera/pair', {
    body: { code: created.json.pairing.code },
  });
  assert.equal(reuse.status, 401);

  const cameraMe = await request('GET', '/api/camera/me', { cookie: cameraCookie });
  assert.equal(cameraMe.status, 200);
  assert.equal(cameraMe.json.camera.id, cameraId);
});

test('relays a camera frame to the admin and serves a snapshot', async () => {
  const adminWs = await openSocket('/ws/admin', adminCookie);
  const cameraWs = await openSocket('/ws/camera', cameraCookie);

  const framePromise = nextBinary(adminWs);
  cameraWs.send(jpeg);
  const frame = await framePromise;
  assert.equal(frame.subarray(0, 12).toString('ascii'), cameraId);
  assert.deepEqual(frame.subarray(12), jpeg);

  const cameraInfo = await request('GET', '/api/cameras', { cookie: adminCookie });
  const camera = cameraInfo.json.cameras.find((item) => item.id === cameraId);
  assert.equal(camera.online, true);
  assert.equal(camera.streaming, true);
  assert.equal(camera.width, 960);
  assert.equal(camera.height, 540);

  const snapshot = await request('GET', `/api/cameras/${cameraId}/latest.jpg`, { cookie: adminCookie });
  assert.equal(snapshot.status, 200);
  assert.match(snapshot.headers['content-type'], /image\/jpeg/);

  await new Promise((resolve) => {
    cameraWs.once('close', resolve);
    cameraWs.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const after = await request('GET', '/api/cameras', { cookie: adminCookie });
  const offline = after.json.cameras.find((item) => item.id === cameraId);
  assert.equal(offline.online, false);
  assert.equal(offline.streaming, false);

  const retained = await request('GET', `/api/cameras/${cameraId}/latest.jpg`, { cookie: adminCookie });
  assert.equal(retained.status, 200);

  adminWs.close();
});

test('blocks path traversal and protects the camera cookie', async () => {
  const traversal = await request('GET', '/assets/%2e%2e/server/app.js');
  assert.equal(traversal.status, 404);

  const badSession = await request('GET', '/api/camera/me', { cookie: 'goe_camera=not-valid' });
  assert.equal(badSession.status, 401);
  assert.equal(badSession.json.code, 'CAMERA_SESSION_INVALID');

  const unauthorisedSnapshot = await request('GET', `/api/cameras/${cameraId}/latest.jpg`);
  assert.equal(unauthorisedSnapshot.status, 401);
});

test('unbinding invalidates the old camera token and clears the retained frame', async () => {
  const forget = await request('POST', '/api/camera/forget', { cookie: cameraCookie });
  assert.equal(forget.status, 200);

  const invalid = await request('GET', '/api/camera/me', { cookie: cameraCookie });
  assert.equal(invalid.status, 401);

  const snapshot = await request('GET', `/api/cameras/${cameraId}/latest.jpg`, { cookie: adminCookie });
  assert.equal(snapshot.status, 404);
});

test('relays two camera streams to one admin simultaneously', async () => {
  const createdA = await request('POST', '/api/cameras', {
    cookie: adminCookie,
    body: { name: '多路 A', location: '左侧' },
  });
  const createdB = await request('POST', '/api/cameras', {
    cookie: adminCookie,
    body: { name: '多路 B', location: '右侧' },
  });
  assert.equal(createdA.status, 201);
  assert.equal(createdB.status, 201);

  const pairA = await request('POST', '/api/camera/pair', { body: { code: createdA.json.pairing.code } });
  const pairB = await request('POST', '/api/camera/pair', { body: { code: createdB.json.pairing.code } });
  const cookieA = cookiePair(pairA.headers['set-cookie']);
  const cookieB = cookiePair(pairB.headers['set-cookie']);

  const adminWs = await openSocket('/ws/admin', adminCookie);
  const cameraA = await openSocket('/ws/camera', cookieA);
  const cameraB = await openSocket('/ws/camera', cookieB);

  const seen = new Set();
  const both = new Promise((resolve) => {
    adminWs.on('message', (data, isBinary) => {
      if (!isBinary) return;
      seen.add(Buffer.from(data).subarray(0, 12).toString('ascii'));
      if (seen.size === 2) resolve();
    });
  });
  cameraA.send(jpeg);
  cameraB.send(jpeg);
  await both;
  assert.deepEqual([...seen].sort(), [createdA.json.camera.id, createdB.json.camera.id].sort());

  cameraA.close();
  cameraB.close();
  adminWs.close();
});

test('logout invalidates the admin session and realtime socket', async () => {
  const ws = await openSocket('/ws/admin', adminCookie);
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  const logout = await request('POST', '/api/logout', { cookie: adminCookie });
  assert.equal(logout.status, 200);
  const code = await closed;
  assert.equal(code, 4401);

  const me = await request('GET', '/api/me', { cookie: adminCookie });
  assert.equal(me.status, 401);
});

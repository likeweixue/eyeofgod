import fsp from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import os from 'node:os';
import QRCode from 'qrcode';
import { Store } from './store.js';
import { CertManager } from './certs.js';
import { RealtimeHub } from './realtime.js';
import { createTrustServer } from './trust.js';
import {
  cleanText,
  clientIp,
  hashPassword,
  parseCookies,
  passwordProblem,
  randomCode,
  RateLimiter,
  safeEqual,
  serializeCookie,
  SessionStore,
  shortUserAgent,
  signToken,
  verifyPassword,
  verifyToken,
} from './security.js';
import {
  getLanAddresses,
  isAllowedHost,
  isRequestAllowed,
  primaryLanAddress,
  urlsFor,
} from './net.js';

const ADMIN_COOKIE = 'goe_admin';
const CAMERA_COOKIE = 'goe_camera';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message, code = 'ERROR', headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

function setSecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; manifest-src 'self'",
  );
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, data, headers = {}) {
  const buffer = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(buffer);
}

function sendError(res, error) {
  const status = error.status || 500;
  const payload = {
    error: error.message || '服务器内部错误',
    code: error.code || 'ERROR',
  };
  if (status === 500) payload.error = '服务器内部错误';
  sendJson(res, status, payload, error.headers || {});
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '');
    if (!type.toLowerCase().includes('application/json')) {
      reject(new HttpError(415, '请求格式必须为 JSON', 'INVALID_CONTENT_TYPE'));
      return;
    }
    const contentLength = Number(req.headers['content-length'] || 0);
    if (contentLength > limit) {
      reject(new HttpError(413, '请求内容过大', 'BODY_TOO_LARGE'));
      req.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求内容过大', 'BODY_TOO_LARGE'));
        return;
      }
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, '请求内容格式不正确', 'INVALID_BODY'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, '请求内容不是有效 JSON', 'INVALID_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function validatePairCodeInput(value) {
  if (typeof value !== 'string') return '';
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== `https://${req.headers.host}`) {
    throw new HttpError(403, '请求来源不正确', 'ORIGIN_MISMATCH');
  }
}

function formatTime(date = new Date()) {
  return date.toLocaleString('zh-CN', { hour12: false });
}

export async function createSystem(config, { logger = console } = {}) {
  const store = new Store(config.dataDir, logger);
  const certs = new CertManager(config.certDir, logger).ensure();
  const sessions = new SessionStore(config.sessionHours);
  const limiter = new RateLimiter();

  let setupCode = store.data.admin ? null : randomCode(6);
  let setupInProgress = false;
  let server = null;
  let trustServer = null;
  let hub = null;
  let startedAt = null;
  let stopping = false;

  const pairCodes = new Map();

  function networkInfo() {
    const httpsAddress = server?.address();
    const httpAddress = trustServer?.address();
    const httpsPort = typeof httpsAddress === 'object' && httpsAddress ? httpsAddress.port : config.httpsPort;
    const httpPort = typeof httpAddress === 'object' && httpAddress ? httpAddress.port : config.httpPort;
    const primaryIp = primaryLanAddress();
    const lanAddresses = getLanAddresses().map((item) => ({
      ...item,
      urls: urlsFor(httpsPort, httpPort, item.address),
    }));
    return {
      appName: config.appName,
      version: config.version,
      httpsPort,
      httpPort,
      primaryIp,
      hostname: os.hostname(),
      urls: urlsFor(httpsPort, httpPort, primaryIp),
      lanAddresses,
      caFingerprint: certs.caFingerprint,
      allowRemote: config.allowRemote,
      startedAt,
    };
  }

  function appendEvent(type, message, meta = {}) {
    const event = store.appendEvent(type, message, meta);
    try {
      hub?.notifyEvent(event);
    } catch {
      /* realtime notification is best effort */
    }
    return event;
  }

  function verifyDeviceToken(token) {
    const payload = verifyToken(token, store.secrets.deviceSecret);
    if (!payload || payload.role !== 'camera' || typeof payload.cid !== 'string') return null;
    const camera = store.camera(payload.cid);
    if (!camera) return null;
    if (camera.pairVersion !== payload.ver) return null;
    return camera;
  }

  function deviceSession(req) {
    const token = parseCookies(req.headers.cookie)[CAMERA_COOKIE];
    const payload = verifyToken(token, store.secrets.deviceSecret);
    if (!payload || payload.role !== 'camera' || typeof payload.cid !== 'string') return null;
    const camera = store.camera(payload.cid);
    if (!camera || camera.pairVersion !== payload.ver) return null;
    return { camera, payload, token };
  }

  function adminSession(req) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    const session = sessions.get(token);
    if (!session) return null;
    return { session, token };
  }

  function requireAdmin(req) {
    const admin = adminSession(req);
    if (!admin) throw new HttpError(401, '登录状态已失效，请重新登录', 'AUTH_REQUIRED');
    return admin;
  }

  function setAdminCookie(res) {
    const token = sessions.create();
    res.setHeader(
      'Set-Cookie',
      serializeCookie(ADMIN_COOKIE, token, {
        maxAge: config.sessionHours * 3600,
        secure: true,
        sameSite: 'Lax',
      }),
    );
    return token;
  }

  function clearCookie(res, name) {
    res.setHeader(
      'Set-Cookie',
      serializeCookie(name, '', {
        maxAge: 0,
        expires: new Date(0),
        secure: true,
        sameSite: 'Lax',
      }),
    );
  }

  function setCameraCookie(res, camera) {
    const exp = Math.floor(Date.now() / 1000) + config.deviceDays * 86400;
    const token = signToken(
      { role: 'camera', cid: camera.id, ver: camera.pairVersion, exp },
      store.secrets.deviceSecret,
    );
    res.setHeader(
      'Set-Cookie',
      serializeCookie(CAMERA_COOKIE, token, {
        maxAge: config.deviceDays * 86400,
        secure: true,
        sameSite: 'Lax',
      }),
    );
    return token;
  }

  function cleanupPairCodes() {
    const now = Date.now();
    for (const [code, entry] of pairCodes) {
      if (entry.expiresAt <= now) pairCodes.delete(code);
    }
  }

  function issuePairCode(cameraId) {
    cleanupPairCodes();
    for (const [code, entry] of pairCodes) {
      if (entry.cameraId === cameraId) pairCodes.delete(code);
    }
    let code;
    do {
      code = randomCode(6);
    } while (pairCodes.has(code));
    const expiresAt = Date.now() + config.pairMinutes * 60 * 1000;
    pairCodes.set(code, { cameraId, expiresAt });
    return { code, expiresAt };
  }

  function consumePairCode(code) {
    cleanupPairCodes();
    const entry = pairCodes.get(code);
    if (!entry) return null;
    const camera = store.camera(entry.cameraId);
    if (!camera) {
      pairCodes.delete(code);
      return null;
    }
    return { camera, entry };
  }

  async function makeQr(text) {
    return QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#16130b', light: '#f5eddb' },
    });
  }

  async function buildPairing(camera) {
    const { code, expiresAt } = issuePairCode(camera.id);
    const info = networkInfo();
    const captureUrl = `${info.urls.capture}#c=${code}`;
    const [qrDataUrl, trustQrDataUrl] = await Promise.all([
      makeQr(captureUrl),
      makeQr(info.urls.trust),
    ]);
    return {
      code,
      expiresAt: new Date(expiresAt).toISOString(),
      captureUrl,
      trustUrl: info.urls.trust,
      qrDataUrl,
      trustQrDataUrl,
      primaryIp: info.primaryIp,
      warning: info.primaryIp ? null : '未检测到局域网 IP，请确认 Mac 已连接 Wi-Fi 或有线网络。',
    };
  }

  function cameraStats() {
    const cameras = hub.listCameras();
    return {
      total: cameras.length,
      online: cameras.filter((camera) => camera.online).length,
      streaming: cameras.filter((camera) => camera.streaming).length,
      paired: cameras.filter((camera) => camera.paired).length,
    };
  }

  async function servePage(res, filename) {
    const filePath = path.join(config.publicDir, filename);
    const body = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function serveAsset(res, pathname) {
    if (!pathname.startsWith('/assets/') && !pathname.startsWith('/js/') && pathname !== '/favicon.svg' && pathname !== '/manifest.webmanifest') {
      return false;
    }
    const relative = pathname.replace(/^\/+/, '');
    const filePath = path.resolve(config.publicDir, relative);
    const root = path.resolve(config.publicDir) + path.sep;
    if (!filePath.startsWith(root)) return false;
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const body = await fsp.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
    return true;
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method;
    if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
      throw new HttpError(405, '不支持的请求方法', 'METHOD_NOT_ALLOWED', { Allow: 'GET, POST, PATCH, DELETE' });
    }
    if (method !== 'GET') assertSameOrigin(req);

    if (method === 'GET' && pathname === '/api/bootstrap') {
      const info = networkInfo();
      sendJson(res, 200, {
        appName: config.appName,
        version: config.version,
        setupRequired: !store.data.admin,
        secure: true,
        primaryIp: info.primaryIp,
        urls: { app: info.urls.app, capture: info.urls.capture, trust: info.urls.trust },
      });
      return;
    }

    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true, app: 'eye-of-god', time: new Date().toISOString() });
      return;
    }

    if (method === 'GET' && pathname === '/api/me') {
      const admin = adminSession(req);
      if (admin) {
        sendJson(res, 200, { role: 'admin', username: store.data.admin?.username || 'admin' });
        return;
      }
      const device = deviceSession(req);
      if (device) {
        sendJson(res, 200, {
          role: 'camera',
          camera: hub.cameraView(device.camera),
          sessionExpiresAt: new Date(device.payload.exp * 1000).toISOString(),
        });
        return;
      }
      throw new HttpError(401, '尚未登录', 'AUTH_REQUIRED');
    }

    if (method === 'POST' && pathname === '/api/setup') {
      const ip = clientIp(req);
      const limit = limiter.consume(`setup:${ip}`, 8, 10 * 60_000);
      if (!limit.allowed) {
        throw new HttpError(429, '尝试次数过多，请稍后再试', 'RATE_LIMITED', { 'Retry-After': limit.retryAfter });
      }
      if (store.data.admin) throw new HttpError(409, '系统已经完成初始化', 'ALREADY_SETUP');
      if (setupInProgress) throw new HttpError(409, '初始化正在进行，请稍候', 'SETUP_IN_PROGRESS');
      const body = await readJsonBody(req);
      const submittedCode = String(body.setupCode || '').trim().toUpperCase();
      if (!setupCode || !safeEqual(submittedCode, setupCode)) {
        throw new HttpError(401, '初始化码不正确，请查看启动终端', 'INVALID_SETUP_CODE');
      }
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');
      setupInProgress = true;
      try {
        const password = await hashPassword(body.password);
        if (store.data.admin) throw new HttpError(409, '系统已经完成初始化', 'ALREADY_SETUP');
        store.data.admin = {
          username: 'admin',
          password,
          createdAt: new Date().toISOString(),
          passwordChangedAt: new Date().toISOString(),
        };
        store.save();
        setupCode = null;
        pairCodes.clear();
        setAdminCookie(res);
        appendEvent('admin.setup', '系统初始化完成，管理员账户已创建');
        limiter.reset(`setup:${ip}`);
        sendJson(res, 200, { ok: true, role: 'admin' });
      } finally {
        setupInProgress = false;
      }
      return;
    }

    if (method === 'POST' && pathname === '/api/login') {
      const ip = clientIp(req);
      const limit = limiter.consume(`login:${ip}`, 10, 5 * 60_000);
      if (!limit.allowed) {
        throw new HttpError(429, '登录尝试过多，请稍后再试', 'RATE_LIMITED', { 'Retry-After': limit.retryAfter });
      }
      if (!store.data.admin) throw new HttpError(409, '系统尚未初始化', 'SETUP_REQUIRED');
      const body = await readJsonBody(req);
      if (!(await verifyPassword(String(body.password || ''), store.data.admin.password))) {
        throw new HttpError(401, '密码不正确', 'INVALID_PASSWORD');
      }
      setAdminCookie(res);
      limiter.reset(`login:${ip}`);
      appendEvent('admin.login', '管理员登录管理端');
      sendJson(res, 200, { ok: true, role: 'admin' });
      return;
    }

    if (method === 'POST' && pathname === '/api/logout') {
      const admin = adminSession(req);
      if (admin) {
        sessions.destroy(admin.token);
        hub?.disconnectAdmin(admin.token, '管理员已退出登录');
      }
      clearCookie(res, ADMIN_COOKIE);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/camera/me') {
      const device = deviceSession(req);
      if (!device) throw new HttpError(401, '摄像机接入已失效', 'CAMERA_SESSION_INVALID');
      sendJson(res, 200, {
        camera: hub.cameraView(device.camera),
        sessionExpiresAt: new Date(device.payload.exp * 1000).toISOString(),
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/camera/pair') {
      const ip = clientIp(req);
      const limit = limiter.consume(`pair:${ip}`, 15, 10 * 60_000);
      if (!limit.allowed) {
        throw new HttpError(429, '接入尝试过多，请稍后再试', 'RATE_LIMITED', { 'Retry-After': limit.retryAfter });
      }
      const body = await readJsonBody(req);
      const code = validatePairCodeInput(body.code);
      if (code.length !== 6) throw new HttpError(400, '请输入 6 位接入码', 'INVALID_PAIR_CODE');
      const found = consumePairCode(code);
      if (!found) throw new HttpError(401, '接入码无效或已过期', 'INVALID_PAIR_CODE');
      const { camera } = found;
      pairCodes.delete(code);

      if (hub.cameraSockets.has(camera.id)) {
        hub.disconnectCamera(camera.id, '摄像机已重新绑定到新设备', 4000);
      }
      camera.pairVersion = Number(camera.pairVersion || 0) + 1;
      hub.dropLatestFrame(camera.id);
      camera.pairedAt = new Date().toISOString();
      camera.lastSeenAt = new Date().toISOString();
      store.save();
      setCameraCookie(res, camera);
      appendEvent('camera.paired', `「${camera.name}」已绑定到${shortUserAgent(req.headers['user-agent'])}`, {
        cameraId: camera.id,
        cameraName: camera.name,
      });
      hub.broadcastStatuses();
      sendJson(res, 200, { ok: true, camera: hub.cameraView(camera) });
      return;
    }

    if (method === 'POST' && pathname === '/api/camera/forget') {
      const device = deviceSession(req);
      if (!device) throw new HttpError(401, '摄像机接入已失效', 'CAMERA_SESSION_INVALID');
      const { camera } = device;
      hub.disconnectCamera(camera.id, '本机已解除绑定', 4000);
      hub.dropLatestFrame(camera.id);
      camera.pairVersion = Number(camera.pairVersion || 0) + 1;
      camera.updatedAt = new Date().toISOString();
      store.save();
      clearCookie(res, CAMERA_COOKIE);
      appendEvent('camera.unpaired', `「${camera.name}」已解除设备绑定`, {
        cameraId: camera.id,
        cameraName: camera.name,
      });
      hub.broadcastStatuses();
      sendJson(res, 200, { ok: true });
      return;
    }

    requireAdmin(req);

    if (method === 'GET' && pathname === '/api/config') {
      const info = networkInfo();
      sendJson(res, 200, {
        appName: config.appName,
        version: config.version,
        server: info,
        admin: { username: store.data.admin.username },
        stats: cameraStats(),
        pairMinutes: config.pairMinutes,
        deviceDays: config.deviceDays,
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/password') {
      const ip = clientIp(req);
      const limit = limiter.consume(`password:${ip}`, 6, 10 * 60_000);
      if (!limit.allowed) {
        throw new HttpError(429, '操作过于频繁，请稍后再试', 'RATE_LIMITED', { 'Retry-After': limit.retryAfter });
      }
      const body = await readJsonBody(req);
      if (!(await verifyPassword(String(body.currentPassword || ''), store.data.admin.password))) {
        throw new HttpError(401, '当前密码不正确', 'INVALID_PASSWORD');
      }
      const problem = passwordProblem(body.newPassword);
      if (problem) throw new HttpError(400, problem, 'WEAK_PASSWORD');
      if (String(body.currentPassword) === String(body.newPassword)) {
        throw new HttpError(400, '新密码不能与当前密码相同', 'SAME_PASSWORD');
      }
      store.data.admin.password = await hashPassword(body.newPassword);
      store.data.admin.passwordChangedAt = new Date().toISOString();
      store.save();
      sessions.clear();
      hub?.closeAllAdmins('管理员密码已更新，请重新连接');
      setAdminCookie(res);
      limiter.reset(`password:${ip}`);
      appendEvent('admin.password', '管理员密码已更新，其他登录会话已失效');
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && pathname === '/api/events') {
      const requested = Number(url.searchParams.get('limit') || 120);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.floor(requested), 1), 300) : 120;
      sendJson(res, 200, { events: store.data.events.slice(0, limit) });
      return;
    }

    if (pathname === '/api/cameras' && method === 'GET') {
      sendJson(res, 200, { cameras: hub.listCameras() });
      return;
    }

    if (pathname === '/api/cameras' && method === 'POST') {
      const body = await readJsonBody(req);
      const name = cleanText(body.name, 40);
      const location = cleanText(body.location, 60);
      if (!name) throw new HttpError(400, '请填写摄像机名称', 'INVALID_NAME');
      if (store.data.cameras.length >= 24) {
        throw new HttpError(400, '最多支持 24 路摄像机', 'CAMERA_LIMIT');
      }
      const camera = store.addCamera({ name, location });
      appendEvent('camera.created', `已创建摄像机「${name}」`, {
        cameraId: camera.id,
        cameraName: camera.name,
      });
      hub.broadcastStatuses();
      const pairing = await buildPairing(camera);
      sendJson(res, 201, { camera: hub.cameraView(camera), pairing });
      return;
    }

    const cameraMatch = pathname.match(/^\/api\/cameras\/([a-f0-9]{12})(?:\/(pair-code|disconnect|latest\.jpg))?$/);
    if (cameraMatch) {
      const [, cameraId, action] = cameraMatch;
      const camera = store.camera(cameraId);
      if (!camera) throw new HttpError(404, '摄像机不存在', 'CAMERA_NOT_FOUND');

      if (!action && method === 'PATCH') {
        const body = await readJsonBody(req);
        if (body.name !== undefined) {
          const name = cleanText(body.name, 40);
          if (!name) throw new HttpError(400, '摄像机名称不能为空', 'INVALID_NAME');
          camera.name = name;
        }
        if (body.location !== undefined) camera.location = cleanText(body.location, 60);
        camera.updatedAt = new Date().toISOString();
        store.save();
        hub.broadcastStatuses();
        sendJson(res, 200, { camera: hub.cameraView(camera) });
        return;
      }

      if (!action && method === 'DELETE') {
        const name = camera.name;
        hub.disconnectCamera(camera.id, '摄像机已被管理员移除');
        hub.dropCameraState(camera.id);
        store.removeCamera(camera.id);
        appendEvent('camera.deleted', `摄像机「${name}」已被移除`, { cameraName: name });
        hub.broadcastStatuses();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === 'pair-code' && method === 'POST') {
        const pairing = await buildPairing(camera);
        sendJson(res, 200, { pairing });
        return;
      }

      if (action === 'disconnect' && method === 'POST') {
        const wasOnline = hub.disconnectCamera(camera.id, '管理员已停止该摄像机的直播');
        appendEvent('camera.disconnected', `管理员停止了「${camera.name}」的直播`, {
          cameraId: camera.id,
          cameraName: camera.name,
        });
        sendJson(res, 200, { ok: true, wasOnline });
        return;
      }

      if (action === 'latest.jpg' && method === 'GET') {
        const jpeg = hub.latestFrame(camera.id);
        if (!jpeg) throw new HttpError(404, '暂无画面', 'NO_FRAME');
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': jpeg.length,
          'Cache-Control': 'no-store',
        });
        res.end(jpeg);
        return;
      }

      throw new HttpError(404, '接口不存在', 'NOT_FOUND');
    }

    throw new HttpError(404, '接口不存在', 'NOT_FOUND');
  }

  async function handleHttps(req, res) {
    setSecurityHeaders(res);
    try {
      if (!isRequestAllowed(req, config.allowRemote)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('仅允许局域网访问。');
        return;
      }
      if (!isAllowedHost(req.headers.host)) {
        res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
        res.end('不被允许的访问地址。');
        return;
      }

      const url = new URL(req.url, 'https://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
        res.end('Method Not Allowed');
        return;
      }

      if (pathname === '/') {
        if (adminSession(req)) return redirect(res, '/app');
        if (deviceSession(req)) return redirect(res, '/capture');
        return redirect(res, '/login');
      }

      if (pathname === '/login') {
        if (adminSession(req)) return redirect(res, '/app');
        if (deviceSession(req)) return redirect(res, '/capture');
        return servePage(res, 'login.html');
      }

      if (pathname === '/app') {
        if (!adminSession(req)) return redirect(res, '/login');
        return servePage(res, 'app.html');
      }

      if (pathname === '/capture') {
        return servePage(res, 'capture.html');
      }

      if (pathname === '/trust') {
        return redirect(res, networkInfo().urls.trust);
      }

      if (await serveAsset(res, pathname)) return;

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="background:#07090a;color:#e9e5dc;font-family:sans-serif;padding:48px"><h1>404</h1><p>页面不存在。</p><a style="color:#d6b56f" href="/">返回上帝之眼</a></body>');
    } catch (error) {
      if (error instanceof HttpError) {
        if (!res.headersSent) sendError(res, error);
        else res.end();
        return;
      }
      logger.error('[http] 请求失败:', error);
      if (!res.headersSent) sendError(res, new HttpError(500, '服务器内部错误'));
      else res.end();
    }
  }

  function attachHub() {
    hub = new RealtimeHub({
      store,
      config,
      sessions,
      verifyDeviceToken,
      onEvent: appendEvent,
      logger,
    });
    hub.attach(server);
  }

  trustServer = createTrustServer({ config, certs, getInfo: networkInfo, logger });

  function getInfo() {
    return networkInfo();
  }

  async function start() {
    if (server) return getInfo();
    server = https.createServer(certs.httpsOptions, handleHttps);
    attachHub();

    const listen = (instance, port) =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          instance.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          instance.off('error', onError);
          resolve();
        };
        instance.once('error', onError);
        instance.once('listening', onListening);
        instance.listen(port, config.host);
      });

    try {
      await listen(server, config.httpsPort);
      await listen(trustServer, config.httpPort);
    } catch (error) {
      try {
        hub?.stop();
        server.close();
        trustServer.close();
      } catch {
        /* ignore */
      }
      server = null;
      throw error;
    }

    startedAt = new Date().toISOString();
    server.on('error', (error) => logger.error('[https] 服务器错误:', error.message));
    trustServer.on('error', (error) => logger.error('[http] 证书服务错误:', error.message));
    server.on('clientError', (error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    return getInfo();
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    hub?.stop();
    sessions.stop();
    limiter.stop();
    store.save();
    const close = (instance) =>
      new Promise((resolve) => {
        if (!instance || !instance.listening) {
          resolve();
          return;
        }
        instance.close(() => resolve());
        instance.closeAllConnections?.();
        setTimeout(resolve, 1500).unref?.();
      });
    await Promise.all([close(server), close(trustServer)]);
    server = null;
    trustServer = null;
  }

  function printBanner() {
    const info = networkInfo();
    const lines = [
      '',
      '  ◉  上帝之眼  EYE OF GOD',
      '  ─────────────────────────────────────────────',
      `  ① 证书安装  ${info.urls.trust}`,
      `  ② 管理端    ${info.urls.app}`,
      `  ③ 摄像机端  ${info.urls.capture}`,
      '',
      `  局域网 IP   ${info.primaryIp || '未检测到（请检查 Wi-Fi）'}`,
      `  数据目录    ${config.dataDir}`,
      '  首次使用请先在这台 Mac 上打开证书安装页，信任本地 CA。',
      '  手机与 iPad 也需要安装一次，否则浏览器不允许调用摄像头。',
    ];
    if (setupCode) {
      lines.push(
        '',
        '  ┌─ 首次初始化 ───────────────────────────────',
        `  │ 初始化码：${setupCode}`,
        '  │ 打开管理端，输入此码并设置管理员密码。',
        '  │ 此码只显示在终端，服务重启后会更换。',
        '  └────────────────────────────────────────────',
      );
    } else {
      lines.push('', `  启动时间    ${formatTime(new Date())}`);
    }
    lines.push('', '  Ctrl+C 停止服务。手机需与 Mac 连接同一 Wi-Fi。', '');
    logger.info(lines.join('\n'));
  }

  return {
    start,
    stop,
    getInfo,
    getSetupCode: () => setupCode,
    printBanner,
    store,
    sessions,
    hub: () => hub,
    config,
  };
}

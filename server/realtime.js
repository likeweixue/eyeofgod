import { WebSocketServer, WebSocket } from 'ws';
import { jpegDimensions, parseCookies } from './security.js';
import { isAllowedHost, isRequestAllowed } from './net.js';

const HEARTBEAT_MS = 25_000;
const STATUS_MS = 2_000;
const FRAME_WINDOW_MS = 3_000;

function rejectUpgrade(socket, status, message) {
  const body = Buffer.from(message || 'Forbidden');
  socket.write(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
  socket.destroy();
}

function originMatches(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `https://${req.headers.host}`;
}

export class RealtimeHub {
  constructor({ store, config, sessions, verifyDeviceToken, onEvent, logger = console }) {
    this.store = store;
    this.config = config;
    this.sessions = sessions;
    this.verifyDeviceToken = verifyDeviceToken;
    this.onEvent = onEvent;
    this.logger = logger;
    this.cameraSockets = new Map();
    this.cameraRuntime = new Map();
    this.latestFrames = new Map();
    this.adminSockets = new Set();
    this.server = null;
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: config.maxFrameBytes });
    this.statusTimer = null;
    this.heartbeatTimer = null;
  }

  attach(httpsServer) {
    this.server = httpsServer;
    httpsServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.statusTimer = setInterval(() => this.broadcastStatuses(), STATUS_MS);
    this.statusTimer.unref?.();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  handleUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'https://localhost').pathname;
    } catch {
      rejectUpgrade(socket, '400 Bad Request', 'Bad request');
      return;
    }

    if (pathname !== '/ws/admin' && pathname !== '/ws/camera') {
      rejectUpgrade(socket, '404 Not Found', 'Not found');
      return;
    }
    if (!isRequestAllowed(req, this.config.allowRemote)) {
      rejectUpgrade(socket, '403 Forbidden', 'LAN only');
      return;
    }
    if (!isAllowedHost(req.headers.host)) {
      rejectUpgrade(socket, '421 Misdirected Request', 'Host not allowed');
      return;
    }
    if (!originMatches(req)) {
      rejectUpgrade(socket, '403 Forbidden', 'Origin mismatch');
      return;
    }

    const cookies = parseCookies(req.headers.cookie);
    if (pathname === '/ws/admin') {
      const session = this.sessions.get(cookies.goe_admin);
      if (!session) {
        rejectUpgrade(socket, '401 Unauthorized', 'Login required');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleAdmin(ws, cookies.goe_admin));
      return;
    }

    const camera = this.verifyDeviceToken(cookies.goe_camera);
    if (!camera) {
      rejectUpgrade(socket, '401 Unauthorized', 'Camera session invalid');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleCamera(ws, camera));
  }

  sendJson(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* socket closing */
    }
  }

  broadcastJson(data, except = null) {
    const serialized = JSON.stringify(data);
    for (const ws of this.adminSockets) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      try {
        ws.send(serialized);
      } catch {
        /* socket closing */
      }
    }
  }

  handleAdmin(ws, token) {
    ws.isAlive = true;
    ws.clientKind = 'admin';
    ws.adminToken = token;
    this.adminSockets.add(ws);
    this.sendJson(ws, { type: 'hello', cameras: this.listCameras(), serverTime: Date.now() });

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const message = JSON.parse(data.toString());
        if (message.type === 'ping') this.sendJson(ws, { type: 'pong', serverTime: Date.now() });
      } catch {
        /* ignore malformed control messages */
      }
    });
    ws.on('close', () => {
      this.adminSockets.delete(ws);
    });
    ws.on('error', () => {
      this.adminSockets.delete(ws);
    });
  }

  handleCamera(ws, camera) {
    const previous = this.cameraSockets.get(camera.id);
    if (previous && previous !== ws) {
      try {
        previous.close(4000, '该摄像机已由另一台设备接管');
      } catch {
        /* ignore */
      }
    }

    const runtime = {
      socket: ws,
      connectedAt: Date.now(),
      lastFrameAt: null,
      frameTimes: [],
      width: null,
      height: null,
      latestJpeg: null,
      latestAt: null,
      bytes: 0,
      firstFrameLogged: false,
    };
    this.cameraSockets.set(camera.id, ws);
    this.cameraRuntime.set(camera.id, runtime);
    ws.isAlive = true;
    ws.clientKind = 'camera';
    ws.cameraId = camera.id;

    camera.lastSeenAt = new Date().toISOString();
    camera.pairedAt = camera.pairedAt || camera.lastSeenAt;
    this.store.save();
    this.onEvent('camera.online', `「${camera.name}」已上线，加密通道已建立`, {
      cameraId: camera.id,
      cameraName: camera.name,
    });

    this.sendJson(ws, {
      type: 'ready',
      camera: { id: camera.id, name: camera.name },
      serverTime: Date.now(),
    });
    this.broadcastStatuses();

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === 'ping') this.sendJson(ws, { type: 'pong', serverTime: Date.now() });
          if (message.type === 'bye') {
            try {
              ws.close(1000, '摄像机主动停止');
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore malformed control messages */
        }
        return;
      }
      this.acceptFrame(camera, runtime, data);
    });

    ws.on('close', (code) => {
      if (this.cameraSockets.get(camera.id) === ws) {
        this.cameraSockets.delete(camera.id);
        this.cameraRuntime.delete(camera.id);
        camera.lastSeenAt = new Date().toISOString();
        this.store.save();
        this.onEvent('camera.offline', `「${camera.name}」离线`, {
          cameraId: camera.id,
          cameraName: camera.name,
        });
        this.broadcastJson({
          type: 'camera-closed',
          cameraId: camera.id,
          code,
          cameras: this.listCameras(),
        });
      }
    });

    ws.on('error', () => {
      /* close handler handles state */
    });
  }

  acceptFrame(camera, runtime, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length < 4 || buffer.length > this.config.maxFrameBytes) return;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return;
    if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return;

    const now = Date.now();
    runtime.lastFrameAt = now;
    runtime.latestJpeg = buffer;
    runtime.latestAt = now;
    runtime.bytes += buffer.length;
    runtime.frameTimes.push(now);
    this.latestFrames.set(camera.id, { jpeg: buffer, at: now, width: runtime.width, height: runtime.height });
    const cutoff = now - FRAME_WINDOW_MS;
    while (runtime.frameTimes.length && runtime.frameTimes[0] < cutoff) runtime.frameTimes.shift();

    const dimensions = jpegDimensions(buffer);
    if (dimensions && (dimensions.width !== runtime.width || dimensions.height !== runtime.height)) {
      runtime.width = dimensions.width;
      runtime.height = dimensions.height;
      this.broadcastStatuses();
    }

    if (!runtime.firstFrameLogged) {
      runtime.firstFrameLogged = true;
      this.onEvent('stream.started', `「${camera.name}」开始传输监控画面`, {
        cameraId: camera.id,
        cameraName: camera.name,
      });
    }

    this.broadcastFrame(camera.id, buffer);
  }

  adminIsAuthorized(ws) {
    return Boolean(ws.adminToken && this.sessions.get(ws.adminToken));
  }

  closeAdminSocket(ws, reason) {
    try {
      ws.close(4401, reason);
    } catch {
      /* ignore */
    }
    this.adminSockets.delete(ws);
  }

  broadcastFrame(cameraId, jpeg) {
    if (this.adminSockets.size === 0) return;
    const header = Buffer.from(cameraId, 'ascii');
    const packet = Buffer.concat([header, jpeg]);
    for (const ws of this.adminSockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!this.adminIsAuthorized(ws)) {
        this.closeAdminSocket(ws, '登录状态已失效');
        continue;
      }
      if (ws.bufferedAmount > 2 * 1024 * 1024) continue;
      try {
        ws.send(packet);
      } catch {
        /* socket closing */
      }
    }
  }

  fpsFor(runtime) {
    if (!runtime) return 0;
    const cutoff = Date.now() - FRAME_WINDOW_MS;
    const recent = runtime.frameTimes.filter((time) => time >= cutoff);
    return Math.round((recent.length / FRAME_WINDOW_MS) * 1000 * 10) / 10;
  }

  cameraView(camera) {
    const runtime = this.cameraRuntime.get(camera.id);
    const online = Boolean(runtime && runtime.socket.readyState === WebSocket.OPEN);
    const lastFrameAt = runtime?.lastFrameAt || null;
    const streaming = Boolean(online && lastFrameAt && Date.now() - lastFrameAt < 10_000);
    return {
      id: camera.id,
      name: camera.name,
      location: camera.location,
      createdAt: camera.createdAt,
      updatedAt: camera.updatedAt,
      paired: camera.pairVersion > 0,
      pairedAt: camera.pairedAt || null,
      online,
      streaming,
      fps: streaming ? this.fpsFor(runtime) : 0,
      width: runtime?.width || null,
      height: runtime?.height || null,
      lastSeenAt: lastFrameAt || this.latestFrames.get(camera.id)?.at
        ? new Date(lastFrameAt || this.latestFrames.get(camera.id).at).toISOString()
        : camera.lastSeenAt,
      connectedAt: runtime ? new Date(runtime.connectedAt).toISOString() : null,
      latestFrameAt: runtime?.latestAt || this.latestFrames.get(camera.id)?.at
        ? new Date(runtime?.latestAt || this.latestFrames.get(camera.id).at).toISOString()
        : null,
    };
  }

  listCameras() {
    return this.store.data.cameras.map((camera) => this.cameraView(camera));
  }

  latestFrame(cameraId) {
    return this.latestFrames.get(cameraId)?.jpeg || this.cameraRuntime.get(cameraId)?.latestJpeg || null;
  }

  dropLatestFrame(cameraId) {
    this.latestFrames.delete(cameraId);
  }

  disconnectAdmin(token, reason = '管理员会话已失效') {
    for (const ws of [...this.adminSockets]) {
      if (!token || ws.adminToken === token) this.closeAdminSocket(ws, reason);
    }
  }

  closeAllAdmins(reason = '管理员会话已失效') {
    for (const ws of [...this.adminSockets]) this.closeAdminSocket(ws, reason);
  }

  broadcastStatuses() {
    if (this.adminSockets.size === 0) return;
    for (const ws of [...this.adminSockets]) {
      if (!this.adminIsAuthorized(ws)) this.closeAdminSocket(ws, '登录状态已失效');
    }
    this.broadcastJson({ type: 'status', cameras: this.listCameras(), serverTime: Date.now() });
  }

  notifyEvent(event) {
    this.broadcastJson({ type: 'event', event });
  }

  disconnectCamera(cameraId, reason = '管理员已停止该摄像机的直播', code = 4001) {
    const ws = this.cameraSockets.get(cameraId);
    if (!ws) return false;
    try {
      ws.close(code, reason);
    } catch {
      /* ignore */
    }
    return true;
  }

  dropCameraState(cameraId) {
    this.cameraSockets.delete(cameraId);
    this.cameraRuntime.delete(cameraId);
    this.latestFrames.delete(cameraId);
    this.broadcastStatuses();
  }

  heartbeat() {
    for (const ws of this.cameraSockets.values()) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
    for (const ws of this.adminSockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }

  stop() {
    clearInterval(this.statusTimer);
    clearInterval(this.heartbeatTimer);
    for (const ws of [...this.cameraSockets.values(), ...this.adminSockets]) {
      try {
        ws.close(1001, '服务停止');
      } catch {
        /* ignore */
      }
    }
    this.cameraSockets.clear();
    this.cameraRuntime.clear();
    this.latestFrames.clear();
    this.adminSockets.clear();
    this.wss.close();
  }
}

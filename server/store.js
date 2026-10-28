import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY_DATA = {
  version: 1,
  createdAt: null,
  admin: null,
  cameras: [],
  events: [],
};

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

export class Store {
  constructor(dataDir, logger = console) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'eye-of-god.json');
    this.secretsFile = path.join(dataDir, 'secrets.json');
    this.logger = logger;
    ensureDirectory(dataDir);
    this.data = this.load();
    this.secrets = this.loadSecrets();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) {
        const initial = { ...EMPTY_DATA, createdAt: new Date().toISOString() };
        fs.writeFileSync(this.file, JSON.stringify(initial, null, 2), { mode: 0o600 });
        return initial;
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...EMPTY_DATA,
        ...parsed,
        cameras: Array.isArray(parsed.cameras) ? parsed.cameras : [],
        events: Array.isArray(parsed.events) ? parsed.events : [],
      };
    } catch (error) {
      this.logger.error('[store] 数据库读取失败:', error.message);
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.file, backup);
        this.logger.error(`[store] 已备份损坏文件到 ${backup}`);
      } catch {
        /* ignore */
      }
      const initial = { ...EMPTY_DATA, createdAt: new Date().toISOString() };
      fs.writeFileSync(this.file, JSON.stringify(initial, null, 2), { mode: 0o600 });
      return initial;
    }
  }

  loadSecrets() {
    try {
      if (fs.existsSync(this.secretsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
        if (parsed && typeof parsed.deviceSecret === 'string' && parsed.deviceSecret.length >= 32) {
          return parsed;
        }
      }
    } catch {
      /* regenerate */
    }
    const secrets = { deviceSecret: crypto.randomBytes(48).toString('base64url') };
    fs.writeFileSync(this.secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 });
    return secrets;
  }

  save() {
    const temp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  camera(id) {
    return this.data.cameras.find((camera) => camera.id === id) || null;
  }

  addCamera({ name, location }) {
    const now = new Date().toISOString();
    const camera = {
      id: crypto.randomBytes(6).toString('hex'),
      name,
      location,
      createdAt: now,
      updatedAt: now,
      pairVersion: 0,
      pairedAt: null,
      lastSeenAt: null,
    };
    this.data.cameras.push(camera);
    this.save();
    return camera;
  }

  removeCamera(id) {
    const before = this.data.cameras.length;
    this.data.cameras = this.data.cameras.filter((camera) => camera.id !== id);
    if (this.data.cameras.length !== before) {
      this.data.events = this.data.events.filter((event) => event.cameraId !== id);
      this.save();
      return true;
    }
    return false;
  }

  appendEvent(type, message, meta = {}) {
    const event = {
      id: crypto.randomBytes(6).toString('hex'),
      at: new Date().toISOString(),
      type,
      message,
      cameraId: meta.cameraId || null,
      cameraName: meta.cameraName || null,
    };
    this.data.events.unshift(event);
    if (this.data.events.length > 300) this.data.events.length = 300;
    this.save();
    return event;
  }
}

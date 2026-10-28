import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

const PASSWORD_N = 16384;
const PASSWORD_R = 8;
const PASSWORD_P = 1;
const PASSWORD_KEYLEN = 64;

const WEAK_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1', 'password123',
  'admin123', 'admin1234', 'qwerty123', '11111111', '00000000', '88888888',
  'iloveyou', 'abc12345', 'letmein1', 'welcome1', 'god12345',
]);

export function passwordProblem(password) {
  if (typeof password !== 'string') return '密码格式不正确';
  const normalized = password.normalize('NFKC');
  if (normalized.length < 8) return '密码至少需要 8 位';
  if (normalized.length > 128) return '密码不能超过 128 位';
  if (WEAK_PASSWORDS.has(normalized.toLowerCase())) return '这个密码太常见，请换一个';
  if (/^(.)\1+$/.test(normalized)) return '密码不能是单一重复字符';
  return null;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, PASSWORD_KEYLEN, {
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    maxmem: 96 * 1024 * 1024,
  });
  return {
    algorithm: 'scrypt',
    N: PASSWORD_N,
    r: PASSWORD_R,
    p: PASSWORD_P,
    salt: salt.toString('hex'),
    hash: derived.toString('hex'),
  };
}

export async function verifyPassword(password, stored) {
  if (!stored || stored.algorithm !== 'scrypt' || !stored.salt || !stored.hash) return false;
  try {
    const salt = Buffer.from(stored.salt, 'hex');
    const expected = Buffer.from(stored.hash, 'hex');
    const derived = await scryptAsync(String(password).normalize('NFKC'), salt, expected.length, {
      N: stored.N || PASSWORD_N,
      r: stored.r || PASSWORD_R,
      p: stored.p || PASSWORD_P,
      maxmem: 96 * 1024 * 1024,
    });
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch {
    return false;
  }
}

export function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomHex(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return null;
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key || key in cookies) continue;
    let value = part.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    cookies[key] = value;
  }
  return cookies;
}

export function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  return parts.join('; ');
}

export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.cleanup(), 60_000);
    this.timer.unref?.();
  }

  consume(key, limit, windowMs) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return { allowed: bucket.count <= limit, remaining: Math.max(0, limit - bucket.count), retryAfter };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

export class SessionStore {
  constructor(ttlHours = 12) {
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.sessions = new Map();
    this.timer = setInterval(() => this.cleanup(), 10 * 60_000);
    this.timer.unref?.();
  }

  create() {
    const token = randomId(32);
    this.sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  get(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  clear() {
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

export function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function clientIp(req) {
  return req.socket?.remoteAddress || 'unknown';
}

export function shortUserAgent(header = '') {
  const ua = String(header);
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android 设备';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return '浏览器设备';
}

export function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame && offset + 9 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

function numberEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`无效的端口: ${value}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  return {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    dataDir: env.GOE_DATA_DIR || path.join(ROOT, 'data'),
    certDir: env.GOE_CERT_DIR || path.join(ROOT, 'certs'),
    host: env.GOE_HOST || '0.0.0.0',
    httpsPort: numberEnv(env.GOE_HTTPS_PORT ?? env.PORT, 8443),
    httpPort: numberEnv(env.GOE_HTTP_PORT, 8080),
    allowRemote: env.GOE_ALLOW_REMOTE === '1',
    appName: '上帝之眼',
    version: '0.1.0',
    sessionHours: 12,
    deviceDays: 30,
    pairMinutes: 15,
    maxFrameBytes: 3 * 1024 * 1024,
    quiet: env.GOE_QUIET === '1',
  };
}

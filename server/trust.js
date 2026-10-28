import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { escapeHtml } from './security.js';
import { isRequestAllowed } from './net.js';

function applyHeaders(res, extra = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
}

function send(res, status, contentType, body, extra = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  applyHeaders(res, {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.writeHead(status);
  if (res.req?.method === 'HEAD') res.end();
  else res.end(buffer);
}

export function createTrustServer({ config, certs, getInfo, logger = console }) {
  const templatePath = path.join(config.publicDir, 'trust.html');
  let template = null;

  return http.createServer((req, res) => {
    try {
      if (!isRequestAllowed(req, config.allowRemote)) {
        send(res, 403, 'text/plain; charset=utf-8', '仅允许局域网访问。');
        return;
      }
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(res, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', { Allow: 'GET, HEAD' });
        return;
      }

      if (pathname === '/') {
        applyHeaders(res, { Location: '/trust', 'Cache-Control': 'no-store' });
        res.writeHead(302);
        res.end();
        return;
      }

      if (pathname === '/health') {
        send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (pathname === '/trust') {
        if (!template) template = fs.readFileSync(templatePath, 'utf8');
        const info = getInfo();
        const html = template
          .replaceAll('{{CAPTURE_URL}}', escapeHtml(info.urls.capture))
          .replaceAll('{{APP_URL}}', escapeHtml(info.urls.app))
          .replaceAll('{{TRUST_URL}}', escapeHtml(info.urls.trust))
          .replaceAll('{{FINGERPRINT}}', escapeHtml(certs.caFingerprint))
          .replaceAll('{{PRIMARY_IP}}', escapeHtml(info.primaryIp || '127.0.0.1'))
          .replaceAll('{{HTTPS_PORT}}', escapeHtml(String(info.httpsPort)))
          .replaceAll('{{HTTP_PORT}}', escapeHtml(String(info.httpPort)));
        send(res, 200, 'text/html; charset=utf-8', html);
        return;
      }

      if (pathname === '/trust/eye-of-god.mobileconfig') {
        send(res, 200, 'application/x-apple-aspen-config', certs.mobileConfig, {
          'Content-Disposition': 'attachment; filename="eye-of-god.mobileconfig"',
        });
        return;
      }

      if (pathname === '/trust/eye-of-god-ca.cer') {
        send(res, 200, 'application/x-x509-ca-cert', certs.caDer, {
          'Content-Disposition': 'attachment; filename="eye-of-god-ca.cer"',
        });
        return;
      }

      if (pathname === '/trust/eye-of-god-ca.crt' || pathname === '/trust/eye-of-god-ca.pem') {
        send(res, 200, 'application/x-x509-ca-cert', certs.caPem, {
          'Content-Disposition': 'attachment; filename="eye-of-god-ca.crt"',
        });
        return;
      }

      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error) {
      logger.error('[trust] 请求处理失败:', error);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal Server Error');
      else res.end();
    }
  });
}

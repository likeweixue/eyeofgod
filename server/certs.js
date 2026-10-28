import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { getLanAddresses, hostNames } from './net.js';

function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function uuidFor(seed) {
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export class CertManager {
  constructor(certDir, logger = console) {
    this.certDir = certDir;
    this.logger = logger;
    this.caCertPath = path.join(certDir, 'ca.crt');
    this.caKeyPath = path.join(certDir, 'ca.key');
    this.leafCertPath = path.join(certDir, 'server.crt');
    this.leafKeyPath = path.join(certDir, 'server.key');
    this.csrPath = path.join(certDir, 'server.csr');
  }

  ensure() {
    ensureDirectory(this.certDir);
    this.ensureCa();
    this.ensureLeaf();
    this.caPem = read(this.caCertPath);
    this.caCertificate = new X509Certificate(this.caPem);
    this.caFingerprint = this.caCertificate.fingerprint256;
    this.httpsOptions = {
      key: read(this.leafKeyPath),
      cert: read(this.leafCertPath),
      minVersion: 'TLSv1.2',
    };
    this.mobileConfig = this.buildMobileConfig();
    return this;
  }

  ensureCa() {
    if (fs.existsSync(this.caCertPath) && fs.existsSync(this.caKeyPath)) {
      try {
        const cert = new X509Certificate(read(this.caCertPath));
        if (!cert.ca) throw new Error('CA 标记无效');
        if (new Date(cert.validTo).getTime() - Date.now() < 365 * 24 * 3600 * 1000) {
          throw new Error('CA 即将过期');
        }
        return;
      } catch (error) {
        this.logger.warn(`[cert] 现有 CA 不可用（${error.message}），将重新生成。`);
      }
    }

    const configPath = path.join(this.certDir, 'ca.cnf');
    fs.writeFileSync(
      configPath,
      [
        '[req]',
        'prompt = no',
        'distinguished_name = dn',
        'x509_extensions = v3_ca',
        '[dn]',
        'CN = God\'s Eye Local CA',
        'O = Eye of God',
        '[v3_ca]',
        'basicConstraints = critical,CA:TRUE,pathlen:0',
        'keyUsage = critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always,issuer',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', this.caKeyPath, '-out', this.caCertPath,
        '-days', '3650', '-sha256', '-config', configPath,
      ],
      { cwd: this.certDir, stdio: 'pipe' },
    );
    fs.chmodSync(this.caKeyPath, 0o600);
    this.logger.info('[cert] 已生成本地根证书（首次启动）。');
  }

  currentSans() {
    const addresses = getLanAddresses().map((item) => item.address);
    const ips = [...new Set(['127.0.0.1', ...addresses])];
    const dns = [...new Set(hostNames())];
    return { ips, dns };
  }

  leafIsCurrent() {
    if (!fs.existsSync(this.leafCertPath) || !fs.existsSync(this.leafKeyPath)) return false;
    try {
      const cert = new X509Certificate(read(this.leafCertPath));
      const ca = new X509Certificate(read(this.caCertPath));
      if (!cert.verify(ca.publicKey)) return false;
      if (new Date(cert.validTo).getTime() - Date.now() < 30 * 24 * 3600 * 1000) return false;
      const { ips, dns } = this.currentSans();
      for (const ip of ips) {
        if (!cert.checkIP(ip)) return false;
      }
      for (const host of dns) {
        if (!cert.checkHost(host)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  ensureLeaf() {
    if (this.leafIsCurrent()) return;
    const { ips, dns } = this.currentSans();
    const altLines = [];
    dns.forEach((host, index) => altLines.push(`DNS.${index + 1} = ${host}`));
    ips.forEach((ip, index) => altLines.push(`IP.${index + 1} = ${ip}`));

    const configPath = path.join(this.certDir, 'leaf.cnf');
    fs.writeFileSync(
      configPath,
      [
        '[req]',
        'prompt = no',
        'distinguished_name = dn',
        '[dn]',
        'CN = Eye of God',
        'O = Eye of God LAN',
        '[v3_leaf]',
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid,issuer',
        'subjectAltName = @alt_names',
        '[alt_names]',
        ...altLines,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    execFileSync(
      'openssl',
      [
        'req', '-new', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', this.leafKeyPath, '-out', this.csrPath,
        '-sha256', '-config', configPath,
      ],
      { cwd: this.certDir, stdio: 'pipe' },
    );

    try {
      execFileSync(
        'openssl',
        [
          'x509', '-req', '-in', this.csrPath,
          '-CA', this.caCertPath, '-CAkey', this.caKeyPath, '-CAcreateserial',
          '-out', this.leafCertPath, '-days', '397', '-sha256',
          '-extfile', configPath, '-extensions', 'v3_leaf',
        ],
        { cwd: this.certDir, stdio: 'pipe' },
      );
    } catch (error) {
      throw new Error(`生成 HTTPS 证书失败: ${error.stderr?.toString?.() || error.message}`);
    }
    fs.chmodSync(this.leafKeyPath, 0o600);
    this.logger.info(`[cert] 已签发本机 HTTPS 证书（${ips.join(', ')}）。`);
  }

  buildMobileConfig() {
    const der = new X509Certificate(this.caPem).raw;
    const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
    const displayName = '上帝之眼 本地根证书';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>EyeOfGod-CA.cer</string>
      <key>PayloadContent</key>
      <data>
${base64}
      </data>
      <key>PayloadDescription</key>
      <string>用于验证“上帝之眼”局域网监控服务的 HTTPS 证书。</string>
      <key>PayloadDisplayName</key>
      <string>${escapeXml(displayName)}</string>
      <key>PayloadIdentifier</key>
      <string>local.eyeofgod.ca.${uuidFor(this.caFingerprint || 'ca')}</string>
      <key>PayloadOrganization</key>
      <string>Eye of God</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuidFor(`cert-${this.caFingerprint || 'ca'}`)}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>安装后，Safari 才能安全地访问局域网内的“上帝之眼”并调用摄像头。</string>
  <key>PayloadDisplayName</key>
  <string>${escapeXml(displayName)}</string>
  <key>PayloadIdentifier</key>
  <string>local.eyeofgod.profile.${uuidFor('profile')}</string>
  <key>PayloadOrganization</key>
  <string>Eye of God</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuidFor('profile-eye-of-god')}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
  }

  caDownloadName(kind = 'crt') {
    return kind === 'pem' ? 'eye-of-god-ca.pem' : 'eye-of-god-ca.crt';
  }

  get caDer() {
    return new X509Certificate(this.caPem).raw;
  }
}

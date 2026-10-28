import os from 'node:os';
import net from 'node:net';

export function getLanAddresses() {
  const result = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      result.push({ interface: name, address: entry.address });
    }
  }
  const unique = new Map();
  for (const item of result) unique.set(item.address, item);
  return [...unique.values()];
}

function scoreAddress(address) {
  if (address.startsWith('192.168.')) return 0;
  if (address.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 3;
  return 4;
}

export function primaryLanAddress() {
  const addresses = getLanAddresses();
  return [...addresses].sort((a, b) => {
    const score = scoreAddress(a.address) - scoreAddress(b.address);
    if (score !== 0) return score;
    if (a.interface === 'en0') return -1;
    if (b.interface === 'en0') return 1;
    return a.address.localeCompare(b.address);
  })[0]?.address || null;
}

export function isPrivateAddress(rawAddress) {
  if (!rawAddress) return false;
  let address = rawAddress;
  if (address.startsWith('::ffff:')) address = address.slice(7);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return (
      lower === '::1' ||
      lower === '::' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  }

  return false;
}

export function isRequestAllowed(req, allowRemote = false) {
  if (allowRemote) return true;
  const remote = req.socket?.remoteAddress || '';
  return isPrivateAddress(remote);
}

export function urlsFor(port, httpPort, primary) {
  const host = primary || '127.0.0.1';
  const httpsHost = net.isIPv6(host) ? `[${host}]` : host;
  const suffix = port === 443 ? '' : `:${port}`;
  const httpSuffix = httpPort === 80 ? '' : `:${httpPort}`;
  return {
    app: `https://${httpsHost}${suffix}`,
    capture: `https://${httpsHost}${suffix}/capture`,
    trust: `http://${httpsHost}${httpSuffix}/trust`,
  };
}

export function hostnameFromHeader(hostHeader = '') {
  const value = String(hostHeader).trim();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? value : value.slice(1, end);
  }
  return value.split(':')[0];
}

export function isAllowedHost(hostHeader) {
  const hostname = hostnameFromHeader(hostHeader).toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  const allowed = new Set([
    ...getLanAddresses().map((item) => item.address.toLowerCase()),
    ...hostNames().map((name) => name.toLowerCase()),
  ]);
  return allowed.has(hostname);
}

export function hostNames() {
  const raw = os.hostname();
  const names = new Set(['localhost', raw]);
  if (!raw.endsWith('.local')) names.add(`${raw}.local`);
  const short = raw.split('.')[0];
  if (short) {
    names.add(short);
    names.add(`${short}.local`);
  }
  return [...names];
}

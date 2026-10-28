import process from 'node:process';
import { loadConfig } from './config.js';
import { createSystem } from './app.js';

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  console.error(`需要 Node.js 20 或更高版本，当前为 ${process.versions.node}。`);
  process.exit(1);
}

const config = loadConfig();
let system;
let closing = false;

async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n收到 ${signal}，正在关闭上帝之眼…`);
  try {
    await system?.stop();
  } catch (error) {
    console.error('关闭时发生错误：', error.message);
  }
  process.exit(0);
}

try {
  system = await createSystem(config);
  await system.start();
  system.printBanner();
} catch (error) {
  console.error('\n上帝之眼启动失败：');
  if (error.code === 'EADDRINUSE') {
    console.error(`端口已被占用。请关闭其他占用 ${config.httpsPort} / ${config.httpPort} 端口的程序，`);
    console.error('或在终端使用 GOE_HTTPS_PORT=9443 GOE_HTTP_PORT=9080 npm start 换端口启动。');
  } else if (error.code === 'EACCES') {
    console.error('没有权限绑定端口。请尝试使用 8443 / 8080 以上的端口。');
    console.error(error.message);
  } else {
    console.error(error.stack || error.message);
  }
  await system?.stop().catch(() => {});
  process.exit(1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => {
  console.error('[unhandledRejection]', error);
});

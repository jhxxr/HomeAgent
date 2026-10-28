import { loadServerConfig } from './config.js';
import { createHomeServer } from './app.js';
import { versionBanner } from '../shared/version.js';

try {
  const config = loadServerConfig(), instance = createHomeServer(config);
  await instance.listen();
  console.log(versionBanner('Server'));
  console.log(`HomeAgent relay listening on ${config.host}:${config.port} · Dashboard ${config.publicUrl}`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    void instance.close().then(() => { clearTimeout(timer); process.exit(0); });
  });
} catch (error) {
  console.error('Server startup failed:', error instanceof Error ? error.message : 'unknown');
  process.exitCode = 1;
}

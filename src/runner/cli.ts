import { parseArgs } from 'node:util';
import { loadRunnerConfig } from './config.js';
import { loadCredential, secureStateDirectory } from './credentials.js';
import { Agent } from './agent.js';
import { service } from './service.js';
import { interactiveLogin } from './setup.js';
import { rememberRunnerConfigPath, resolveRunnerConfigPath } from './config-location.js';
import { VERSION } from '../shared/protocol.js';
import { versionBanner } from '../shared/version.js';

async function startRunner(config: Awaited<ReturnType<typeof loadRunnerConfig>>, filename: string) {
  await secureStateDirectory(config.stateDir);
  const credential = await loadCredential(config);
  const agent = new Agent(config, credential);
  await rememberRunnerConfigPath(filename).catch(() => console.error('无法记录配置位置，下次启动请通过 --config 指定路径。'));
  console.log(versionBanner('Runner'));
  console.log(`Runner 配置：${filename}`);
  agent.start();
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    const timer = setTimeout(() => process.exit(1), 10000).unref();
    void agent.close().then(() => { clearTimeout(timer); process.exit(0); });
  });
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, server: { type: 'string' }, name: { type: 'string' },
      force: { type: 'boolean', default: false },
      run: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`HomeAgent Runner ${VERSION}\n  login [--config <path>] [--server URL] [--name NAME] [--run] [--force]\n  run [--config <path>]\n  check-config [--config <path>]\n  service-install [--config <path>]\n  service-uninstall [--config <path>]\n  --version\n\nConfiguration: explicit --config, saved location, ~/.homeagent/runner.json.\nUse homeagent login to set up a device and homeagent run to start it.\nProject directories and permissions are configured on the Web.`);
  } else if (values.version) console.log(versionBanner('Runner'));
  else {
    const command = positionals[0] ?? 'run';
    if (positionals.length > 1 || !['login', 'run', 'check-config', 'service-install', 'service-uninstall'].includes(command)) throw new Error(`Unknown command: ${positionals.join(' ')}. Use homeagent --help.`);
    if (command === 'login') {
      console.log(versionBanner('Runner'));
      const result = await interactiveLogin({ config: values.config, server: values.server, name: values.name, force: values.force });
      if (values.run) await startRunner(result.config, result.filename);
    } else {
      const filename = await resolveRunnerConfigPath(values.config), config = await loadRunnerConfig(filename);
      if (command === 'check-config') console.log(JSON.stringify({ valid: true, version: VERSION, node: process.version, platform: process.platform, architecture: process.arch, configFile: filename, server: config.server, projectConfiguration: 'server-managed', maxProcesses: config.maxProcesses }, null, 2));
      else if (command === 'service-install' || command === 'service-uninstall') await service(config, filename, command === 'service-uninstall');
      else if (command === 'run') await startRunner(config, filename);
      else throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) { console.error('Runner failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; }

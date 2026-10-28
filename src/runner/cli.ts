import { parseArgs } from 'node:util';
import os from 'node:os';
import { loadRunnerConfig } from './config.js';
import { loadCredential, secureStateDirectory } from './credentials.js';
import { Agent } from './agent.js';
import { service } from './service.js';
import { interactiveLogin } from './setup.js';
import { rememberRunnerConfigPath, resolveRunnerConfigPath } from './config-location.js';
import { RunnerTui, tuiEnabled } from './tui.js';
import { VERSION } from '../shared/protocol.js';
import { versionBanner } from '../shared/version.js';
import { runInteractiveApplication } from './interactive.js';

function shortenHome(filename: string) {
  const home = os.homedir();
  if (!filename.toLowerCase().startsWith(home.toLowerCase())) return filename;
  const rest = filename.slice(home.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('\\') ? '~' + rest : filename;
}

async function startRunner(config: Awaited<ReturnType<typeof loadRunnerConfig>>, filename: string, plain = false) {
  await secureStateDirectory(config.stateDir);
  const credential = await loadCredential(config);
  const tui = !plain && tuiEnabled(process.stdout) ? new RunnerTui({
    version: VERSION, node: process.version, platform: process.platform, arch: process.arch,
    device: config.name, server: config.server, config: shortenHome(filename),
  }) : undefined;
  const agent = new Agent(config, credential, tui ? message => tui.log(message) : console.log, tui ? (state, detail) => tui.setState(state, detail) : undefined);
  if (tui) tui.start();
  else { console.log(versionBanner('Runner')); console.log(`Runner 配置：${filename}`); }
  await rememberRunnerConfigPath(filename).catch(() => (tui ? tui.log('无法记录配置位置，下次启动请通过 --config 指定路径。') : console.error('无法记录配置位置，下次启动请通过 --config 指定路径。')));
  agent.start();
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return; closing = true;
    const timer = setTimeout(() => { tui?.stop(); process.exit(1); }, 10000).unref();
    void agent.close().then(() => { clearTimeout(timer); tui?.stop(); process.exit(0); });
  });
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' }, server: { type: 'string' }, name: { type: 'string' },
      force: { type: 'boolean', default: false }, plain: { type: 'boolean', default: false },
      run: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(`HomeAgent Runner ${VERSION}\n\n  homeagent                 Open the interactive app (login, settings and connection)\n\nAdvanced commands:\n  login [--config <path>] [--server URL] [--name NAME] [--run] [--force] [--plain]\n  run [--config <path>] [--plain]\n  check-config [--config <path>]\n  service-install [--config <path>]\n  service-uninstall [--config <path>]\n  --version\n\nConfiguration: explicit --config, saved location, ~/.homeagent/runner.json.\nIn a terminal, homeagent detects login automatically and guides setup in full screen.\n--plain prints one line per event; scripts and services retain the command interface.\nProject directories and permissions are configured on the Web.`);
  } else if (values.version) console.log(versionBanner('Runner'));
  else {
    const command = positionals[0] ?? 'run';
    if (positionals.length > 1 || !['login', 'run', 'check-config', 'service-install', 'service-uninstall'].includes(command)) throw new Error(`Unknown command: ${positionals.join(' ')}. Use homeagent --help.`);
    if (!values.plain && process.stdin.isTTY && tuiEnabled(process.stdout) && ['login', 'run'].includes(command)) {
      await runInteractiveApplication({ config: values.config, server: values.server, name: values.name, force: values.force, login: command === 'login' });
    } else if (command === 'login') {
      console.log(versionBanner('Runner'));
      const result = await interactiveLogin({ config: values.config, server: values.server, name: values.name, force: values.force });
      if (values.run) await startRunner(result.config, result.filename, values.plain);
    } else {
      const filename = await resolveRunnerConfigPath(values.config), config = await loadRunnerConfig(filename);
      if (command === 'check-config') console.log(JSON.stringify({ valid: true, version: VERSION, node: process.version, platform: process.platform, architecture: process.arch, configFile: filename, server: config.server, projectConfiguration: 'server-managed', maxProcesses: config.maxProcesses }, null, 2));
      else if (command === 'service-install' || command === 'service-uninstall') await service(config, filename, command === 'service-uninstall');
      else if (command === 'run') await startRunner(config, filename, values.plain);
      else throw new Error(`Unknown command: ${command}`);
    }
  }
} catch (error) { console.error('Runner failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; }

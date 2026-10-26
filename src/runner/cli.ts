import { parseArgs } from 'node:util';
import path from 'node:path';
import { loadRunnerConfig } from './config.js';
import { loadCredential, pair, secureStateDirectory } from './credentials.js';
import { Agent } from './agent.js';
import { service } from './service.js';
import { VERSION } from '../shared/protocol.js';

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { config: { type: 'string', default: 'runner.local.json' }, force: { type: 'boolean', default: false }, help: { type: 'boolean', default: false }, version: { type: 'boolean', default: false } },
  });
  if (values.help) {
    console.log('HomeAgent runner\n  pair --config runner.local.json [--force]\n  run --config runner.local.json\n  check-config --config runner.local.json\n  service-install --config runner.local.json\n  service-uninstall --config runner.local.json\n  --version');
  } else if (values.version) console.log(`HomeAgent runner ${VERSION} · Node ${process.version} · ${process.platform}/${process.arch}`);
  else {
    const filename = path.resolve(values.config), config = await loadRunnerConfig(filename);
    const command = positionals[0] ?? 'run';
    if (command === 'check-config') console.log(JSON.stringify({ valid: true, server: config.server, projects: config.projects.map(({ id, name, readOnly, allowGitWrite, commands, commandAliases, environmentProfiles, gitCommonDir }) => ({ id, name, readOnly, allowGitWrite, commands, aliases: Object.keys(commandAliases), environments: Object.keys(environmentProfiles), linkedWorktreeConfigured: !!gitCommonDir })), maxProcesses: config.maxProcesses }, null, 2));
    else if (command === 'pair') await pair(config, values.force);
    else if (command === 'service-install' || command === 'service-uninstall') await service(config, filename, command === 'service-uninstall');
    else if (command === 'run') {
      await secureStateDirectory(config.stateDir);
      const agent = new Agent(config, await loadCredential(config));
      agent.start();
      let closing = false;
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
        if (closing) return; closing = true;
        const timer = setTimeout(() => process.exit(1), 10000).unref();
        void agent.close().then(() => { clearTimeout(timer); process.exit(0); });
      });
    } else throw new Error(`Unknown command: ${command}`);
  }
} catch (error) { console.error('Runner failed:', error instanceof Error ? error.message : 'unknown'); process.exitCode = 1; }

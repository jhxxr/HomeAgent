#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(`HomeAgent
  homeagent login [options]       Interactive Runner login
  homeagent run [--config <path>] Start the Runner using its saved configuration
  homeagent check-config        Check local connection and runtime settings
  homeagent service-install     Install Runner auto-start
  homeagent service-uninstall   Remove Runner auto-start
  homeagent server
  homeagent init               Create .env in the current directory
  homeagent --version

Runner login creates the private configuration, generates a browser approval link,
and saves the device credential after approval. Project directories and permissions
are managed in the Dashboard. After login, use homeagent run.`);
  } else if (['--version', '-v'].includes(command)) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`HomeAgent ${version}`);
  } else if (['server', 'login', 'run', 'check-config', 'service-install', 'service-uninstall'].includes(command)) {
    if (command === 'server') process.argv.splice(2, 1);
    await import(command === 'server' ? './server.mjs' : './runner.mjs');
  } else if (command === 'init' && !args.length) {
    await import('../scripts/init.mjs');
  } else {
    throw new Error('Unknown command or arguments. Use homeagent --help.');
  }
} catch (error) {
  console.error('HomeAgent failed:', error.message);
  process.exitCode = 1;
}

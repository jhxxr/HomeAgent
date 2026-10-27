#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) {
    console.log(`HomeAgent
  homeagent runner <login|pair|run|check-config|service-install|service-uninstall> [options]
  homeagent login [options]       Interactive Runner login
  homeagent server
  homeagent init               Create .env in the current directory
  homeagent init-runner [--config <private-path>]
                              Create a Runner template (default: ~/.homeagent/runner.json)
  homeagent --version

Runner login creates the private configuration, generates a browser approval link,
and saves the device credential after approval. Existing pair/run commands remain
available for manually maintained configurations.`);
  } else if (['--version', '-v'].includes(command)) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(`HomeAgent ${version}`);
  } else if (command === 'runner' || command === 'server' || command === 'login') {
    process.argv.splice(2, 1, ...(command === 'login' ? ['login'] : []));
    await import(command === 'server' ? './server.mjs' : './runner.mjs');
  } else if (command === 'init' && !args.length) {
    await import('../scripts/init.mjs');
  } else if (command === 'init-runner') {
    const { values } = parseArgs({ args, options: { config: { type: 'string', default: path.join(os.homedir(), '.homeagent', 'runner.json') } } });
    const filename = path.resolve(values.config);
    const template = await readFile(new URL('../runner.example.json', import.meta.url), 'utf8');
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, template, { flag: 'wx', mode: 0o600 });
    console.log(`Created Runner template: ${filename}\nEdit server and project roots before pairing. Existing files are never overwritten.`);
  } else {
    throw new Error('Unknown command or arguments. Use homeagent --help.');
  }
} catch (error) {
  console.error('HomeAgent failed:', error.message);
  process.exitCode = 1;
}

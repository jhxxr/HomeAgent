#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
  console.log('HomeAgent server\n  homeagent-server\nReads .env from the current directory; existing environment variables take precedence.\nUse homeagent init to create a local .env, then configure PUBLIC_URL before deployment.');
} else if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(`HomeAgent server ${version}`);
} else if (args.length) {
  console.error('Unknown server arguments. Use homeagent-server --help.');
  process.exitCode = 1;
} else {
  try {
    try { process.loadEnvFile('.env'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await import('../dist/server/cli.js');
  } catch (error) {
    console.error('Server startup failed:', error.message);
    process.exitCode = 1;
  }
}

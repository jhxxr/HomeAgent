import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(path.join(root, 'release/npm-package.json'), 'utf8'));
assert.equal(path.basename(metadata.filename), metadata.filename);
const archive = path.join(root, 'release', metadata.filename);
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), metadata.sha256);
assert.ok(process.env.npm_execpath, 'Run with npm run test:package');
const temporary = await mkdtemp(path.join(tmpdir(), 'homeagent-package-test-'));
let server;
try {
  const prefix = path.join(temporary, 'install');
  const installed = spawnSync(process.execPath, [process.env.npm_execpath, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', archive], {
    encoding: 'utf8', windowsHide: true,
  });
  assert.equal(installed.status, 0, installed.stderr);
  const packagePath = path.join(prefix, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', metadata.name);
  const manifest = JSON.parse(await readFile(path.join(packagePath, 'package.json'), 'utf8'));
  assert.equal(manifest.name, metadata.name);
  assert.equal(manifest.version, metadata.version);
  const working = path.join(temporary, 'working');
  await mkdir(working);
  const run = (name, args, expected = 0) => {
    const result = spawnSync(process.execPath, [path.join(packagePath, manifest.bin[name]), ...args], { cwd: working, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, expected, `${name}: ${result.stderr}`);
    return result.stdout;
  };
  for (const name of Object.keys(manifest.bin)) {
    const shim = path.join(prefix, process.platform === 'win32' ? `${name}.cmd` : `bin/${name}`);
    await access(shim);
    assert.match(run(name, ['--version']), new RegExp(metadata.version.replace(/\./g, '\\.')));
    assert.match(run(name, ['--help']), /HomeAgent/i);
    // Check the actual global-install command shim, including Windows .cmd launchers.
    const result = process.platform === 'win32'
      ? spawnSync(`"${shim}" --version`, { shell: process.env.ComSpec ?? 'cmd.exe', encoding: 'utf8', windowsHide: true })
      : spawnSync(shim, ['--version'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${name} shim: ${result.stderr}`);
    assert.ok(result.stdout.includes(metadata.version), `Invalid ${name} shim output`);
  }
  const config = path.join(working, 'private/runner.json'), project = path.join(working, 'project'), state = path.join(working, 'state');
  await mkdir(project);
  run('homeagent', ['init-runner', '--config', config]);
  const original = await readFile(config, 'utf8');
  run('homeagent', ['init-runner', '--config', config], 1);
  assert.equal(await readFile(config, 'utf8'), original, 'Runner initialization overwrote an existing file');
  await writeFile(config, JSON.stringify({ ...JSON.parse(original), stateDir: state, projects: [{ id: 'project', name: 'Package test', root: project }] }));
  assert.equal(JSON.parse(run('homeagent-runner', ['check-config', '--config', config])).valid, true);
  run('homeagent', ['init']);
  const initialEnv = await readFile(path.join(working, '.env'), 'utf8');
  run('homeagent', ['init'], 1);
  assert.equal(await readFile(path.join(working, '.env'), 'utf8'), initialEnv, 'Server initialization overwrote an existing file');
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const env = { ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, HOMEAGENT_DB: path.join(working, 'server.sqlite') };
  delete env.ADMIN_PASSWORD; delete env.SESSION_SECRET;
  server = spawn(process.execPath, [path.join(packagePath, manifest.bin['homeagent-server'])], { cwd: working, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { output = (output + data.toString()).slice(-8192); });
  const origin = `http://localhost:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, `Installed server exited: ${output}`);
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { assert.equal((await response.json()).version, metadata.version); ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, `Installed server failed to start: ${output}`);
  for (const resource of ['/assets/dashboard.js', '/assets/consent.js', '/assets/style.css']) {
    assert.equal((await fetch(`${origin}${resource}`)).status, 200, `Missing packaged asset: ${resource}`);
  }
  assert.equal((await fetch(`${origin}/mcp`)).status, 401);
  console.log(`Installed ${metadata.name}@${metadata.version} successfully: 3 global CLI shims, initialization without overwrite, Runner configuration, live Server, assets and MCP authentication.`);
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => { server.once('exit', resolve); if (server.exitCode !== null) resolve(); });
  }
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('homeagent-package-test-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

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
let server, loginProcess, runner;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  child.kill();
  await closed;
}
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
  const home = path.join(temporary, 'profile');
  const cliEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete cliEnv.HOMEAGENT_SERVER; delete cliEnv.ALLOWED_ROOTS;
  const run = (name, args, expected = 0) => {
    const result = spawnSync(process.execPath, [path.join(packagePath, manifest.bin[name]), ...args], { cwd: working, env: cliEnv, encoding: 'utf8', windowsHide: true });
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
  await mkdir(path.dirname(config), { recursive: true });
  await writeFile(config, JSON.stringify({ server: 'http://localhost:3210', stateDir: state }));
  assert.equal(JSON.parse(run('homeagent', ['check-config', '--config', config])).valid, true);
  run('homeagent', ['init-runner'], 1);
  run('homeagent', ['pair'], 1);
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
  for (const resource of ['/assets/dashboard.js', '/assets/consent.js', '/assets/permissions.js', '/assets/ui.js', '/assets/style.css']) {
    assert.equal((await fetch(`${origin}${resource}`)).status, 200, `Missing packaged asset: ${resource}`);
  }
  assert.equal((await fetch(`${origin}/mcp`)).status, 401);

  // Exercise the installed top-level login/run commands, including a custom
  // config path followed by startup from another working directory.
  const managedConfig = path.join(working, 'private', 'managed runner.json');
  loginProcess = spawn(process.execPath, [path.join(packagePath, manifest.bin.homeagent), 'login', '--config', managedConfig, '--server', origin, '--name', 'Package managed Runner'], {
    cwd: working, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let loginOutput = '';
  for (const stream of [loginProcess.stdout, loginProcess.stderr]) stream.on('data', chunk => { loginOutput = (loginOutput + chunk.toString()).slice(-8192); });
  const loginClosed = new Promise(resolve => loginProcess.once('close', resolve));
  let verifyUrl;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(loginProcess.exitCode, null, `Installed login exited: ${loginOutput}`);
    verifyUrl = /https?:\/\/[^\s]+\/pair\/verify\?[^\s]+/.exec(loginOutput)?.[0];
    if (verifyUrl) break;
    await delay(100);
  }
  assert.ok(verifyUrl, `Installed login did not produce a verification URL: ${loginOutput}`);
  const password = /^ADMIN_PASSWORD=(.+)$/m.exec(initialEnv)[1].trim();
  const adminLogin = await fetch(origin + '/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }), redirect: 'manual' });
  assert.equal(adminLogin.status, 302);
  const cookie = adminLogin.headers.getSetCookie()[0].split(';')[0];
  const adminState = await (await fetch(origin + '/api/state', { headers: { cookie } })).json();
  const approvalUrl = new URL(verifyUrl);
  const approved = await fetch(origin + '/pair/verify', {
    method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-csrf-token': adminState.csrf },
    body: JSON.stringify({ id: approvalUrl.searchParams.get('id'), token: approvalUrl.searchParams.get('token'), root: project }), redirect: 'manual',
  });
  assert.equal(approved.status, 303, await approved.text());
  const loginTimeout = setTimeout(() => loginProcess.kill(), 15000);
  try { assert.equal(await loginClosed, 0, `Installed login failed: ${loginOutput}`); }
  finally { clearTimeout(loginTimeout); }
  assert.equal(Object.hasOwn(JSON.parse(await readFile(managedConfig, 'utf8')), 'projects'), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(home, '.homeagent', 'runner-location.json'), 'utf8')), { config: managedConfig });
  const checked = JSON.parse(run('homeagent', ['check-config']));
  assert.equal(checked.configFile, managedConfig);
  assert.equal(checked.projectConfiguration, 'server-managed');

  const otherDirectory = path.join(temporary, 'other-directory');
  await mkdir(otherDirectory);
  runner = spawn(process.execPath, [path.join(packagePath, manifest.bin.homeagent), 'run'], { cwd: otherDirectory, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let runnerOutput = '';
  for (const stream of [runner.stdout, runner.stderr]) stream.on('data', chunk => { runnerOutput = (runnerOutput + chunk.toString()).slice(-8192); });
  let applied = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    assert.equal(runner.exitCode, null, `Installed homeagent run exited: ${runnerOutput}`);
    const state = await (await fetch(origin + '/api/state', { headers: { cookie } })).json();
    if (state.devices.some(device => device.online && device.permissionAppliedRevision === 1 && device.projects.some(project => project.id === 'workspace'))) { applied = true; break; }
    await delay(100);
  }
  assert.ok(applied, `Installed homeagent run failed to apply the Server project: ${runnerOutput}`);
  console.log(`Installed ${metadata.name}@${metadata.version} successfully: 3 global CLI shims, initialization without overwrite, live Server, Web-only projects, login, remembered configuration and homeagent run from another directory.`);
} finally {
  await stop(runner);
  await stop(loginProcess);
  await stop(server);
  assert.equal(path.dirname(temporary), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('homeagent-package-test-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

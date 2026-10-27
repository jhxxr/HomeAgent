import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Tools } from '../src/runner/tools.js';
import { RunnerLock } from '../src/runner/lock.js';
import { JobMirror } from '../src/server/jobs.js';
import { Store, hash, secret } from '../src/server/store.js';
import { createHomeServer } from '../src/server/app.js';
import { Agent } from '../src/runner/agent.js';
import { projectGranted, type Principal, type ToolResult, type JobView } from '../src/shared/protocol.js';
import { fixture, freePort, waitFor, setDeviceProjects } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';
import { toolEnvironment } from '../src/runner/processes.js';

const owner: Principal = { id: 'parity-owner', scopes: ['read', 'write', 'execute', 'git'], devices: null, projects: null };
const data = (value: ToolResult) => JSON.parse(value.content[0]!.text);
test('directory continuation reaches every entry and read revisions reject changed continuation', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  for (let i = 0; i < 7; i++) await writeFile(path.join(f.root, `${i}.txt`), `content-${i}`);
  const names: string[] = [];
  let offset = 0;
  while (true) {
    const response = data(await tools.invoke('list_directory', { projectId: 'workspace', offset, limit: 2 }, owner));
    names.push(...response.entries.map((item: { name: string }) => item.name));
    if (response.nextOffset === null) break;
    offset = response.nextOffset;
  }
  assert.equal(new Set(names).size, 7); assert.equal(names.length, 7);
  const first = data(await tools.invoke('read_file', { projectId: 'workspace', path: '0.txt', length: 3 }, owner));
  const next = data(await tools.invoke('read_file', { projectId: 'workspace', path: '0.txt', offset: first.nextOffset, expectedRevision: first.revision }, owner));
  assert.equal(next.text, 'tent-0');
  await writeFile(path.join(f.root, '0.txt'), 'replacement');
  const rejected = await tools.invoke('read_file', { projectId: 'workspace', path: '0.txt', offset: first.nextOffset, expectedRevision: first.revision }, owner);
  assert.equal(data(rejected).error, 'conflict');
});

test('process idempotency survives concurrent retry and Runner restart without repeating side effects', async t => {
  const f = await fixture();
  let tools = new Tools(f.config);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const args = { projectId: 'workspace', executable: process.execPath, args: ['-e', 'require("fs").appendFileSync("side-effects.txt","once\\n")'], idempotencyKey: 'retry-stable-key' };
  const replies = await Promise.all(Array.from({ length: 4 }, () => tools.invoke('start_process', args, owner)));
  for (const response of replies) assert.ok(!response.isError, response.content[0]!.text);
  const ids = replies.map(response => data(response).id);
  assert.equal(new Set(ids).size, 1);
  await waitFor(async () => data(await tools.invoke('read_process_output', { projectId: 'workspace', processId: ids[0] }, owner)).finished);
  assert.equal(await readFile(path.join(f.root, 'side-effects.txt'), 'utf8'), 'once\n');
  assert.equal(data(await tools.invoke('start_process', { ...args, args: ['-e', 'console.log("different")'] }, owner)).error, 'idempotency_conflict');
  await tools.close(); tools = new Tools(f.config);
  const recovered = data(await tools.invoke('start_process', args, owner));
  assert.equal(recovered.id, ids[0]); assert.equal(recovered.replayed, true);
  assert.equal(await readFile(path.join(f.root, 'side-effects.txt'), 'utf8'), 'once\n');
});

test('Runner state lock excludes another OS process and automatically releases after its death', async t => {
  const f = await fixture();
  const filename = path.join(f.stateDir, 'runner-lock.sqlite');
  const child = spawn(process.execPath, ['--input-type=module', '-e', 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.argv[1]);db.exec("BEGIN EXCLUSIVE");console.log("locked");setInterval(()=>{},1000);', filename], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  t.after(async () => { if (child.exitCode === null) child.kill(); await f.cleanup(); });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); });
  await waitFor(() => output.includes('locked'));
  assert.throws(() => new RunnerLock(f.stateDir), /Another Runner/);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill(); await closed;
  const lock = new RunnerLock(f.stateDir); lock.close();
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
test('exiting leader cannot leave a background descendant outside the tracked job lifetime', async t => {
  const f = await fixture(), tools = new Tools(f.config);
  let descendant: number | undefined;
  t.after(async () => { if (descendant && alive(descendant)) { try { process.kill(descendant, 'SIGKILL'); } catch {} } await tools.close(); await f.cleanup(); });
  const childCode = 'require("fs").writeFileSync("descendant.pid",String(process.pid));setInterval(()=>{},1000)';
  const leaderCode = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:"ignore"});setTimeout(()=>process.exit(0),400)`;
  const started = data(await tools.invoke('start_process', { projectId: 'workspace', executable: process.execPath, args: ['-e', leaderCode] }, owner));
  assert.ok(started.id);
  descendant = await waitFor(async () => { try { return Number(await readFile(path.join(f.root, 'descendant.pid'), 'utf8')); } catch { return undefined; } });
  await waitFor(async () => data(await tools.invoke('read_process_output', { projectId: 'workspace', processId: started.id }, owner)).finished);
  await waitFor(async () => {
    if (!alive(descendant!)) return true;
    if (process.platform === 'linux') { try { return /\) Z /.test(await readFile(`/proc/${descendant}/stat`, 'utf8')); } catch { return true; } }
    return false;
  });
});

test('Windows supervisor closes its Job Object when the owning Runner process dies', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture();
  const helper = fileURLToPath(new URL('../runtime/windows-process-tree.ps1', import.meta.url));
  const childCode = 'require("fs").writeFileSync("runner-child.pid",String(process.pid));setInterval(()=>{},1000)';
  const hostCode = `const{spawn}=require("child_process");const supervisor=spawn("powershell.exe",["-NoProfile","-NonInteractive","-WindowStyle","Hidden","-File",process.argv[1],"-Executable",process.execPath,"-ArgumentsBase64",Buffer.from(JSON.stringify(["-e",${JSON.stringify(childCode)}])).toString("base64"),"-ParentPid",String(process.pid)],{windowsHide:true,stdio:"ignore"});require("fs").writeFileSync("supervisor.pid",String(supervisor.pid));setInterval(()=>{},1000);`;
  const host = spawn(process.execPath, ['-e', hostCode, helper], { cwd: f.root, windowsHide: true, stdio: 'ignore', env: toolEnvironment() });
  let ownedPid: number | undefined;
  let supervisorPid: number | undefined;
  t.after(async () => {
    if (host.exitCode === null) host.kill();
    if (ownedPid && alive(ownedPid)) { try { process.kill(ownedPid); } catch {} }
    if (supervisorPid && alive(supervisorPid)) { try { process.kill(supervisorPid); } catch {} }
    await f.cleanup();
  });
  ownedPid = await waitFor(async () => { try { return Number(await readFile(path.join(f.root, 'runner-child.pid'), 'utf8')); } catch { return undefined; } });
  supervisorPid = Number(await readFile(path.join(f.root, 'supervisor.pid'), 'utf8'));
  const exited = new Promise<void>(resolve => host.once('close', () => resolve())); host.kill(); await exited;
  await waitFor(() => !alive(ownedPid!) && !alive(supervisorPid!));
});

test('device-qualified project grants cannot expand to a new project or another device with the same project id', async t => {
  const f = await fixture(), deviceId = randomUUID(), other = randomUUID(), tools = new Tools(f.config, deviceId);
  t.after(async () => { await tools.close(); await f.cleanup(); });
  const principal: Principal = { ...owner, devices: [deviceId, other], projectGrants: { [deviceId]: ['workspace'], [other]: [] } };
  assert.equal(projectGranted(principal, deviceId, 'workspace'), true);
  assert.equal(projectGranted(principal, deviceId, 'new-project'), false);
  assert.equal(projectGranted(principal, other, 'workspace'), false);
  assert.ok(!(await tools.invoke('list_directory', { projectId: 'workspace' }, principal)).isError);
  assert.equal((await tools.invoke('list_directory', { projectId: 'workspace' }, { ...principal, projectGrants: { [other]: ['workspace'] } })).isError, true);
});

test('retained job observations reject changed ownership, old revisions and terminal-to-active regression', async t => {
  const f = await fixture(), store = new Store(path.join(f.directory, 'server.sqlite')), jobs = new JobMirror(store), deviceId = randomUUID();
  t.after(async () => { store.close(); await f.cleanup(); });
  const job: JobView = { id: randomUUID(), owner: owner.id, projectId: 'workspace', executable: 'node', revision: 1, started: Date.now(), state: 'running', outputBytes: 0, truncated: false };
  jobs.accept(deviceId, 'instance', job);
  assert.throws(() => jobs.accept(deviceId, 'instance', { ...job, revision: 2, owner: 'foreign' }), /cannot change/);
  jobs.accept(deviceId, 'instance', { ...job, revision: 3, state: 'exited', finished: Date.now(), exitCode: 0 });
  jobs.accept(deviceId, 'instance', { ...job, revision: 2 });
  assert.equal(jobs.get(deviceId, job.id)!.state, 'exited');
  assert.throws(() => jobs.accept(deviceId, 'instance', { ...job, revision: 4 }), /cannot become active/);
  jobs.reconcile(deviceId, new Set());
  assert.ok(jobs.get(deviceId, job.id)!.missingSince);
  assert.equal(jobs.list({ ...owner, id: 'foreign' }).length, 0);
});

test('Dashboard observes and controls exact Runner jobs without persisting output, and browser sessions are revocable', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'relay.sqlite'), password: 'parity-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  const deviceId = randomUUID(), raw = secret();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'device', tokenHash: hash(raw), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now() });
  f.config.server = base; setDeviceProjects(relay.store, deviceId, f.config); const agent = new Agent(f.config, { server: base, deviceId, token: raw }, () => {}); agent.start();
  const client = new Client({ name: 'parity', version: '1' });
  t.after(async () => { await client.close(); await agent.close(); await relay.close(); await f.cleanup(); });
  await waitFor(() => relay.hub.devices().some(device => device.online && device.permissionAppliedRevision === 0));
  const token = relay.store.mintToken({ ...owner, clientId: 'parity', kind: 'pat', family: randomUUID(), devices: [deviceId], expires: Date.now() + 60000 });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await fetch(base + '/api/jobs', { redirect: 'manual' })).status, 401);
  const login = () => fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ password: 'parity-admin-password' }), redirect: 'manual' });
  const cookie = (await login()).headers.getSetCookie()[0]!.split(';')[0]!;
  const otherCookie = (await login()).headers.getSetCookie()[0]!.split(';')[0]!;
  let state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as any;
  const otherSession = state.sessions.find((session: { current: boolean }) => !session.current);
  assert.equal(state.sessions.length, 2); assert.ok(!('csrf' in otherSession));
  const revoked = await fetch(base + `/api/sessions/${otherSession.id}/revoke`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: '{}' });
  assert.equal(revoked.status, 200); assert.equal((await fetch(base + '/api/state', { headers: { cookie: otherCookie }, redirect: 'manual' })).status, 401);
  const started = data(await client.callTool({ name: 'start_process', arguments: { deviceId, projectId: 'workspace', executable: process.execPath, args: ['-e', 'console.log("sensitive-job-output");setInterval(()=>{},1000)'], idempotencyKey: 'dashboard-job-test' } }) as ToolResult);
  await waitFor(() => relay.hub.jobs().find(job => job.id === started.id && job.outputBytes > 0 && job.available));
  state = await (await fetch(base + '/api/state', { headers: { cookie } })).json() as any;
  assert.ok(state.jobs.some((job: { id: string }) => job.id === started.id));
  assert.ok(!JSON.stringify(state).includes('sensitive-job-output'));
  const output = await (await fetch(base + `/api/jobs/${deviceId}/${started.id}/output`, { headers: { cookie } })).json() as any;
  assert.ok(output.output.includes('sensitive-job-output'));
  assert.ok(!JSON.stringify(relay.store.all('jobs')).includes('sensitive-job-output'));
  const stop = await fetch(base + `/api/jobs/${deviceId}/${started.id}/stop`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-csrf-token': state.csrf }, body: '{}' });
  assert.equal(stop.status, 200);
  await waitFor(() => relay.hub.jobs().some(job => job.id === started.id && job.state === 'stopped' && job.finished));
  assert.ok(relay.store.audits(100).some(entry => entry.principal === 'admin' && entry.tool === 'stop_process'));
});

test('revoking a credential cancels its in-flight dispatch and sends cancellation to the exact connection', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'relay.sqlite'), password: 'parity-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  const deviceId = randomUUID(), raw = secret(), family = randomUUID();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'fake', tokenHash: hash(raw), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now() });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/runner', { headers: { Authorization: `Bearer ${raw}`, 'X-Device-ID': deviceId } });
  t.after(async () => { socket.terminate(); await relay.close(); await f.cleanup(); });
  await new Promise<void>(resolve => socket.once('open', resolve));
  socket.on('message', frame => {
    const message = JSON.parse(frame.toString());
    if (message.type === 'welcome') socket.send(JSON.stringify({ type: 'permissions_applied', revision: message.permissions.revision, projects: [{ id: 'workspace', name: 'Workspace', readOnly: false, commands: [] }] }));
  });
  socket.send(JSON.stringify({ type: 'hello', protocol: 2, name: 'fake', platform: 'test', version: 'test', instanceId: randomUUID(), capabilities: ['read_file'], projects: [] }));
  await waitFor(() => relay.hub.devices().some(device => device.online && device.permissionAppliedRevision === 0));
  let dispatched = false, cancelled = false;
  const credential = relay.store.mintToken({ ...owner, kind: 'pat', family, clientId: 'revocation-test', expires: Date.now() + 60000 });
  socket.on('message', frame => { const message = JSON.parse(frame.toString()); if (message.type === 'call') dispatched = true; if (message.type === 'cancel') cancelled = true; });
  const running = relay.hub.invoke(owner, 'read_file', { deviceId, projectId: 'workspace', path: 'a' }, undefined, { family, tokenHash: hash(credential) });
  const rejected = assert.rejects(running, /Credential revoked/);
  await waitFor(() => dispatched); relay.store.revokeFamily(family); await rejected;
  await waitFor(() => cancelled);
  await assert.rejects(relay.hub.invoke(owner, 'read_file', { deviceId, projectId: 'workspace', path: 'a' }, undefined, { family, tokenHash: hash(credential) }), /no longer valid/);
});

test('a pause applied while the Runner is disconnected stops jobs when reconnection receives 403', async t => {
  const f = await fixture(), port = await freePort(), base = `http://127.0.0.1:${port}`;
  const relay = createHomeServer({ host: '127.0.0.1', port, publicUrl: base, db: path.join(f.directory, 'relay.sqlite'), password: 'parity-admin-password', sessionSecret: 's'.repeat(64), trustProxyHops: 0, retentionDays: 90 });
  await relay.listen();
  const deviceId = randomUUID(), raw = secret();
  relay.store.put('devices', deviceId, { id: deviceId, name: 'pause-test', tokenHash: hash(raw), revoked: false, paused: false, projects: [], platform: '', lastSeen: 0, created: Date.now() });
  f.config.server = base;
  setDeviceProjects(relay.store, deviceId, f.config);
  const agent = new Agent(f.config, { server: base, deviceId, token: raw }, () => {}); agent.start();
  t.after(async () => { await agent.close(); await relay.close(); await f.cleanup(); });
  await waitFor(() => relay.hub.devices().some(device => device.online && device.permissionAppliedRevision === 0));
  const started = data(await agent.tools.invoke('start_process', { projectId: 'workspace', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, owner));
  assert.ok(started.id);
  // Code 1001 emulates a server interruption, which normally allows the task to continue.
  relay.hub.close();
  const device = relay.store.get<any>('devices', deviceId)!;
  device.paused = true; relay.store.put('devices', deviceId, device);
  await waitFor(() => {
    const job = agent.tools.processes.list(owner.id, 'workspace').find(job => job.id === started.id);
    return job?.finished && job.state === 'stopped';
  });
});

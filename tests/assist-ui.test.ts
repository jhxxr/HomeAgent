import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareAssist, parseAssistLink, type AssistUi } from '../src/runner/assist.js';
import { assistConnectCommand } from '../public/assist.js';
import { ASSIST_MULTI_FEATURE } from '../src/shared/assist.js';
import { rememberRunnerConfigPath, runnerConfigLocationPath } from '../src/runner/config-location.js';
import { fixture, waitFor } from './helpers.js';

function invitation(t: TestContext) {
  const id = randomUUID(), authorizationId = randomUUID(), token = 'ha_assist_' + 'x'.repeat(43);
  const invite = { id, authorizationId, authorizationRevision: 0, operatorId: 'operator', operatorName: 'Friend', scopes: ['read', 'write'], maxDurationMinutes: 30, expiresAt: Date.now() + 600000, state: 'pending' };
  const requests: { route: string; body: any }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); requests.push({ route: url, body });
    if (url.endsWith('/inspect')) return Response.json({ feature: ASSIST_MULTI_FEATURE, invite });
    assert.ok(url.endsWith('/claim'));
    return Response.json({ feature: ASSIST_MULTI_FEATURE, descriptor: { sessionId: randomUUID(), deviceId: randomUUID(), inviteId: id, authorizationId, authorizationRevision: 0, operatorId: 'operator', deviceOwnerId: randomUUID(), localConsentRevision: 1, approval: body.approval }, token: 'ha_assist_device_' + 'y'.repeat(43) }, { status: 201 });
  });
  return { requests, token, link: `http://localhost:3210/assist#${new URLSearchParams({ id, token })}` };
}
function ui(root: string, selections: string[]) {
  const logs: string[] = [];
  const value: AssistUi = { async ask(title, fallback) { return title === '允许访问的本机项目' ? root : fallback; }, async select(_title, choices) { const answer = selections.shift(); assert.ok(answer === undefined || choices.some(choice => choice.value === answer)); return answer; }, log(text) { logs.push(text); } };
  return { value, logs };
}

test('Dashboard connection commands carry the Server origin in a quoted invitation argument', () => {
  const id = randomUUID(), token = 'ha_assist_' + 'x'.repeat(43);
  for (const server of ['https://assist.example.com', 'https://assist.example.com:8443', 'http://127.0.0.1:3210', 'http://[::1]:3210']) {
    const link = `${server}/assist#${new URLSearchParams({ id, token })}`, command = assistConnectCommand(link);
    assert.equal(command, `homeagent assist "${link}"`);
    assert.deepEqual(parseAssistLink(command.slice('homeagent assist "'.length, -1)), { server, id, token });
  }
  for (const host of ['$(touch).example.com', 'a`whoami`.example.com', '%USERNAME%.example.com']) {
    assert.throws(() => assistConnectCommand(`https://${host}/assist#id=${id}&token=${token}`));
  }
  assert.throws(() => assistConnectCommand(`https://assist.example.com/assist#id=${id}&token=${token}";anything`));
});

test('canceling assistance before project selection never claims or writes ordinary configuration', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const remote = invitation(t), local = ui(f.root, ['cancel']), home = path.join(f.directory, 'home');
  assert.equal(await prepareAssist(remote.link, local.value, home), undefined);
  assert.equal(remote.requests.length, 1);
  await assert.rejects(readdir(home), { code: 'ENOENT' });
  assert.ok(!local.logs.join('\n').includes(remote.token));
});

test('local assistance approval preserves saved configuration and credentials and final cancellation does not claim', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'home'), filename = path.join(f.directory, 'runner.json'), credential = path.join(f.stateDir, 'device.json');
  await writeFile(filename, JSON.stringify({ server: f.config.server, name: 'ordinary', stateDir: f.stateDir }));
  await writeFile(credential, 'ordinary-private-credential');
  await rememberRunnerConfigPath(filename, home);
  const before = await Promise.all([filename, credential, runnerConfigLocationPath(home)].map(file => readFile(file, 'utf8')));
  const remote = invitation(t), canceled = ui(f.root, ['continue', 'add', 'read', 'done', '30', 'next', 'next', 'cancel']);
  assert.equal(await prepareAssist(remote.link, canceled.value, home), undefined);
  assert.equal(remote.requests.filter(item => item.route.endsWith('/claim')).length, 0);
  const approved = ui(f.root, ['continue', 'add', 'write', 'done', '30', 'next', 'next', 'approve']);
  const prepared = await prepareAssist(remote.link, approved.value, home);
  assert.ok(prepared); prepared.consent.close();
  assert.notEqual(prepared.config.stateDir, f.stateDir);
  await assert.rejects(readFile(path.join(prepared.config.stateDir, 'device.json')), { code: 'ENOENT' });
  assert.deepEqual(await Promise.all([filename, credential, runnerConfigLocationPath(home)].map(file => readFile(file, 'utf8'))), before);
  assert.ok(!approved.logs.join('\n').includes(remote.token));
});

test('a saved private-state junction cannot be exposed through its canonical project directory', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'home'), privateRoot = path.join(f.outside, 'private'), alias = path.join(f.directory, 'private-alias'), filename = path.join(f.directory, 'runner.json');
  await mkdir(privateRoot);
  await symlink(privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(filename, JSON.stringify({ server: f.config.server, stateDir: alias }));
  await rememberRunnerConfigPath(filename, home);
  const remote = invitation(t), local = ui(f.outside, ['continue', 'add', 'read', 'done', 'cancel']);
  assert.equal(await prepareAssist(remote.link, local.value, home), undefined);
  assert.match(local.logs.join('\n'), /exclude Runner/);
  assert.equal(remote.requests.length, 1);
});

test('canceling a pending claim cannot bind or activate a late server response', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const remote = invitation(t), local = ui(f.root, ['continue', 'add', 'read', 'done', '30', 'next', 'next', 'approve']);
  const fetch = globalThis.fetch;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await fetch(...args);
    if (String(args[0]).endsWith('/claim')) await held;
    return response;
  });
  local.value.progress = async (_title, _description, run) => {
    const controller = new AbortController(), pending = run(controller.signal);
    await waitFor(() => remote.requests.some(item => item.route.endsWith('/claim')));
    controller.abort(new Error('Local approval canceled')); release();
    return pending;
  };
  await assert.rejects(prepareAssist(remote.link, local.value, path.join(f.directory, 'home')), /Local approval canceled/);
  assert.equal(remote.requests.filter(item => item.route.endsWith('/claim')).length, 1);
  assert.deepEqual(local.logs, []);
});

test('multiple local drafts keep stable IDs, independent scopes and an unticked review deadline', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const remote = invitation(t), shown: string[][] = [];
  const selections = ['continue', 'add', 'write', 'add', 'read', 'project:project-1', 'edit', 'read', 'done', '30', 'next', 'next', 'next', 'next', 'approve'];
  const roots = [f.root, f.outside, f.root], names = ['源码', '资料', '改名源码'];
  let reviewing = false;
  const local: AssistUi = {
    async ask(title) { return title === '允许访问的本机项目' ? roots.shift() : names.shift(); },
    async select(title, choices, description = []) {
      const answer = selections.shift(); assert.ok(choices.some(choice => choice.value === answer), `${title}: ${answer}`);
      if (title === '核对本机授权') { reviewing = true; shown.push(description); }
      if (title === '激活远程协助') assert.ok(reviewing);
      return answer;
    },
    log() {},
  };
  const prepared = await prepareAssist(remote.link, local, path.join(f.directory, 'home'));
  assert.ok(prepared); prepared.consent.close();
  const approval = remote.requests.find(item => item.route.endsWith('/claim'))!.body.approval;
  assert.deepEqual(approval.projects.map((project: any) => [project.id, project.name, project.scopes]), [['project-1', '改名源码', ['read']], ['project-2', '资料', ['read']]]);
  assert.equal(shown.length, 4);
  assert.ok(approval.approvedAt >= Date.now() - 5000);
  assert.equal(approval.expiresAt - approval.approvedAt, 1800000);
  assert.deepEqual(selections, []);
});

test('a multi-project Runner rejects an old Server without fallback or local state', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const remote = invitation(t), home = path.join(f.directory, 'home');
  const routes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => { routes.push(url); return new Response('Not Found', { status: 404 }); });
  await assert.rejects(prepareAssist(remote.link, ui(f.root, []).value, home), /升级 Server/);
  assert.equal(routes.length, 1); assert.ok(routes[0]!.endsWith('/assist/v2/inspect'));
  await assert.rejects(readdir(home), { code: 'ENOENT' });
});

test('the real CLI rejects non-TTY approval, including plain mode, without printing invitation secrets', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const home = path.join(f.directory, 'home'), token = 'ha_assist_' + 'x'.repeat(43);
  const link = `http://localhost:3210/assist#${new URLSearchParams({ id: randomUUID(), token })}`;
  try {
    await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/runner/cli.ts'), 'assist', link, '--plain'], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    assert.fail('non-TTY approval must fail');
  } catch (error) {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /interactive local terminal/);
    assert.ok(!(failure.stdout + failure.stderr).includes(token));
  }
  await assert.rejects(readdir(home), { code: 'ENOENT' });
});

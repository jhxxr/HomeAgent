import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runInteractiveApplication, type InteractiveDependencies } from '../src/runner/interactive.js';
import { saveRunnerSettings } from '../src/runner/config.js';
import { rememberRunnerConfigPath, runnerConfigLocationPath } from '../src/runner/config-location.js';
import { TuiCancelError, type TuiChoice, type RunnerState } from '../src/runner/tui.js';
import { fixture } from './helpers.js';

class ScriptedUi {
  states: RunnerState[] = [];
  logs: string[] = [];
  screens: string[] = [];
  started = false;
  stopped = false;
  actions: string[] = [];
  answers: (string | undefined)[] = [];
  selections: (string | undefined)[] = [];
  onWait?: () => void;
  start() { this.started = true; }
  stop() { this.stopped = true; }
  setState(state: RunnerState) { this.states.push(state); }
  updateInfo() {}
  log(text: string) { this.logs.push(text); }
  requestExit() {}
  async waitForAction() { this.onWait?.(); return this.actions.shift() ?? 'quit'; }
  async select(title: string, choices: TuiChoice[]) {
    this.screens.push(title);
    const answer = this.selections.shift();
    assert.ok(answer === undefined || choices.some(choice => choice.value === answer), `${title}: unexpected choice ${answer}`);
    return answer;
  }
  async ask(title: string, _value?: string, _description?: string[], validate?: (value: string) => string | undefined) {
    assert.ok(this.started, 'forms must only open after entering the full-screen UI');
    this.screens.push(title);
    const answer = this.answers.shift();
    if (answer !== undefined) assert.equal(validate?.(answer), undefined);
    return answer;
  }
  showProgress(title: string) { this.screens.push(title); }
  async progress<T>(title: string, _description: string[], run: (signal: AbortSignal) => Promise<T>) {
    this.showProgress(title);
    return run(new AbortController().signal);
  }
  async activity() { return undefined; }
}

async function sessionFixture() {
  const f = await fixture();
  const filename = path.join(f.directory, 'runner.json');
  const home = path.join(f.directory, 'home');
  const ui = new ScriptedUi();
  let starts = 0, closes = 0;
  const identity = { server: f.config.server, deviceId: randomUUID(), token: 'x'.repeat(64) };
  const deps: InteractiveDependencies = {
    home, ui, secureState: async () => {},
    createAgent: (_config, _credential, _log, state) => ({
      start() { starts++; state('connected', identity.deviceId); },
      async close() { closes++; state('stopped'); },
    }),
    pair: async (config, _force, _log, options) => {
      options?.onPairing?.({ verificationUrl: config.server + '/pair/verify?id=demo', code: '1234567890', expires: Date.now() + 600000 });
      const credential = { ...identity, server: config.server };
      await mkdir(config.stateDir, { recursive: true });
      await writeFile(path.join(config.stateDir, 'device.json'), JSON.stringify(credential));
      return credential;
    },
  };
  const saved = { server: f.config.server, name: 'demo', stateDir: f.stateDir };
  const login = async () => {
    await saveRunnerSettings(filename, saved);
    await writeFile(path.join(f.stateDir, 'device.json'), JSON.stringify(identity));
  };
  return { ...f, filename, home, ui, deps, login, saved, stats: () => ({ starts, closes }) };
}

test('a fresh session enters full-screen before login and connects immediately after browser approval', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  f.ui.actions = ['login', 'quit'];
  f.ui.answers = [f.config.server, '我的机器'];
  await runInteractiveApplication({ config: f.filename }, f.deps);
  assert.equal(f.ui.states[0], 'unpaired');
  assert.ok(f.ui.screens.includes('等待浏览器批准'));
  assert.deepEqual(f.stats(), { starts: 1, closes: 1 });
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).name, '我的机器');
  assert.deepEqual(JSON.parse(await readFile(runnerConfigLocationPath(f.home), 'utf8')), { config: f.filename });
  assert.ok(f.ui.stopped);
});

test('a paired session starts directly without showing a login form', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  await runInteractiveApplication({ config: f.filename }, f.deps);
  assert.deepEqual(f.stats(), { starts: 1, closes: 1 });
  assert.deepEqual(f.ui.screens, []);
});

test('canceling first-time login leaves no configuration or credential behind', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  f.ui.actions = ['login', 'quit'];
  f.ui.answers = [undefined];
  await runInteractiveApplication({ config: f.filename }, f.deps);
  await assert.rejects(readFile(f.filename), { code: 'ENOENT' });
  assert.deepEqual(f.stats(), { starts: 0, closes: 0 });
});

test('stale remembered paths remain in full-screen until the user selects a configuration', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  await rememberRunnerConfigPath(path.join(f.directory, 'removed.json'), f.home);
  f.ui.actions = ['config', 'quit'];
  f.ui.answers = [f.filename];
  await runInteractiveApplication({}, f.deps);
  assert.ok(f.ui.logs.some(text => text.includes('moved or removed')));
  assert.ok(f.ui.screens.includes('选择配置文件'));
  assert.deepEqual(f.stats(), { starts: 1, closes: 1 });
});

test('runtime settings are validated, saved and applied by restarting one Runner', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  f.ui.actions = ['settings', 'quit'];
  f.ui.selections = ['maxProcesses', 'confirm', 'back'];
  f.ui.answers = ['4'];
  await runInteractiveApplication({ config: f.filename }, f.deps);
  const saved = JSON.parse(await readFile(f.filename, 'utf8'));
  assert.equal(saved.maxProcesses, 4);
  assert.ok(!Object.hasOwn(saved, 'projects'));
  assert.deepEqual(f.stats(), { starts: 2, closes: 2 });
});

test('logout only removes the selected local credential after explicit confirmation', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  f.ui.actions = ['settings', 'quit'];
  f.ui.selections = ['logout', 'confirm'];
  await runInteractiveApplication({ config: f.filename }, f.deps);
  await assert.rejects(readFile(path.join(f.stateDir, 'device.json')), { code: 'ENOENT' });
  assert.ok(await readFile(f.filename));
  assert.equal(f.ui.states.at(-1), 'unpaired');
});

test('a canceled relogin preserves the current credential and resumes the previous connection', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  const before = await readFile(path.join(f.stateDir, 'device.json'), 'utf8');
  f.ui.actions = ['login', 'quit'];
  f.ui.answers = [f.config.server, 'demo'];
  f.ui.selections = ['confirm'];
  f.deps.pair = async () => { throw new TuiCancelError('cancel'); };
  await runInteractiveApplication({ config: f.filename }, f.deps);
  assert.equal(await readFile(path.join(f.stateDir, 'device.json'), 'utf8'), before);
  assert.deepEqual(f.stats(), { starts: 2, closes: 2 });
});

test('switching services uses independent credentials and preserves the old device identity', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  const before = await readFile(path.join(f.stateDir, 'device.json'), 'utf8');
  f.ui.actions = ['login', 'quit'];
  f.ui.answers = ['https://another.example.com', 'other-device'];
  f.ui.selections = ['confirm'];
  await runInteractiveApplication({ config: f.filename }, f.deps);
  const saved = JSON.parse(await readFile(f.filename, 'utf8'));
  assert.equal(saved.server, 'https://another.example.com');
  assert.notEqual(saved.stateDir, f.stateDir);
  assert.equal(await readFile(path.join(f.stateDir, 'device.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(path.join(saved.stateDir, 'device.json'), 'utf8')).server, saved.server);
});

test('enabling autostart closes the foreground Runner before handing over to the service', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  f.ui.actions = ['settings', 'quit'];
  f.ui.selections = ['service-install', 'confirm', 'back', 'back'];
  let installed = false;
  f.deps.service = async (_config, filename, uninstall) => {
    assert.equal(filename, f.filename);
    assert.equal(uninstall, false);
    assert.deepEqual(f.stats(), { starts: 1, closes: 1 });
    installed = true;
  };
  await runInteractiveApplication({ config: f.filename }, f.deps);
  assert.ok(installed);
  assert.deepEqual(f.stats(), { starts: 1, closes: 1 });
});

test('late status callbacks from an old connection cannot overwrite a restarted Runner', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  f.ui.actions = ['settings', 'quit'];
  f.ui.selections = ['maxProcesses', 'confirm', 'back'];
  f.ui.answers = ['4'];
  const callbacks: ((state: RunnerState, detail?: string) => void)[] = [];
  f.deps.createAgent = (_config, _credential, _log, onState) => {
    const index = callbacks.push(onState) - 1;
    return {
      start() {
        onState('connected');
        if (index > 0) callbacks[index - 1]!('stopped');
      },
      async close() { onState('stopped'); },
    };
  };
  f.ui.onWait = () => assert.equal(f.ui.states.at(-1), 'connected');
  await runInteractiveApplication({ config: f.filename }, f.deps);
  assert.equal(callbacks.length, 2);
});

test('canceling an explicit login does not label an existing authenticated device as signed out', async t => {
  const f = await sessionFixture(); t.after(f.cleanup);
  await f.login();
  f.ui.answers = [undefined];
  f.ui.onWait = () => assert.equal(f.ui.states.at(-1), 'stopped');
  await runInteractiveApplication({ config: f.filename, login: true }, f.deps);
  assert.deepEqual(f.stats(), { starts: 0, closes: 0 });
  assert.ok(await readFile(path.join(f.stateDir, 'device.json')));
});

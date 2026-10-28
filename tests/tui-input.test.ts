import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { RunnerTui, TuiCancelError, TuiExitError, renderRunnerScreen, stripAnsi, displayWidth } from '../src/runner/tui.js';

const info = { device: 'demo', server: '尚未设置服务地址', config: '~/.homeagent/runner.json', node: process.version, platform: 'win32', arch: 'x64' };

function interactiveTerminal(color = false) {
  const chunks: string[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(enabled: boolean) { this.isRaw = enabled; return this; },
  });
  input.pause();
  const stream = Object.assign(new EventEmitter(), { write: (text: string) => chunks.push(text), columns: 100, rows: 30 });
  const ui = new RunnerTui({ ...info }, {
    stream,
    input: input as unknown as NodeJS.ReadStream, interactive: true, keepOpenOnStop: true, color,
  });
  ui.setState('unpaired');
  ui.start();
  const key = (sequence: string | Buffer) => input.write(sequence);
  const point = (label: string) => {
    const frame = chunks.findLast(chunk => chunk.includes(`\x1b[${stream.rows};1H`))!;
    for (const match of frame.matchAll(/\x1b\[(\d+);1H\x1b\[2K(.*?)(?=\x1b\[\d+;1H|\x1b\[H|$)/g)) {
      const text = stripAnsi(match[2]!);
      const index = text.indexOf(label);
      if (index >= 0) return { x: displayWidth(text.slice(0, index)) + 1, y: Number(match[1]) };
    }
    throw new Error(`Missing visible control: ${label}`);
  };
  const click = (x: number, y: number) => key(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  const clickLabel = (label: string) => { const p = point(label); click(p.x, p.y); };
  const hover = (x: number, y: number) => key(`\x1b[<35;${x};${y}M`);
  return { ui, input, chunks, stream, key, click, clickLabel, point, hover };
}

test('unsigned-in welcome screen remains full-screen and Enter starts login', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const text = renderRunnerScreen(info, 'unpaired', undefined, [], { columns: 100, rows: 30, interactive: true }).join('\n');
  assert.ok(text.includes('尚未登录'));
  assert.ok(text.includes('Enter 登录设备'));
  assert.ok(f.chunks[0]!.includes('\x1b[?1049h'));
  const action = f.ui.waitForAction();
  f.key('\r');
  assert.equal(await action, 'login');
  assert.equal(f.input.isRaw, true);
  f.ui.stop();
  assert.equal(f.input.isRaw, false);
  assert.equal(f.input.isPaused(), true);
  assert.equal(f.input.listenerCount('keypress'), 0);
});

test('keyboard menus support selection and Escape returns without applying an action', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const choices = [{ value: 'cancel', label: '取消' }, { value: 'save', label: '保存' }];
  const selection = f.ui.select('保存设置', choices);
  f.key('\x1b[B'); f.key('\r');
  assert.equal(await selection, 'save');
  const canceled = f.ui.select('保存设置', choices);
  // Emit Escape directly: readline otherwise waits to distinguish escape sequences.
  f.key('\x1b');
  assert.equal(await canceled, undefined);
});

test('mouse tracking is enabled for interactive sessions and clicks activate actions and choices', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  assert.ok(f.chunks.join('').includes('\x1b[?1000h') && f.chunks.join('').includes('\x1b[?1006h'));
  assert.ok(f.chunks.join('').includes('\x1b[?1003h'));
  const action = f.ui.waitForAction();
  f.clickLabel('[Enter 登录]');
  assert.equal(await action, 'login');
  const selection = f.ui.select('设置', [{ value: 'back', label: '返回' }, { value: 'save', label: '保存' }]);
  f.clickLabel('返回');
  assert.equal(await selection, 'back');
  f.ui.stop();
  const output = f.chunks.join('');
  assert.ok(output.includes('\x1b[?1006l') && output.includes('\x1b[?1000l'));
  assert.ok(output.includes('\x1b[?1003l'));
});

const HOVER = '\x1b[1;38;2;240;245;255;48;2;43;53;72m';
const PRESSED = '\x1b[1;38;2;255;255;255;48;2;7;85;255m';

test('pointer hover shades a clickable footer without activating it and clears on leaving', async t => {
  const f = interactiveTerminal(true); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  const p = f.point('[s 设置]');
  f.hover(p.x, p.y);
  assert.ok(f.chunks.at(-1)!.includes(HOVER + '[s 设置]'));
  const count = f.chunks.length;
  f.hover(p.x + 1, p.y);
  assert.equal(f.chunks.length, count, 'movement within the same button must not redraw');
  f.hover(1, 2);
  assert.ok(!f.chunks.at(-1)!.includes(HOVER));
  f.key('c');
  assert.equal(await action, 'config', 'hover must never trigger the button');
});

test('pressing a hovered button provides stronger shading, and dragging away cancels activation', async t => {
  const f = interactiveTerminal(true); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  const p = f.point('[s 设置]');
  f.hover(p.x, p.y);
  f.key(`\x1b[<0;${p.x};${p.y}M`);
  assert.ok(f.chunks.at(-1)!.includes(PRESSED + '[s 设置]'));
  f.key('\x1b[<32;1;2M');
  assert.ok(!f.chunks.at(-1)!.includes(PRESSED));
  f.key('\x1b[<0;1;2m');
  f.key('c');
  assert.equal(await action, 'config');
});

test('hover shades an entire menu row without moving keyboard selection', async t => {
  const f = interactiveTerminal(true); t.after(() => f.ui.stop());
  const selection = f.ui.select('设置', [{ value: 'back', label: '取消' }, { value: 'save', label: '保存' }]);
  const p = f.point('保存');
  f.hover(p.x + 20, p.y); // Blank padding within the same clickable menu row.
  assert.ok(f.chunks.at(-1)!.includes(HOVER + '  保存'));
  f.key('\r');
  assert.equal(await selection, 'back');
});

test('input hover provides a shaded edit area without changing the text or cursor', async t => {
  const f = interactiveTerminal(true); t.after(() => f.ui.stop());
  const answer = f.ui.ask('设备名称', '中文demo');
  const p = f.point('中文demo');
  f.hover(p.x + 1, p.y);
  assert.ok(f.chunks.at(-1)!.includes(HOVER + '中文demo'));
  f.key('X');
  f.key('\r');
  assert.equal(await answer, '中文demoX');
});

test('resizing, changing dialogs and disabling mouse tracking clear stale hover shading', async t => {
  const f = interactiveTerminal(true); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  const p = f.point('[s 设置]');
  f.hover(p.x, p.y);
  f.stream.columns = 80;
  f.stream.emit('resize');
  assert.ok(!f.chunks.at(-1)!.includes(HOVER));
  const next = f.point('[s 设置]');
  f.hover(next.x, next.y);
  f.key('m');
  assert.ok(!f.chunks.at(-1)!.includes(HOVER));
  assert.ok(f.chunks.join('').includes('\x1b[?1003l'));
  f.key('s');
  assert.equal(await action, 'settings');
  const menu = f.ui.select('设置', [{ value: 'back', label: '返回' }]);
  assert.ok(!f.chunks.at(-1)!.includes(HOVER));
  f.key('\r');
  await menu;
});

test('monochrome hover uses inverse text as a visible fallback', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  const p = f.point('[s 设置]');
  f.hover(p.x, p.y);
  assert.ok(f.chunks.at(-1)!.includes('\x1b[7m[s 设置]'));
  f.clickLabel('[s 设置]');
  assert.equal(await action, 'settings');
});

test('mouse wheel changes a selection without submitting it', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const selection = f.ui.select('设置', [{ value: 'first', label: '第一项' }, { value: 'second', label: '第二项' }]);
  f.key('\x1b[<65;3;7M'); // Real SGR wheel events have no release.
  f.key('\r');
  assert.equal(await selection, 'second');
});

test('each visible footer button maps to its action at different viewport widths', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  for (const columns of [80, 140]) {
    f.stream.columns = columns;
    f.ui.setState('connected');
    for (const [label, expected] of [['[s 设置]', 'settings'], ['[a 活动]', 'activity'], ['[o 网页]', 'web'], ['[p 暂停/连接]', 'toggle']]) {
      const action = f.ui.waitForAction();
      f.clickLabel(label!);
      assert.equal(await action, expected);
    }
  }
});

test('wheel scrolling and clicking a visible menu entry uses its actual index, not its screen row', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const selection = f.ui.select('设置', Array.from({ length: 40 }, (_, i) => ({ value: String(i), label: `选项 ${i}` })), ['说明']);
  for (let i = 0; i < 35; i++) f.key('\x1b[<65;30;15M');
  f.clickLabel('选项 34');
  assert.equal(await selection, '34');
});

test('right-click, release-only packets and clicks on blank areas do not activate controls', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('测试表单', 'abc');
  const point = f.point('[Enter 确认]');
  f.key(`\x1b[<2;${point.x};${point.y}M\x1b[<2;${point.x};${point.y}m`);
  f.key(`\x1b[<0;${point.x};${point.y}m`);
  f.click(1, 2);
  f.key('d');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, 'abcd');
});

test('mouse packets split across raw input chunks never contaminate text fields', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('测试表单', 'name');
  f.key('\x1b[<0;'); f.key('1;2M\x1b[<0;1;'); f.key('2m');
  f.key('X');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, 'nameX');
});

test('clicking CJK input text places the cursor by terminal cells', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('设备名称', '中文ab');
  const p = f.point('中文ab');
  f.click(p.x + 4, p.y);
  f.key('X');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, '中文Xab');
});

test('clicking a horizontally scrolled field respects the visible text offset', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  f.stream.columns = 40;
  const value = '0123456789'.repeat(12);
  const answer = f.ui.ask('长输入', value);
  const p = f.point('› 901234');
  f.click(p.x + 2, p.y);
  f.key('X');
  f.key('\r');
  const result = await answer;
  assert.equal(result!.replace('X', ''), value);
  assert.equal(result!.indexOf('X'), 120 - (39 - 8));
});

test('pasting single-line text is atomic and never submits a form or triggers app shortcuts', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('服务地址');
  f.key('\x1b[200~https://example.com\nq\x03s\x1b[201~');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, 'https://example.com qs');
  const action = f.ui.waitForAction();
  f.key('\x1b[200~qso\x1b[201~');
  f.key('s');
  assert.equal(await action, 'settings');
});

test('clickable clear, validation and back controls preserve input semantics', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('不能为空', 'old', [], text => text ? undefined : '请输入内容');
  f.clickLabel('[Ctrl+U 清空]');
  f.clickLabel('[Enter 确认]');
  assert.ok(f.chunks.at(-1)!.includes('请输入内容'));
  f.clickLabel('[Esc 返回]');
  assert.equal(await answer, undefined);
});

test('pairing buttons open the browser and cancel without making the whole footer clickable', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  let opened = 0;
  const progress = f.ui.progress('批准登录', ['设备 demo'], signal => new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), async () => { opened++; });
  f.click(99, 30);
  assert.equal(opened, 0);
  f.clickLabel('[o 打开登录页面]');
  assert.equal(opened, 1);
  f.clickLabel('[Esc 取消]');
  await assert.rejects(progress, TuiCancelError);
});

test('resizing between press and release cannot activate a moved control', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('设备名称', 'name');
  const p = f.point('[Enter 确认]');
  f.key(`\x1b[<0;${p.x};${p.y}M`);
  f.stream.rows = 24; f.stream.columns = 80;
  f.stream.emit('resize');
  f.key(`\x1b[<0;${p.x};${p.y}m`);
  f.key('X');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, 'nameX');
});

test('mouse mode can be disabled for terminal selection and resumed without leaving the prompt', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  f.clickLabel('[m 鼠标开]');
  assert.ok(f.chunks.join('').includes('\x1b[?1006l\x1b[?1000l'));
  f.clickLabel('[s 设置]'); // Ignored until mouse mode is explicitly restored.
  f.key('m');
  f.clickLabel('[c 选择配置]');
  assert.equal(await action, 'config');
});

test('pressing on a control and releasing outside does not confirm it', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('设备名称', 'demo');
  const p = f.point('[Enter 确认]');
  f.key(`\x1b[<0;${p.x};${p.y}M\x1b[<0;1;2m`);
  f.key('X');
  f.clickLabel('[Enter 确认]');
  assert.equal(await answer, 'demoX');
});

test('clicking the welcome login entry is supported as well as the footer shortcut', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const action = f.ui.waitForAction();
  f.clickLabel('Enter 登录设备');
  assert.equal(await action, 'login');
});

test('forms validate input, support editing Unicode and keep cancellation reversible', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  const answer = f.ui.ask('设备名称', 'old', [], value => value ? undefined : '不能为空');
  f.key('\x15'); f.key('\r');
  assert.ok(f.chunks.at(-1)!.includes('不能为空'));
  f.key('机器👩‍💻'); f.key('\x7f'); f.key('\r');
  assert.equal(await answer, '机器');
  const canceled = f.ui.ask('服务地址', 'https://example.com');
  f.key('\x1b');
  assert.equal(await canceled, undefined);
});

test('pairing progress can open the approval link and abort without leaving the UI', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  let opened = 0;
  const progress = f.ui.progress('等待浏览器批准', ['demo login'], signal =>
    new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  async () => { opened++; });
  f.key('o');
  assert.equal(opened, 1);
  f.key('\x1b');
  await assert.rejects(progress, TuiCancelError);
  const action = f.ui.waitForAction();
  f.key('s');
  assert.equal(await action, 'settings');
});

test('Ctrl+C cancels a prompt and restores raw mode and the original screen', async () => {
  const f = interactiveTerminal();
  const answer = f.ui.ask('登录');
  f.key('\x03');
  await assert.rejects(answer, TuiExitError);
  f.ui.stop();
  assert.equal(f.input.isRaw, false);
  assert.ok(f.chunks.join('').endsWith('\x1b[?1049l\x1b[?25h'));
  await assert.rejects(f.ui.waitForAction(), TuiExitError);
});

test('stopping does not leave a previously idle stdin resumed and keep Node alive', () => {
  const chunks: string[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false,
    setRawMode(enabled: boolean) { this.isRaw = enabled; return this; },
  });
  assert.equal(input.readableFlowing, null);
  const ui = new RunnerTui({ ...info }, {
    stream: { write: text => chunks.push(text) }, input: input as unknown as NodeJS.ReadStream, interactive: true,
  });
  ui.start(); ui.stop();
  assert.equal(input.isRaw, false);
  assert.equal(input.isPaused(), true);
});

test('an already-confirmed system change does not report cancellation after it has been applied', async t => {
  const f = interactiveTerminal(); t.after(() => f.ui.stop());
  let complete!: () => void;
  let signal!: AbortSignal;
  const applying = f.ui.progress('更新自启动', [], activeSignal => {
    signal = activeSignal;
    return new Promise<void>(resolve => { complete = resolve; });
  }, undefined, false);
  f.key('\x1b');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(signal.aborted, false);
  complete();
  await applying;
});

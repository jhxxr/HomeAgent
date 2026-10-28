import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerTui, colorEnabled, displayWidth, renderLogo, renderRunnerCard, renderStatus, truecolorEnabled, truncate, tuiEnabled } from '../src/runner/tui.js';
import { VERSION } from '../src/shared/protocol.js';

const info = {
  version: VERSION,
  node: 'v24.14.0',
  platform: 'win32',
  arch: 'x64',
  device: 'DESKTOP-1',
  server: 'http://localhost:3210',
  config: '~/.homeagent/runner.json',
};

test('runner startup card centers the brand mark and reports runtime details', () => {
  const lines = renderRunnerCard(info, { columns: 80, color: false });
  assert.equal(lines.length, 18);
  assert.equal(new Set(lines.map(displayWidth)).size, 1);
  const text = lines.join('\n');
  for (const value of ['HomeAgent Runner', `v${VERSION}`, 'DESKTOP-1', 'http://localhost:3210', '~/.homeagent/runner.json', 'v24.14.0 · win32/x64']) {
    assert.ok(text.includes(value), `card should include ${value}`);
  }
  assert.ok(!text.includes('\x1b'));
  assert.ok(text.includes('│'));
});

test('colored card renders the detailed brand mark without changing its width', () => {
  const plain = renderRunnerCard(info, { columns: 80, color: false });
  const colored = renderRunnerCard(info, { columns: 80, color: true });
  assert.deepEqual(colored.map(displayWidth), plain.map(displayWidth));
  const text = colored.join('\n');
  assert.ok(text.includes('\x1b[38;2;7;85;255m'));
  assert.ok(text.includes('\x1b[38;2;255;101;62m'));
  assert.ok(/[▘▝▀▖▌▞▛▗▚▐▜▄▙▟█]/.test(text));
  assert.ok(text.includes('╭'));

});

test('narrow terminals fall back to a compact card that never wraps', () => {
  const lines = renderRunnerCard(info, { columns: 36, color: false });
  assert.ok(lines.every(line => displayWidth(line) <= 36));
  assert.ok(!lines.join('\n').includes('▀'));
  assert.ok(lines.join('\n').includes(`v${VERSION}`));
});

test('the icon preserves its cell bounds at both detail levels', () => {
  const logo = renderLogo(true);
  assert.equal(logo.length, 16);
  assert.ok(logo.every(line => displayWidth(line) === 32));
  assert.equal(renderLogo(false).length, 16);
  assert.equal(renderLogo(true, 40).length, 20);
  assert.ok(renderLogo(true, 40).every(line => displayWidth(line) === 40));
});

test('display widths count East Asian characters and ignore ANSI escapes', () => {
  assert.equal(displayWidth('设备'), 4);
  assert.equal(displayWidth('\x1b[31mred\x1b[0m'), 3);
  assert.equal(displayWidth('Node v24'), 8);
  assert.equal(truncate('abcdefgh', 5), 'abcd…');
  assert.equal(truncate('中文测试', 5), '中文…');
  assert.equal(truncate('abc', 5), 'abc');
});

test('status lines describe the connection lifecycle', () => {
  assert.ok(renderStatus('connecting', undefined, false, 0).includes('正在连接'));
  assert.ok(renderStatus('connected', 'device-1', false).includes('已连接 · device-1'));
  assert.ok(renderStatus('reconnecting', '5s', false, 0).includes('5s 后重试'));
  assert.equal(renderStatus('stopped', undefined, false), '■ 已停止');
  assert.ok(renderStatus('connected', 'device-1', true).includes('\x1b['));
});

test('TUI activation respects TTY, CI and NO_COLOR configuration', () => {
  assert.equal(tuiEnabled({ isTTY: false }, {}), false);
  assert.equal(tuiEnabled({ isTTY: true }, {}), true);
  assert.equal(tuiEnabled({ isTTY: true }, { HOMEAGENT_TUI: '0' }), false);
  assert.equal(tuiEnabled({ isTTY: false }, { HOMEAGENT_TUI: '1' }), false);
  assert.equal(tuiEnabled({ isTTY: true }, { CI: 'true' }), false);
  assert.equal(colorEnabled({}), true);
  assert.equal(colorEnabled({ NO_COLOR: '' }), false);
  assert.equal(colorEnabled({ FORCE_COLOR: '0' }), false);
  assert.equal(colorEnabled({ TERM: 'dumb' }), false);
  assert.equal(truecolorEnabled({}, { COLORTERM: 'truecolor' }), true);
  assert.equal(truecolorEnabled({}, { NO_COLOR: '' }), false);
  assert.equal(truecolorEnabled({ getColorDepth: () => 8 }, {}), false);
  assert.equal(truecolorEnabled({ getColorDepth: () => 24 }, {}), true);
});

test('interactive renderer prints the card, pins status below logs and restores the cursor', () => {
  const chunks: string[] = [];
  const stream = { write: (chunk: string) => { chunks.push(chunk); return true; }, columns: 80, isTTY: true };
  const tui = new RunnerTui(info, { stream, color: false });
  tui.start();
  tui.setState('connected', 'device-1');
  tui.log('Runner connected');
  tui.stop();
  const output = chunks.join('');
  assert.ok(output.includes('HomeAgent Runner'));
  assert.ok(output.includes('已连接 · device-1'));
  assert.ok(output.includes('Runner connected\n'));
  assert.ok(output.includes('已停止'));
  assert.ok(output.includes('\x1b[?25l') && output.includes('\x1b[?25h'));
  assert.ok(output.includes('\x1b[2K'));
});


test('cards fit tiny terminals, custom widths and untrusted device names', () => {
  for (const columns of [1, 8, 20, 24, 31, 36, 60, 80, 120]) {
    const lines = renderRunnerCard({ ...info, device: '开发👩‍💻e\u0301\n\x1b[2J\x1b]0;injected\x07' }, { columns, color: false });
    assert.ok(lines.every(line => displayWidth(line) < columns || columns === 1 && !line));
    assert.ok(lines.every(line => !/[\n\r\x1b\x07]/.test(line)));
    assert.ok(!lines.join('').includes('injected'));
  }
  const lines = renderRunnerCard(info, { columns: 120, width: 60, color: false });
  assert.equal(new Set(lines.map(displayWidth)).size, 1);
  assert.equal(displayWidth(lines[0]!.trimStart()), 60);
  assert.equal(displayWidth('e\u0301👩‍💻🇨🇳'), 5);
  assert.equal(truncate('abc', 0), '');
});

test('status stays on one line after resize and restores cursor on agent stop', () => {
  const chunks: string[] = [];
  const stream = { write: (chunk: string) => { chunks.push(chunk); return true; }, columns: 80, isTTY: true };
  const tui = new RunnerTui(info, { stream, color: false });
  tui.start();
  stream.columns = 20;
  tui.setState('connected', '设备'.repeat(100));
  assert.ok(displayWidth(chunks.at(-1)!.replace(/\r/g, '')) < 20);
  tui.setState('stopped');
  assert.ok(chunks.join('').endsWith('\x1b[?25h'));
  const count = chunks.length;
  tui.stop();
  assert.equal(chunks.length, count);
});

test('reconnect countdown decreases as time advances', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const chunks: string[] = [];
  const tui = new RunnerTui(info, { stream: { write: chunk => chunks.push(chunk), columns: 80 }, color: false });
  t.after(() => tui.stop());
  tui.start();
  tui.setState('reconnecting', '5s');
  t.mock.timers.tick(2100);
  assert.ok(chunks.at(-1)!.includes('3s 后重试'));
});

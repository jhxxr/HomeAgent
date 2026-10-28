import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalInput, type TerminalMouseEvent } from '../src/runner/terminal-input.js';

function fixture() {
  const keys: string[] = [], mouse: TerminalMouseEvent[] = [], pastes: string[] = [];
  const parser = new TerminalInput({ keyboard: text => keys.push(text), mouse: event => mouse.push(event), paste: text => pastes.push(text) });
  return { parser, keys, mouse, pastes };
}

test('split and coalesced SGR mouse packets are consumed before keyboard decoding', t => {
  const f = fixture(); t.after(() => f.parser.close());
  f.parser.feed('a\x1b[<');
  f.parser.feed('0;40;');
  f.parser.feed('12M\x1b[<0;40;12m\x1b[<65;40;12M\x1b[A');
  assert.equal(f.keys.join(''), 'a\x1b[A');
  assert.deepEqual(f.mouse.map(event => [event.button, event.type, event.x, event.y]), [
    ['left', 'press', 40, 12], ['left', 'release', 40, 12], ['wheel-down', 'press', 40, 12],
  ]);
});

test('UTF-8 code points survive byte boundaries and invalid reports never leak their payload', t => {
  const f = fixture(); t.after(() => f.parser.close());
  const bytes = Buffer.from('开发👩‍💻');
  for (const byte of bytes) f.parser.feed(Buffer.from([byte]));
  f.parser.feed('\x1b[<0;0;0M\x1b[<nope\x1b[<0;1;1M');
  assert.equal(f.keys.join(''), '开发👩‍💻');
  assert.equal(f.mouse.length, 1);
});

test('bracketed paste is framed across chunks, bounded and delivered without keyboard shortcuts', t => {
  const f = fixture(); t.after(() => f.parser.close());
  f.parser.feed('\x1b[20');
  f.parser.feed('0~q\rs\x03\x1b[<0;1;1M');
  f.parser.feed('abc\x1b[20');
  f.parser.feed('1~\x1b[D');
  assert.deepEqual(f.pastes, ['q\rs\x03\x1b[<0;1;1Mabc']);
  assert.deepEqual(f.keys, ['\x1b[D']);
  assert.deepEqual(f.mouse, []);
  f.parser.feed('\x1b[200~' + 'x'.repeat(50000) + '\x1b[201~');
  assert.equal(f.pastes[1]!.length, 16384);
});

test('Escape ambiguity is bounded and an incomplete mouse report is discarded on timeout', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); t.after(() => f.parser.close());
  f.parser.feed('\x1b');
  t.mock.timers.tick(40);
  assert.deepEqual(f.keys, ['\x1b']);
  f.parser.feed('\x1b[<0;20;');
  t.mock.timers.tick(250);
  f.parser.feed('x');
  assert.deepEqual(f.keys, ['\x1b', 'x']);
  assert.deepEqual(f.mouse, []);
});

test('mouse modifiers, wheel releases and right clicks remain distinguishable; device reports are not keys', t => {
  const f = fixture(); t.after(() => f.parser.close());
  f.parser.feed('\x1b[<4;5;6M\x1b[<2;5;6M\x1b[<65;5;6m\x1b[<32;5;6M\x1b[?1;2c\x1b[I');
  assert.equal(f.mouse[0]!.modified, true);
  assert.equal(f.mouse[1]!.button, 'right');
  assert.equal(f.mouse[2]!.type, 'release');
  assert.equal(f.mouse[3]!.type, 'motion');
  assert.deepEqual(f.keys, []);
});

test('unpressed pointer motion is decoded independently from clicks and keyboard text', t => {
  const f = fixture(); t.after(() => f.parser.close());
  f.parser.feed('\x1b[<35;');
  f.parser.feed('16;24M\x1b[<32;17;24M\x1b[<3;17;24m');
  assert.deepEqual(f.mouse.map(event => [event.button, event.type, event.x, event.y]), [
    ['none', 'motion', 16, 24], ['left', 'motion', 17, 24],
  ]);
  assert.deepEqual(f.keys, []);
});

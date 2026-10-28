import { stripVTControlCharacters } from 'node:util';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { TerminalInput, type TerminalMouseEvent } from './terminal-input.js';
import { VERSION } from '../shared/protocol.js';
import { logoPixels } from './logo.js';

/** Connection states reported by the Agent. */
export type RunnerState = 'unpaired' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

export interface RunnerCardInfo {
  version?: string;
  node: string;
  platform: string;
  arch: string;
  device: string;
  server: string;
  config: string;
}

export interface RenderOptions {
  columns?: number;
  width?: number;
  color?: boolean;
}

export interface RunnerScreenOptions extends RenderOptions {
  rows?: number;
  dialog?: TuiDialog;
  interactive?: boolean;
  hitRegions?: TuiHitRegion[];
  mouse?: boolean;
  pointer?: { x: number; y: number };
  pressed?: { action: string; choice?: number };
}

export interface TuiHitRegion {
  x: number;
  y: number;
  width: number;
  action: string;
  choice?: number;
  inputStart?: number;
  inputCursor?: number;
}

export interface TuiChoice { value: string; label: string; detail?: string }
export interface TuiDialog {
  kind: 'select' | 'input' | 'progress';
  title: string;
  description: string[];
  choices?: TuiChoice[];
  selected?: number;
  scroll?: number;
  value?: string;
  cursor?: number;
  error?: string;
  hint?: string;
}
export class TuiExitError extends Error {}
export class TuiCancelError extends Error {}

export interface TuiStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getColorDepth?: () => number;
  on?: (event: 'resize', listener: () => void) => unknown;
  off?: (event: 'resize', listener: () => void) => unknown;
}

export interface TuiOptions extends RunnerScreenOptions {
  stream?: TuiStream;
  input?: NodeJS.ReadStream;
  keepOpenOnStop?: boolean;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const BRAND = {
  blue: '38;2;7;85;255',
  orange: '38;2;255;101;62',
  border: '38;2;106;120;140',
  green: '38;2;63;185;80',
  yellow: '38;2;210;153;34',
  red: '38;2;248;81;73',
  dim: '2',
  bold: '1',
  hover: '1;38;2;240;245;255;48;2;43;53;72',
  pressed: '1;38;2;255;255;255;48;2;7;85;255',
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SEGMENTS = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹫＀-｠￠-￦]/;

export function stripAnsi(text: string): string {
  return stripVTControlCharacters(text);
}

/** Keep configuration and remote messages from injecting terminal commands. */
function safeText(text: string): string {
  return stripAnsi(text).replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\u200d' ? char : '');
}

function cellWidth(segment: string): number {
  if (/^[\p{Mark}\p{Cf}]+$/u.test(segment)) return 0;
  if (/\p{Emoji_Presentation}|\uFE0F|\u20E3/u.test(segment)) return 2;
  return WIDE.test(segment) ? 2 : 1;
}

/** Terminal cells, including CJK, combining accents and emoji clusters. */
export function displayWidth(text: string): number {
  return [...SEGMENTS.segment(stripAnsi(text))].reduce((width, { segment }) => width + cellWidth(segment), 0);
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (displayWidth(text) <= width) return text;
  let result = '', used = 0;
  for (const { segment } of SEGMENTS.segment(stripAnsi(text))) {
    const size = cellWidth(segment);
    if (used + size > width - 1) break;
    result += segment; used += size;
  }
  return result + '…';
}

function cardLayout(options: RenderOptions) {
  // Leave the last cell unused to avoid terminal autowrap during live updates.
  const columns = Math.max(1, Math.floor(options.columns ?? 80));
  const width = Math.max(0, Math.min(Math.floor(options.width ?? 96), columns - 1));
  return { columns, width, indent: ' '.repeat(Math.max(0, Math.floor((columns - width) / 2))) };
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${ESC}${code}m${text}${RESET}` : text;
}

/** Shade exact terminal cells, preserving the styles of neighboring content. */
function shadeCells(line: string, column: number, width: number, style: string): string {
  const padded = line + ' '.repeat(Math.max(0, column + width - displayWidth(line)));
  const parts = ['', '', ''];
  let cell = 0;
  for (const match of padded.matchAll(/\x1b\[[0-9;]*m|[^\x1b]+/g)) {
    const text = match[0];
    if (text.startsWith('\x1b')) {
      parts[cell < column ? 0 : cell < column + width ? 1 : 2] += text;
      continue;
    }
    for (const { segment } of SEGMENTS.segment(text)) {
      parts[cell < column ? 0 : cell < column + width ? 1 : 2] += segment;
      cell += cellWidth(segment);
    }
  }
  return parts[0] + `${ESC}${style}m` + stripAnsi(parts[1]!) + RESET + parts[2];
}

/** Quadrant glyphs retain twice the horizontal detail of half-block pixels. */
export function renderLogo(color: boolean, columns: 32 | 40 = 32): string[] {
  const pixels = logoPixels[columns]!;
  const quadrants = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let line = '';
    for (let x = 0; x < columns * 2; x += 2) {
      const cell = [pixels[y]![x], pixels[y]![x + 1], pixels[y + 1]![x], pixels[y + 1]![x + 1]];
      const mask = cell.reduce((bits, pixel, index) => bits | (pixel !== ' ' ? 1 << index : 0), 0);
      const ink = cell.includes('o') ? BRAND.orange : BRAND.blue;
      // Background-filled cells avoid font baseline seams in solid strokes.
      line += color && mask === 15 ? paint(' ', ink.replace('38;', '48;'), true)
        : mask ? paint(quadrants[mask]!, ink, color) : ' ';
    }
    lines.push(line);
  }
  return lines;
}

/** Legacy startup card retained for non-full-screen renderers and tests. */
export function renderRunnerCard(info: RunnerCardInfo, options: RenderOptions = {}): string[] {
  const { width, indent } = cardLayout(options);
  const color = options.color ?? false;
  const title = paint('HomeAgent Runner', `${BRAND.bold};${BRAND.blue}`, color);
  const version = paint(`v${safeText(info.version ?? VERSION)}`, BRAND.dim, color);
  const entries = [
    ['设备', info.device], ['服务', info.server], ['配置', info.config],
    ['环境', `${info.node} · ${info.platform}/${info.arch}`],
  ];
  const hint = 'Ctrl+C 停止 · 项目与权限在网页端配置';
  if (width < 32) return [
    `HomeAgent Runner v${safeText(info.version ?? VERSION)}`,
    ...entries.map(([label, value]) => `${label}  ${safeText(value!)}`),
    'Ctrl+C 停止',
  ].map(line => indent + truncate(line, width));

  const inner = width - 4;
  const border = (text: string) => paint(text, BRAND.border, color);
  const lines = [border('╭' + '─'.repeat(width - 2) + '╮')];
  const row = (content = '') => {
    const text = truncate(content, inner);
    lines.push(border('│') + ' ' + text + ' '.repeat(Math.max(0, inner - displayWidth(text))) + ' ' + border('│'));
  };
  const entry = ([label, value]: string[]) => paint(label!, BRAND.dim, color) + '  ' + safeText(value!);
  if (width >= 76) {
    const logoWidth = width >= 92 ? 40 : 32;
    const detailWidth = inner - logoWidth - 4;
    const details = ['', title, version, '', ...entries.map(entry), '', paint(truncate(hint, detailWidth), BRAND.dim, color)];
    const top = Math.floor((logoWidth / 2 - details.length) / 2);
    renderLogo(color, logoWidth).forEach((logo, index) => {
      const detail = truncate(details[index - top] ?? '', detailWidth);
      row(logo + '  ' + border('│') + ' ' + detail);
    });
  } else {
    row(title + '  ' + version);
    row();
    for (const value of entries) row(entry(value));
    row();
    row(paint(truncate(hint, inner), BRAND.dim, color));
  }
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines.map(line => indent + line);
}

export function renderStatus(state: RunnerState, detail: string | undefined, color: boolean, frame = 0): string {
  const dot = (glyph: string, code: string) => paint(glyph, code, color);
  switch (state) {
    case 'unpaired':
      return `${dot('○', BRAND.orange)} 尚未登录`;
    case 'connecting':
      return `${dot(SPINNER[frame % SPINNER.length]!, BRAND.orange)} ${paint('正在连接 Server…', BRAND.dim, color)}`;
    case 'connected':
      return `${dot('●', BRAND.green)} 已连接${detail ? paint(` · ${detail}`, BRAND.dim, color) : ''}`;
    case 'reconnecting':
      return `${dot(SPINNER[frame % SPINNER.length]!, BRAND.yellow)} 连接中断${detail ? paint(` · ${detail} 后重试`, BRAND.dim, color) : ''}`;
    case 'stopped':
      return `${dot('■', BRAND.red)} 已停止`;
  }
}

/** A fixed-size viewport; all external text is sanitized before it is styled. */
export function renderRunnerScreen(
  info: RunnerCardInfo,
  state: RunnerState,
  detail: string | undefined,
  logs: string[],
  options: RunnerScreenOptions = {},
  frame = 0,
): string[] {
  const columns = Math.max(1, Math.floor(options.columns ?? 80));
  const rows = Math.max(1, Math.floor(options.rows ?? 24));
  const available = Math.max(0, columns - 1);
  const color = options.color ?? false;
  const lines = Array<string>(rows).fill('');
  const clean: RunnerCardInfo = {
    version: safeText(info.version ?? VERSION), device: safeText(info.device),
    server: safeText(info.server), config: safeText(info.config),
    node: safeText(info.node), platform: safeText(info.platform), arch: safeText(info.arch),
  };
  const width = Math.max(0, Math.min(available, Math.floor(options.width ?? 96)));
  const left = Math.max(0, Math.floor((available - width) / 2));
  const hits = options.hitRegions ?? [];
  hits.length = 0;
  const region = (row: number, column: number, size: number, action: string, extra: Partial<TuiHitRegion> = {}) => {
    const visibleWidth = Math.min(size, available - column);
    if (row < 0 || row >= rows || visibleWidth <= 0) return;
    hits.push({ ...extra, x: column + 1, y: row + 1, width: visibleWidth, action });
  };
  const styled = (text: string, code = BRAND.dim) => paint(text, code, color);
  const put = (row: number, text: string, column = left, limit = width) => {
    if (row < 0 || row >= rows) return;
    lines[row] = ' '.repeat(column) + truncate(text, Math.max(0, limit));
  };
  const centered = (row: number, text: string) => {
    const clipped = truncate(text, width);
    put(row, clipped, left + Math.max(0, Math.floor((width - displayWidth(clipped)) / 2)), width);
  };
  const status = renderStatus(state, detail ? safeText(detail) : undefined, color, frame);
  const title = styled('›', BRAND.blue) + ' ' + styled('HomeAgent Runner', BRAND.bold) +
    styled(`  v${clean.version ?? VERSION}`);
  put(0, title);
  if (rows < 8) {
    if (rows > 1) put(1, status);
    if (rows > 2) put(rows - 1, styled('Ctrl+C 停止'));
    return lines;
  }
  put(1, styled(clean.config));
  const bodyTop = 3;
  const bodyBottom = rows - 4;
  const bodyHeight = Math.max(0, bodyBottom - bodyTop);
  const showLogo = width >= 72 && bodyHeight >= 20;
  const logoWidth = width >= 92 && bodyHeight >= 28 ? 40 : 32;
  const logo = showLogo ? renderLogo(color, logoWidth) : [];
  const details = state === 'unpaired' ? [
    styled('欢迎使用 HomeAgent', `${BRAND.bold};${BRAND.blue}`),
    styled('连接你的机器，开始协作'),
    '',
    styled('尚未登录。请先登录并在浏览器中批准设备。'),
    '',
    styled('Enter 登录设备', BRAND.bold),
    styled('s 设置  ·  c 选择配置  ·  q 退出'),
  ] : [
    styled('HomeAgent', `${BRAND.bold};${BRAND.blue}`),
    styled('你的机器，你来掌控'),
    '',
    styled('设备  ') + clean.device,
    styled('服务  ') + clean.server,
    styled('环境  ') + `${clean.node} · ${clean.platform}/${clean.arch}`,
    '',
    status,
  ];
  const heroHeight = showLogo ? logo.length : Math.min(details.length, Math.max(1, bodyHeight - 3));
  const activityRows = Math.max(0, Math.min(5, bodyHeight - heroHeight - 2));
  const heroTop = bodyTop + Math.max(0, Math.floor((bodyHeight - heroHeight - activityRows - 2) / 2));
  if (options.dialog) {
    const dialog = options.dialog;
    put(bodyTop, styled(safeText(dialog.title), `${BRAND.bold};${BRAND.blue}`));
    let row = bodyTop + 2;
    const descriptionBudget = dialog.kind === 'progress' ? Math.max(1, bodyHeight - 4)
      : Math.max(1, Math.floor(bodyHeight / 3));
    for (const message of dialog.description.slice(0, descriptionBudget)) {
      put(row++, styled(safeText(message)));
    }
    row++;
    if (dialog.kind === 'input') {
      const segments = [...SEGMENTS.segment(dialog.value ?? '')].map(({ segment }) => segment);
      const cursor = dialog.cursor ?? segments.length;
      let start = 0;
      while (start < cursor && displayWidth(segments.slice(start, cursor).join('')) > Math.max(1, width - 8)) start++;
      const prefix = segments.slice(start, cursor).join('');
      put(row, styled('› ', BRAND.blue) + safeText(prefix) + styled('▏', BRAND.blue) + safeText(segments.slice(cursor).join('')));
      if (row < bodyBottom) region(row, left + 2, Math.max(0, width - 2), 'input', { inputStart: start, inputCursor: cursor });
      if (dialog.error) put(row + 2, styled(safeText(dialog.error), BRAND.red));
    } else if (dialog.kind === 'select') {
      const choices = dialog.choices ?? [];
      const count = Math.max(0, bodyBottom - row - 1);
      const selectedIndex = dialog.selected ?? 0;
      let start = dialog.scroll ?? 0;
      if (selectedIndex < start) start = selectedIndex;
      if (selectedIndex >= start + count) start = selectedIndex - count + 1;
      start = Math.max(0, Math.min(start, choices.length - count));
      dialog.scroll = start;
      choices.slice(start, start + count).forEach((choice, offset) => {
        const selected = start + offset === (dialog.selected ?? 0);
        const label = styled(selected ? '› ' : '  ', BRAND.blue) + styled(safeText(choice.label), selected ? '1;7' : BRAND.dim);
        put(row + offset, label);
        region(row + offset, left, width, 'choice', { choice: start + offset });
      });
      const selected = choices[dialog.selected ?? 0];
      if (selected?.detail) put(bodyBottom - 1, styled(safeText(selected.detail)));
      if (choices.length > count && row > bodyTop + 1) put(row - 1, styled(`滚轮 / ↑↓ 浏览  ${(dialog.selected ?? 0) + 1}/${choices.length}`));
    } else if (dialog.error) put(Math.min(row, bodyBottom - 1), styled(safeText(dialog.error), BRAND.red));
  } else if (showLogo) {
    const detailWidth = width - logoWidth - 4;
    const offset = Math.max(0, Math.floor((logo.length - details.length) / 2));
    logo.forEach((line, row) => {
      put(heroTop + row, line + '    ' + truncate(details[row - offset] ?? '', detailWidth));
      if (options.interactive && state === 'unpaired' && row - offset === 5) {
        const labelWidth = displayWidth(details[5]!);
        if (labelWidth <= detailWidth) region(heroTop + row, left + logoWidth + 4, labelWidth, 'login');
      }
    });
  } else {
    details.slice(0, heroHeight).forEach((line, row) => {
      centered(heroTop + row, line);
      if (options.interactive && state === 'unpaired' && row === 5 && displayWidth(line) <= width) {
        region(heroTop + row, left + Math.max(0, Math.floor((width - displayWidth(line)) / 2)), displayWidth(line), 'login');
      }
    });
  }

  if (!options.dialog && activityRows > 0) {
    const activity = logs.flatMap(message => message.split(/\r?\n/).map(safeText).filter(line => line.trim()));
    const start = bodyBottom - activityRows;
    put(start, styled('最近活动'));
    const visible = activity.slice(-Math.max(0, activityRows - 1));
    if (visible.length === 0 && activityRows > 1) visible.push('等待设备活动…');
    visible.slice(0, activityRows - 1).forEach((message, row) => put(start + row + 1, styled('· ') + message));
  }
  put(rows - 3, styled('─'.repeat(width)));
  put(rows - 2, status + styled(`  ·  ${clean.device}`));
  if (options.interactive) {
    const buttons: [string, string][] = options.dialog?.kind === 'input'
      ? [['Enter 确认', 'confirm'], ['Esc 返回', 'back'], ['Ctrl+U 清空', 'clear'], ['Ctrl+C 退出', 'quit']]
      : options.dialog?.kind === 'select'
        ? [['Enter 确认', 'confirm'], ['Esc 返回', 'back'], ['Ctrl+C 退出', 'quit']]
        : options.dialog?.kind === 'progress'
          ? [
            ...(options.dialog.hint?.includes('o 打开') ? [['o 打开登录页面', 'open'] as [string, string]] : []),
            ...(options.dialog.hint?.includes('Esc 取消') ? [['Esc 取消', 'back'] as [string, string]] : []),
            ['Ctrl+C 退出', 'quit'],
          ]
          : state === 'unpaired'
            ? [['Enter 登录', 'login'], ['s 设置', 'settings'], ['c 选择配置', 'config'], ['q 退出', 'quit']]
            : [['s 设置', 'settings'], ['a 活动', 'activity'], ['o 网页', 'web'], ['p 暂停/连接', 'toggle'], ['q 退出', 'quit']];
    // Text selection can be re-enabled without leaving the application.
    buttons.push([`m 鼠标${options.mouse === false ? '关' : '开'}`, 'mouse']);
    let content = '';
    for (const [label, action] of buttons) {
      const text = `[${label}]`;
      const column = left + displayWidth(content);
      if (displayWidth(content + text) > width) break;
      region(rows - 1, column, displayWidth(text), action);
      content += styled(text, action === 'login' || action === 'confirm' ? BRAND.blue : BRAND.dim) + ' ';
    }
    put(rows - 1, content);
  } else put(rows - 1, styled('Ctrl+C 停止  ·  项目与权限在网页端配置'));
  if (options.pointer && options.mouse !== false) {
    const target = hits.find(hit => hit.y === options.pointer!.y &&
      options.pointer!.x >= hit.x && options.pointer!.x < hit.x + hit.width);
    if (target) {
      const down = options.pressed?.action === target.action && options.pressed.choice === target.choice;
      lines[target.y - 1] = shadeCells(lines[target.y - 1]!, target.x - 1, target.width,
        color ? (down ? BRAND.pressed : BRAND.hover) : (down ? '1;7' : '7'));
    }
  }
  return lines;
}

export function tuiEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HOMEAGENT_TUI === '0' || env.HOMEAGENT_TUI === 'plain') return false;
  if (!stream.isTTY || env.TERM === 'dumb') return false;
  if (env.HOMEAGENT_TUI === '1') return true;
  return env.CI === undefined;
}

export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (Object.hasOwn(env, 'NO_COLOR')) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

/** Use the brand colors on truecolor terminals, and monochrome elsewhere. */
export function truecolorEnabled(stream: { getColorDepth?: () => number } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!colorEnabled(env)) return false;
  if (env.COLORTERM && /truecolor|24bit/i.test(env.COLORTERM)) return true;
  if (env.WT_SESSION || /^(?:vscode|iTerm\.app|WezTerm|Apple_Terminal)$/i.test(env.TERM_PROGRAM ?? '')) return true;
  return typeof stream.getColorDepth === 'function' && stream.getColorDepth() >= 24;
}

/** Own the alternate screen while running, restoring the shell on shutdown. */
export class RunnerTui {
  private timer?: NodeJS.Timeout;
  private exitHandler?: () => void;
  private resizeHandler?: () => void;
  private state: RunnerState = 'connecting';
  private detail?: string;
  private retryAt?: number;
  private frame = 0;
  private logs: string[] = [];
  private started = false;
  private dialog?: TuiDialog;
  private pending?: { resolve: (value?: string) => void; reject: (error: Error) => void; validate?: (value: string) => string | undefined };
  private progressCancel?: (error: Error) => void;
  private progressOpen?: () => Promise<void>;
  private progressCancelable = true;
  private keyHandler?: (text: string, key: Key) => void;
  private dataHandler?: (chunk: Buffer | string) => void;
  private keyboard?: PassThrough;
  private terminalInput?: TerminalInput;
  private hitRegions: TuiHitRegion[] = [];
  private pressed?: { action: string; choice?: number; dialog?: TuiDialog };
  private pointer?: { x: number; y: number };
  private wasRaw = false;
  private wasFlowing = false;
  private exitRequested = false;
  private mouseEnabled = false;

  constructor(readonly info: RunnerCardInfo, private readonly options: TuiOptions = {}) {}

  private get stream() { return this.options.stream ?? process.stdout; }
  private get color() { return this.options.color ?? truecolorEnabled(this.stream, process.env); }
  private get inputStream() { return this.options.input ?? process.stdin; }
  start() {
    if (this.started) return;
    this.started = true;
    this.stream.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
    this.exitHandler = () => this.stop();
    process.on('exit', this.exitHandler);
    this.resizeHandler = () => {
      this.pressed = undefined; this.pointer = undefined;
      if (this.started) this.draw();
    };
    this.stream.on?.('resize', this.resizeHandler);
    if (this.options.interactive && this.inputStream.isTTY) {
      const input = this.inputStream;
      this.wasRaw = Boolean(input.isRaw);
      this.wasFlowing = input.readableFlowing === true;
      // A separate stream receives only keyboard frames. Raw mouse/paste
      // reports never reach readline or turn into form text and shortcuts.
      this.keyboard = new PassThrough();
      emitKeypressEvents(this.keyboard);
      input.setRawMode(true);
      this.keyHandler = (text, key) => this.handleKey(text, key);
      this.keyboard.on('keypress', this.keyHandler);
      this.terminalInput = new TerminalInput({
        keyboard: text => {
          if (text === '\x1b') this.handleKey('', { name: 'escape' });
          else this.keyboard?.write(text);
        },
        mouse: event => this.handleMouse(event),
        paste: text => this.insertText(text),
      });
      this.dataHandler = chunk => this.terminalInput?.feed(chunk);
      input.on('data', this.dataHandler);
      input.resume();
      this.mouseEnabled = this.options.mouse !== false && process.env.HOMEAGENT_MOUSE !== '0';
      this.stream.write((this.mouseEnabled ? `${ESC}?1000h${ESC}?1003h${ESC}?1006h` : '') + `${ESC}?2004h`);
    }
    this.draw();
    this.timer = setInterval(() => {
      this.frame += 1;
      if (this.state === 'connecting' || this.state === 'reconnecting') this.draw();
    }, 90);
    this.timer.unref();
  }

  setState(state: RunnerState, detail?: string) {
    if (state === 'stopped' && this.started && !this.options.keepOpenOnStop) { this.stop(); return; }
    this.state = state;
    this.detail = detail;
    this.retryAt = state === 'reconnecting' && /^\d+s$/.test(detail ?? '') ? Date.now() + Number(detail!.slice(0, -1)) * 1000 : undefined;
    if (state === 'connected' || state === 'stopped') {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    } else if (this.started && !this.timer) {
      this.timer = setInterval(() => { this.frame += 1; this.draw(); }, 90);
      this.timer.unref();
    }
    if (this.started) this.draw();
  }

  log(message: string) {
    const entries = message.split(/\r?\n/).map(safeText);
    if (!this.started) { this.stream.write(entries.join('\n') + '\n'); return; }
    this.logs.push(...entries);
    this.logs = this.logs.slice(-200);
    this.draw();
  }

  updateInfo(info: Partial<RunnerCardInfo>) {
    Object.assign(this.info, info);
    if (this.started) this.draw();
  }

  private async prompt(dialog?: TuiDialog, validate?: (value: string) => string | undefined): Promise<string | undefined> {
    if (this.exitRequested) throw new TuiExitError('Exit requested');
    if (this.pending || this.progressCancel) throw new Error('Another interaction is already open');
    this.dialog = dialog;
    this.pressed = undefined;
    this.pointer = undefined;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        this.pending = { resolve, reject, validate };
        this.draw();
      });
    } finally {
      this.pending = undefined;
      this.dialog = undefined;
      if (this.started) this.draw();
    }
  }

  select(title: string, choices: TuiChoice[], description: string[] = []) {
    return this.prompt({ kind: 'select', title, choices, description, selected: 0 });
  }

  ask(title: string, value = '', description: string[] = [], validate?: (value: string) => string | undefined) {
    return this.prompt({ kind: 'input', title, value, cursor: [...SEGMENTS.segment(value)].length, description }, validate);
  }

  waitForAction() { return this.prompt(); }

  activity() {
    return this.select('最近活动', [
      ...this.logs.filter(line => line.trim()).map((line, index) => ({ value: String(index), label: line })),
      { value: 'back', label: '返回总览' },
    ], ['↑↓ 浏览活动，Esc 返回；完整任务与审计记录可在网页中查看。']);
  }

  showProgress(title: string, description: string[]) {
    this.pressed = undefined;
    this.pointer = undefined;
    this.dialog = { kind: 'progress', title, description, hint: !this.progressCancelable ? '正在应用设置，请稍候  ·  Ctrl+C 完成后退出'
      : this.progressOpen ? 'o 打开登录页面  ·  Esc 取消  ·  Ctrl+C 退出' : 'Esc 取消  ·  Ctrl+C 退出' };
    if (this.started) this.draw();
  }

  async progress<T>(title: string, description: string[], run: (signal: AbortSignal) => Promise<T>, onOpen?: () => Promise<void>, cancelable = true): Promise<T> {
    if (this.exitRequested) throw new TuiExitError('Exit requested');
    if (this.pending || this.progressCancel) throw new Error('Another interaction is already open');
    const controller = new AbortController();
    this.progressCancel = error => controller.abort(error);
    this.progressOpen = onOpen;
    this.progressCancelable = cancelable;
    this.showProgress(title, description);
    try {
      const result = await run(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      this.progressCancel = undefined;
      this.progressOpen = undefined;
      this.progressCancelable = true;
      this.dialog = undefined;
      if (this.started) this.draw();
    }
  }

  requestExit() {
    this.exitRequested = true;
    const error = new TuiExitError('Exit requested');
    this.progressCancel?.(error);
    this.pending?.reject(error);
  }

  private handleKey(text: string, key: Key) {
    if (key.ctrl && key.name === 'c') { this.requestExit(); return; }
    if (!key.ctrl && !key.meta && key.name === 'm' && this.dialog?.kind !== 'input') {
      this.toggleMouse(); return;
    }
    if (this.progressCancel) {
      if (key.name === 'escape' && this.progressCancelable) this.progressCancel(new TuiCancelError('操作已取消'));
      if (key.name === 'o' && this.progressOpen) void this.progressOpen().catch(error => {
        if (this.dialog) { this.dialog.error = error instanceof Error ? error.message : '无法打开浏览器'; this.draw(); }
      });
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    const dialog = this.dialog;
    if (!dialog) {
      const action = key.name === 'return' ? (this.state === 'unpaired' ? 'login' : 'settings')
        : ({ s: 'settings', a: 'activity', o: 'web', p: 'toggle', q: 'quit', c: 'config', l: 'login', '?': 'help' } as Record<string, string>)[text || key.name || ''];
      if (action) pending.resolve(action);
      return;
    }
    if (key.name === 'escape') { pending.resolve(undefined); return; }
    if (dialog.kind === 'select') {
      const count = dialog.choices?.length ?? 0;
      if (key.name === 'up') dialog.selected = ((dialog.selected ?? 0) + count - 1) % Math.max(1, count);
      if (key.name === 'down' || key.name === 'tab') dialog.selected = ((dialog.selected ?? 0) + 1) % Math.max(1, count);
      if (key.name === 'return') { pending.resolve(dialog.choices?.[dialog.selected ?? 0]?.value); return; }
    } else if (dialog.kind === 'input') {
      const segments = [...SEGMENTS.segment(dialog.value ?? '')].map(({ segment }) => segment);
      let cursor = Math.min(dialog.cursor ?? segments.length, segments.length);
      if (key.name === 'return') {
        const value = (dialog.value ?? '').trim();
        dialog.error = pending.validate?.(value);
        if (!dialog.error) { pending.resolve(value); return; }
      } else if (key.ctrl && key.name === 'u') { segments.length = 0; cursor = 0; }
      else if (key.name === 'left') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'right') cursor = Math.min(segments.length, cursor + 1);
      else if (key.name === 'home' || key.ctrl && key.name === 'a') cursor = 0;
      else if (key.name === 'end' || key.ctrl && key.name === 'e') cursor = segments.length;
      else if (key.name === 'backspace' && cursor > 0) segments.splice(--cursor, 1);
      else if (key.name === 'delete') segments.splice(cursor, 1);
      else if (!key.ctrl && !key.meta && text && !/[\p{Cc}]/u.test(text)) { this.insertText(text); return; }
      dialog.value = segments.join('');
      dialog.cursor = cursor;
    }
    this.draw();
  }

  private insertText(text: string) {
    const dialog = this.dialog;
    if (!this.pending || dialog?.kind !== 'input') return;
    const clean = safeText(text.replace(/[\r\n\t]+/g, ' '));
    const segments = [...SEGMENTS.segment(dialog.value ?? '')].map(({ segment }) => segment);
    const cursor = Math.min(dialog.cursor ?? segments.length, segments.length);
    const before = segments.slice(0, cursor).join('') + clean;
    const combined = before + segments.slice(cursor).join('');
    const next = [...SEGMENTS.segment(combined)].map(({ segment }) => segment).slice(0, 4096);
    dialog.value = next.join('');
    // Re-segment the prefix as well, so combining marks and emoji joiners
    // stay editable as one grapheme even when delivered in separate chunks.
    dialog.cursor = Math.min([...SEGMENTS.segment(before)].length, next.length);
    dialog.error = undefined;
    this.draw();
  }

  private handleMouse(event: TerminalMouseEvent) {
    if (!this.mouseEnabled) return;
    const columns = this.options.columns ?? this.stream.columns ?? 80;
    const rows = this.options.rows ?? this.stream.rows ?? 24;
    const previousTarget = this.pointer && this.hitRegions.find(hit => hit.y === this.pointer!.y &&
      this.pointer!.x >= hit.x && this.pointer!.x < hit.x + hit.width);
    if (event.modified || event.x > columns || event.y > rows) {
      this.pointer = undefined; this.pressed = undefined;
      if (previousTarget) this.draw();
      return;
    }
    this.pointer = { x: event.x, y: event.y };
    const target = this.hitRegions.find(hit => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width);
    if (event.type === 'motion') {
      // Redraw on entering/leaving a control, not for every pixel of movement.
      if (target !== previousTarget) this.draw();
      return;
    }
    const dialog = this.dialog;
    if (event.button === 'wheel-up' || event.button === 'wheel-down') {
      // SGR terminals send wheel presses without a corresponding release.
      if (event.type !== 'press' || dialog?.kind !== 'select') return;
      this.pressed = undefined;
      const last = Math.max(0, (dialog.choices?.length ?? 0) - 1);
      dialog.selected = Math.max(0, Math.min(last, (dialog.selected ?? 0) + (event.button === 'wheel-down' ? 1 : -1)));
      this.draw();
      return;
    }
    if (event.button !== 'left') return;
    if (event.type === 'press') {
      this.pressed = target ? { action: target.action, choice: target.choice, dialog } : undefined;
      if (dialog?.kind === 'select' && target?.choice !== undefined) {
        dialog.selected = target.choice;
      }
      this.draw();
      return;
    }
    const pressed = this.pressed;
    this.pressed = undefined;
    if (pressed) this.draw();
    if (!target || !pressed || pressed.dialog !== dialog || pressed.action !== target.action || pressed.choice !== target.choice) return;
    if (target.action === 'input' && dialog?.kind === 'input') {
      const segments = [...SEGMENTS.segment(dialog.value ?? '')].map(({ segment }) => segment);
      let cursor = target.inputStart ?? 0, cell = target.x;
      for (; cursor < segments.length; cursor++) {
        if (cursor === target.inputCursor) {
          if (event.x <= cell) break;
          cell++; // The visible cursor marker itself occupies a cell.
        }
        const next = cell + displayWidth(segments[cursor]!);
        if (event.x < next) break;
        cell = next;
      }
      dialog.cursor = cursor;
      this.draw();
    } else if (target.action === 'mouse') this.toggleMouse();
    else if (target.action === 'quit') this.requestExit();
    else if (target.action === 'open') this.handleKey('o', { name: 'o' });
    else if (target.action === 'back') this.handleKey('', { name: 'escape' });
    else if (target.action === 'confirm') this.handleKey('', { name: 'return' });
    else if (target.action === 'clear') this.handleKey('', { name: 'u', ctrl: true });
    else if (target.action === 'choice' && dialog?.kind === 'select') this.pending?.resolve(dialog.choices?.[target.choice!]?.value);
    else if (!dialog) this.pending?.resolve(target.action);
  }

  private toggleMouse() {
    if (!this.keyHandler) return;
    this.mouseEnabled = !this.mouseEnabled;
    this.pressed = undefined;
    this.pointer = undefined;
    this.stream.write(this.mouseEnabled ? `${ESC}?1000h${ESC}?1003h${ESC}?1006h` : `${ESC}?1003l${ESC}?1006l${ESC}?1000l`);
    this.draw();
  }

  stop() {
    if (!this.started) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = 'stopped';
    this.draw();
    this.stream.write(`${RESET}${ESC}?2004l${ESC}?1003l${ESC}?1006l${ESC}?1000l${ESC}?1049l${ESC}?25h`);
    if (this.exitHandler) { process.off('exit', this.exitHandler); this.exitHandler = undefined; }
    if (this.resizeHandler) this.stream.off?.('resize', this.resizeHandler);
    this.resizeHandler = undefined;
    if (this.keyHandler) {
      this.terminalInput?.close();
      this.terminalInput = undefined;
      this.keyboard?.off('keypress', this.keyHandler);
      this.keyboard?.destroy();
      this.keyboard = undefined;
      if (this.dataHandler) this.inputStream.off('data', this.dataHandler);
      this.inputStream.setRawMode(this.wasRaw);
      if (!this.wasFlowing) this.inputStream.pause();
      this.keyHandler = undefined;
      this.dataHandler = undefined;
    }
    this.pressed = undefined;
    this.pointer = undefined;
    this.hitRegions = [];
    this.mouseEnabled = false;
    this.pending?.reject(new TuiExitError('Terminal closed'));
    this.started = false;
  }

  private draw() {
    const columns = Math.max(1, Math.floor(this.options.columns ?? this.stream.columns ?? 80));
    const rows = Math.max(1, Math.floor(this.options.rows ?? this.stream.rows ?? 24));
    const detail = this.retryAt === undefined ? this.detail : `${Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))}s`;
    const lines = renderRunnerScreen(this.info, this.state, detail, this.logs, {
      ...this.options, columns, rows, color: this.color, dialog: this.dialog, hitRegions: this.hitRegions, mouse: this.mouseEnabled,
      pointer: this.pointer, pressed: this.pressed,
    }, this.frame);
    // Avoid newlines and the last cell: neither redraw nor resize may scroll.
    this.stream.write(lines.map((line, row) => `${ESC}${row + 1};1H${ESC}2K${line}`).join('') + `${ESC}H`);
  }
}

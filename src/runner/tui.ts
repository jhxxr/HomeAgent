import { VERSION } from '../shared/protocol.js';

/** Connection states reported by the Agent and rendered in the startup status line. */
export type RunnerState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

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

export interface TuiStream {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
  getColorDepth?: () => number;
}

export interface TuiOptions extends RenderOptions {
  stream?: TuiStream;
}

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const LOGO = [
  '    ................    ',
  '  ....................  ',
  ' ...................... ',
  ' ..................o... ',
  '..................+o+...',
  '.................+oooo..',
  '..............+###+o+...',
  '..............####+o....',
  '...+############+#+.....',
  '...############++##.....',
  '...#+............+#+....',
  '...#+.+..........+#+....',
  '...#+.##+........+#+....',
  '...#+.+##+.......+#+....',
  '...#+...##+......+#+....',
  '...#+..###+......+#+....',
  '...#+.##+.++++++.+#+....',
  '...#+.++..#####+.+#+....',
  '...#+............+#+....',
  '...##++++++++++++##.....',
  ' ..+##############+.... ',
  ' ...................... ',
  '  ....................  ',
  '    ................    ',
];

const PALETTE: Record<string, string> = {
  '.': '243;249;253',
  '#': '7;85;255',
  'o': '255;101;62',
  '+': '224;235;252',
};

const BRAND = {
  blue: '38;2;7;85;255',
  orange: '38;2;255;101;62',
  border: '38;2;106;120;140',
  green: '38;2;63;185;80',
  yellow: '38;2;210;153;34',
  red: '38;2;248;81;73',
  dim: '2',
  bold: '1',
};

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︐-︙︰-﹫＀-｠￠-￦]/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Terminal cell width, counting East Asian characters as two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += WIDE.test(char) ? 2 : 1;
  return width;
}

export function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let result = '', used = 0, index = 0;
  while (index < text.length) {
    if (text[index] === '\x1b') {
      const match = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(text.slice(index));
      if (match) { result += match[0]; index += match[0].length; continue; }
    }
    const char = String.fromCodePoint(text.codePointAt(index)!);
    const size = WIDE.test(char) ? 2 : 1;
    if (used + size > width - 1) break;
    result += char; used += size; index += char.length;
  }
  return result + (text.includes('\x1b') ? RESET : '') + '…';
}

function center(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - displayWidth(text)) / 2));
  const right = Math.max(0, width - left - displayWidth(text));
  return ' '.repeat(left) + text + ' '.repeat(right);
}

function paint(text: string, code: string, color: boolean): string {
  return color ? `${ESC}${code}m${text}${RESET}` : text;
}

/** Render the app mark as half blocks: 24 columns wide, 12 rows tall. */
export function renderLogo(color: boolean): string[] {
  const lines: string[] = [];
  for (let row = 0; row < LOGO.length; row += 2) {
    const upper = LOGO[row]!;
    const lower = LOGO[row + 1];
    let line = '';
    for (let x = 0; x < upper.length; x++) {
      const top = upper[x] ?? ' ';
      const bottom = lower?.[x] ?? ' ';
      const topFilled = color ? top !== ' ' : top !== ' ' && top !== '.';
      const bottomFilled = color ? bottom !== ' ' : bottom !== ' ' && bottom !== '.';
      if (!topFilled && !bottomFilled) { line += ' '; continue; }
      if (!color) { line += topFilled && bottomFilled ? '█' : topFilled ? '▀' : '▄'; continue; }
      if (topFilled && bottomFilled) line += `${ESC}38;2;${PALETTE[top]}m${ESC}48;2;${PALETTE[bottom]}m▀`;
      else if (topFilled) line += `${ESC}38;2;${PALETTE[top]}m${ESC}49m▀`;
      else line += `${ESC}38;2;${PALETTE[bottom]}m${ESC}49m▄`;
    }
    lines.push(color ? line + RESET : line);
  }
  return lines;
}

/** Startup card shown by `homeagent run` in an interactive terminal. */
export function renderRunnerCard(info: RunnerCardInfo, options: RenderOptions = {}): string[] {
  const columns = Math.max(24, options.columns ?? 80);
  const color = options.color ?? false;
  const inner = Math.max(20, Math.min(options.width ?? 50, columns - 4));
  const logo = renderLogo(color);
  const showLogo = inner >= 32 && columns >= 40;
  const lines: string[] = [];
  const border = (text: string) => paint(text, BRAND.border, color);
  const rule = (left: string, right: string) => border(left + '─'.repeat(inner + 2) + right);
  const row = (content = '') => {
    const text = truncate(content, inner);
    lines.push(border('│') + ' ' + text + ' '.repeat(Math.max(0, inner - displayWidth(text))) + ' ' + border('│'));
  };
  const labelWidth = 8;
  const valueWidth = Math.max(8, inner - labelWidth - 6);
  const entries: [string, string][] = [
    ['device', info.device],
    ['server', info.server],
    ['config', info.config],
    ['runtime', `${info.node} · ${info.platform}/${info.arch}`],
  ];
  const indent = ' '.repeat(Math.max(0, Math.floor((columns - inner - 4) / 2)));

  lines.push(rule('╭', '╮'));
  if (showLogo) for (const line of logo) row(center(line, inner));
  row(center(paint('HomeAgent Runner', `${BRAND.bold};${BRAND.blue}`, color) + paint(`  v${info.version ?? VERSION}`, BRAND.dim, color), inner));
  row();
  for (const [label, value] of entries) row('  ' + paint(label.padEnd(labelWidth), BRAND.dim, color) + '    ' + truncate(value, valueWidth));
  row(center(paint('Ctrl+C 停止 · 项目与权限在网页端配置', BRAND.dim, color), inner));
  lines.push(rule('╰', '╯'));
  return lines.map(line => indent + line);
}

export function renderStatus(state: RunnerState, detail: string | undefined, color: boolean, frame = 0): string {
  const dot = (glyph: string, code: string) => paint(glyph, code, color);
  switch (state) {
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

export function tuiEnabled(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HOMEAGENT_TUI === '0' || env.HOMEAGENT_TUI === 'plain') return false;
  if (env.HOMEAGENT_TUI === '1') return true;
  return Boolean(stream.isTTY) && env.TERM !== 'dumb' && env.CI === undefined;
}

export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (Object.hasOwn(env, 'NO_COLOR')) return false;
  if (env.FORCE_COLOR === '0') return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

/** The icon relies on 24-bit color; degrade to the monochrome mark elsewhere. */
export function truecolorEnabled(stream: { getColorDepth?: () => number } = process.stdout, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!colorEnabled(env)) return false;
  if (env.COLORTERM && /truecolor|24bit/i.test(env.COLORTERM)) return true;
  if (env.WT_SESSION || /^(?:vscode|iTerm\.app|WezTerm|Apple_Terminal)$/i.test(env.TERM_PROGRAM ?? '')) return true;
  return typeof stream.getColorDepth === 'function' && stream.getColorDepth() >= 24;
}

/** Keep the connection status pinned below the log stream, like Claude Code. */
export class RunnerTui {
  private timer?: NodeJS.Timeout;
  private exitHandler?: () => void;
  private state: RunnerState = 'connecting';
  private detail?: string;
  private frame = 0;
  private statusDrawn = false;
  private started = false;

  constructor(readonly info: RunnerCardInfo, private readonly options: TuiOptions = {}) {}

  private get stream() { return this.options.stream ?? process.stdout; }
  private get color() { return this.options.color ?? truecolorEnabled(this.stream, process.env); }
  private get indent() {
    const columns = this.options.columns ?? this.stream.columns ?? 80;
    const inner = Math.max(20, Math.min(this.options.width ?? 50, columns - 4));
    return ' '.repeat(Math.max(0, Math.floor((columns - inner - 4) / 2)));
  }

  start() {
    if (this.started) return;
    this.started = true;
    const columns = this.options.columns ?? this.stream.columns ?? 80;
    this.stream.write(renderRunnerCard(this.info, { columns, color: this.color }).join('\n') + '\n\n');
    this.stream.write(`${ESC}?25l`);
    this.exitHandler = () => this.stream.write(`${ESC}?25h`);
    process.on('exit', this.exitHandler);
    this.draw();
    this.timer = setInterval(() => {
      this.frame += 1;
      if (this.state === 'connecting' || this.state === 'reconnecting') this.draw();
    }, 90);
    this.timer.unref();
  }

  setState(state: RunnerState, detail?: string) {
    this.state = state;
    this.detail = detail;
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
    if (!this.started) { this.stream.write(message + '\n'); return; }
    this.clearLine();
    this.stream.write(message + '\n');
    this.draw();
  }

  stop() {
    if (!this.started) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearLine();
    this.state = 'stopped';
    this.stream.write(this.indent + renderStatus('stopped', undefined, this.color, this.frame) + '\n');
    this.stream.write(`${ESC}?25h`);
    if (this.exitHandler) { process.off('exit', this.exitHandler); this.exitHandler = undefined; }
    this.started = false;
  }

  private draw() {
    this.stream.write('\r' + `${ESC}2K` + this.indent + renderStatus(this.state, this.detail, this.color, this.frame));
    this.statusDrawn = true;
  }

  private clearLine() {
    if (!this.statusDrawn) return;
    this.stream.write('\r' + `${ESC}2K`);
    this.statusDrawn = false;
  }
}

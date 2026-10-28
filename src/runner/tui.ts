import { stripVTControlCharacters } from 'node:util';
import { VERSION } from '../shared/protocol.js';
import { logoPixels } from './logo.js';

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

/** Startup card shown by `homeagent run` in an interactive terminal. */
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

/** Keep the connection status on one line below the log stream. */
export class RunnerTui {
  private timer?: NodeJS.Timeout;
  private exitHandler?: () => void;
  private state: RunnerState = 'connecting';
  private detail?: string;
  private retryAt?: number;
  private frame = 0;
  private statusDrawn = false;
  private started = false;

  constructor(readonly info: RunnerCardInfo, private readonly options: TuiOptions = {}) {}

  private get stream() { return this.options.stream ?? process.stdout; }
  private get color() { return this.options.color ?? truecolorEnabled(this.stream, process.env); }
  private get indent() {
    return cardLayout({ ...this.options, columns: this.options.columns ?? this.stream.columns }).indent;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const columns = this.options.columns ?? this.stream.columns ?? 80;
    this.stream.write(renderRunnerCard(this.info, { ...this.options, columns, color: this.color }).join('\n') + '\n\n');
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
    if (state === 'stopped' && this.started) { this.stop(); return; }
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
    const text = message.split(/\r?\n/).map(safeText).join('\n') + '\n';
    if (!this.started) { this.stream.write(text); return; }
    this.clearLine();
    this.stream.write(text);
    this.draw();
  }

  stop() {
    if (!this.started) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearLine();
    this.state = 'stopped';
    const columns = this.options.columns ?? this.stream.columns ?? 80;
    this.stream.write(this.indent + truncate(renderStatus('stopped', undefined, this.color, this.frame), Math.max(0, columns - this.indent.length - 1)) + '\n');
    this.stream.write(`${ESC}?25h`);
    if (this.exitHandler) { process.off('exit', this.exitHandler); this.exitHandler = undefined; }
    this.started = false;
  }

  private draw() {
    const columns = Math.max(1, this.options.columns ?? this.stream.columns ?? 80);
    const detail = this.retryAt === undefined ? this.detail : `${Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))}s`;
    const status = renderStatus(this.state, detail ? safeText(detail) : undefined, this.color, this.frame);
    const indent = this.indent;
    this.stream.write('\r' + `${ESC}2K` + indent + truncate(status, Math.max(0, columns - indent.length - 1)));
    this.statusDrawn = true;
  }

  private clearLine() {
    if (!this.statusDrawn) return;
    this.stream.write('\r' + `${ESC}2K`);
    this.statusDrawn = false;
  }
}

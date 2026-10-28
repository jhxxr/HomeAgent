import { stripVTControlCharacters } from 'node:util';
import { VERSION } from '../shared/protocol.js';
import { logoPixels } from './logo.js';

/** Connection states reported by the Agent. */
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

export interface RunnerScreenOptions extends RenderOptions {
  rows?: number;
}

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
  const details = [
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
  if (showLogo) {
    const detailWidth = width - logoWidth - 4;
    const offset = Math.max(0, Math.floor((logo.length - details.length) / 2));
    logo.forEach((line, row) => {
      put(heroTop + row, line + '    ' + truncate(details[row - offset] ?? '', detailWidth));
    });
  } else {
    details.slice(0, heroHeight).forEach((line, row) => centered(heroTop + row, line));
  }

  if (activityRows > 0) {
    const activity = logs.flatMap(message => message.split(/\r?\n/).map(safeText).filter(line => line.trim()));
    const start = bodyBottom - activityRows;
    put(start, styled('最近活动'));
    const visible = activity.slice(-Math.max(0, activityRows - 1));
    if (visible.length === 0 && activityRows > 1) visible.push('等待设备活动…');
    visible.slice(0, activityRows - 1).forEach((message, row) => put(start + row + 1, styled('· ') + message));
  }
  put(rows - 3, styled('─'.repeat(width)));
  put(rows - 2, status + styled(`  ·  ${clean.device}`));
  put(rows - 1, styled('Ctrl+C 停止  ·  项目与权限在网页端配置'));
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

  constructor(readonly info: RunnerCardInfo, private readonly options: TuiOptions = {}) {}

  private get stream() { return this.options.stream ?? process.stdout; }
  private get color() { return this.options.color ?? truecolorEnabled(this.stream, process.env); }
  start() {
    if (this.started) return;
    this.started = true;
    this.stream.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
    this.exitHandler = () => this.stop();
    process.on('exit', this.exitHandler);
    this.resizeHandler = () => { if (this.started) this.draw(); };
    this.stream.on?.('resize', this.resizeHandler);
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
    const entries = message.split(/\r?\n/).map(safeText);
    if (!this.started) { this.stream.write(entries.join('\n') + '\n'); return; }
    this.logs.push(...entries);
    this.logs = this.logs.slice(-200);
    this.draw();
  }

  stop() {
    if (!this.started) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.state = 'stopped';
    this.draw();
    this.stream.write(`${RESET}${ESC}?1049l${ESC}?25h`);
    if (this.exitHandler) { process.off('exit', this.exitHandler); this.exitHandler = undefined; }
    if (this.resizeHandler) this.stream.off?.('resize', this.resizeHandler);
    this.resizeHandler = undefined;
    this.started = false;
  }

  private draw() {
    const columns = Math.max(1, Math.floor(this.options.columns ?? this.stream.columns ?? 80));
    const rows = Math.max(1, Math.floor(this.options.rows ?? this.stream.rows ?? 24));
    const detail = this.retryAt === undefined ? this.detail : `${Math.max(0, Math.ceil((this.retryAt - Date.now()) / 1000))}s`;
    const lines = renderRunnerScreen(this.info, this.state, detail, this.logs, {
      ...this.options, columns, rows, color: this.color,
    }, this.frame);
    // Avoid newlines and the last cell: neither redraw nor resize may scroll.
    this.stream.write(lines.map((line, row) => `${ESC}${row + 1};1H${ESC}2K${line}`).join('') + `${ESC}H`);
  }
}

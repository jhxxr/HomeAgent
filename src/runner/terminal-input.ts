import { StringDecoder } from 'node:string_decoder';

export interface TerminalMouseEvent {
  button: 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down';
  x: number;
  y: number;
  type: 'press' | 'release' | 'motion';
  modified: boolean;
}

interface InputHandlers {
  keyboard: (text: string) => void;
  mouse: (event: TerminalMouseEvent) => void;
  paste: (text: string) => void;
}

const ESC = '\x1b';
const PASTE_END = `${ESC}[201~`;
const MAX_PASTE = 16384;

/** Frame terminal protocols before feeding ordinary keystrokes to readline.
 * Reports and pasted text must never become application shortcut keys.
 */
export class TerminalInput {
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private pasted: string | undefined;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly handlers: InputHandlers) {}

  feed(chunk: Buffer | string) {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.parse();
  }

  private parse() {
    while (this.buffer && !this.closed) {
      if (this.pasted !== undefined) {
        const end = this.buffer.indexOf(PASTE_END);
        if (end < 0) {
          // Keep a possible split delimiter, with a bounded paste payload.
          const count = Math.max(0, this.buffer.length - PASTE_END.length + 1);
          this.pasted = (this.pasted + this.buffer.slice(0, count)).slice(0, MAX_PASTE);
          this.buffer = this.buffer.slice(count);
          return;
        }
        const text = (this.pasted + this.buffer.slice(0, end)).slice(0, MAX_PASTE);
        this.buffer = this.buffer.slice(end + PASTE_END.length);
        this.pasted = undefined;
        this.handlers.paste(text);
        continue;
      }
      const escape = this.buffer.indexOf(ESC);
      if (escape !== 0) {
        const count = escape < 0 ? this.buffer.length : escape;
        const text = this.buffer.slice(0, count);
        this.buffer = this.buffer.slice(count);
        this.handlers.keyboard(text);
        continue;
      }
      if (this.buffer.startsWith(`${ESC}[200~`)) {
        this.buffer = this.buffer.slice(6);
        this.pasted = '';
        continue;
      }
      if (this.buffer.startsWith(`${ESC}[<`)) {
        const report = /^\x1b\[<(\d{1,4});(\d{1,5});(\d{1,5})([Mm])/.exec(this.buffer);
        if (!report) {
          if (/^\x1b\[<[0-9;]*$/.test(this.buffer) && this.buffer.length <= 32) { this.wait(); return; }
          // Discard a malformed report, not its printable payload as keystrokes.
          const end = this.buffer.indexOf(ESC, 1);
          this.buffer = end < 0 ? '' : this.buffer.slice(end);
          continue;
        }
        this.buffer = this.buffer.slice(report[0].length);
        const code = Number(report[1]), x = Number(report[2]), y = Number(report[3]);
        if (x < 1 || y < 1 || code > 127 || (code & 3) === 3 && !(code & 32) || (code & 64) && (code & 3) > 1) continue;
        this.handlers.mouse({
          button: code & 64 ? (code & 1 ? 'wheel-down' : 'wheel-up')
            : (code & 3) === 0 ? 'left' : (code & 3) === 1 ? 'middle' : (code & 3) === 2 ? 'right' : 'none',
          x, y, modified: Boolean(code & 28),
          type: code & 32 ? 'motion' : report[4] === 'm' ? 'release' : 'press',
        });
        continue;
      }
      if (this.buffer.startsWith(`${ESC}[M`)) {
        // Legacy X10 reports, even though this app requests SGR coordinates.
        if (this.buffer.length < 6) { this.wait(); return; }
        this.buffer = this.buffer.slice(6);
        continue;
      }
      if (this.buffer.startsWith(`${ESC}[`) || this.buffer.startsWith(`${ESC}O`)) {
        const sequence = /^\x1b(?:\[[0-?]*[ -/]*|O)[@-~]/.exec(this.buffer);
        if (!sequence) {
          if (this.buffer.length > 64) { this.buffer = ''; continue; }
          this.wait(); return;
        }
        this.buffer = this.buffer.slice(sequence[0].length);
        // Pass keyboard CSI/SS3 only. Device responses and focus reports are not keys.
        if (/^\x1b(?:\[[0-9;]*[ABCDHFZ~]|O[ABCDHFPQRS])$/.test(sequence[0])) {
          this.handlers.keyboard(sequence[0]);
        }
        continue;
      }
      if (this.buffer === ESC) { this.wait(); return; }
      const length = this.buffer.codePointAt(1)! > 0xffff ? 3 : 2;
      const altKey = this.buffer.slice(0, length);
      this.buffer = this.buffer.slice(length);
      this.handlers.keyboard(altKey);
    }
  }

  private wait() {
    const loneEscape = this.buffer === ESC;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = this.buffer;
      this.buffer = '';
      if (text === ESC) this.handlers.keyboard(ESC);
      // Incomplete reports are dropped rather than replayed into the form.
    }, loneEscape ? 40 : 250);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.buffer = '';
    this.pasted = undefined;
  }
}

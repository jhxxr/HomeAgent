import { closeSync, openSync, readSync, writeSync } from 'node:fs';

export const TAIL_BYTES = 65536;
/** Preserve the original bounded prefix API and a separate fixed-size rolling tail. */
export class OutputLog {
  private prefix: number;
  private tail: number;
  total = 0;
  retained = 0;
  constructor(prefixFile: string, private capacity: number) {
    this.prefix = openSync(prefixFile, 'wx', 0o600);
    try { this.tail = openSync(`${prefixFile}.tail`, 'wx', 0o600); }
    catch (error) { closeSync(this.prefix); throw error; }
  }
  append(bytes: Buffer) {
    const accepted = bytes.subarray(0, Math.max(0, this.capacity - this.retained));
    if (accepted.length) { writeSync(this.prefix, accepted); this.retained += accepted.length; }
    // Only the last TAIL_BYTES of an oversized producer chunk can remain in the ring.
    const tail = bytes.subarray(Math.max(0, bytes.length - TAIL_BYTES));
    const position = (this.total + bytes.length - tail.length) % TAIL_BYTES;
    const first = Math.min(tail.length, TAIL_BYTES - position);
    if (first) writeSync(this.tail, tail, 0, first, position);
    if (first < tail.length) writeSync(this.tail, tail, first, tail.length - first, 0);
    this.total += bytes.length;
  }
  close() { closeSync(this.prefix); closeSync(this.tail); }
  static read(prefixFile: string, total: number, length: number, cursor?: number) {
    const oldest = Math.max(0, total - TAIL_BYTES);
    const requested = cursor ?? Math.max(oldest, total - length);
    const start = Math.min(total, Math.max(oldest, requested));
    const count = Math.min(length, total - start);
    const bytes = Buffer.alloc(count);
    if (count) {
      const fd = openSync(`${prefixFile}.tail`, 'r');
      try {
        const position = start % TAIL_BYTES, first = Math.min(count, TAIL_BYTES - position);
        readSync(fd, bytes, 0, first, position);
        if (first < count) readSync(fd, bytes, first, count - first, 0);
      } finally { closeSync(fd); }
    }
    return { output: bytes.toString('utf8'), cursor: start, nextCursor: start + count, oldestCursor: oldest, totalOutputBytes: total, skippedBytes: Math.max(0, oldest - requested), eof: start + count >= total };
  }
}

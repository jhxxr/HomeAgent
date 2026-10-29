import { constants } from 'node:fs';
import { open, mkdir, rename, lstat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../shared/protocol.js';
import type { ProjectConfig } from './config.js';
import { inside } from './config.js';
import { Policy } from './policy.js';

export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE = 1024 * 1024;
export class Files {
  constructor(private policy: Policy) {}
  private async bounded(handle: FileHandle, max: number) {
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const next = await handle.read(buffer, size, buffer.length - size, size);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    if (size > max) throw new AppError('file_limit', 'File grew beyond the read limit');
    return buffer.subarray(0, size);
  }
  private async readSafe(filename: string, max = MAX_FILE) {
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1 || stat.size > max) throw new AppError('file_limit', 'Expected a regular file within the size limit');
      return await this.bounded(handle, max);
    } finally { await handle.close(); }
  }
  async read(project: ProjectConfig, args: { path: string; offset: number; length: number; expectedRevision?: string }) {
    const filename = await this.policy.resolve(project, args.path);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink > 1) throw new AppError('not_file', 'Expected a regular file');
      const revisionOf = (value: typeof stat) => sha256(JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs]));
      const revision = revisionOf(stat);
      if (args.expectedRevision && args.expectedRevision !== revision) throw new AppError('conflict', 'File changed between paged reads; restart from offset zero');
      const buffer = Buffer.alloc(args.length);
      const { bytesRead } = await handle.read(buffer, 0, args.length, args.offset);
      const bytes = buffer.subarray(0, bytesRead);
      const digest = stat.size <= MAX_FILE ? sha256(await this.bounded(handle, MAX_FILE)) : undefined;
      if (revisionOf(await handle.stat()) !== revision) throw new AppError('conflict', 'File changed during this read');
      return { text: bytes.toString('utf8'), offset: args.offset, nextOffset: args.offset + bytesRead, size: stat.size, eof: args.offset + bytesRead >= stat.size, revision, sha256: digest };
    } finally { await handle.close(); }
  }
  async atomic(filename: string, content: Buffer, guard?: () => void) {
    const temporary = path.join(path.dirname(filename), `.ha-${randomUUID()}.tmp`);
    let mode = 0o600;
    try { mode = (await lstat(filename)).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(content); await handle.sync(); }
      finally { await handle.close(); }
      guard?.();
      await rename(temporary, filename);
    }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async snapshot(project: ProjectConfig, input: string, allowMissing = false, max = MAX_FILE) {
    const filename = await this.policy.resolve(project, input, allowMissing);
    try {
      const bytes = await this.readSafe(filename, max);
      const stat = await lstat(filename);
      return { filename, bytes, sha256: sha256(bytes), mode: stat.mode & 0o777 };
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { filename, bytes: null, sha256: null, mode: 0o600 };
      throw error;
    }
  }
  async readFiles(project: ProjectConfig, args: { files: { path: string; startLine: number; endLine?: number; expectedSha256?: string }[]; maxBytes: number }) {
    const results: Record<string, unknown>[] = [];
    let remaining = args.maxBytes;
    for (const item of args.files) {
      if (remaining <= 0) { results.push({ path: item.path, error: 'result_budget', suggestedCall: { name: 'read_files', arguments: { projectId: project.id, files: [item], maxBytes: args.maxBytes } } }); continue; }
      try {
        const snapshot = await this.snapshot(project, item.path, false, 8 * MAX_FILE);
        if (item.expectedSha256 && snapshot.sha256 !== item.expectedSha256) throw new AppError('conflict', 'File changed since the earlier read');
        if (snapshot.bytes!.includes(0)) throw new AppError('binary_file', 'Use a binary artifact tool for this file');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes!);
        const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const end = Math.min(item.endLine ?? item.startLine + 199, item.startLine + 999, lines.length);
        if (item.endLine !== undefined && item.endLine < item.startLine) throw new AppError('invalid_range', 'endLine precedes startLine');
        let selected = '', line = item.startLine - 1;
        while (line < end) {
          const next = lines[line]!;
          if (Buffer.byteLength(selected) + Buffer.byteLength(next) > remaining) break;
          selected += next; line++;
        }
        const used = Buffer.byteLength(selected); remaining -= used;
        const truncated = line < Math.min(item.endLine ?? lines.length, lines.length);
        const response: Record<string, unknown> = { path: item.path, text: selected, startLine: item.startLine, endLine: line, totalLines: lines.length, sha256: snapshot.sha256, bytes: snapshot.bytes!.length, truncated, nextStartLine: truncated && line >= item.startLine ? line + 1 : null };
        if (line < end && !used) response.error = 'line_exceeds_budget';
        results.push(response);
      } catch (error) {
        results.push({ path: item.path, error: error instanceof AppError ? error.code : 'read_failed', message: error instanceof Error ? error.message : 'Read failed' });
      }
    }
    return { files: results, bytesReturned: args.maxBytes - remaining, budgetBytes: args.maxBytes };
  }
  async write(project: ProjectConfig, args: { path: string; content: string; append: boolean; expectedSha256?: string }) {
    const filename = await this.policy.resolve(project, args.path, true);
    let prior = Buffer.alloc(0);
    if (args.append || args.expectedSha256) {
      try { prior = await this.readSafe(filename); }
      catch (error) { if (!args.expectedSha256 && (error as NodeJS.ErrnoException).code === 'ENOENT') {} else throw error; }
    }
    if (args.expectedSha256 && sha256(prior) !== args.expectedSha256) throw new AppError('conflict', 'File changed since it was read');
    const next = args.append ? Buffer.concat([prior, Buffer.from(args.content)]) : Buffer.from(args.content);
    if (next.length > MAX_FILE) throw new AppError('file_limit', 'Result exceeds 1 MiB; split the file');
    await this.atomic(filename, next, () => this.policy.check(project));
    return { written: next.length, sha256: sha256(next) };
  }
  async edit(project: ProjectConfig, args: { path: string; oldText: string; newText: string; expectedSha256?: string }) {
    const filename = await this.policy.resolve(project, args.path);
    const bytes = await this.readSafe(filename);
    if (args.expectedSha256 && sha256(bytes) !== args.expectedSha256) throw new AppError('conflict', 'File changed since it was read');
    const text = bytes.toString('utf8');
    const index = text.indexOf(args.oldText);
    if (index < 0 || text.indexOf(args.oldText, index + 1) >= 0) throw new AppError('not_unique', 'oldText must match exactly once');
    const next = Buffer.from(text.slice(0, index) + args.newText + text.slice(index + args.oldText.length));
    if (next.length > MAX_FILE) throw new AppError('file_limit', 'Result exceeds file limit');
    await this.atomic(filename, next, () => this.policy.check(project));
    return { written: next.length, sha256: sha256(next) };
  }
  async list(project: ProjectConfig, args: { path: string; limit: number; offset?: number }) {
    const directory = await this.policy.resolve(project, args.path);
    const dir = await openDirectory(directory);
    const entries: { name: string; type: string }[] = [];
    let truncated = false, index = 0, scanned = 0, sourceTruncated = false;
    try {
      for await (const item of dir) {
        if (++scanned > 100000) { sourceTruncated = true; break; }
        if (project.deniedNames.some(name => name.toLowerCase() === item.name.toLowerCase()) || item.isSymbolicLink()) continue;
        const candidate = path.join(directory, item.name);
        if ((this.policy.config.protectedPaths ?? []).some(privatePath => path.resolve(privatePath) === path.resolve(candidate) || inside(privatePath, candidate))) continue;
        if (index++ < (args.offset ?? 0)) continue;
        if (entries.length >= args.limit) { truncated = true; break; }
        entries.push({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' });
      }
    } finally { await dir.close().catch(() => {}); }
    return { entries: entries.sort((a, b) => a.name.localeCompare(b.name)), offset: args.offset ?? 0, nextOffset: truncated && !sourceTruncated ? (args.offset ?? 0) + entries.length : null, truncated: truncated || sourceTruncated, sourceTruncated };
  }
  async info(project: ProjectConfig, input: string) {
    const stat = await lstat(await this.policy.resolve(project, input));
    return { type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime.toISOString() };
  }
  async mkdir(project: ProjectConfig, input: string) {
    const target = await this.policy.resolve(project, input, true);
    this.policy.check(project);
    await mkdir(target, { recursive: true }); return { created: true };
  }
  async move(project: ProjectConfig, source: string, destination: string) {
    const from = await this.policy.resolve(project, source), to = await this.policy.resolve(project, destination, true);
    if (from === project.root || to === project.root) throw new AppError('root_move', 'Cannot move a project root');
    if ([this.policy.config.stateDir, ...(this.policy.config.protectedPaths ?? [])].some(privatePath => inside(from, privatePath) || inside(to, privatePath))) throw new AppError('private_state', 'Cannot move a directory containing Runner configuration or private state');
    try { await lstat(to); throw new AppError('exists', 'Destination already exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.policy.check(project);
    await rename(from, to); return { moved: true };
  }
  async search(project: ProjectConfig, args: { path: string; query: string; content: boolean; caseSensitive: boolean; limit: number; include?: string[]; exclude?: string[]; contextLines?: number }, signal?: AbortSignal, sourcePaths?: string[]) {
    const start = await this.policy.resolve(project, args.path), pending = sourcePaths ? sourcePaths.slice(0, 10000).map(name => path.join(project.root, name)) : [start];
    const matches: { path: string; line?: number; text?: string; context?: { startLine: number; text: string } }[] = [];
    let scanned = 0, truncated = false, resultBytes = 0, budgetExhausted = false;
    const normalize = (value: string) => args.caseSensitive ? value : value.toLowerCase();
    const query = normalize(args.query);
    while (pending.length && matches.length < args.limit && !budgetExhausted) {
      if (signal?.aborted) throw new AppError('cancelled', 'Search cancelled');
      if (++scanned > 10000) { truncated = true; break; }
      const filename = pending.pop()!;
      let stat;
      try { await this.policy.resolve(project, filename); stat = await lstat(filename); }
      catch { continue; }
      const relative = path.relative(project.root, filename);
      const normalized = relative.split(path.sep).join('/');
      if (!stat.isDirectory() && ((args.include?.length && !args.include.some(pattern => path.matchesGlob(normalized, pattern))) || args.exclude?.some(pattern => path.matchesGlob(normalized, pattern)))) continue;
      if (!args.content && normalize(relative).includes(query)) matches.push({ path: relative });
      if (stat.isDirectory()) {
        const dir = await openDirectory(filename);
        for await (const entry of dir) {
          if (pending.length + scanned >= 10000) { truncated = true; break; }
          if (!entry.isSymbolicLink() && entry.name !== 'node_modules' && !project.deniedNames.includes(entry.name)) pending.push(path.join(filename, entry.name));
        }
      } else if (args.content && stat.isFile() && stat.size <= MAX_FILE) {
        try {
          const buffer = await this.readSafe(filename);
          if (buffer.includes(0)) continue;
          const lines = buffer.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && matches.length < args.limit; i++) if (normalize(lines[i]!).includes(query)) {
            const context = args.contextLines ? { startLine: Math.max(0, i - args.contextLines) + 1, text: lines.slice(Math.max(0, i - args.contextLines), i + args.contextLines + 1).map(line => line.slice(0, 1000)).join('\n') } : undefined;
            const match = { path: relative, line: i + 1, text: lines[i]!.slice(0, 1000), ...(context ? { context } : {}) };
            const size = Buffer.byteLength(JSON.stringify(match));
            if (resultBytes + size > 262144) { budgetExhausted = true; break; }
            resultBytes += size; matches.push(match);
          }
        } catch { /* Unreadable files do not abort a bounded search. */ }
      }
    }
    return { matches, scanned, gitIgnoreApplied: sourcePaths !== undefined, truncated: budgetExhausted || truncated || pending.length > 0 || matches.length >= args.limit || (sourcePaths?.length ?? 0) > 10000 };
  }
}
// opendir streams large directories without allocating an unbounded listing.
import { opendir as openDirectory } from 'node:fs/promises';

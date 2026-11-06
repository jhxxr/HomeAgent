import { accessSync, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import os from 'node:os';
import { inside } from './config.js';

export interface MemoryHint {
  file: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  content: string;
  matchedPaths: string[];
}

interface IndexEntry {
  globs: string[];
  severity: 'critical' | 'warning' | 'info';
  source: string;
  created?: string;
}

interface CachedIndex {
  mtimeMs: number;
  entries: Record<string, IndexEntry>;
}

const MAX_CHARTER_BYTES = 8192;
const MAX_HINT_BYTES = 4096;
const MAX_HINTS = 3;
const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function resolveWorkspacePath(configDir?: string): string {
  if (process.env.HOMEAGENT_WORKSPACE) return path.resolve(process.env.HOMEAGENT_WORKSPACE);
  if (configDir) {
    const candidate = path.join(configDir, 'workspace.json');
    try { accessSync(candidate); return configDir; } catch {}
  }
  return path.join(os.homedir(), '.homeagent', 'workspace');
}

function safeFilename(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(value)
    && !/[. ]$/.test(value) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

// Streaming decoding leaves an incomplete final UTF-8 sequence buffered rather than emitting U+FFFD.
const utf8Prefix = (buffer: Buffer, limit: number) => buffer.length > limit
  ? new StringDecoder('utf8').write(buffer.subarray(0, limit)) : buffer.toString('utf8');

export class Memory {
  private indexCache = new Map<string, CachedIndex>();
  constructor(private workspacePath: string) {}

  private memoryDir(projectId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId) || !safeFilename(projectId)) throw new Error('Invalid memory project ID');
    return path.join(this.workspacePath, 'memory', projectId);
  }

  /** The configured workspace is trusted; no link underneath it may redirect memory reads. */
  private async checkedPath(projectId: string, parts: string[]): Promise<string> {
    this.memoryDir(projectId); // Validate before constructing any filesystem path.
    if (!parts.every(safeFilename)) throw new Error('Invalid memory filename');
    const root = await realpath(this.workspacePath);
    let current = root;
    const components = ['memory', projectId, ...parts];
    for (const [index, part] of components.entries()) {
      current = path.join(current, part);
      if (!inside(root, current)) throw new Error('Memory path escape');
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (index < components.length - 1 ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw new Error('Unsafe memory file');
      if (!inside(root, await realpath(current))) throw new Error('Resolved memory path escape');
    }
    return current;
  }

  private async readMemoryFile(projectId: string, parts: string[], limit: number): Promise<Buffer> {
    const filename = await this.checkedPath(projectId, parts);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error('Unsafe memory file');
      const checked = await lstat(await this.checkedPath(projectId, parts));
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) throw new Error('Memory file changed');
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      return buffer.subarray(0, size);
    } finally { await handle.close(); }
  }

  async charter(projectId: string): Promise<{ text: string; truncated: boolean } | null> {
    try {
      const buffer = await this.readMemoryFile(projectId, ['charter.md'], MAX_CHARTER_BYTES);
      const truncated = buffer.byteLength > MAX_CHARTER_BYTES;
      const text = utf8Prefix(buffer, MAX_CHARTER_BYTES);
      return text ? { text, truncated } : null;
    } catch { return null; }
  }

  private async loadIndex(projectId: string): Promise<Record<string, IndexEntry>> {
    try {
      const filename = await this.checkedPath(projectId, ['pitfalls', '_index.json']);
      const s = await lstat(filename);
      const cached = this.indexCache.get(projectId);
      if (cached && cached.mtimeMs === s.mtimeMs) return cached.entries;
      const buffer = await this.readMemoryFile(projectId, ['pitfalls', '_index.json'], 262144);
      if (buffer.length > 262144) return {};
      const raw: unknown = JSON.parse(buffer.toString('utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
      const entries: Record<string, IndexEntry> = Object.create(null);
      for (const [file, value] of Object.entries(raw)) {
        if (!safeFilename(file) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
        const v = value as Record<string, unknown>;
        if (!Array.isArray(v.globs) || !v.globs.every(g => typeof g === 'string')) continue;
        entries[file] = {
          globs: v.globs as string[],
          severity: (['critical', 'warning', 'info'].includes(v.severity as string) ? v.severity : 'info') as IndexEntry['severity'],
          source: typeof v.source === 'string' ? v.source : '',
          created: typeof v.created === 'string' ? v.created : undefined,
        };
      }
      this.indexCache.set(projectId, { mtimeMs: s.mtimeMs, entries });
      return entries;
    } catch { return {}; }
  }

  async match(projectId: string, paths: string[]): Promise<MemoryHint[]> {
    if (!paths.length) return [];
    const index = await this.loadIndex(projectId);
    const normalized = paths.map(p => path.posix.normalize(p.replaceAll('\\', '/')).replace(/^\.\//, ''));
    const hits: { file: string; entry: IndexEntry; matchedPaths: string[] }[] = [];
    for (const [file, entry] of Object.entries(index)) {
      const matched = normalized.filter(p => entry.globs.some(g => path.posix.matchesGlob(p, g)));
      if (matched.length) hits.push({ file, entry, matchedPaths: matched });
    }
    hits.sort((a, b) => (SEVERITY_ORDER[a.entry.severity] ?? 2) - (SEVERITY_ORDER[b.entry.severity] ?? 2));
    const results: MemoryHint[] = [];
    let totalBytes = 0;
    for (const hit of hits) {
      if (results.length >= MAX_HINTS) break;
      try {
        const remaining = MAX_HINT_BYTES - totalBytes;
        if (remaining <= 0) break;
        const buffer = await this.readMemoryFile(projectId, ['pitfalls', hit.file], remaining);
        const content = utf8Prefix(buffer, remaining);
        totalBytes += Buffer.byteLength(content);
        const prefix = hit.entry.severity === 'critical' ? '⚠️' : '💡';
        results.push({
          file: hit.file,
          severity: hit.entry.severity,
          source: hit.entry.source,
          content: `${prefix} [${hit.entry.severity} · 来源: ${hit.entry.source}]\n${content}`,
          matchedPaths: hit.matchedPaths,
        });
      } catch { /* Missing memory file — skip silently. */ }
    }
    return results;
  }
}

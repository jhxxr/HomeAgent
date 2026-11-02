import { AppError } from '../shared/protocol.js';
import type { FileChange } from '../shared/tools.js';
import type { ProjectConfig } from './config.js';
import type { Files } from './files.js';

export interface PatchOptions {
  fuzz?: number;
  ignoreWhitespace?: boolean;
}
export interface RelocatedHunk {
  path: string;
  hunkIndex: number;
  expectedLine: number;
  appliedLine: number;
  offset: number;
  whitespaceNormalized?: boolean;
}
export type ParsedPatch = FileChange[] & { relocatedHunks: RelocatedHunk[] };

const normalizeLine = (line: string) => line.replace(/[ \t]+(?=\n|$)/g, '').trimStart();

/** Unified diff parser with optional bounded fuzzy hunk relocation and whitespace tolerance. */
export async function parseUnifiedDiff(files: Files, project: ProjectConfig, diff: string, expected: Record<string, string | null>, options: PatchOptions = {}): Promise<ParsedPatch> {
  const fuzz = Math.max(0, Math.min(200, options.fuzz ?? 20));
  const ignoreWhitespace = options.ignoreWhitespace ?? false;
  const relocatedHunks: RelocatedHunk[] = [];
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const changes: FileChange[] = [];
  let index = 0;
  const filename = (line: string, prefix: string) => {
    const name = line.slice(prefix.length).split('\t')[0]!;
    if (!name || name.startsWith('"')) throw new AppError('invalid_patch', 'Quoted/empty diff paths are not supported');
    return name === '/dev/null' ? null : name.replace(/^[ab]\//, '');
  };
  while (index < lines.length) {
    if (!lines[index] || /^(diff --git |index |new file mode |deleted file mode )/.test(lines[index]!)) { index++; continue; }
    if (!lines[index]!.startsWith('--- ')) throw new AppError('invalid_patch', 'Expected --- file header; binary/mode-only/rename patches are not supported');
    const beforePath = filename(lines[index++]!, '--- ');
    if (!lines[index]?.startsWith('+++ ')) throw new AppError('invalid_patch', 'Missing +++ file header');
    const afterPath = filename(lines[index++]!, '+++ ');
    if ((!beforePath && !afterPath) || (beforePath && afterPath && beforePath !== afterPath)) throw new AppError('invalid_patch', 'Rename patches are not supported');
    const name = afterPath ?? beforePath!;
    if (!Object.hasOwn(expected, name)) throw new AppError('missing_revision', `Supply expectedSha256 for ${name}`);
    const snapshot = await files.snapshot(project, name, true);
    if (snapshot.sha256 !== expected[name] || (!beforePath && snapshot.bytes !== null) || (beforePath && snapshot.bytes === null)) throw new AppError('conflict', `Patch file changed: ${name}`);
    const originalText = snapshot.bytes ? new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes) : '';
    const crlf = originalText.includes('\r\n'), original = originalText.replace(/\r\n/g, '\n').match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const output: string[] = [];
    let consumed = 0, hunks = 0;
    while (index < lines.length && lines[index]!.startsWith('@@ ')) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[index++]!);
      if (!header) throw new AppError('invalid_patch', 'Invalid hunk header');
      const oldCount = Number(header[2] ?? 1), newCount = Number(header[4] ?? 1);
      const oldStart = oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1;
      const newStart = newCount === 0 ? Number(header[3]) : Number(header[3]) - 1;
      if (fuzz === 0) {
        if (oldStart < consumed || oldStart > original.length) throw new AppError('invalid_patch', 'Overlapping or out-of-range hunks');
        if (newStart !== output.length + (oldStart - consumed)) throw new AppError('invalid_patch', 'New hunk line position does not match preceding changes');
      }
      const removed: string[] = [], added: string[] = [];
      let oldLines = 0, newLines = 0, previous: { old?: number; next?: number } | undefined;
      while (oldLines < oldCount || newLines < newCount) {
        const line = lines[index++]!;
        if (line === undefined || ![' ', '+', '-'].includes(line[0] ?? '')) throw new AppError('invalid_patch', 'Unexpected end or invalid hunk body');
        const value = `${line.slice(1)}\n`;
        previous = {};
        if (line[0] !== '+') { previous.old = removed.length; removed.push(value); oldLines++; }
        if (line[0] !== '-') { previous.next = added.length; added.push(value); newLines++; }
        if (lines[index] === '\\ No newline at end of file') {
          if (previous.old !== undefined) removed[previous.old] = removed[previous.old]!.slice(0, -1);
          if (previous.next !== undefined) added[previous.next] = added[previous.next]!.slice(0, -1);
          index++;
        }
        if (oldLines > oldCount || newLines > newCount) throw new AppError('invalid_patch', 'Hunk line counts do not match header');
      }
      const matchesAt = (pos: number, loose: boolean) => {
        if (pos < consumed || pos + oldCount > original.length) return false;
        for (let k = 0; k < oldCount; k++) {
          const left = original[pos + k]!, right = removed[k]!;
          if (loose ? normalizeLine(left) !== normalizeLine(right) : left !== right) return false;
        }
        return true;
      };
      let targetPos: number | undefined;
      if (oldCount === 0) {
        if (oldStart < consumed || oldStart > original.length) throw new AppError('invalid_patch', 'Overlapping or out-of-range hunks');
        targetPos = oldStart;
      } else if (matchesAt(oldStart, false)) {
        targetPos = oldStart;
      } else if (fuzz > 0) {
        const minPos = Math.max(consumed, oldStart - fuzz), maxPos = Math.min(original.length - oldCount, oldStart + fuzz);
        const exactCandidates: number[] = [];
        for (let pos = minPos; pos <= maxPos; pos++) if (matchesAt(pos, false)) exactCandidates.push(pos);
        if (exactCandidates.length === 1) {
          targetPos = exactCandidates[0]!;
          relocatedHunks.push({ path: name, hunkIndex: hunks + 1, expectedLine: oldStart + 1, appliedLine: targetPos + 1, offset: targetPos - oldStart });
        } else if (exactCandidates.length > 1) {
          throw new AppError('ambiguous_patch', `Fuzzy hunk context matches multiple locations in ${name}`);
        }
      }
      if (targetPos === undefined && ignoreWhitespace && oldCount > 0) {
        const minPos = Math.max(consumed, oldStart - fuzz), maxPos = Math.min(original.length - oldCount, oldStart + fuzz);
        const looseCandidates: number[] = [];
        for (let pos = minPos; pos <= maxPos; pos++) if (matchesAt(pos, true)) looseCandidates.push(pos);
        if (looseCandidates.length === 1) {
          targetPos = looseCandidates[0]!;
          relocatedHunks.push({ path: name, hunkIndex: hunks + 1, expectedLine: oldStart + 1, appliedLine: targetPos + 1, offset: targetPos - oldStart, whitespaceNormalized: true });
        } else if (looseCandidates.length > 1) {
          throw new AppError('ambiguous_patch', `Fuzzy hunk context matches multiple locations in ${name}`);
        }
      }
      if (targetPos === undefined) {
        if (oldStart < consumed || oldStart > original.length) throw new AppError('invalid_patch', 'Overlapping or out-of-range hunks');
        throw new AppError('patch_context', `Hunk context does not match ${name}`);
      }
      output.push(...original.slice(consumed, targetPos));
      output.push(...added);
      consumed = targetPos + oldCount;
      hunks++;
    }
    if (!hunks) throw new AppError('invalid_patch', 'A file patch must contain at least one hunk');
    output.push(...original.slice(consumed));
    let content = output.join('');
    if (crlf) content = content.replace(/\n/g, '\r\n');
    if (!afterPath) {
      if (content !== '') throw new AppError('invalid_patch', 'Deletion must remove the complete file');
      changes.push({ operation: 'delete', path: name, expectedSha256: snapshot.sha256! });
    } else if (!beforePath) changes.push({ operation: 'create', path: name, content });
    else changes.push({ operation: 'replace', path: name, expectedSha256: snapshot.sha256!, content });
  }
  if (!changes.length || changes.length > 32) throw new AppError('invalid_patch', 'Expected 1 to 32 file changes');
  return Object.assign(changes, { relocatedHunks });
}

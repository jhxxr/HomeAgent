import { AppError } from '../shared/protocol.js';
import type { FileChange } from '../shared/tools.js';
import type { ProjectConfig } from './config.js';
import type { Files } from './files.js';

/** Deliberately strict unified diff parser: line-numbered context must match, with no fuzzy relocation. */
export async function parseUnifiedDiff(files: Files, project: ProjectConfig, diff: string, expected: Record<string, string | null>): Promise<FileChange[]> {
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
      if (oldStart < consumed || oldStart > original.length) throw new AppError('invalid_patch', 'Overlapping or out-of-range hunks');
      output.push(...original.slice(consumed, oldStart)); consumed = oldStart;
      const newStart = newCount === 0 ? Number(header[3]) : Number(header[3]) - 1;
      if (newStart !== output.length) throw new AppError('invalid_patch', 'New hunk line position does not match preceding changes');
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
      if (original.slice(consumed, consumed + oldCount).join('') !== removed.join('')) throw new AppError('patch_context', `Hunk context does not match ${name}`);
      output.push(...added); consumed += oldCount; hunks++;
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
  return changes;
}

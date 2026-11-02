import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat, opendir } from 'node:fs/promises';
import { AppError, type Principal } from '../shared/protocol.js';
import type { ProjectConfig } from './config.js';
import type { Files } from './files.js';
import type { Git } from './git.js';
import type { Policy } from './policy.js';
import { toolEnvironment } from './processes.js';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'property'
  | 'constant'
  | 'variable'
  | 'struct'
  | 'trait'
  | 'impl'
  | 'module';

export interface DocumentSymbolItem {
  name: string;
  kind: SymbolKind;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  containerName?: string;
  signature: string;
  documentation?: string;
  exported: boolean;
}

export interface ImportBinding {
  localName: string;
  importedName: string;
  source: string;
  line: number;
}

export interface DiagnosticItem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  source: string;
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.rs', '.go', '.java', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.json',
]);

function isCodeFile(filename: string): boolean {
  return CODE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function extractLeadingDoc(lines: string[], lineIndex: number): string | undefined {
  const docLines: string[] = [];
  let idx = lineIndex - 1;
  while (idx >= 0 && lines[idx]!.trim() === '') {
    if (lineIndex - idx > 1) break;
    idx--;
  }
  if (idx < 0) return undefined;
  const trimmed = lines[idx]!.trim();
  if (trimmed.endsWith('*/')) {
    const block: string[] = [];
    while (idx >= 0) {
      const current = lines[idx]!.trim();
      block.unshift(
        current
          .replace(/^\/\*\*?/, '')
          .replace(/\*\/$/, '')
          .replace(/^\*\s?/, '')
          .trim(),
      );
      if (current.startsWith('/*')) break;
      idx--;
    }
    const text = block.filter(Boolean).join('\n').trim();
    return text || undefined;
  }
  while (idx >= 0) {
    const current = lines[idx]!.trim();
    if (current.startsWith('///') || current.startsWith('//!') || current.startsWith('//')) {
      docLines.unshift(current.replace(/^\/\/[/!]?\s?/, ''));
      idx--;
    } else if (current.startsWith('#') && !current.startsWith('#!')) {
      docLines.unshift(current.replace(/^#+\s?/, ''));
      idx--;
    } else {
      break;
    }
  }
  const joined = docLines.join('\n').trim();
  return joined || undefined;
}

function extractPythonDocstring(lines: string[], startLineIndex: number): string | undefined {
  let idx = startLineIndex + 1;
  while (idx < lines.length && lines[idx]!.trim() === '') idx++;
  if (idx >= lines.length) return undefined;
  const first = lines[idx]!.trim();
  const quote = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : undefined;
  if (!quote) return undefined;
  const afterOpen = first.slice(3);
  if (afterOpen.endsWith(quote) && afterOpen.length >= 3) {
    return afterOpen.slice(0, -3).trim() || undefined;
  }
  const collected: string[] = [afterOpen];
  idx++;
  while (idx < lines.length) {
    const line = lines[idx]!;
    const endAt = line.indexOf(quote);
    if (endAt >= 0) {
      collected.push(line.slice(0, endAt));
      break;
    }
    collected.push(line.trim());
    idx++;
  }
  return collected.join('\n').trim() || undefined;
}

function findBlockEndLine(lines: string[], startIndex: number, ext: string): number {
  if (ext === '.py') {
    const baseIndent = lines[startIndex]!.match(/^\s*/)?.[0].length ?? 0;
    let lastContent = startIndex;
    for (let i = startIndex + 1; i < lines.length; i++) {
      const text = lines[i]!;
      const trimmed = text.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = text.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      lastContent = i;
    }
    return lastContent + 1;
  }
  let depth = 0;
  let opened = false;
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === '/' && line[c + 1] === '/') break;
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') {
        depth--;
        if (opened && depth <= 0) return i + 1;
      }
    }
    if (!opened && line.trim().endsWith(';')) return i + 1;
  }
  return startIndex + 1;
}

export function parseDocumentIntelligence(text: string, filename: string): { symbols: DocumentSymbolItem[]; imports: ImportBinding[] } {
  const ext = path.extname(filename).toLowerCase();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const symbols: DocumentSymbolItem[] = [];
  const imports: ImportBinding[] = [];

  if (ext === '.py') {
    const containerStack: { name: string; indent: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = raw.match(/^\s*/)?.[0].length ?? 0;
      while (containerStack.length && containerStack[containerStack.length - 1]!.indent >= indent) {
        containerStack.pop();
      }
      const fromImport = /^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)$/.exec(trimmed);
      if (fromImport) {
        const mod = fromImport[1]!;
        const parts = fromImport[2]!.split(',');
        for (const part of parts) {
          const clean = part.trim();
          if (!clean || clean === '*') continue;
          const asMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(clean);
          if (asMatch) {
            imports.push({
              importedName: asMatch[1]!,
              localName: asMatch[2] ?? asMatch[1]!,
              source: mod,
              line: i + 1,
            });
          }
        }
        continue;
      }
      const plainImport = /^import\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?$/.exec(trimmed);
      if (plainImport) {
        const mod = plainImport[1]!;
        const local = plainImport[2] ?? mod.split('.')[0]!;
        imports.push({ importedName: '*', localName: local, source: mod, line: i + 1 });
        continue;
      }
      const classMatch = /^class\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(trimmed);
      if (classMatch) {
        const name = classMatch[1]!;
        const col = raw.indexOf(name) + 1;
        const endLine = findBlockEndLine(lines, i, ext);
        const containerName = containerStack[containerStack.length - 1]?.name;
        const doc = extractPythonDocstring(lines, i) ?? extractLeadingDoc(lines, i);
        symbols.push({
          name,
          kind: 'class',
          line: i + 1,
          column: col,
          endLine,
          endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
          ...(containerName ? { containerName } : {}),
          signature: trimmed.replace(/:\s*$/, ''),
          ...(doc ? { documentation: doc } : {}),
          exported: !name.startsWith('_'),
        });
        containerStack.push({ name, indent });
        continue;
      }
      const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(trimmed);
      if (defMatch) {
        const name = defMatch[1]!;
        const col = raw.indexOf(name) + 1;
        const endLine = findBlockEndLine(lines, i, ext);
        const containerName = containerStack[containerStack.length - 1]?.name;
        const doc = extractPythonDocstring(lines, i) ?? extractLeadingDoc(lines, i);
        symbols.push({
          name,
          kind: containerName ? 'method' : 'function',
          line: i + 1,
          column: col,
          endLine,
          endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
          ...(containerName ? { containerName } : {}),
          signature: trimmed.replace(/:\s*$/, ''),
          ...(doc ? { documentation: doc } : {}),
          exported: !name.startsWith('_'),
        });
        continue;
      }
      if (indent === 0) {
        const assignMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[^=]+)?=\s*(.+)$/.exec(trimmed);
        if (assignMatch) {
          const name = assignMatch[1]!;
          const col = raw.indexOf(name) + 1;
          const doc = extractLeadingDoc(lines, i);
          symbols.push({
            name,
            kind: /^[A-Z0-9_]+$/.test(name) ? 'constant' : 'variable',
            line: i + 1,
            column: col,
            endLine: i + 1,
            endColumn: raw.length + 1,
            signature: trimmed.slice(0, 160),
            ...(doc ? { documentation: doc } : {}),
            exported: !name.startsWith('_'),
          });
        }
      }
    }
    return { symbols, imports };
  }

  // JS/TS/Rust/Go/C-family line + brace tracker
  let braceDepth = 0;
  const containers: { name: string; depth: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    // Track ES module imports
    const esImport = /^import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/.exec(trimmed);
    if (esImport) {
      const clause = esImport[1]!.trim();
      const source = esImport[2]!;
      const namedMatch = /\{([^}]+)\}/.exec(clause);
      if (namedMatch) {
        for (const item of namedMatch[1]!.split(',')) {
          const clean = item.trim().replace(/^type\s+/, '');
          if (!clean) continue;
          const parts = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(clean);
          if (parts) {
            imports.push({ importedName: parts[1]!, localName: parts[2] ?? parts[1]!, source, line: i + 1 });
          }
        }
      }
      const namespaceMatch = /\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(clause);
      if (namespaceMatch) {
        imports.push({ importedName: '*', localName: namespaceMatch[1]!, source, line: i + 1 });
      }
      const defaultMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,|$)/.exec(clause);
      if (defaultMatch && defaultMatch[1] !== 'type') {
        imports.push({ importedName: 'default', localName: defaultMatch[1]!, source, line: i + 1 });
      }
    }
    const cjsRequire = /^(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/.exec(trimmed);
    if (cjsRequire) {
      const target = cjsRequire[1]!.trim();
      const source = cjsRequire[2]!;
      if (target.startsWith('{') && target.endsWith('}')) {
        for (const item of target.slice(1, -1).split(',')) {
          const clean = item.trim();
          const parts = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(clean);
          if (parts) imports.push({ importedName: parts[1]!, localName: parts[2] ?? parts[1]!, source, line: i + 1 });
        }
      } else {
        imports.push({ importedName: 'default', localName: target, source, line: i + 1 });
      }
    }

    const currentContainer = containers[containers.length - 1]?.name;
    const exported = /^(?:export\s+|pub(?:\([^)]*\))?\s+)/.test(trimmed) || (ext === '.go' && /^[A-Z]/.test(trimmed.replace(/^(?:func|type|var|const)\s+/, '')));
    const doc = extractLeadingDoc(lines, i);

    const patterns: [RegExp, SymbolKind, boolean][] = [
      [/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/, 'class', true],
      [/^(?:export\s+(?:default\s+)?)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/, 'interface', true],
      [/^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*=/, 'type', false],
      [/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)/, 'enum', true],
      [/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/, 'function', false],
      [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/, 'function', false],
      [/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=/, 'constant', false],
      [/^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=]+)?=/, 'variable', false],
      [/^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)/, 'struct', true],
      [/^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/, 'trait', true],
      [/^impl(?:<[^>]*>)?\s+(?:[A-Za-z0-9_:<>]+\s+for\s+)?([A-Za-z_][A-Za-z0-9_]*)/, 'impl', true],
      [/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, 'function', false],
      [/^func\s+(?:\([^)]+\)\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function', false],
      [/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/, 'struct', true],
      [/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\b/, 'interface', true],
    ];

    let matched = false;
    for (const [regex, kind, isContainer] of patterns) {
      if ((kind === 'constant' || kind === 'variable') && braceDepth > 0) continue;
      const m = regex.exec(trimmed);
      if (m) {
        const name = m[1]!;
        const col = raw.indexOf(name) + 1;
        const endLine = findBlockEndLine(lines, i, ext);
        const resolvedKind: SymbolKind = currentContainer && kind === 'function' ? 'method' : kind;
        symbols.push({
          name,
          kind: resolvedKind,
          line: i + 1,
          column: col,
          endLine,
          endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
          ...(currentContainer ? { containerName: currentContainer } : {}),
          signature: trimmed.replace(/\s*\{$/, '').slice(0, 180),
          ...(doc ? { documentation: doc } : {}),
          exported: exported || (ext === '.go' && /^[A-Z]/.test(name)),
        });
        if (isContainer) {
          containers.push({ name, depth: braceDepth });
        }
        matched = true;
        break;
      }
    }

    if (!matched && currentContainer && braceDepth === (containers[containers.length - 1]?.depth ?? 0) + 1) {
      const methodMatch = /^(?:(?:public|private|protected|readonly|static|async|override|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^{;]+)?\{?$/.exec(trimmed);
      if (methodMatch) {
        const name = methodMatch[1]!;
        if (!['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'super'].includes(name)) {
          const col = raw.indexOf(name) + 1;
          const endLine = findBlockEndLine(lines, i, ext);
          symbols.push({
            name,
            kind: 'method',
            line: i + 1,
            column: col,
            endLine,
            endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
            containerName: currentContainer,
            signature: trimmed.replace(/\s*\{$/, '').slice(0, 180),
            ...(doc ? { documentation: doc } : {}),
            exported: false,
          });
        }
      }
    }

    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c]!;
      if (ch === '/' && raw[c + 1] === '/') break;
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        while (containers.length && containers[containers.length - 1]!.depth >= braceDepth) {
          containers.pop();
        }
      }
    }
  }
  return { symbols, imports };
}

function identifierAtPosition(lines: string[], line?: number, column?: number): string | undefined {
  if (!line || line < 1 || line > lines.length) return undefined;
  const text = lines[line - 1]!;
  const regex = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  const tokens: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(regex)) {
    const start = (match.index ?? 0) + 1;
    tokens.push({ word: match[0], start, end: start + match[0].length - 1 });
  }
  if (!tokens.length) return undefined;
  if (column !== undefined) {
    const exact = tokens.find(token => column >= token.start && column <= token.end + 1);
    if (exact) return exact.word;
  }
  const keywords = new Set(['import', 'from', 'export', 'default', 'const', 'let', 'var', 'function', 'async', 'await', 'return', 'class', 'interface', 'type', 'enum', 'def', 'fn', 'pub', 'struct', 'trait', 'impl', 'func']);
  return (tokens.find(token => !keywords.has(token.word)) ?? tokens[0])!.word;
}

export class Lsp {
  constructor(private policy: Policy, private files: Files, private git: Git) {}

  private async listSourceFiles(project: ProjectConfig, subPath: string, respectGitIgnore: boolean, signal?: AbortSignal): Promise<{ files: string[]; gitIgnoreApplied: boolean; truncated: boolean }> {
    let sourcePaths: string[] | undefined;
    if (respectGitIgnore) {
      try { sourcePaths = await this.git.listFiles(project, subPath, signal); }
      catch (error) { if (error instanceof AppError && error.code === 'search_source_limit') throw error; }
    }
    if (sourcePaths !== undefined) {
      const filtered = sourcePaths.filter(isCodeFile);
      return { files: filtered.slice(0, 2000), gitIgnoreApplied: true, truncated: filtered.length > 2000 };
    }
    const start = await this.policy.resolve(project, subPath);
    const pending = [start];
    const discovered: string[] = [];
    let scanned = 0, truncated = false;
    while (pending.length && discovered.length < 2000) {
      if (signal?.aborted) throw new AppError('cancelled', 'LSP workspace scan cancelled');
      if (++scanned > 10000) { truncated = true; break; }
      const current = pending.pop()!;
      let stat;
      try { await this.policy.resolve(project, current); stat = await lstat(current); }
      catch { continue; }
      if (stat.isDirectory()) {
        const dir = await opendir(current);
        for await (const entry of dir) {
          if (pending.length + scanned >= 10000) { truncated = true; break; }
          if (!entry.isSymbolicLink() && entry.name !== 'node_modules' && entry.name !== 'dist' && !project.deniedNames.includes(entry.name)) {
            pending.push(path.join(current, entry.name));
          }
        }
      } else if (stat.isFile() && isCodeFile(current)) {
        discovered.push(path.relative(project.root, current));
      }
    }
    return { files: discovered.sort(), gitIgnoreApplied: false, truncated };
  }

  private async readText(project: ProjectConfig, filePath: string): Promise<{ text: string; lines: string[]; sha256: string }> {
    const snapshot = await this.files.snapshot(project, filePath);
    if (snapshot.bytes!.includes(0)) throw new AppError('binary_file', 'LSP tools require UTF-8 text files');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.bytes!);
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    return { text, lines, sha256: snapshot.sha256! };
  }

  private async resolveModuleFile(project: ProjectConfig, fromFile: string, specifier: string): Promise<string | undefined> {
    const fromDir = path.dirname(path.join(project.root, fromFile));
    const candidates: string[] = [];
    if (specifier.startsWith('.')) {
      const base = path.resolve(fromDir, specifier);
      const ext = path.extname(base);
      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        const stem = base.slice(0, -ext.length);
        candidates.push(`${stem}.ts`, `${stem}.tsx`, base, `${stem}.d.ts`);
      } else if (ext) {
        candidates.push(base);
      } else {
        candidates.push(
          `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.py`, `${base}.rs`, `${base}.go`,
          path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js'), path.join(base, '__init__.py'),
        );
      }
    } else if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(specifier)) {
      const pyRel = specifier.replace(/\./g, path.sep);
      candidates.push(
        path.join(fromDir, `${pyRel}.py`),
        path.join(project.root, `${pyRel}.py`),
        path.join(project.root, pyRel, '__init__.py'),
      );
    }
    for (const candidate of candidates) {
      try {
        const resolved = await this.policy.resolve(project, candidate);
        const stat = await lstat(resolved);
        if (stat.isFile()) return path.relative(project.root, resolved);
      } catch {}
    }
    return undefined;
  }

  async documentSymbols(project: ProjectConfig, args: { path: string }) {
    const { text, sha256 } = await this.readText(project, args.path);
    const { symbols, imports } = parseDocumentIntelligence(text, args.path);
    return { path: args.path, sha256, symbols, imports };
  }

  async workspaceSymbols(
    project: ProjectConfig,
    args: { path: string; query?: string; kind?: SymbolKind; exportedOnly: boolean; limit: number; respectGitIgnore: boolean },
    signal?: AbortSignal,
  ) {
    const { files, gitIgnoreApplied, truncated: scanTruncated } = await this.listSourceFiles(project, args.path, args.respectGitIgnore, signal);
    const query = args.query?.toLowerCase();
    const matched: (DocumentSymbolItem & { path: string; score: number })[] = [];
    let filesScanned = 0;
    for (const file of files) {
      if (signal?.aborted) throw new AppError('cancelled', 'LSP symbol search cancelled');
      try {
        const { text } = await this.readText(project, file);
        filesScanned++;
        const { symbols } = parseDocumentIntelligence(text, file);
        for (const sym of symbols) {
          if (args.exportedOnly && !sym.exported) continue;
          if (args.kind && sym.kind !== args.kind) continue;
          const lower = sym.name.toLowerCase();
          if (query && !lower.includes(query)) continue;
          const score = !query ? 1 : (lower === query ? 3 : lower.startsWith(query) ? 2 : 1);
          matched.push({ path: file, ...sym, score });
        }
      } catch {}
    }
    matched.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.path.localeCompare(b.path) || a.line - b.line);
    const truncated = scanTruncated || matched.length > args.limit;
    return {
      symbols: matched.slice(0, args.limit).map(({ score: _score, ...item }) => item),
      filesScanned,
      gitIgnoreApplied,
      truncated,
    };
  }

  private async resolveTargetSymbol(project: ProjectConfig, args: { path: string; line?: number; column?: number; symbol?: string }) {
    const doc = await this.readText(project, args.path);
    const symbol = args.symbol?.trim() || identifierAtPosition(doc.lines, args.line, args.column);
    if (!symbol) throw new AppError('symbol_not_found', 'No identifier found at the requested position; provide symbol or a valid 1-based line/column');
    return { symbol, doc };
  }

  async definition(
    project: ProjectConfig,
    args: { path: string; line?: number; column?: number; symbol?: string; respectGitIgnore: boolean },
    signal?: AbortSignal,
  ) {
    const { symbol, doc } = await this.resolveTargetSymbol(project, args);
    const localIntel = parseDocumentIntelligence(doc.text, args.path);
    const previewOf = (lines: string[], startLine: number, endLine: number) =>
      lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, startLine + 6, endLine)).join('\n');

    const localDefs = localIntel.symbols
      .filter(item => item.name === symbol)
      .map(item => ({ path: args.path, ...item, preview: previewOf(doc.lines, item.line, item.endLine) }));
    if (localDefs.length) {
      return { symbol, resolvedVia: 'local' as const, definitions: localDefs };
    }

    const importBinding = localIntel.imports.find(imp => imp.localName === symbol);
    if (importBinding) {
      const targetFile = await this.resolveModuleFile(project, args.path, importBinding.source);
      if (targetFile) {
        try {
          const targetDoc = await this.readText(project, targetFile);
          const targetIntel = parseDocumentIntelligence(targetDoc.text, targetFile);
          const wanted = importBinding.importedName === 'default' || importBinding.importedName === '*'
            ? symbol
            : importBinding.importedName;
          const importedDefs = targetIntel.symbols
            .filter(item => item.name === wanted || (importBinding.importedName === 'default' && item.exported))
            .map(item => ({ path: targetFile, ...item, preview: previewOf(targetDoc.lines, item.line, item.endLine) }));
          if (importedDefs.length) {
            return { symbol, resolvedVia: 'import' as const, importedFrom: importBinding.source, definitions: importedDefs };
          }
        } catch {}
      }
    }

    const { files } = await this.listSourceFiles(project, '.', args.respectGitIgnore, signal);
    const workspaceDefs = [];
    for (const file of files) {
      if (file === args.path) continue;
      if (signal?.aborted) throw new AppError('cancelled', 'LSP definition lookup cancelled');
      try {
        const fileDoc = await this.readText(project, file);
        const intel = parseDocumentIntelligence(fileDoc.text, file);
        for (const item of intel.symbols) {
          if (item.name === symbol) {
            workspaceDefs.push({ path: file, ...item, preview: previewOf(fileDoc.lines, item.line, item.endLine) });
          }
        }
      } catch {}
    }
    workspaceDefs.sort((a, b) => Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path) || a.line - b.line);
    return {
      symbol,
      resolvedVia: workspaceDefs.length ? ('workspace' as const) : ('none' as const),
      definitions: workspaceDefs.slice(0, 20),
    };
  }

  async references(
    project: ProjectConfig,
    args: { path: string; line?: number; column?: number; symbol?: string; includeDeclaration: boolean; contextLines: number; limit: number; respectGitIgnore: boolean },
    signal?: AbortSignal,
  ) {
    const { symbol } = await this.resolveTargetSymbol(project, args);
    const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, 'g');
    const { files, gitIgnoreApplied, truncated: scanTruncated } = await this.listSourceFiles(project, '.', args.respectGitIgnore, signal);
    const orderedFiles = [args.path, ...files.filter(f => f !== args.path)];
    const references: {
      path: string;
      line: number;
      column: number;
      text: string;
      isDeclaration: boolean;
      isImport: boolean;
      context?: { startLine: number; text: string };
    }[] = [];
    let filesScanned = 0, truncated = scanTruncated;

    for (const file of orderedFiles) {
      if (signal?.aborted) throw new AppError('cancelled', 'LSP references search cancelled');
      try {
        const { text, lines } = await this.readText(project, file);
        filesScanned++;
        const intel = parseDocumentIntelligence(text, file);
        const declLines = new Set(intel.symbols.filter(s => s.name === symbol).map(s => s.line));
        const importLines = new Set(intel.imports.filter(imp => imp.localName === symbol || imp.importedName === symbol).map(imp => imp.line));
        for (let i = 0; i < lines.length; i++) {
          const lineText = lines[i]!;
          const trimmed = lineText.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
          const codePart = lineText.split('//')[0]!;
          for (const match of codePart.matchAll(wordRegex)) {
            const lineNum = i + 1;
            const isDeclaration = declLines.has(lineNum);
            const isImport = importLines.has(lineNum);
            if (!args.includeDeclaration && isDeclaration) continue;
            if (references.length >= args.limit) {
              truncated = true;
              break;
            }
            const context = args.contextLines > 0
              ? {
                  startLine: Math.max(0, i - args.contextLines) + 1,
                  text: lines.slice(Math.max(0, i - args.contextLines), i + args.contextLines + 1).map(l => l.slice(0, 500)).join('\n'),
                }
              : undefined;
            references.push({
              path: file,
              line: lineNum,
              column: (match.index ?? 0) + 1,
              text: lineText.slice(0, 500),
              isDeclaration,
              isImport,
              ...(context ? { context } : {}),
            });
          }
          if (truncated && references.length >= args.limit) break;
        }
      } catch {}
      if (truncated && references.length >= args.limit) break;
    }
    return {
      symbol,
      references,
      filesScanned,
      gitIgnoreApplied,
      truncated,
    };
  }

  async hover(
    project: ProjectConfig,
    args: { path: string; line?: number; column?: number; symbol?: string; respectGitIgnore: boolean },
    signal?: AbortSignal,
  ) {
    const resolved = await this.definition(project, args, signal);
    const primary = resolved.definitions[0];
    if (!primary) {
      return { symbol: resolved.symbol, found: false };
    }
    return {
      symbol: resolved.symbol,
      found: true,
      kind: primary.kind,
      signature: primary.signature,
      ...(primary.documentation ? { documentation: primary.documentation } : {}),
      ...(primary.containerName ? { containerName: primary.containerName } : {}),
      exported: primary.exported,
      resolvedVia: resolved.resolvedVia,
      definedAt: {
        path: primary.path,
        line: primary.line,
        column: primary.column,
        endLine: primary.endLine,
      },
      preview: primary.preview,
    };
  }

  private async analyzeFileDiagnostics(project: ProjectConfig, filePath: string, tsModule?: any): Promise<DiagnosticItem[]> {
    const { text, lines } = await this.readText(project, filePath);
    const ext = path.extname(filePath).toLowerCase();
    const items: DiagnosticItem[] = [];

    if (ext === '.json') {
      try {
        JSON.parse(text);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid JSON';
        const posMatch = /position\s+(\d+)/i.exec(message);
        let line = 1, column = 1;
        if (posMatch) {
          const offset = Number(posMatch[1]);
          const prefix = text.slice(0, offset);
          const split = prefix.split('\n');
          line = split.length;
          column = split[split.length - 1]!.length + 1;
        }
        items.push({ path: filePath, line, column, severity: 'error', code: 'json_syntax', message, source: 'builtin-json' });
      }
      return items;
    }

    let tsChecked = false;
    if (tsModule?.createSourceFile && tsModule?.ScriptKind && ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
      try {
        const scriptKind = ext === '.tsx' ? tsModule.ScriptKind.TSX : ext === '.jsx' ? tsModule.ScriptKind.JSX : ext.includes('ts') ? tsModule.ScriptKind.TS : tsModule.ScriptKind.JS;
        const sourceFile = tsModule.createSourceFile(filePath, text, tsModule.ScriptTarget?.Latest ?? 99, true, scriptKind);
        const parseDiagnostics: any[] = sourceFile.parseDiagnostics ?? [];
        for (const diag of parseDiagnostics) {
          const pos = typeof sourceFile.getLineAndCharacterOfPosition === 'function'
            ? sourceFile.getLineAndCharacterOfPosition(diag.start ?? 0)
            : (typeof tsModule.getLineAndCharacterOfPosition === 'function' ? tsModule.getLineAndCharacterOfPosition(sourceFile, diag.start ?? 0) : { line: 0, character: 0 });
          const msg = typeof tsModule.flattenDiagnosticMessageText === 'function'
            ? tsModule.flattenDiagnosticMessageText(diag.messageText, '\n')
            : String(diag.messageText ?? 'Syntax error');
          items.push({
            path: filePath,
            line: pos.line + 1,
            column: pos.character + 1,
            severity: 'error',
            code: `TS${diag.code}`,
            message: msg,
            source: 'typescript',
          });
        }
        tsChecked = true;
      } catch {}
    }
    if (!tsChecked) {
      // Lightweight bracket/delimiter balance check for non-TS files
      const stack: { ch: string; line: number; col: number }[] = [];
      const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
      const closing: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let inQuote: string | null = null;
        for (let c = 0; c < line.length; c++) {
          const ch = line[c]!;
          if (!inQuote && ((ch === '/' && line[c + 1] === '/') || (ext === '.py' && ch === '#'))) break;
          if (ch === '"' || ch === "'") {
            if (inQuote === ch && line[c - 1] !== '\\') inQuote = null;
            else if (!inQuote) inQuote = ch;
            continue;
          }
          if (inQuote) continue;
          if (pairs[ch]) stack.push({ ch, line: i + 1, col: c + 1 });
          else if (closing[ch]) {
            const last = stack.pop();
            if (!last || last.ch !== closing[ch]) {
              items.push({
                path: filePath,
                line: i + 1,
                column: c + 1,
                severity: 'error',
                code: 'unmatched_delimiter',
                message: `Unmatched closing '${ch}'`,
                source: 'builtin-syntax',
              });
              break;
            }
          }
        }
      }
      if (stack.length && items.length === 0) {
        const unclosed = stack[stack.length - 1]!;
        items.push({
          path: filePath,
          line: unclosed.line,
          column: unclosed.col,
          severity: 'error',
          code: 'unclosed_delimiter',
          message: `Unclosed '${unclosed.ch}'`,
          source: 'builtin-syntax',
        });
      }
    }

    // Check unresolved relative imports in JS/TS/Python
    const { imports } = parseDocumentIntelligence(text, filePath);
    const seenImports = new Set<string>();
    for (const imp of imports) {
      if (!imp.source.startsWith('.')) continue;
      const key = `${imp.line}:${imp.source}`;
      if (seenImports.has(key)) continue;
      seenImports.add(key);
      const resolved = await this.resolveModuleFile(project, filePath, imp.source);
      if (!resolved) {
        const col = Math.max(1, (lines[imp.line - 1]?.indexOf(imp.source) ?? 0) + 1);
        items.push({
          path: filePath,
          line: imp.line,
          column: col,
          severity: 'error',
          code: 'unresolved_import',
          message: `Cannot resolve relative import '${imp.source}'`,
          source: 'builtin-imports',
        });
      }
    }
    return items;
  }

  private async queryExternalLspDiagnostics(
    project: ProjectConfig,
    targetFiles: string[],
    executableInput: string,
    extraArgs: string[],
    signal?: AbortSignal,
  ): Promise<DiagnosticItem[]> {
    const alias = Object.hasOwn(project.commandAliases, executableInput) ? project.commandAliases[executableInput] : undefined;
    const executable = alias?.executable ?? executableInput;
    const argv = [...(alias?.args ?? []), ...extraArgs];
    if (!alias) this.policy.command(project, executable);
    else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
      throw new AppError('command_denied', 'Command aliases must resolve to an executable, not a .cmd/.bat wrapper');
    }

    const docs: { uri: string; relPath: string; text: string; languageId: string }[] = [];
    for (const relPath of targetFiles.slice(0, 16)) {
      const { text } = await this.readText(project, relPath);
      const absPath = await this.policy.resolve(project, relPath);
      const normalized = absPath.split(path.sep).join('/');
      const uri = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
      const ext = path.extname(relPath).toLowerCase();
      const languageId = ext === '.py' ? 'python' : ext === '.rs' ? 'rust' : ext === '.go' ? 'go' : ext.includes('ts') ? 'typescript' : 'javascript';
      docs.push({ uri, relPath, text, languageId });
    }

    const rootNormalized = project.root.split(path.sep).join('/');
    const rootUri = rootNormalized.startsWith('/') ? `file://${rootNormalized}` : `file:///${rootNormalized}`;
    const collected: DiagnosticItem[] = [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, argv, {
        cwd: project.root,
        shell: false,
        windowsHide: true,
        env: toolEnvironment(),
        stdio: 'pipe',
      });
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(), 4000).unref();
      signal?.addEventListener('abort', () => finish(new AppError('cancelled', 'External LSP query cancelled')), { once: true });
      child.stdin.on('error', () => {});
      child.once('error', err => finish(new AppError('lsp_server_failed', `Failed to start LSP server: ${err.message}`)));
      child.once('close', () => finish());

      const send = (payload: object) => {
        const json = Buffer.from(JSON.stringify(payload), 'utf8');
        child.stdin.write(`Content-Length: ${json.length}\r\n\r\n`);
        child.stdin.write(json);
      };

      let openedCount = 0;
      const handleMessage = (msg: any) => {
        if (msg.id === 1 && msg.result) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          for (const doc of docs) {
            send({
              jsonrpc: '2.0',
              method: 'textDocument/didOpen',
              params: { textDocument: { uri: doc.uri, languageId: doc.languageId, version: 1, text: doc.text } },
            });
          }
          if (!docs.length) finish();
        } else if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
          const uri = String(msg.params.uri ?? '');
          const matchedDoc = docs.find(d => d.uri.toLowerCase() === uri.toLowerCase());
          const filePath = matchedDoc?.relPath ?? uri;
          for (const d of msg.params.diagnostics ?? []) {
            const line = (d.range?.start?.line ?? 0) + 1;
            const column = (d.range?.start?.character ?? 0) + 1;
            const sev = d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info';
            collected.push({
              path: filePath,
              line,
              column,
              severity: sev,
              code: String(d.code ?? 'lsp'),
              message: String(d.message ?? ''),
              source: String(d.source ?? path.basename(executable)),
            });
          }
          openedCount++;
          if (openedCount >= docs.length) {
            send({ jsonrpc: '2.0', id: 2, method: 'shutdown', params: null });
            finish();
          }
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) break;
          const header = buffer.subarray(0, headerEnd).toString('ascii');
          const match = /Content-Length:\s*(\d+)/i.exec(header);
          if (!match) { finish(); return; }
          const length = Number(match[1]);
          const bodyStart = headerEnd + 4;
          if (buffer.length < bodyStart + length) break;
          const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
          buffer = buffer.subarray(bodyStart + length);
          try { handleMessage(JSON.parse(body)); } catch {}
        }
      });

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: process.pid,
          rootUri,
          capabilities: { textDocument: { publishDiagnostics: {} } },
        },
      });
    });

    return collected;
  }

  async diagnostics(
    project: ProjectConfig,
    principal: Principal,
    args: { path?: string; limit: number; respectGitIgnore: boolean; serverExecutable?: string; serverArgs: string[] },
    signal?: AbortSignal,
  ) {
    let targetFiles: string[];
    if (args.path && args.path !== '.') {
      const resolved = await this.policy.resolve(project, args.path);
      const stat = await lstat(resolved);
      if (stat.isFile()) {
        targetFiles = [path.relative(project.root, resolved)];
      } else {
        targetFiles = (await this.listSourceFiles(project, args.path, args.respectGitIgnore, signal)).files;
      }
    } else {
      targetFiles = (await this.listSourceFiles(project, '.', args.respectGitIgnore, signal)).files;
    }

    if (args.serverExecutable) {
      if (!principal.scopes.includes('execute') || project.readOnly) {
        throw new AppError('forbidden', 'External LSP server execution requires execute scope on a writable project');
      }
      const external = await this.queryExternalLspDiagnostics(project, targetFiles, args.serverExecutable, args.serverArgs, signal);
      return {
        diagnostics: external.slice(0, args.limit),
        filesChecked: Math.min(targetFiles.length, 16),
        engine: 'external-lsp',
        truncated: external.length > args.limit,
      };
    }

    let tsModule: any;
    try {
      const mod = await import('typescript');
      tsModule = (mod as any).default ?? mod;
    } catch {}

    const diagnostics: DiagnosticItem[] = [];
    let filesChecked = 0;
    for (const file of targetFiles.slice(0, 200)) {
      if (signal?.aborted) throw new AppError('cancelled', 'LSP diagnostics cancelled');
      try {
        const fileDiags = await this.analyzeFileDiagnostics(project, file, tsModule);
        filesChecked++;
        diagnostics.push(...fileDiags);
        if (diagnostics.length >= args.limit) break;
      } catch {}
    }

    return {
      diagnostics: diagnostics.slice(0, args.limit),
      filesChecked,
      engine: tsModule ? 'builtin+typescript' : 'builtin',
      truncated: diagnostics.length > args.limit || targetFiles.length > 200,
    };
  }
}

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const staged = process.argv.includes('--staged');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
const args = ['ls-files', '-z', '--cached', ...(staged ? [] : ['--others', '--exclude-standard'])];
const files = [...new Set(git(...args).split('\0').filter(Boolean))].sort();
const roots = new Set([
  '.dockerignore', '.editorconfig', '.env.example', '.gitattributes', '.gitignore',
  '.github', '.npmrc', '.nvmrc', 'CHANGELOG.md', 'CONTRIBUTING.md', 'Dockerfile',
  'LICENSE', 'README.md', 'README.en.md', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md',
  'compose.yaml', 'deploy', 'docs', 'licenses', 'package-lock.json', 'package.json',
  'bin', 'public', 'runner.example.json', 'runtime', 'scripts', 'src', 'tests', 'tsconfig.json',
]);
const required = [
  'LICENSE', 'README.md', 'README.en.md', 'SECURITY.md', 'CONTRIBUTING.md',
  'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'licenses/npm-runtime.txt',
  'package.json', 'package-lock.json', '.env.example', 'runner.example.json',
  'docs/OPEN_SOURCE.md',
];
const problems = [];
const sources = new Map();
const patterns = [
  ['private-key material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['Instabox API credential', /\bibk_[a-z0-9]{20,}\b/i],
  ['HomeAgent credential', /\bha_(?:pat|device|code)_[A-Za-z0-9_-]{25,}\b/],
  ['GitHub access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['npm access token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['provider API credential', /\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{30,}\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['personal Windows home path', /[A-Za-z]:[\\/]+Users[\\/]+(?!me(?:[\\/]|$)|user(?:[\\/]|$)|example(?:[\\/]|$)|<)[A-Za-z0-9_. -]+[\\/]/i],
];
for (const file of files) {
  const parts = file.split('/');
  if (!roots.has(parts[0])) problems.push(`${file}: unexpected top-level release path`);
  if (parts.some(part => /^(?:\.git|node_modules|dist|data|coverage|backups?|release|tmp|temp|\.homeagent|\.codex|\.cursor|\.vscode|\.idea)$/i.test(part))) problems.push(`${file}: private or generated directory`);
  const name = path.posix.basename(file);
  if ((/^\.env(?:$|\.)/.test(name) && name !== '.env.example') ||
      (/^runner\..*\.json$/.test(name) && name !== 'runner.example.json') ||
      /\.(?:sqlite(?:-.+)?|db|log|pem|key|p12|pfx|bundle|tgz|zip|tar(?:\.gz)?)$/i.test(name)) problems.push(`${file}: private configuration, credential or generated artifact`);
  let text;
  try { text = staged ? git('show', `:${file}`) : await readFile(path.join(root, file), 'utf8'); }
  catch { problems.push(`${file}: cannot inspect release contents`); continue; }
  sources.set(file, text);
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || text.includes('\0')) problems.push(`${file}: binary or oversized release file requires manual review`);
  for (const [label, pattern] of patterns) {
    const match = pattern.exec(text);
    if (match) problems.push(`${file}:${text.slice(0, match.index).split('\n').length}: ${label}`);
  }
}
for (const file of required) if (!sources.has(file)) problems.push(`${file}: required release file missing`);
if (sources.has('package.json') && sources.has('package-lock.json')) {
  const manifest = JSON.parse(sources.get('package.json'));
  const lock = JSON.parse(sources.get('package-lock.json'));
  if (manifest.license !== 'MIT') problems.push('package.json: license must match the selected MIT release license');
  if (manifest.private === true) problems.push('package.json: the public npm package must not be private');
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig?.registry !== 'https://registry.npmjs.org/') problems.push('package.json: explicitly select public npm publishing');
  if (!Array.isArray(manifest.files) || !manifest.files.includes('dist/**/*.js')) problems.push('package.json: explicit compiled package file list required');
  for (const name of ['homeagent', 'homeagent-runner', 'homeagent-server']) {
    const entry = manifest.bin?.[name];
    if (!entry || !sources.get(entry)?.startsWith('#!/usr/bin/env node\n')) problems.push(`package.json: missing executable entry for ${name}`);
  }
  if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version) problems.push('package-lock.json: root version mismatch');
  const protocol = sources.get('src/shared/protocol.ts') ?? '';
  if (!protocol.includes(`VERSION = '${manifest.version}'`)) problems.push('src/shared/protocol.ts: runtime version differs from package.json');
}
// Validate local Markdown links against the release inventory, not ignored local files.
for (const [file, text] of sources) {
  if (!file.endsWith('.md')) continue;
  for (const match of text.matchAll(/!?\[[^\]]*\]\((<?[^)\n]+>?)\)/g)) {
    let destination = match[1].replace(/^<|>$/g, '').split(/\s+"/)[0];
    if (/^(?:https?:|mailto:|#)/i.test(destination)) continue;
    destination = decodeURIComponent(destination.split('#')[0]);
    if (!destination) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), destination));
    if (!sources.has(resolved) && !files.some(name => name.startsWith(`${resolved}/`))) problems.push(`${file}: local Markdown link missing from release: ${destination}`);
  }
}
if (problems.length) {
  console.error('Release check failed:\n' + problems.map(problem => `- ${problem}`).join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Release check passed: ${files.length} ${staged ? 'staged' : 'tracked/unignored'} files; no detected credentials or forbidden artifacts; required files and local Markdown links present.`);
  console.log('Pattern checks cannot prove that a repository contains no secrets. Review the source archive before publishing.');
}

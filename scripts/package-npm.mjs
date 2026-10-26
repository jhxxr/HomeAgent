import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'release');
await mkdir(directory, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run this command with npm run release:npm.');
const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
  cwd: root, encoding: 'utf8', windowsHide: true,
});
if (packed.status !== 0) { console.error(packed.stderr); process.exit(packed.status ?? 1); }
const [info] = JSON.parse(packed.stdout);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (info.name !== manifest.name || info.version !== manifest.version || path.basename(info.filename) !== info.filename) throw new Error('Unexpected npm package metadata.');
const allowed = /^(?:package\.json|LICENSE|README(?:\.en)?\.md|CONTRIBUTING\.md|SECURITY\.md|CHANGELOG\.md|THIRD_PARTY_NOTICES\.md|\.env\.example|runner\.example\.json|bin\/[^/]+\.mjs|dist\/.+\.js|public\/[^/]+\.(?:js|css|svg)|runtime\/windows-process-tree\.(?:ps1|cs)|scripts\/(?:init|backup)\.mjs|licenses\/[^/]+\.txt|docs\/[^/]+\.(?:md|json))$/;
const files = info.files.map(file => file.path);
for (const file of files) if (!allowed.test(file)) throw new Error(`Unexpected npm archive path: ${file}`);
for (const file of ['LICENSE', 'licenses/npm-runtime.txt', 'public/dashboard.js', 'public/consent.js', 'runtime/windows-process-tree.ps1', 'runtime/windows-process-tree.cs', 'dist/runner/cli.js', 'dist/server/cli.js', 'scripts/init.mjs', 'runner.example.json', ...Object.values(manifest.bin)]) {
  if (!files.includes(file)) throw new Error(`Required npm archive path missing: ${file}`);
}
const archive = await readFile(path.join(directory, info.filename));
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
if (integrity !== info.integrity) throw new Error('npm package integrity mismatch.');
const sha256 = createHash('sha256').update(archive).digest('hex');
await writeFile(path.join(directory, `${info.filename}.sha256`), `${sha256}  ${info.filename}\n`);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
await writeFile(path.join(directory, 'npm-package.json'), JSON.stringify({
  name: info.name, version: info.version, filename: info.filename, integrity, sha256, commit,
  distTag: info.version.includes('-') ? 'next' : 'latest', files,
}, null, 2) + '\n');
console.log(`Prepared ${info.filename}: ${files.length} files, ${archive.length} bytes. No publish performed.`);

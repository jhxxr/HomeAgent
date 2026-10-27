import { spawnSync, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'release');
const stage = path.join(directory, '.runner-package');
await mkdir(directory, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run this command with npm run release:npm.');

const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const runnerTemplate = JSON.parse(await readFile(path.join(root, 'runner-package.json'), 'utf8'));
if (!rootManifest.version) throw new Error('Invalid Server package version.');

function pack(cwd, expectedName) {
  const packed = spawnSync(process.execPath, [process.env.npm_execpath, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], {
    cwd, encoding: 'utf8', windowsHide: true,
  });
  if (packed.status !== 0) {
    console.error(packed.stdout);
    console.error(packed.stderr);
    process.exit(packed.status ?? 1);
  }
  const [info] = JSON.parse(packed.stdout);
  if (info.name !== expectedName || info.version !== rootManifest.version || path.basename(info.filename) !== info.filename) {
    throw new Error(`Unexpected npm package metadata for ${expectedName}.`);
  }
  return info;
}

async function copyRunnerFile(relativePath) {
  const source = path.join(root, relativePath);
  const target = path.join(stage, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function packageRunner() {
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await writeFile(path.join(stage, 'package.json'), JSON.stringify({ ...runnerTemplate, version: rootManifest.version }, null, 2) + '\n');
  for (const file of [
    'LICENSE',
    'README.md',
    'README.en.md',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'CHANGELOG.md',
    'THIRD_PARTY_NOTICES.md',
    'bin/runner.mjs',
    'runtime',
    'public/icon.png',
    'dist/runner',
    'dist/shared',
    'licenses',
    'docs',
  ]) await copyRunnerFile(file);
  try {
    return pack(stage, runnerTemplate.name);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const serverInfo = pack(root, rootManifest.name);
const runnerInfo = await packageRunner();
const packages = [];
for (const info of [serverInfo, runnerInfo]) {
  const archive = path.join(directory, info.filename);
  const contents = await readFile(archive);
  const integrity = `sha512-${createHash('sha512').update(contents).digest('base64')}`;
  const sha256 = createHash('sha256').update(contents).digest('hex');
  const metadata = {
    name: info.name,
    version: info.version,
    filename: info.filename,
    integrity,
    sha256,
    distTag: info.version.includes('-') ? 'next' : 'latest',
    files: info.files.map(file => file.path),
  };
  packages.push(metadata);
  await writeFile(path.join(directory, `${metadata.filename}.sha256`), `${metadata.sha256}  ${metadata.filename}\n`);
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
await writeFile(path.join(directory, 'npm-packages.json'), JSON.stringify({ version: rootManifest.version, commit, packages }, null, 2) + '\n');
console.log(`Prepared ${packages.map(({ filename }) => filename).join(' and ')}. No publish performed.`);

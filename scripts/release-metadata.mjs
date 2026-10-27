import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateVersionTag(tag, version) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(tag ?? '');
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Release tag must be vX.Y.Z or vX.Y.Z-prerelease with valid semantic-version identifiers.');
  }
  if (tag.slice(1) !== version) throw new Error('Release tag does not match package.json version.');
  return { tag, version, prerelease: !!match[4] };
}

export function changelogSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => {
    const match = /^##\s+\[?([0-9][0-9A-Za-z.+-]*)\]?(?:\s|$)/.exec(line);
    return match?.[1] === version;
  });
  if (start < 0) throw new Error('CHANGELOG.md has no entry for the release version.');
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const section = lines.slice(start + 1, next < 0 ? undefined : next).join('\n').trim();
  if (!section) throw new Error('The release changelog entry must not be empty.');
  return section;
}

async function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const runner = JSON.parse(await readFile(path.join(root, 'runner-package.json'), 'utf8'));
  const metadata = validateVersionTag(process.env.RELEASE_TAG ?? process.argv[2], manifest.version);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const commit = git('rev-parse', '--verify', `refs/tags/${metadata.tag}^{commit}`);
  if (commit !== git('rev-parse', 'HEAD')) throw new Error('Checked-out commit differs from the release tag.');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== metadata.version || lock.packages[''].version !== metadata.version) throw new Error('Lockfile release version mismatch.');
  const section = changelogSection(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), metadata.version);
  if (manifest.name !== 'homeagent-server' || runner.name !== 'homeagent-runner') throw new Error('Unexpected npm package names.');
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name) || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(runner.name)) throw new Error('Invalid npm release package name.');
  const npmTag = metadata.prerelease ? 'next' : 'latest';
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `tag=${metadata.tag}\nversion=${metadata.version}\ncommit=${commit}\nprerelease=${metadata.prerelease}\nserver_package_name=${manifest.name}\nrunner_package_name=${runner.name}\nnpm_tag=${npmTag}\n`);
  if (process.argv.includes('--notes')) {
    const directory = path.join(root, 'release');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'RELEASE_NOTES.md'), `# HomeAgent ${metadata.tag}\n\n${section}\n\n## Install\n\n\`\`\`sh\nnpm install -g ${manifest.name}@${metadata.version}\nhomeagent-server --help\n\nnpm install -g ${runner.name}@${metadata.version}\nhomeagent --help\n\`\`\`\n\nThe npm dist-tag for this release is \`${npmTag}\` for both packages.\n\n## Release assets\n\nThe attached source archive is built from commit \`${commit}\` after Linux, Windows and Docker verification. It includes the source, tests, deployment files and license notices; it excludes Git history, credentials, runtime state and installed dependencies. The verified Server and Runner npm tarballs, checksums, package metadata and source file manifest are attached alongside it.\n\nThis release does not include standalone executables or pre-published container images. See the repository README for build and deployment instructions.\n`);
  }
  console.log(JSON.stringify({ ...metadata, commit }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

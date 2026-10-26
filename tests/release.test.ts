import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVersionTag, changelogSection } from '../scripts/release-metadata.mjs';

test('release tags must match the exact package version and reject branch names or injected arguments', () => {
  assert.deepEqual(validateVersionTag('v0.3.0', '0.3.0'), { tag: 'v0.3.0', version: '0.3.0', prerelease: false });
  assert.equal(validateVersionTag('v1.0.0-rc.1', '1.0.0-rc.1').prerelease, true);
  for (const tag of ['main', '--help', 'v0.3.0\nbad=value', 'v01.3.0', 'v1.0.0-rc.01', 'v0.3.0;echo bad', 'v0.3.1']) {
    assert.throws(() => validateVersionTag(tag, '0.3.0'), undefined, tag);
  }
});

test('release notes select only the requested changelog section and require nonempty version notes', () => {
  const changelog = '# Changelog\n\n## 0.4.0 — New\n\nNew changes\n\n## 0.3.0 — Previous\n\nPrevious changes\n';
  assert.equal(changelogSection(changelog, '0.4.0'), 'New changes');
  assert.equal(changelogSection(changelog, '0.3.0'), 'Previous changes');
  assert.equal(changelogSection('## [1.0.0-rc.1]\n\nPreview\n', '1.0.0-rc.1'), 'Preview');
  assert.throws(() => changelogSection(changelog, '2.0.0'), /no entry/);
  assert.throws(() => changelogSection('## 1.0.0\n\n## 0.9.0\nOld', '1.0.0'), /must not be empty/);
});

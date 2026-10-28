// Version helpers shared by the Dashboard and its unit tests.
export const normalizeVersion = value => String(value ?? '').trim().replace(/^v/i, '');

export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(normalizeVersion(value));
  if (!match || match[4]?.split('.').some(part => /^0\d+$/.test(part))) return null;
  // Keep numeric identifiers as strings so arbitrarily large versions compare exactly.
  return { core: match.slice(1, 4), prerelease: match[4]?.split('.') ?? null };
}

function compareNumeric(left, right) {
  return left.length - right.length || (left === right ? 0 : left < right ? -1 : 1);
}

export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    const comparison = compareNumeric(a.core[index], b.core[index]);
    if (comparison) return comparison;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return compareNumeric(x, y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Compare a Runner-reported version with the Server version running this Dashboard. */
export function versionStatus(serverVersion, runnerVersion) {
  const runner = normalizeVersion(runnerVersion);
  if (!runner) return { state: 'unknown', version: '', label: '待确认', title: '设备尚未上报 Runner 版本' };
  const version = `v${runner}`, comparison = compareVersions(runner, serverVersion);
  if (comparison === null) return { state: 'unknown', version, label: '无法比较', title: 'Runner 版本不是标准的语义化版本号' };
  if (comparison === 0) return { state: 'match', version, label: '一致', title: '与 Server 版本一致' };
  return comparison < 0
    ? { state: 'outdated', version, label: '需升级', title: '低于 Server 版本，建议升级 Runner' }
    : { state: 'ahead', version, label: '高于 Server', title: '高于 Server 版本，请确认 Server 已升级' };
}

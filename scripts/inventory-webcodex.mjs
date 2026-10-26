import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string', default: 'data/reference/webcodex' }, output: { type: 'string', default: 'docs/webcodex-source-inventory.json' } } });
const root = path.resolve(values.root);
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
const commit = git('rev-parse', 'HEAD');
const parity = JSON.parse(await readFile(new URL('../docs/webcodex-parity-map.json', import.meta.url), 'utf8'));
if (commit !== parity.upstreamCommit) throw new Error('Upstream revision changed; explicitly review and update the parity baseline first');
const files = git('ls-tree', '-r', '--name-only', 'HEAD').split('\n');
const definitionRoot = 'crates/webcodex-tool-contracts/src/tool_definition';
const declarationSource = await readFile(path.join(root, `${definitionRoot}.rs`), 'utf8');
const modules = [...declarationSource.matchAll(/^mod ([a-z_]+);/gm)].map(match => match[1]).filter(name => !name.endsWith('_tests'));
const toolModules = await Promise.all(modules.map(async family => {
  if (!Object.hasOwn(parity.families, family)) throw new Error(`Unclassified upstream family: ${family}`);
  const file = `${definitionRoot}/${family}.rs`, source = await readFile(path.join(root, file), 'utf8');
  // Static declaration inventory, including cfg-gated definitions. This is not a compiled tools/list response.
  const declarations = [...source.matchAll(/\b(def|[a-z][a-z0-9_]*_(?:def|definition)|resource_tool)\s*\(\s*"([^"]+)"/g)].map(match => ({
    name: match[2], helper: match[1], line: source.slice(0, match.index).split('\n').length,
    homeagent: parity.overrides[match[2]] ?? { status: parity.defaultStatus, tools: [], note: parity.families[family] },
  }));
  return { family, file, source: `https://github.com/yyjeqhc/webcodex/blob/${commit}/${file}`, declarations };
}));
const names = new Set(toolModules.flatMap(module => module.declarations.map(declaration => declaration.name)));
for (const name of Object.keys(parity.overrides)) if (!names.has(name)) throw new Error(`Mapped tool is absent from the source inventory: ${name}`);
const appSource = await readFile(path.join(root, 'crates/webcodex-tool-contracts/src/registry/tool_specs.rs'), 'utf8');
const unmatchedAppDescriptors = [...appSource.matchAll(/tool_descriptor\(\s*"([^"]+)"/g)].map(match => match[1]).filter(name => !names.has(name));
if (unmatchedAppDescriptors.length) throw new Error(`Unclassified App descriptors: ${unmatchedAppDescriptors.join(', ')}`);
const cargo = await readFile(path.join(root, 'Cargo.toml'), 'utf8');
const crates = [...cargo.matchAll(/^\s+"(crates\/[^"]+)",/gm)].map(match => match[1]);
const inventory = {
  repository: 'https://github.com/yyjeqhc/webcodex', commit, auditedOn: '2026-10-26',
  method: 'Static Rust declaration inventory; cfg-gated/hidden tools included. No upstream code is executed and no runtime-parity claim is implied.',
  trackedFileCount: files.length,
  checkedOutCoreSourceFileCount: files.filter(file => /^(src|crates)\//.test(file) && /\.(rs|cs|ps1)$/.test(file)).length,
  workspaceCrates: crates,
  toolModules,
  declarationsCount: toolModules.reduce((sum, module) => sum + module.declarations.length, 0),
  statusCounts: toolModules.flatMap(module => module.declarations).reduce((counts, declaration) => { const status = declaration.homeagent.status; counts[status] = (counts[status] ?? 0) + 1; return counts; }, {}),
  unmatchedAppDescriptors,
  modulesWithoutMatchedDeclarations: toolModules.filter(module => !module.declarations.length).map(module => module.family),
};
await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
await writeFile(values.output, JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ commit, crates: crates.length, families: toolModules.length, declarations: inventory.declarationsCount, unparsedFamilies: inventory.modulesWithoutMatchedDeclarations, output: values.output }));

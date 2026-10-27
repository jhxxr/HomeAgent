import { z } from 'zod';
import type { Scope } from './protocol.js';

const target = {
  deviceId: z.string().min(1).max(100).optional().describe('Required when more than one authorized device is online'),
  projectId: z.string().min(1).max(64).describe('Project ID from list_devices'),
};
const path = z.string().max(4096).default('.');
const gitTarget = { ...target, repository: z.string().max(4096).default('.').describe('Repository directory relative to the project root; absolute paths require device-wide file access') };
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const launch = {
  executable: z.string().min(1).max(4096), args: z.array(z.string().max(8192)).max(256).default([]),
  cwd: path, timeoutMs: z.number().int().min(100).max(86400000).default(3600000),
  environment: z.string().min(1).max(64).optional().describe('Locally configured environment profile name; values stay on the Runner'),
  idempotencyKey: z.string().min(8).max(128).optional().describe('Reuse the same key and identical arguments after an uncertain response; retained for 48 hours'),
};
const change = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), path: z.string().min(1).max(4096), content: z.string().max(262144) }).strict(),
  z.object({ operation: z.literal('replace'), path: z.string().min(1).max(4096), expectedSha256: sha, content: z.string().max(262144) }).strict(),
  z.object({ operation: z.literal('delete'), path: z.string().min(1).max(4096), expectedSha256: sha }).strict(),
  z.object({ operation: z.literal('edit'), path: z.string().min(1).max(4096), expectedSha256: sha, edits: z.array(z.object({ oldText: z.string().min(1).max(131072), newText: z.string().max(131072) }).strict()).min(1).max(100) }).strict(),
]);
export type FileChange = z.infer<typeof change>;
const schemas = {
  get_project_context: z.object({ ...target, includeInstructions: z.boolean().default(true) }).strict(),
  save_project_note: z.object({ ...target, text: z.string().max(8192) }).strict(),
  read_files: z.object({ ...target, files: z.array(z.object({ path: z.string().min(1).max(4096), startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(), expectedSha256: sha.optional() }).strict()).min(1).max(16), maxBytes: z.number().int().min(1024).max(262144).default(131072) }).strict(),
  edit_files: z.object({ ...target, changes: z.array(change).min(1).max(32), dryRun: z.boolean().default(false) }).strict(),
  apply_unified_diff: z.object({ ...target, diff: z.string().min(1).max(262144), expectedSha256: z.record(z.string(), sha.nullable()), dryRun: z.boolean().default(false) }).strict(),
  get_edit_transactions: z.object({ ...target }).strict(),
  recover_edit_transaction: z.object({ ...target, transactionId: z.string().uuid() }).strict(),
  list_directory: z.object({ ...target, path, offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(1000).default(200) }).strict(),
  read_file: z.object({ ...target, path, offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(131072).default(65536), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  write_file: z.object({ ...target, path, content: z.string().max(262144), append: z.boolean().default(false), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  create_directory: z.object({ ...target, path }).strict(),
  move_file: z.object({ ...target, source: path, destination: path }).strict(),
  search_files: z.object({ ...target, path, query: z.string().min(1).max(512), content: z.boolean().default(false), caseSensitive: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100), include: z.array(z.string().max(512)).max(20).default([]), exclude: z.array(z.string().max(512)).max(20).default([]), contextLines: z.number().int().min(0).max(5).default(0), respectGitIgnore: z.boolean().default(true) }).strict(),
  edit_block: z.object({ ...target, path, oldText: z.string().min(1).max(131072), newText: z.string().max(131072), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
  get_file_info: z.object({ ...target, path }).strict(),
  start_process: z.object({ ...target, ...launch }).strict(),
  run_command: z.object({ ...target, ...launch, waitMs: z.number().int().min(0).max(20000).default(1500), length: z.number().int().min(1).max(65536).default(32768) }).strict(),
  wait_process: z.object({ ...target, processId: z.string().uuid(), waitMs: z.number().int().min(0).max(20000).default(10000), until: z.enum(['output', 'finished']).default('finished'), cursor: z.number().int().min(0).optional(), length: z.number().int().min(1).max(65536).default(32768) }).strict(),
  tail_process_output: z.object({ ...target, processId: z.string().uuid(), cursor: z.number().int().min(0).optional(), length: z.number().int().min(1).max(65536).default(32768) }).strict(),
  read_process_output: z.object({ ...target, processId: z.string().uuid(), cursor: z.number().int().min(0).default(0), length: z.number().int().min(1).max(131072).default(65536) }).strict(),
  write_process_input: z.object({ ...target, processId: z.string().uuid(), input: z.string().max(65536), close: z.boolean().default(false) }).strict(),
  list_processes: z.object({ ...target }).strict(),
  stop_process: z.object({ ...target, processId: z.string().uuid() }).strict(),
  git_status: z.object({ ...gitTarget }).strict(),
  git_diff: z.object({ ...gitTarget, staged: z.boolean().default(false), path: z.string().max(4096).optional() }).strict(),
  git_log: z.object({ ...gitTarget, limit: z.number().int().min(1).max(100).default(20) }).strict(),
  git_add: z.object({ ...gitTarget, paths: z.array(z.string().min(1).max(4096)).min(1).max(100) }).strict(),
  git_commit: z.object({ ...gitTarget, message: z.string().min(1).max(4096) }).strict(),
  git_commit_paths: z.object({ ...gitTarget, files: z.array(z.object({ path: z.string().min(1).max(4096), expectedSha256: sha.nullable() }).strict()).min(1).max(100), expectedHead: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/), message: z.string().min(1).max(4096) }).strict(),
  git_branches: z.object({ ...gitTarget }).strict(),
  git_switch_branch: z.object({ ...gitTarget, branch: z.string().min(1).max(200), create: z.boolean().default(false) }).strict(),
  git_fetch: z.object({ ...gitTarget, remote: z.string().min(1).max(128).default('origin'), branch: z.string().min(1).max(200).optional() }).strict(),
  git_pull: z.object({ ...gitTarget, remote: z.string().min(1).max(128).default('origin'), branch: z.string().min(1).max(200).optional() }).strict(),
  git_push: z.object({ ...gitTarget, remote: z.string().min(1).max(128).default('origin'), branch: z.string().min(1).max(200).optional() }).strict(),
};
export type ToolName = keyof typeof schemas;
export const toolSchemas = schemas;
const descriptions: Record<ToolName, string> = {
  get_project_context: 'Inspect project manifests, local instructions, configured commands/aliases/environment names and Git state. Does not execute project scripts or expose environment values.',
  save_project_note: 'Save your bounded project handoff note for the next conversation. Note is tied to this client identity, project and local root; it grants no authority.',
  read_files: 'Read up to 16 UTF-8 files by line range in one bounded call. Returns full-file SHA-256 for revision-fenced edits, per-file errors and nextStartLine.',
  edit_files: 'Preflight a batch of explicit create/replace/exact-edit/delete operations. Existing files require SHA-256. Uses a durable journal and conflict-aware rollback; dryRun previews without writes. Not filesystem snapshot isolation.',
  apply_unified_diff: 'Apply a strict textual unified diff (---/+++/@@) through the journaled editor. Every path requires its expected SHA-256, or null for creation. Rejects binary diffs, renames, fuzzy matches and stale contexts.',
  get_edit_transactions: 'List your recent edit receipts and unresolved recovery transactions for this project; does not expose backup contents.',
  recover_edit_transaction: 'Recover your interrupted edit batch. Restores only paths still matching transaction after-images; refuses to overwrite external changes.',
  list_directory: 'List a project directory in bounded live pages using nextOffset. Concurrent directory changes can shift entries.',
  read_file: 'Read a UTF-8 file in byte ranges; reuse revision as expectedRevision on continuation to reject changed files. Returns SHA-256 for small files.',
  write_file: 'Write or append UTF-8 text; optional expectedSha256 prevents stale edits.',
  create_directory: 'Create directories inside the selected project.',
  move_file: 'Move a file or directory within one project; refuses overwrite.',
  search_files: 'Search file names or literal text; bounded scan, skips symlinks and .git.',
  edit_block: 'Replace one unique exact text block in a file.',
  get_file_info: 'Inspect file size, modification time and type.',
  start_process: 'Start a tracked subprocess with executable + argv (no shell). Requires a locally allowed executable. Returns processId immediately; poll read_process_output.',
  run_command: 'Run a permitted executable or local alias; wait briefly for completion and return its tail output in one call. Longer commands return a tracked process ID for wait_process. No implicit shell.',
  wait_process: 'Wait up to 20 seconds for output changes or completion, without restarting the job. Returns bounded tail, status and absolute byte cursor; cancellation only stops waiting.',
  tail_process_output: 'Read the rolling last 64 KiB of a job, including errors produced after the initial output cap. Absolute cursors and skippedBytes explicitly report overwritten output.',
  read_process_output: 'Read bounded process output by byte cursor, including completion status.',
  write_process_input: 'Send text to a tracked process stdin, optionally closing it.',
  list_processes: 'List your tracked processes for this project.',
  stop_process: 'Terminate a tracked process and its process tree.',
  git_status: 'Read Git porcelain status.',
  git_diff: 'Read bounded working tree or staged Git diff.',
  git_log: 'Read recent commits.',
  git_add: 'Stage explicitly named project paths.',
  git_commit: 'Commit staged changes; hooks/signing disabled. Requires locally enabled Git writes.',
  git_commit_paths: 'Commit only explicit file snapshots with expected HEAD and SHA-256 checks. Refuses selected paths with pre-existing staged changes and preserves unrelated staged entries. Requires Git writes.',
  git_branches: 'Inspect current branch, exact HEAD and bounded local branch list.',
  git_switch_branch: 'Switch to or create a local branch only in a clean working tree/index. Refuses force switching and does not push.',
  git_fetch: 'Fetch a named configured HTTPS/SSH remote without submodules. Requires owner-enabled Git writes and network access. Use repository to select a nested repository.',
  git_pull: 'Fast-forward a clean repository from a named configured HTTPS/SSH remote; never rebase, merge divergent history or recurse into submodules. Requires Git network access.',
  git_push: 'Push HEAD to one branch on a named configured HTTPS/SSH remote, without force, deletion or tags. Requires the owner to separately enable Git push.',
};
export function toolScope(name: ToolName): Scope {
  if (['write_file', 'create_directory', 'move_file', 'edit_block', 'edit_files', 'apply_unified_diff', 'recover_edit_transaction', 'save_project_note'].includes(name)) return 'write';
  if (['start_process', 'run_command', 'write_process_input', 'stop_process'].includes(name)) return 'execute';
  if (['git_add', 'git_commit', 'git_commit_paths', 'git_switch_branch', 'git_fetch', 'git_pull', 'git_push'].includes(name)) return 'git';
  return 'read';
}
export const toolDefinitions = Object.entries(schemas).map(([name, schema]) => ({
  name, description: descriptions[name as ToolName],
  inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
  annotations: { readOnlyHint: toolScope(name as ToolName) === 'read', destructiveHint: toolScope(name as ToolName) !== 'read', idempotentHint: false, openWorldHint: ['start_process', 'run_command', 'write_process_input', 'git_fetch', 'git_pull', 'git_push'].includes(name) },
}));

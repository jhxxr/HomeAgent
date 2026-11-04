# Tool and Configuration Reference

**English** · [简体中文](TOOLS.zh-CN.md)

The 13 development tools introduced in v0.3, command aliases / environment profiles, batch-edit recovery and safe commits are fully described in the [Development Workflow](DEVELOPMENT_WORKFLOW.md). v0.4 added controlled Git network operations, a Web permission editor, fuzzy unified-diff hunk relocation, persistent shell sessions and lightweight LSP integration. The current release exposes **45 MCP tools**. The v0.2 APIs below remain available; the exclusion strategies for Git add and diff were tightened.

## Permission Combinations

Every call must satisfy the client's device/project grants, scopes and the Runner's local project policy. All machine tools require `projectId`; `deviceId` may be omitted when exactly one authorized device is online. The Server cannot modify Runner configuration through a tool.

| Scope | Tools | Additional local condition |
| --- | --- | --- |
| read | list_directory/read_file/read_files/search_files/get_file_info/get_edit_transactions/read_process_output/tail_process_output/wait_process/list_processes/list_shells/lsp_document_symbols/lsp_workspace_symbols/lsp_definition/lsp_references/lsp_hover/lsp_diagnostics/git_status/git_diff/git_log/git_branches | Project exists and file is not excluded; processes and shell sessions must belong to the current principal |
| write | write_file/create_directory/move_file/edit_block/edit_files/apply_unified_diff/recover_edit_transaction/save_project_note | `readOnly=false` |
| execute | start_process/run_command/write_process_input/stop_process/start_shell/run_shell/stop_shell | `readOnly=false`; launch must satisfy the program allowlist/aliases, or both the device project and the client must allow all programs |
| git | git_add/git_commit/git_commit_paths/git_switch_branch/git_fetch/git_pull/git_push | `readOnly=false`, `allowGitWrite=true`; network operations also need the corresponding device switch |

`readOnly` blocks every write and execution entry point; a read token on a writable project still cannot write. The `git` scope does not automatically include `read`. New OAuth grants must select concrete devices/projects and are stored in `projectGrants[deviceId]`; newly added projects do not gain access automatically, and refresh preserves the original scope. PATs support both global `projects` and device-scoped `projectGrants`, intersected. Legacy v0.1 OAuth grants must be revoked and re-authorized to be narrowed.

### Two-layer Web permission model

The device configuration is the capability ceiling and the client authorization is an independent grant for the calling principal; effective access is the intersection:

1. The Dashboard device editor changes each project's file scope, command execution mode, local Git writes, Git network fetch/pull and Git push.
2. The Dashboard client editor changes an existing PAT/OAuth authorization's devices, projects, scopes, tool set, device-wide file access and allow-all-programs switch.
3. Temporary settings carry a minute-level expiry. Server and Runner both check expiry independently; in-flight calls and the corresponding long jobs are stopped, then permanent permissions are restored.

`commandMode` / `filesystemScope` on a `list_devices` project and the project fields of `get_project_context` are the effective policy for the current client. Both provide `executionPolicy` (`configuredMode`, `effectiveMode`, `unrestrictedExecutionGranted`, `executeScopeGranted`, `readOnly`, `limitedBy`) and `filesystemPolicy` (`configuredScope`, `machineAccessGranted`, `limitedBy`). `limitedBy=project` means the device project has not opened the capability, `authorization` means the device opened it but the current client was not granted it, and `null` means both layers are open; execution still requires scope, tool-set and non-read-only conditions. `command_denied` / `path_escape` errors also carry the relevant policy and where to change it.

Device project directories, permissions, command aliases and environment profiles are all stored on the Server. Local config accepts no project configuration or permission switches; there is no project access before Server settings are received and successfully applied. Disconnect, clearing projects or a failed policy application all revoke project permissions. `stateDir` remains the hosted machine's local credential and job directory. `homeagent check-config` inspects only local connection settings; the terminal shows the actually applied directories after sync.

## File Tools

- `list_directory(path=".", offset=0, limit=200)`: up to 1000 entries per page, streaming enumeration, no symlink following. Continue with `nextOffset`; scans at most 100,000 entries and never emits a fake `nextOffset` when the source is truncated. A live directory can produce duplicates/omissions; in-page ordering is not a whole-directory snapshot.
- `read_file(path, offset=0, length=65536, expectedRevision?)`: up to 131,072 bytes, returning text/size/nextOffset/eof/revision; continuing with `revision` rejects a version change. `revision` is a digest of dev/inode/size/mtime/ctime, not a full upstream content snapshot. For files ≤ 1 MiB it also returns the full-content sha256. Multi-byte character boundaries may show replacement characters; binary files do not support editing.
- `write_file(path, content, append=false, expectedSha256?)`: input up to 262,144 characters, result up to 1 MiB; temp file write/fsync then rename; missing parent directories are not created automatically. A mismatched `expectedSha256` is rejected to prevent silently overwriting an older version.
- `create_directory(path)`: recursively creates directories inside a validated path.
- `move_file(source,destination)`: moves within a project, refuses to overwrite the target or move the project root; cross-project moves are not allowed.
- `get_file_info(path)`: size, modification time and file/directory type.
- `search_files(path=".",query,content=false,caseSensitive=false,limit=100,include=[],exclude=[],contextLines=0,respectGitIgnore=true)`: literal matching with Node glob filtering and up to 5 context lines; Git projects use tracked/untracked non-ignored sources; non-Git uses bounded traversal and explicitly reports that ignore rules were not applied. Bounded to roughly 10,000 paths, 500 results and 256 KiB of content results.
- `edit_block(path,oldText,newText,expectedSha256?)`: `oldText` must match exactly and uniquely; edits within a project are serialized so built-in edits from two clients cannot interleave. An external editor or a running command can still modify files concurrently; the application lock is not a filesystem transaction.
- `apply_unified_diff(diff,expectedSha256,dryRun=false,fuzz=20,ignoreWhitespace=false)`: applies a text unified diff through the journaled editor, with `fuzz` (0–200 lines) for bounded context-line relocation and `ignoreWhitespace` tolerance of leading/trailing horizontal whitespace. When several matches occur inside the fuzzy window it rejects with `ambiguous_patch`, and returns `relocatedHunks` describing offsets. Strict `fuzz: 0` mode is still available.

## LSP and Code-Intelligence Tools

- `lsp_document_symbols(path)`: extracts structured source symbols (classes, interfaces, types, enums, functions, methods, constants, variables, etc.), exact line/column ranges, doc comments and module import relations.
- `lsp_workspace_symbols(path=".",query?,kind?,exportedOnly=false,limit=100,respectGitIgnore=true)`: searches symbol definitions across the workspace, ordered by exact match, prefix match and substring match.
- `lsp_definition(path,line?,column?,symbol?,respectGitIgnore=true)`: locates a definition from 1-based line/column coordinates or a symbol name, supporting the current file, relative module imports (including TypeScript `.js` → `.ts` mapping and Python modules) and workspace exported-symbol jumps.
- `lsp_references(path,line?,column?,symbol?,includeDeclaration=true,contextLines=0,limit=100,respectGitIgnore=true)`: finds identifier-word-boundary references across the workspace, automatically filtering comments and distinguishing declarations, imports and ordinary references.
- `lsp_hover(path,line?,column?,symbol?,respectGitIgnore=true)`: returns the declaration signature, extracted JSDoc/Docstring comments, definition location and a code preview for a position or named symbol.
- `lsp_diagnostics(path?,limit=100,respectGitIgnore=true,serverExecutable?,serverArgs=[])`: under the `read` scope provides built-in syntax, JSON, TypeScript AST and unresolved-relative-import diagnostics with no external process; with `serverExecutable` (requires `execute` and a policy-allowed command) it can query an external language server over stdio JSON-RPC 2.0.

Paths may be project-relative or absolute inside the project. `..` escapes, symlinks / Windows junctions in any path component, hard-linked regular files and `deniedNames` are refused. Windows additionally refuses device reserved names, NTFS alternate data streams and trailing-dot/space aliases.

## Terminal Tools

`start_process(executable,args=[],cwd=".",timeoutMs=3600000)` spawns directly without concatenating a shell; the timeout range is 100 ms to 24 hours. `commands` is empty by default; add specific programs in the Dashboard, or enable "Allow all programs" in both the device project and the current client authorization. A specified program matches the full string, case-insensitively on Windows; absolute paths are recommended to avoid PATH hijacking. Interpreters may live outside the project; a `cwd` outside the project also requires device-wide paths allowed by both device and client. Windows `.cmd`/`.bat` is not implicitly launched through a shell and is refused outright; to run a shell you must allow the shell executable and accept its full privileges.

The optional `idempotencyKey` (8–128 characters) should be generated by the caller and kept unchanged when retrying after an uncertain response. The same principal/project/key with identical executable/args/normalized cwd/timeout returns the original job; conflicting parameters are rejected. Admission is written to SQLite before spawn. Receipts are kept for 48 hours, so a cleaned-up job is not re-run; after the key expires or changes, de-duplication no longer applies. This is not exactly-once for all file/Git operations.

Child processes inherit only a limited environment (PATH, system paths, HOME, TEMP, language, etc.), never the Server password or arbitrary token environment variables. There is no interface for MCP to inject arbitrary environment variables. Extra configuration for build environments should be defined in a dedicated account or a trusted launcher.

Since v0.3, administrators can configure local `environmentProfiles` names and `commandAliases`; both values and targets are pre-authorized by the operator, and clients cannot pass arbitrary env maps. `run_command`, `wait_process` and `tail_process_output` provide short-command returns and rolling-tail observation of long jobs. Beyond the prefix cap, a fixed 64 KiB tail is retained so the final error is still visible after overflow; the discarded middle is never presented as a complete log.

The return value is an `id` (UUID), never an arbitrary OS PID. Follow-up calls:

- `read_process_output(processId,cursor=0,length=65536)`: reads merged stdout/stderr, nextCursor, state, exitCode, signal, finished, truncated.
- `write_process_input(processId,input,close=false)`: input up to 65,536 characters; `close=true` sends EOF.
- `list_processes()`: historical and running jobs of the current principal and current project only.
- `stop_process(processId)`: enters `stopping` and keeps the slot occupied, terminating only after the real tree is gone. Linux sends SIGTERM to the group then SIGKILL on timeout, cleaning the remaining group even if the leader exits early; Windows uses a suspended-admission Job Object supervisor for the whole tree and stops the supervisor via taskkill.
- `start_shell(shell?,cwd=".",timeoutMs=3600000,environment?)`: starts a persistent stateful shell session supervised by `Processes` (Windows default `powershell.exe`, POSIX default `sh`/`bash`), still subject to the command allowlist or allow-all-programs policy.
- `run_shell(command,sessionId?,shell?,cwd=".",timeoutMs=3600000,environment?,waitMs=10000)`: runs a command in a persistent shell session (reusing an idle session or starting a new one when `sessionId` is omitted), preserving the working directory (`cd`) and shell/environment variables across commands, and returning the isolated `output`, `exitCode` and updated `cwd` for this command.
- `list_shells()` / `stop_shell(sessionId)`: inspect persistent shell sessions for the current project (`ready`/`running`, current `cwd`, last exit code) or terminate a session and its process tree.

States include starting/running/stopping/exited/failed/stopped/timed_out/interrupted. Defaults: at most 8 running processes, 8 MiB output per process, roughly 500 historical jobs. A Server reconnect does not restart jobs; a Runner restart marks unfinished records interrupted. On Windows the supervisor kills its Job when the Runner dies; on Linux, forced Runner kill cleanup is handled by systemd/container. There is no PTY and no job migration across Runners.

Windows needs system PowerShell/.NET `Add-Type`, using the independently written C# helper under this project's `runtime/`; it downloads no binaries and does not bypass organizational execution policy automatically. If policy blocks it or Job assignment fails, the job fails closed rather than degrading to an unprotected process tree.

Allowing `node`, `python`, `bash`, `powershell`, `npm`, `git` or a project build program may execute arbitrary local code. The argv structure only avoids accidental shell parsing; it does not restrict interpreter capabilities. Use a low-privilege account, container or VM for real system isolation.

## Git Tools

By default `project.root` is an ordinary standalone Git repository. Since v0.3, linked worktrees with a configured `gitCommonDir` are supported after validation; without it, `.git` files are still refused, and arbitrary gitdir pointers of general submodules are not supported.

- `git_status()`: porcelain v1.
- `git_diff(staged=false,path?)`: bounded output, external diff, textconv and submodule diff execution disabled.
- `git_log(limit=20)`: up to 100 entries, short hash/time/author/title.
- `git_add(paths)`: explicit file path array, up to 100 items, no directories (including `.`), pathspec magic disabled; refuses writes when local config contains clean/process filters.
- `git_commit(message)`: commits only staged content; hooks and GPG signing disabled, no push, no automatic author identity configuration.

All Git tools accept a `repository` parameter, a repository-relative directory under the project root defaulting to `.`; absolute paths need device-wide file access. Ordinary Git tools disable system and global Git config, fsmonitor and external diff; network Git uses local SSH config/credentials and only allows configured HTTPS/SSH remotes. Output is capped at 256 KiB, network execution at 35 seconds, other Git execution at 20 seconds. Author identity should be set in the repository beforehand via `git -C <project> config user.name ...` and `user.email`. There is no arbitrary git subcommand interface; `reset --hard`, `clean`, force push and similar actions are not in the tool set.

`git_fetch(remote="origin",branch?)` fetches only configured HTTPS/SSH remotes. `git_pull` requires a clean worktree, performs fast-forward only, and does no rebase, merge, force or recursive submodule update. `git_push` pushes HEAD to a single branch, requires push to be enabled separately on the device, and supports no force, deletion, tags or arbitrary refspec.

These limits reduce implicit execution risk, but Git still reads its own metadata. Against a local malicious user who can replace files or repository config simultaneously, OS isolation is required; a project-root policy cannot replace it.

## Admin and Operations API

The browser must be signed in and supply `X-CSRF-Token` on every modifying request (forms use `_csrf`). The token comes from `/api/state` and belongs only to the current browser session.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /health | Health and database probe; returns Server `version` and `runnerProtocol` |
| GET | /api/state | Devices, client activity, recent audits, current CSRF, plus Server `version`, `runnerProtocol` and Node/platform info |
| GET | /api/jobs?deviceId=UUID&projectId=ID&limit=200 | Bounded persistent job metadata, up to 1000 items |
| GET | /api/jobs/:deviceId/:id/output?cursor=0&length=65536 | Admin reads Runner output by exact instance; not stored on the Server |
| GET | /api/jobs/:deviceId/:id/output?view=tail&length=65536 | Rolling tail (introduced in v0.3); continue with an absolute cursor, returns overrun notice |
| POST | /api/jobs/:deviceId/:id/stop | Admin stops a hosted job of the exact instance; action audited as admin |
| POST | /api/sessions/:id/revoke | Revoke an administrator browser login session |
| POST | /api/pair/inspect | Inspect the device name and expiry for a pairing code before approval |
| POST | /api/pair/approve | Verify and approve a one-time pairing code |
| GET/POST | /pair/verify?id=UUID&token=short-credential | Signed-in administrator approves device pairing from the browser link printed by the Runner |
| POST | /api/devices/:id/pause,resume,revoke,rename | Device management |
| POST | /api/devices/:id/permissions | Edit or clear device project permissions; supports `expectedRevision`, `durationMinutes` and temporary fallback |
| POST | /api/tokens | Create a scoped PAT |
| POST | /api/tokens/:tokenId/revoke | Revoke a token family; OAuth access also revokes the client |
| POST | /api/authorizations/:id/permissions | Edit an existing PAT/OAuth authorization's devices, projects, scopes, tools and temporary advanced permissions |
| GET | /api/clients | List registered OAuth client names and callbacks |
| POST | /api/clients/:id/revoke | Revoke an OAuth client and all its tokens |
| GET | /api/audit?limit=100&before=millisecond-timestamp&beforeId=UUID | Paginate the JSON audit log |

Audit pagination is ordered by (at, id) descending. Pass the last row's `at` and `id` of the previous page as `before` and `beforeId` to traverse multiple rows in the same millisecond stably. The current Dashboard shows the most recent 100 rows; the API returns at most 1000 per page.

# Daily Remote Development Workflow

**English** · [简体中文](DEVELOPMENT_WORKFLOW.zh-CN.md)

This workflow serves a single AI / single-operator cycle of "take over → search → edit → verify → review and commit → recover after disconnect". The v0.3 release added practical tools on top of the v0.2 permission, pairing and job protocol; v0.4.17 later added fuzzy unified diffs, persistent stateful shell sessions and lightweight LSP tools. Clients keep connecting to the same `/mcp`; upgrade Server and Runner together and refresh the client tool list.

## Recommended Tool Flow

1. Call `list_devices` to pick the exact device and project, then `get_project_context` to obtain the manifest, project instructions, Git branch/HEAD, available commands and aliases, environment profile names, recent jobs and your own saved handoff note.
2. Use `search_files` with include/exclude globs and `contextLines` to locate relevant code; Git projects default to `git ls-files --cached --others --exclude-standard`, with bounded sources and no silent fallback to an unbounded full-disk search. Non-Git projects use bounded traversal and return `gitIgnoreApplied=false`. For symbol navigation or diagnostics, use the `lsp_*` tools.
3. Use `read_files` to read specified line ranges of up to 16 files in one request. Use the returned full-content SHA-256 for subsequent edits; no byte offsets need to be computed.
4. `edit_files` pre-validates creation, replacement, exact-block edits or deletion across all files; alternatively `apply_unified_diff` applies a standard text unified diff. Existing files require the expected SHA and new files must be explicitly absent. A `dryRun` shows a summary first.
5. Use `run_command` for an allowed local program/alias. Short commands return status and output in one call; long commands return the same job ID, so continue with `wait_process` instead of starting a second process. Keep `idempotencyKey` when retrying a launch. For stateful multi-command work, use `start_shell` / `run_shell`.
6. Review changes with `git_diff`, then call `git_commit_paths` with the exact HEAD from `git_branches` and the selected files' content SHAs. It refuses to consume pre-existing staged changes of selected files and preserves the staging state of other files.
7. `save_project_note` writes a short handoff note. Calling `get_project_context` later with the same client identity restores your own note, Git status and recent jobs. It is not chat history, automatic scheduling or an upstream Workflow Session.

## Low-Friction Command Configuration

Configure `commandAliases` and `environmentProfiles` in the Dashboard's project permissions so you do not have to concatenate platform wrapper scripts or pass environment variables in every prompt. Replace the paths below with real values from your machine:

Edit the corresponding JSON in "Command Aliases and Environment Profiles" of the device permissions. The following is a Server-side project settings example, not a local Runner connection file. The Server stores these parameters and the Runner opens the capability only after receiving the configuration.

```json
{
  "id": "app",
  "name": "My application",
  "root": "/home/me/projects/app",
  "commands": ["/usr/bin/node", "/usr/bin/python3"],
  "commandAliases": {
    "test": {
      "executable": "/usr/bin/node",
      "args": ["--test"]
    },
    "npm": {
      "executable": "/usr/bin/node",
      "args": ["/usr/lib/node_modules/npm/bin/npm-cli.js"]
    },
    "python": {
      "executable": "/home/me/projects/app/.venv/bin/python",
      "args": []
    }
  },
  "environmentProfiles": {
    "development": {
      "env": {"NODE_ENV": "development"},
      "inherit": ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]
    }
  },
  "allowGitWrite": true
}
```

On Windows the npm alias can point to `C:/Program Files/nodejs/node.exe`, with prefix args pointing to `node_modules/npm/bin/npm-cli.js` in the matching installation directory. The Runner still never executes `.cmd`/`.bat` implicitly and never concatenates strings into a shell command. Aliases are granted only by an administrator in the web device permissions; clients cannot temporarily specify arbitrary environment variables or modify aliases.

```json
{
  "name": "run_command",
  "arguments": {
    "deviceId": "actual-device-uuid",
    "projectId": "app",
    "executable": "npm",
    "args": ["test", "--", "--runInBand"],
    "environment": "development",
    "waitMs": 1500,
    "timeoutMs": 3600000,
    "idempotencyKey": "a-unique-key-kept-unchanged-for-retries-of-this-launch"
  }
}
```

Granting an alias grants execution of its target program even if the target is not separately listed in `commands`; this is an explicit administrator configuration grant. The Dashboard and `list_devices` show alias/environment names (up to 64 each) so the operator can see the extra execution entry points. Enabling node/python/shell still means allowing that program to use the account privileges. `environmentProfiles` values are not returned through context or hello; an authorized program can read its own environment, so do not treat this as a Vault secret from the executor. Use a dedicated low-privilege account or a container mounting only the required projects.

The environment check in `get_project_context` only checks reachability of configured programs on the base PATH; it does not execute scripts found in a manifest or guess which npm scripts are safe. Actual availability after a delivered profile changes PATH is determined by the command execution result. The terminal prints only the applied project directories, never environment values.

## Batch Reads and Edits

```json
{
  "name": "read_files",
  "arguments": {
    "projectId": "app",
    "files": [
      {"path": "src/service.py", "startLine": 20, "endLine": 100},
      {"path": "tests/test_service.py", "startLine": 1, "endLine": 120}
    ],
    "maxBytes": 131072
  }
}
```

Each file reads at most 8 MiB of source, each item at most 1000 lines (about 200 by default), and total returned text at most 256 KiB. Missing, permission or version errors appear in the per-file result; a tight budget explicitly returns continuation information. A single line longer than the budget does not produce a fake "already advanced" cursor. A full-text SHA is returned for edit preconditions.

`edit_files` handles at most 32 unique files, up to 1 MiB per file result, with all before/after images totaling no more than 8 MiB; creating a file requires its parent directory to exist. Existing files use `expectedSha256`, creation accepts only non-existent paths, and the same path cannot appear twice in one batch. Exact edits require a unique match per item.

`apply_unified_diff` accepts only standard text diffs with `--- / +++ / @@`, supporting text creation/deletion, CRLF and no-newline markers. It refuses renames, binary content, mode-only changes, overlapping/misplaced hunks, and missing or stale versions; Codex's `*** Begin Patch` syntax is not supported. It also supports bounded fuzzy hunk relocation: `fuzz` (0–200 lines) relocates hunks whose `@@` line numbers are slightly off, `ignoreWhitespace` tolerates leading/trailing horizontal whitespace differences in context, ambiguous matches inside the fuzzy window are rejected with `ambiguous_patch`, and `relocatedHunks` reports the applied offsets. Strict exact-line-number mode is still available with `fuzz: 0`.

The edit plan, original content and status journal live in the private `stateDir/edits`. Files are modified only after all pre-checks pass; on failure a rollback is performed against the after-image validation. Unfinished transactions are recovered after a restart. If an external process changed a file concurrently, that content is preserved, `recovery_conflict` is returned and further automatic project modification is blocked. Use `get_edit_transactions` to inspect your own transactions; after resolving a conflict, `recover_edit_transaction` re-checks digests and still never force-overwrites external changes.

This is a set of per-file operations with a recovery journal, not filesystem snapshot isolation; an external editor can still see intermediate states. Content backups are deleted after normal success/rollback, keeping only up to roughly 200 digest receipts. When many unresolved or unfinished private directories accumulate, new transactions are refused for operator inspection; unknown recovery data is never deleted automatically. Crash recovery after a process crash has been tested; no filesystem transaction guarantee after power loss is claimed.

## Short Commands, Waits, and Output Tails

`run_command` waits 1500 ms by default, at most 20 seconds in one call; the job's own `timeoutMs` remains independent. Beyond the wait window the same job continues. `wait_process` can wait for completion or new output, at most 20 seconds; cancelling a wait does not terminate the job — use `stop_process` for that.

The current version keeps two bounded output views:

- The original `read_process_output` reads the first `maxOutputBytes`, compatible with the legacy byte cursor.
- `tail_process_output` reads a separate fixed 64 KiB rolling tail, retaining the trailing error produced after the prefix cap. It returns total output bytes, absolute `nextCursor`, `oldestCursor` and `skippedBytes`; rotation is never presented as a complete log.

Per-job disk usage is capped at `maxOutputBytes + 64 KiB`; the middle is discarded on overflow, with no promise of a "full log" download. Legacy v0.2 jobs have no rolling tail, and jobs left unfinished after an abnormal Runner exit do not infer an unknown rolling write position — both continue to use the prefix API. The tail of a normally finished job can still be read after a Runner restart. The Dashboard defaults to the newest content for positions with a valid tail, showing total bytes and a rotation notice.

## Safe Commits and Git Worktrees

`git_commit_paths` accepts concrete ordinary files or explicit deleted files and requires `expectedHead` and per-file `expectedSha256` (`null` for deletions). It locks the real index, builds the commit with a temporary index and CAS-updates the ref, then writes an index that preserves other staged entries. A changed HEAD or file version, or pre-existing staged changes on selected files, is rejected; unrelated staged content of the user is never swept into the commit.

This does not prove every line of a file was written by the current AI; review the selected files before calling. If a crash/error occurs between the ref and index finalization, `index.lock` is retained and reported for manual inspection instead of deleting the lock and blindly retrying. The two updates to a Git ref and index cannot be made into one cross-file atomic transaction.

`git_switch_branch` creates/switches local branches only when both worktree and staging area are clean; it never force-overwrites or pushes. `git_branches` returns the exact HEAD, current branch, up to 100 local branches and status.

An existing linked worktree can explicitly set the project's `gitCommonDir` to the canonical `.git` directory of its owning repository. The Runner validates that gitdir is under its `worktrees` subdirectory and that `commondir` and the bidirectional backlink agree; by default a `.git` file pointing to unauthorized Git metadata is still refused. The fully automatic flow of creating a worktree, registering a derived project and granting client permissions is not implemented; the operator registers it manually.

`git_diff` filters directory arguments per file against local exclusion rules; `git_add` was tightened to explicit files so excluded files inside a directory are not staged implicitly. Git log/status remain metadata within the authorized project repository.

## Acceptance and Remaining Scope

Automated tests include genuinely running Node tests and Python unittest, plus a full chain with the official MCP 2026 Client: failing test → batch read → multi-file diff → re-test passing → review → commit only selected files → save handoff → recover after Server restart. This chain is a reproducible SDK scenario test; **it does not claim a real AI client was signed in or prove a model's autonomous completion rate**. Later v0.4.17 additions (fuzzy diffs, persistent stateful shell sessions and lightweight LSP tools) extend the toolchain beyond that original scenario.

Still not implemented: interactive PTY, a detached supervisor that keeps running across a Runner restart, port preview and browser acceptance, an artifact channel, automatic worktree registration and a full Workflow Session. Persistent stateful shell sessions added in v0.4.17 are bounded, supervised sessions — **not** an interactive PTY or a detached supervisor. The existing profiles/aliases provide a stable entry point for common non-interactive toolchains. Real AI client acceptance still requires choosing a client and a modifiable real project; no model keys need to be provided to the repository.

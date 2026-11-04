# WebCodex Source Code Audit

**English** · [简体中文](WEBCODEX_CODE_AUDIT.zh-CN.md)

Audit date: 2026-10-26. WebCodex pinned revision: `4ab06a5574792a86302dcd9a13bb4214ee09cc50`. HomeAgent's pre-audit baseline was v0.1; this document continues to record the incremental coverage of v0.2/v0.3, and the initial public repository does not retain private development Git commits. v0.4.17 later added fuzzy diffs, persistent stateful shell sessions, and lightweight LSP tools; however, this audit's dated classification remains a point-in-time record.

Conclusion: the previous release completed the core remote MCP pipeline, but **it cannot be called a full-feature-parity implementation of WebCodex**. This round closed real gaps found in the source — protocol, job observability, process-tree lifecycle, authorization, and retry — while advanced workflows, tool domains, and Desktop capabilities still show clear differences.

v0.3 additions: project context/handoff, line-based batch reads, multi-file edits with a recovery journal, strict unified diff, short-command waiting, ring-buffer tailing, path-scoped commits, and explicit linked-worktree support. See [Development Workflow](DEVELOPMENT_WORKFLOW.md). These raised coverage in some of the domains below but still do not implement every upstream product domain.

## Audit Scope and Evidence

Source was taken from the upstream Git revision; no upstream program or installer was executed. The inventory covered 2948 file entries in the entire Git tree, 21 workspace crates, and the root Server; of these, `src/` and `crates/` contain 1539 Rust/C#/PowerShell source files. Key execution paths — protocol, routing, authentication, jobs, file boundaries, process management — were compared against the source at specific points, and **no claim is made that every file was manually reviewed line-by-line or that an upstream security audit was completed**.

On the tool side, `crates/webcodex-tool-contracts/src/tool_definition.rs` was the entry point, covering all 29 definition modules; 192 tool declarations were statically extracted and cross-checked against App descriptor names. This number includes hidden and feature-gated declarations, and **does not equal the tools/list count of any compiled WebCodex Server**.

Every declaration records the tool name, file, line number, upstream pinned link, the corresponding tool in this project, coverage status, and a difference note:

- [Full per-tool inventory](webcodex-source-inventory.json)
- [Manual classification rules](webcodex-parity-map.json)
- [Reproducible inventory script](../scripts/inventory-webcodex.mjs)

```sh
node scripts/inventory-webcodex.mjs --root data/reference/webcodex
```

The script checks the baseline revision, unknown new tool domains, and stale tool mappings; by default it explicitly marks unimplemented declarations as `missing` and does not infer equivalence merely because a generic command-execution tool exists.

v0.3 static classification: **7 core-equivalent capabilities, 31 partially covered, 154 missing** (v0.2 was 7/27/158). This is a declaration-by-declaration comparison against WebCodex's additional product domains, not a "pass rate" for HomeAgent tools. `core-equivalent` does not imply full parity of parameters/return values or Runner binary interoperability.

## Real Gaps Found and Fixed This Round

| Issue | Upstream code evidence | HomeAgent fix and verification |
| --- | --- | --- |
| MCP protocol stuck at 2025 | [`src/mcp/protocol.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/src/mcp/protocol.rs) has `2026-07-28` and `server/discover` | `src/server/mcp.ts` switched to the official SDK v2 `createMcpHandler` / Node adapter; a real v2 Client pins 2026 negotiation and calls tools, while 2025 client tests are retained. |
| No Server/Dashboard observability domain for long jobs | [`runner_protocol/transport.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_protocol/transport.rs), [`job_updates.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/job_updates.rs) | Added `job_update`, bounded paginated `jobs_snapshot`, Server metadata mirroring, a Dashboard job table, output reads, and a stop interface. Body output still stays on the Runner only. |
| Ambiguous state on disconnect or reconnect | [`reconciliation.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/reconciliation.rs), [`runner_job_receipt.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_job_receipt.rs) | Jobs bind device, Runner instance, principal, project, admission time, and a monotonic revision; identity changes and terminal-state rollbacks are rejected. Offline is unconfirmed, an unreported snapshot is missing, and neither success nor re-execution may be inferred. |
| Stop requests became terminal too early | [`runner_job_lifecycle.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_job_lifecycle.rs) distinguishes StopRequested from terminal | Added starting/stopping; stopped/timed_out/exit results are written only after a real close, and the concurrency slot is still held during stopping. |
| Orphaned descendants after the parent exits | [`webcodex-process/src/lib.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/lib.rs), [`unix.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/unix.rs), [`windows.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-process/src/windows.rs) | On Linux the original process group is cleaned up on leader exit; on Windows an independently written C#/PowerShell supervisor places the child into a Kill-on-close Job Object while suspended, then runs it and watches for Runner process death. Verified both leader-exit and Runner-death scenarios. |
| Retrying after an uncertain response could start a duplicate | [`execution_admission.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/execution_admission.rs), [`detached_job/store.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner/src/webcodex_runner/detached_job/store.rs) | `start_process.idempotencyKey` is isolated by principal/project; admission is persisted first, the same parameters return the original job within 48 hours, and differing parameters are rejected; a receipt that refuses duplicate execution is kept even after history is pruned. This covers ordinary tracked starts only and does not masquerade as a detached supervisor. |
| No local single-instance protection | An operational hardening in this project, added after comparing with the upstream full service/lifecycle path | `RunnerLock` uses SQLite OS locks to protect stateDir, mutually excluding both pairing and run; it does not delete "suspected stale PID" locks. Tested with another OS process holding the lock and with automatic release after that process dies. |
| OAuth had only device selection; project authorization was too vague | [`auth/project_credential.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/src/auth/project_credential.rs), [`dispatch_fence.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-runner-registry/src/dispatch_fence.rs) | New OAuth grants must select a specific device/project, stored in `projectGrants[deviceId]`. Refresh keeps the original grant; newly added projects and same-named projects on other devices do not gain permission automatically; both Server and Runner validate. |
| Revocation blocked only new HTTP, not queued calls | The upstream dispatch fence checks permissions/target at both admission and dispatch | The Server re-reads credentials at dispatch; token-family revocation proactively sends a cancel to the exact connection, and queued Runner tools check abort. Writes and external side effects that already occurred cannot be undone; existing long jobs must be stopped or have the device revoked separately. |
| Directory truncation blocked continuation; file paging could mix old and new versions | The paging/read_revision contract in [`tool_definition/files.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-tool-contracts/src/tool_definition/files.rs) | Directories gained offset/nextOffset; read_file gained revision/expectedRevision, bounded same-handle reads, and version checks before and after reading. revision is a metadata version, not equivalent to the upstream's full content-snapshot guarantee. |
| Dashboard "sessions" were actually only tokens | The upstream [`webcodex-workflow-session`](https://github.com/yyjeqhc/webcodex/tree/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-workflow-session) is a standalone business domain | The UI was renamed "client authorizations and tokens" and a real admin login-session view/revoke was added. Workflow Session is explicitly still not implemented. |
| Incomplete run-identity and service-uninstall diagnostics | [`webcodex-cli/.../runner_service.rs`](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-cli/src/webcodex_cli/runner_service.rs) | hello stores version/instance/tool capabilities; the CLI gained --version/check-config; Windows uninstall does End before Delete, avoiding the case where only the scheduled task is deleted but the old process keeps running. Full install/restart acceptance is still listed separately. |

Also fixed: the management API's error redirect when not logged in, login auditing, rate-limiter key-capacity bounds, and the cleanup path after a temp-file write failure. Runtime behavior borrows architecture and semantics but does not copy upstream implementation code.

Testing also filled in the path that pauses while offline and stops the original job after a 403 on reconnect; the Dashboard now keeps job rows and buttons and refreshes only their content, so periodic refresh no longer replaces the controls. At that time, the Windows 25/25 regression passed, including genuine cross-process locking, whole managed-tree cleanup after Windows Runner death, and official 2026/2025 client tests; see [Validation Record](VALIDATION.md) for environment details.

The v0.2 feature-baseline Linux regression was 24 passing, 1 Windows-specific test skipped, 0 failed. Both Docker targets built and Compose persistence acceptance passed; after a restart, a real Client could call tools over both the 2026 and 2025 protocols.

## Coverage Status of All 29 Tool Domains

| Upstream domain | HomeAgent status |
| --- | --- |
| discovery | Has devices, context/manifest/instructions, Git/jobs and handoff summaries; no dynamic project registration/creation, project_ref, Workbench, or adaptive discovery. |
| files | Has directory paging, byte/line ranges, batch reads, globs/ignore/context, SHA; no regex, multi-query batch, or the upstream's full snapshot continuation. |
| edits | Has a recovery journal, precheck, rollback on failure, restart recovery, and precise block edits; no cross-file snapshot isolation or full range editor. |
| patches | Has textual unified diff, bounded fuzzy line relocation (fuzz), optional whitespace tolerance, create/delete, and version checks; no Codex Patch, or binary/rename/mode-only diff. |
| git | Has path-scoped safe commits, branch inspect/switch, explicit linked worktrees; no frozen review snapshot, hunk cursor, or automatic worktree registration/derived authorization. |
| jobs | Has short-command returns, job waiting, ring-buffer tailing, alias/profile, and persistent stateful shell sessions (start_shell/run_shell/list_shells/stop_shell); no detached supervisor, semantic readiness, or Host continuation App. |
| testing | Can run explicitly allowed real test tools; no structured Rust/Go/Python validation plans or test-count proofs. |
| hygiene | Batch edits can delete/roll back files by digest; no dedicated Git restore/discard domain. |
| runner_config | Has local check-config; no remote CAS/hot reload. |
| diagnostics | Has an audit summary; no upstream detailed tool trace or window activity aggregation. |
| sessions | **Workflow Session not implemented**, nor external evidence, handoff, closeout, or Work Result App. Browser sessions are unrelated to it. |
| artifacts | **Not implemented**: binary artifact streaming, Host import, cross-project transfer, resource download links, and table App. |
| documents | **Not implemented**: PDF App reader. |
| docx | **Not implemented**: DOCX App reader. |
| resource_references | **Not implemented**: unified resource references and Workbench. |
| lsp | Has document symbols, workspace symbols, cross-file definition jumps, reference lookup, hover signature/docs, and built-in plus external stdio LSP diagnostics; call hierarchy not implemented. |
| skills | **Not implemented**: trusted Skill sources, install/version/activate/execute. |
| plugins | **Not implemented**: Runner-local MCP provider gateway. |
| ssh_resources | **Not implemented**: named SSH resources and persistent SSH shell. Allowing the ssh program does not count as an equivalent implementation. |
| coding_agents | **Not implemented**: dedicated run domain for Codex/Claude and other coding agents. |
| communication | **Not implemented**: Durable Agent, Conversation, Inbox, Endpoint, Host auto-resume. |
| agent_tasks | **Not implemented**: Agent Task/Attempt. |
| agent_waits | **Not implemented**: any/all fan-in and wake. |
| goals | **Not implemented**: persistent Goal and plan App. |
| memory | **Not implemented**: memory store/retrieve/cleanup domain. |
| computer | **Not implemented**: desktop observation/control/screenshots/clipboard. |
| browser | **Not implemented**: browser observation/control. |
| checkpoints | **Not implemented**: workspace checkpoint; upstream is an optional feature. |
| code_mode | **Not implemented**: V8 Code Mode; upstream is an optional feature. |

## Non-Tool Modules Are Not Counted as "Implemented"

| Upstream module | This project's counterpart or difference |
| --- | --- |
| root Server, core, tool-contracts, tool-runtime-contracts | TS shared/server/runner implement core routing and policy; the full set of business types and tool protocols is not replicated. |
| runner, runner-registry | Proactive WSS, local execution, request/instance isolation, job mirroring; no QUIC, HTTP polling fallback, or dynamic inventory registry. |
| process, persistent-shell | Process groups / Windows Job Objects implemented; bounded supervised stateful shell sessions now implemented (start_shell/run_shell/list_shells/stop_shell); PTY, SSH framing, and a detached supervisor that survives a Runner restart are still NOT implemented. |
| store, admin | SQLite, OAuth/PAT, pairing, single-admin Dashboard/sessions; no multi-user, shared-key group, ProjectGrant management product, or emergency bootstrap domain. |
| workspace, validation | Root-directory policy, read/write, Git and a real toolchain are usable; no recipe, managed worktree, structured validation, checkpoints, or full artifact domain. |
| cli, environment, build-info, runner-config | Has login/run/service/check-config/version and Docker; no native unified installer, upgrade/rollback, all-platform recovery flows, or full Git build fingerprint. |
| workflow-session | Not implemented; cannot be replaced by MCP stateless or browser sessions. |
| browser, computer, lsp, code-mode | Not implemented. |
| openai-tunnel | No dedicated Host tunnel of this kind; offers Caddy/Nginx/optional Cloudflare. The runtime pipeline does not depend on a third-party relay. |
| apps/desktop | No Tauri Desktop product; a Web Dashboard manages the core scope. |

## Original Goals and the Boundary of Future Extensions

The original requirements — Server/Runner proactive connection, standard remote MCP, pairing, device revocation, multi-device routing, project permissions, files/terminal/Git, long-job observation, auditing, Dashboard, Compose, and Linux/Windows paths — already have real implementations and regression tests.

To move further toward being a feature-parity replacement for WebCodex, the following are still needed: full Workflow Session/evidence, PTY, a detached supervisor that survives Runner restarts, a binary artifact channel, automatic worktree registration/derived authorization, frozen review, and structured validation; after that come Skill/provider, Agent/Goal/collaboration, and Desktop/Browser. The handoff notes, multi-file recovery edits, strict textual diff, and existing worktree support already present in v0.3 do not masquerade as these full domains, **nor does the ability of a generic command to run some program substitute for a dedicated domain implementation**.

Windows autostart is still a scheduled task triggered by user logon, not an unattended system service. Real AI client accounts, HTTPS/reverse proxy, and post-install system reboot acceptance cannot be replaced by unit tests. See [Validation Record](VALIDATION.md).

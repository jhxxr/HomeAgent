# Validation Record

**English** · [简体中文](VALIDATION.zh-CN.md)

This file is a chronological verification record. Historical per-version counts, dates, environments and conclusions are preserved as written; the current release is v0.4.21.

Date: 2026-10-27. Tests use temporary directories, temporary credentials and the project's own MCP SDK client, never real project keys.

This file keeps the verification facts of local, temporary Linux environments and public CI, marked by version and execution scope. Git history was tidied for public release; historical records use version identifiers and do not reference old private commit IDs. The released source is defined by the corresponding Git tag and archive manifest.

## Early Dual-Package Verification (Unpublished at the Time)

2026-10-27, full local Windows verification passed: type check, build, **58/58 tests** and release file checks. Regression covered local project fields and rejection of legacy directory fallback, Runner protocol 1 rejection, Server project delivery and reconnect, disconnect stopping jobs, permission failure clearing projects, temporary permission revocation, Server command aliases and environment profiles, and resuming interrupted edits after project delivery while preserving conflict-write limits.

Isolated npm install tests separately installed and verified `homeagent-server-0.4.2.tgz` and `homeagent-0.4.2.tgz`: the Server package's `homeagent-server` shim, `homeagent-server init`, web static assets and unauthenticated `/mcp`, plus the Runner package's `homeagent` shim, login, web project configuration, automatic recording of a custom connection file location and `homeagent run` after changing the working directory all passed. No npm publish or GitHub Release push was performed in this round, and no new public Linux/Docker CI was run.

## v0.4.0 Web Permissions and Controlled Git

2026-10-27, local Windows Node 24.14.1 ran the full test suite, **48/48 passed, 0 failed, 0 skipped**. New regression coverage:

- Dashboard edits existing PAT/OAuth authorizations without rotating credentials; device permissions and client advanced permissions take effect separately, and temporary grant expiry restores the original scope.
- Device permission updates cancel in-flight calls and hosted jobs; Runner disconnect, reconnect, expiry, old revision, invalid roots and protected state/config paths all fail safe.
- This section records v0.4.0 permission behavior at that time. The later development version removed local project fallback and accepts only Server project settings and Runner protocol 2.
- `tools/list` shrinks dynamically with a client's specific tool permissions; file scope, arbitrary programs, local Git writes, fetch/pull and push were verified separately.
- Nested-repository Git status/add/commit, controlled HTTPS/SSH fetch, fast-forward pull and separately enabled push; unconfigured protocols, force behavior, dirty worktrees and submodule recursion were rejected.

Type checking and permission-Dashboard browser regression passed: no horizontal overflow at a 390px viewport; permission editing, temporary opening, expiry revocation and job stopping were verified. A 0.4.0 source archive and npm tgz were then generated at the final commit and the npm packages installed into an isolated prefix; all three CLI shims, initialization overwrite refusal, Runner config check, a real Server, Dashboard assets and unauthenticated `/mcp` passed.

## v0.3.1 OAuth Authorization Callback

2026-10-26, in an isolated local Chrome session, v0.3.0 was reproduced: after login, selecting permissions/devices/projects and submitting authorization, the console reported a `form-action 'self'` block, client callback count was 0, and the Server had saved 1 authorization code and deleted the request; a second submit showed `Authorization request expired`. The test used two different loopback ports as Server and external client and did not connect a real AI account.

After the fix, the same browser flow entered an on-site completion page, then navigated to the registered callback: callback count 1, real PKCE token exchange HTTP 200, authorization code consumed. Rapid repeat submits were cancelled, the native form still contained a unique `decision=allow`, and the button was disabled with a submitting state. Global CSP was not relaxed.

Local Windows Node 24.14.1 type check, build and **42/42 tests** passed. New coverage: concurrent retries of the same request not issuing extra codes, completion-receipt login session isolation, modified decision/scope rejection, encrypted storage of callback info, code still single-use, validation failure preserving choices, authorization denial, expiry and revocation. The npm install package check requires and provides `/assets/consent.js`.

The fix only requires upgrading the Server; existing Runner config and persistent device credentials are compatible. Browser re-verification used a local callback client and does not claim a real Cursor account sign-in acceptance.

## Open Source and Release Preparation

2026-10-26, local Windows Node 24.14.1: full verify **all 39 tests passed**, including version tag / injected-parameter rejection and changelog version-section extraction; type check, build, release file / sensitive pattern / local link checks passed. Production dependency audit reported 0 known vulnerabilities, and the license report covered 99 locked production packages and passed its consistency check.

Separately, the source tar.gz generated from the initial public commit was extracted into a brand-new directory outside the repository; after verifying SHA-256 and archive paths, `npm ci`, full `npm run verify`, license check and production dependency audit were run, **39/39 passed, 0 skipped**. In that private test copy a real annotated `v0.3.0` tag was created; tag/commit/version checks, changelog release-note generation for that version and re-archiving all succeeded. The public project itself did not create or push version tags.

The CI and release workflows passed **actionlint 1.7.12** static validation. Automated release runs only after a version tag push or a manual trigger against an existing tag; at the time of this source-archive verification no public remote repository was bound, so no online Release execution is claimed. The new Dockerfile additionally copies license files and needs verification in an actual public CI build.

Old Git history, runtime data, test credentials and reference source were moved out of the release directory into a local private backup; the source package comes only from the new public HEAD. Licenses, contributing notes, bilingual entry points and dependency declarations are within the release scope.

## npm CLI and Token Release Preparation

2026-10-26, local Windows Node 24.14.1, npm 11.12.1: switched to the `homeagent-mcp` package name, adding three CLI entry points and a release file allowlist. Full type check, build, **39/39** tests, release file check and 99-production-package license report consistency check passed; CI/release again passed actionlint 1.7.12.

After globally installing real npm tgz files into an isolated temp prefix, the three Windows `.cmd` commands' version and help, Server/Runner initialization and overwrite refusal, and Runner config check all passed. Using the installed package to create a private `.env` and start a real Server, `/health` version, Dashboard JS/CSS and unauthenticated `/mcp` returning 401 all passed; the test did not modify the machine's global npm install.

The workflow was wired to `NPM_TOKEN`, can switch to OIDC, and supports recovery after npm succeeded but the GitHub Release did not, verified by tarball integrity. That chain has not been published online with a real npm account; Linux install-package and Docker verification are performed by the updated CI. Local GitHub CLI installation and account login are local development configuration, not part of the npm archives.

The first public CI's Linux tests, npm install-package smoke test and Docker build/Compose health check passed. Windows exposed a test fixture bypassing production config path normalization: CI temp directories carried aliases, triggering the `root_changed` check. The fixture was changed to call `realpath` first, and bounded cleanup retries were added for temp directory handle release after Job Object exit. Additionally on Windows, TEMP/TMP were pointed at junction aliases to confirm an original-vs-canonical path difference, then all **39/39 tests passed**; production directory permission checks kept their original implementation.

Later Windows CI comparison confirmed that Windows PowerShell starting the supervisor in a filtered environment with `PSModulePath` removed would hang, while inheriting the CI module path worked; pinning the legacy module directory narrowed the stall to the `Add-Type` call. The Runner now explicitly sets the built-in system module directory and imports the system Utility module from `$PSHOME`; PowerShell may add the machine-level Program Files module directory and by default does not inherit user/project module load paths. A new real-child-process regression verifies npm credentials are not inherited and module directories come only from those machine-level locations; after the update local **40/40** tests passed, and CI added a supervisor startup check using the same production environment function. The source release scan also added an npm Token pattern, with a synthetic value verifying rejection behavior and diagnostics not echoing the Token.

## v0.3.0 Daily Development Experience

This round added 13 tools for a total of 32; see the [Development Workflow](DEVELOPMENT_WORKFLOW.md). Windows Node 24.14.1 regression covered the following development scenarios, with the final execution count recorded at the end of this section:

- Official MCP 2026 Client full Node project scenario: failing test, project context, ignore-rule search, batch read, two-file Diff, re-test, safe commit, preserving the user's existing staged changes, handoff and recovery after Server restart. This scenario used 10 workflow tool calls.
- Actually starting local Python unittest, observing failure, editing via digest verification and re-testing to pass.
- Multi-file pre-check/dry-run, failure rollback, external-modification conflict preservation, private journal startup recovery.
- Strict unified diff multi-file, CRLF, no-newline, misplaced-context rejection.
- Command aliases and local environment profile; short command direct return and cancelled wait not killing the job.
- Trailing error still in the rolling tail after output exceeded the prefix cap, absolute cursor explicitly reporting overrun.
- Precise file commit, old HEAD / old file digest / pre-existing staged changes on selected paths rejected, without swallowing the user's other staged entries.
- Explicit common-dir authorization for a linked worktree, clean branch switching and dirty-worktree rejection.
- Runner config file located inside an exposed project refused to load, preventing read-only file permissions from reading private environment profiles.

This proves deterministic chaining of tools and protocol; no real AI client sign-in was used to measure a model's autonomous completion rate.

This round's Windows final execution was **37/37 passed, 0 skipped, 0 failed**; type check, build, Dashboard JS syntax and npm production dependency audit (0 known vulnerabilities) passed. Also measured in Chrome 155 a failing job whose prefix retained only 65,536 bytes of 150,018 total output bytes; the Dashboard reading the tail still showed the trailing FINAL_BUILD_ERROR; at a 390px viewport the page width matched the viewport with no console error/warn. Test devices were revoked and the browser exited.

Linux/Docker re-verified the v0.3.0 functional baseline: Linux x86_64, Node **24.22.1**, Python **3.11.2**, Docker Engine **29.8.2**, Compose **5.6.0**.

- **37 tests, 36 passed, 1 skipped, 0 failed**; the only skip was the Windows-only Job Object test, and both Node and Python coding scenarios actually ran.
- Both relay/runner production targets built successfully. Python was added only to a one-off test-derived image; the production runner image keeps the Node/Git base environment per the deployment docs.
- Compose health check, pairing, PAT issuance and unauthenticated MCP returning 401 passed. Actual UID=1000.
- After down/up with the volume retained, both 2026 and 2025 real SDK Clients discovered 32 tools and called them successfully; devices and credentials persisted correctly.
- The test project's containers/volume and test credential files were cleaned up after acceptance; the machine was restored to its original suspended state; source and credential-free test logs were kept in a separate test directory.

## v0.2.0 Regression After Source Comparison

The WebCodex comparison baseline, per-tool-declaration mapping and unported domains are in the [Source Audit](WEBCODEX_CODE_AUDIT.md). This round is not a full feature-parity acceptance.

Windows Node 24.14.1 ran type check, build, JS syntax check and **25/25** regression tests; npm production dependency audit reported 0 known vulnerabilities. New verification covered:

- Official SDK v2 client pinned to MCP 2026-07-28, listing/calling tools via server/discover and per-request envelope, while compatible with v1/2025 clients; wrong versions rejected.
- Directory pagination fully traversable, paginated continued read rejected when a file version changes.
- Stable `idempotencyKey` concurrent launch/retry/Runner restart executes only once, conflicting parameters rejected.
- `stateDir` mutual exclusion between genuinely different OS processes, automatic lock release after process death.
- Descendant process cleanup when the leader exits first; on forced Windows Runner exit the supervisor and all descendants in the Job Object terminate.
- Dashboard job metadata, output reading and stopping, Server not persisting output, browser login session viewing and revocation.
- Exact device/project authorization not extending to a same-named project on another device; OAuth refresh preserving authorization.
- Job owner/project/admission time, revision, terminal-state validation; token revocation cancelling in-flight calls and rejecting the next dispatch.
- Device paused during disconnect; Runner reconnect receiving 403 stops existing hosted jobs.

Chrome 155 measured the new login → job appears → click read output → click stop → final status stopped, and observed the admin call audit. Auto-refresh keeps job buttons instead of constantly replacing the DOM; the 390px mobile simulation had no horizontal page overflow and no console error/warn. Test device credentials were revoked and the browser exited.

Linux/Docker re-verified the v0.2.0 functional baseline on Linux x86_64, Node **24.22.1**, Docker Engine **29.8.2**, Compose **5.6.0**:

- Both relay/runner Docker targets built successfully; Linux type check, build and production dependency audit passed.
- 25 tests total: **24 passed, 1 skipped, 0 failed**. The only skip was the Windows-only Runner death / Job Object check; the same check passed on Windows locally.
- Compose started healthy, `/health` returned version **0.2.0**; unauthenticated `/mcp` returned 401; the container's actual UID was 1000.
- After deployment, pairing and scoped PAT issuance completed; with Compose down/up retaining the data volume, real official v2 Clients using fixed `2026-07-28` and legacy modes listed tools / called `list_devices`, and devices and credentials remained valid.
- At the end, the independent Compose project's containers and volumes were empty; only `.env` and `smoke-state.json` in this independent test directory were deleted, credential-free build/test logs were kept, and nothing else on the machine was modified.

The v0.1 results below are retained as a historical record.

## Windows Local Machine

Environment: Windows, Node.js 24.14.1, npm 11.12.1, Git. Executed:

```text
npm run check
npm run build
npm test
npm audit --omit=dev --audit-level=high
```

v0.1's 14 test groups covered:

1. One-time pairing approval/claim/replay prevention, real SDK initialize/tools/list/tools/call.
2. Multi-device routing ambiguity rejection, device/project/scopes limits, pause/resume/revoke, token revocation and content not entering audits.
3. OAuth discovery, DCR, PKCE, browser authorization state, resource binding, single-use code, refresh rotation and replay revocation.
4. Credentials still valid after Server restart, the original Runner's long job continuing and its full result readable.
5. HTTP URL and config rejection rules, result size limits after transport escaping.
6. Stable pagination of audit records within the same millisecond.
7. WS authentication, hello readiness, cross-device forged result rejection and call cancellation.
8. File write/append/paging/move/search/exact edit, stale SHA rejection, read-only permission.
9. Escape, symlink/Windows junction, hard link, Windows ADS and reserved-name rejection.
10. stateDir and project isolation.
11. Process allowlist, argv, different-principal isolation, output truncation and completion record persistence.
12. stdin, whole-tree termination, observable timeout.
13. Git status/diff/log/add/commit, write disabled and direct/indirect configured clean/process filter rejection.
14. Concurrent launches not exceeding the local process limit.

The production dependency npm official advisory check reported **0 known vulnerabilities**; this only reflects the registry's known-vulnerability result at that time and does not mean no unknown vulnerabilities exist.

Also through the compiled CLI and Chrome 155, a real browser flow ran: login → pairing code verification/approval → Windows Runner credential save → Runner online → scoped PAT created → `/mcp` file write/read and process launch. Desktop 1440px and mobile-simulated 390px layouts were checked with no horizontal overflow; the mobile table scrolls within its own container. The final page console had no error/warn. The one-time-display PAT was hidden after refresh.

Browser verification found and fixed the `Referrer-Policy: no-referrer` issue causing form Origin=null, and the auto-refresh replacing the device selection control. A same-origin policy is now used without relaxing cross-Origin validation.

An online backup of the running test SQLite was performed with `scripts/backup.mjs`. Production restore still needs rehearsal in your own storage and permission environment.

## Linux and Docker Machine

Run on a temporary Linux x86_64 machine in an independent directory, using the v0.1.0 committed source baseline; the release contains none of the then-private config, databases, access credentials or test-machine information.

Environment: Docker Engine **29.8.2**, Compose **5.6.0**, test container Node.js **24.22.1**.

- Both Dockerfile relay and runner targets actually built successfully.
- With dev dependencies installed in the runner image, `npm run check`, the same **14/14** tests and production dependency audit all passed.
- An independent Compose project started a non-root Server with a passing health check; `/health` returned `{"status":"ok","version":"0.1.0"}`.
- Unauthenticated `/mcp` returned 401.
- Admin login, pairing approval/claim and scoped PAT creation completed through the deployed HTTP API.
- After `docker compose down` without deleting volumes, then `up --wait`, the original device record and client credentials were still readable via MCP `list_devices`.
- The container's actual `process.getuid()` was **1000**.
- Finally the Compose project created for this test was stopped and its test volumes deleted, and no containers for that test project remained; nothing else on the machine was deleted or changed.

The first manual probe of a non-default mapped port used a Host different from `PUBLIC_URL` and returned 403 by config; using `PUBLIC_URL`'s `localhost` passed. This is the expected Host boundary; the reverse proxy must preserve the configured domain.

## Acceptance Still Outstanding

The repository now provides Linux/Windows CI and Docker build / Compose health-check workflows (`.github/workflows/ci.yml` and `release.yml`) with push/PR triggers, plus source archives and npm tarballs up to v0.4.21 under `release/`. However, the following environment acceptance is still outstanding:

- No interactive acceptance was performed with a real ChatGPT, Claude or Cursor account. Client docs reference official guides found on 2026-10-26; the protocol and OAuth chain use real SDK and HTTP/WS automated tests.
- Linux systemd and Windows Task Scheduler install/uninstall and reboot persistence have not been executed, to avoid modifying login tasks and services on test or development machines.
- Domain names, certificates, reverse proxies and the optional Cloudflare Tunnel still need verification in the final deployment environment.
- The local validation record above does not stand in for a CI run on the public repository; observe actual Linux, Windows and Docker CI results after the first push.

## Release Boundaries

This is an initial version containing practical features, a permission policy, operations files and automated verification. There is no independent security audit, long-duration stress test, multi-tenancy or full OS sandbox. Facing a malicious repository or untrusted commands, use a dedicated system account or a container/VM; do not expose production credentials in a high-privilege everyday account.

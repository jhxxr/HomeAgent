# HomeAgent

[简体中文](README.md) · English

**MIT licensed · v0.3.0 early release · Linux / Windows · Self-hosted**

HomeAgent connects an MCP client to development projects on your own machines.
The relay authenticates and routes requests; runners connect outbound over
WebSocket and execute authorized file, command and Git operations locally.
Runners do not open inbound ports.

The execution system does not require a model API key, hosted relay, telemetry or
paid cloud service. Tool results are still sent to the AI client you choose.

```text
AI MCP client
  │ HTTPS /mcp + OAuth or scoped token
  ▼
HomeAgent relay ── Dashboard / SQLite / audit
  ▲
  │ authenticated outbound WSS
  │
Linux or Windows runner
  ├─ project policy → file/search/edit tools
  ├─ local allowlist → commands and tracked jobs
  └─ Git → inspect, review and commit selected files
```

## What works

- Official MCP SDK HTTP serving for 2026-07-28 and legacy 2025 clients.
- One-time pairing, revocable device credentials, scoped personal tokens and
  OAuth authorization-code flow with S256 PKCE.
- Single-admin Dashboard for devices, projects, jobs, browser sessions, tokens
  and audit records.
- 32 tools covering project context, line-based batch reads, bounded search,
  strict unified diffs, journaled multi-file edits, commands and Git.
- Short-command responses, waitable long jobs, idempotent starts, bounded prefix
  and rolling-tail output.
- Local command aliases/environment profiles, selected-file commits preserving
  unrelated staged entries, and explicit linked-worktree configuration.
- Docker Compose, Caddy/Nginx examples, optional Cloudflare Tunnel and native
  runner service installers.

This is an early self-hosted release, not a claim of feature parity with WebCodex
or an independently audited operating-system sandbox. Persistent shells/PTY,
detached tasks surviving runner replacement, automatic worktree registration,
preview tunnels and a full workflow-session system are not implemented.

## Quick start

Requirements: Node.js 24 LTS (minimum 24.14; `.nvmrc` specifies the checked patch
version), npm and Git. Docker Compose is an alternative for the relay.

```sh
npm ci
npm run build
npm run init
npm run server
```

Open `http://localhost:3210`. Read `ADMIN_PASSWORD` from the generated local `.env`;
the initializer does not print it.

Copy `runner.example.json` into a private directory such as
`~/.homeagent/runner.json` and set the project's absolute root path. Both the
configuration file and runner state must be outside every shared project root.
On Windows, JSON paths can use forward slashes.

```sh
npm run runner -- pair --config /absolute/private/runner.json
# Sign in to the Dashboard, verify the device name and approve the displayed code.
npm run runner -- run --config /absolute/private/runner.json
```

Replace the configuration path with your own. Commands and aliases are disabled
by default. Enable only the executables or local aliases you intend to expose;
Git writes also require `allowGitWrite` and the client's `git` scope.

Connect the client to `/mcp` using OAuth or a Dashboard-issued token. Remote
deployments require a fixed HTTPS origin. The same endpoint serves modern and
legacy protocol clients.

## Typical development workflow

1. `list_devices` and `get_project_context`.
2. `search_files` and `read_files` for relevant code and full-file hashes.
3. `edit_files` or `apply_unified_diff` with explicit expected hashes.
4. `run_command`, then `wait_process` for long executions.
5. `git_diff`, `git_branches` and `git_commit_paths`.
6. `save_project_note` for a bounded handoff to the same client identity.

Multiple online devices require an explicit `deviceId`. Machine tools also
require `projectId`. A job UUID is an identifier, not permission to access it.

## Documentation

Detailed operational documents are currently in Chinese; the examples use the
same command and configuration names on all platforms.

| Document | Purpose |
| --- | --- |
| [Documentation index](docs/README.md) | All guides |
| [Deployment](docs/DEPLOYMENT.md) | Docker, proxies, pairing, services and backups |
| [Client setup](docs/CLIENTS.md) | ChatGPT, Claude, Cursor and SDK clients |
| [Development workflow](docs/DEVELOPMENT_WORKFLOW.md) | Tools, profiles, recovery and known limits |
| [Tool reference](docs/TOOLS.md) | Arguments, scopes and admin endpoints |
| [Architecture](docs/ARCHITECTURE.md) | Protocol and persistence |
| [Security](SECURITY.md) | Trust boundaries and reporting |
| [Validation](docs/VALIDATION.md) | Tests performed and unverified environments |
| [Source audit](docs/WEBCODEX_CODE_AUDIT.md) | Explicit differences from WebCodex |

## Development

```sh
npm ci
npm run verify
npm run notices:check
npm audit --omit=dev --audit-level=high
```

Tests use temporary directories and local HTTP/WebSocket servers. Python is
optional; its workflow test reports a skip if no interpreter is available.
See [CONTRIBUTING.md](CONTRIBUTING.md) for environment details.

## Security and license

An allowed interpreter, shell or build tool runs with the runner account's
permissions. File-root checks constrain built-in file tools; they do not sandbox
arbitrary code. Use a dedicated low-privilege account or container/VM.

Original source is available under the [MIT License](LICENSE). Dependencies retain
their own terms in [third-party notices](THIRD_PARTY_NOTICES.md). The public npm
package is named `homeagent-mcp`; an explicit file list includes compiled CLIs,
Dashboard assets, Windows helpers and license notices.

See [release preparation](docs/OPEN_SOURCE.md) to generate a reviewed source
archive. Nothing in the release commands automatically publishes or pushes it.

After the first npm publication:

```sh
npm install -g homeagent-mcp
homeagent init-runner
# Edit ~/.homeagent/runner.json, then use your actual private configuration path:
homeagent-runner pair --config /absolute/private/runner.json
homeagent-runner run --config /absolute/private/runner.json
```

Use `homeagent init` and `homeagent-server` for a native Server, or Docker Compose.
Initialization never overwrites an existing configuration.

The GitHub `release` workflow publishes npm and GitHub Release assets on matching
`vX.Y.Z` tags after Linux/Windows/Docker and installed-package checks. Configure
the repository's `NPM_TOKEN` Actions secret for token publishing. Prereleases use
the npm `next` tag; stable versions use `latest`. Existing npm versions must match
the verified tarball integrity to resume a failed GitHub Release. See the release
guide for required token permissions and migration to OIDC trusted publishing
with the `NPM_AUTH_MODE=oidc` repository variable.

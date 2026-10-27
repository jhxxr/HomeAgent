# HomeAgent

[简体中文](README.md) · English

**MIT licensed · v0.4.1 · Linux / Windows · Self-hosted**

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
  └─ Git → inspect, review, commit, fetch, pull and push
```

## What works

- Official MCP SDK HTTP serving for 2026-07-28 and legacy 2025 clients.
- One-time pairing, revocable device credentials, scoped personal tokens and
  OAuth authorization-code flow with S256 PKCE.
- Single-admin Dashboard for devices, projects, jobs, browser sessions, tokens
  and audit records.
- 35 tools covering project context, line-based batch reads, bounded search,
  strict unified diffs, journaled multi-file edits, commands and Git.
- Short-command responses, waitable long jobs, idempotent starts, bounded prefix
  and rolling-tail output.
- Local command aliases/environment profiles, selected-file commits preserving
  unrelated staged entries, and explicit linked-worktree configuration.
- Docker Compose, Caddy/Nginx examples, optional Cloudflare Tunnel and native
  runner service installers.
- Dashboard-managed device limits, per-client tool grants and temporary
  elevation with automatic expiry and managed-job cancellation.

This is an early self-hosted release, not a claim of feature parity with WebCodex
or an independently audited operating-system sandbox. Persistent shells/PTY,
detached tasks surviving runner replacement, automatic worktree registration,
preview tunnels and a full workflow-session system are not implemented.

## Quick start

`homeagent-mcp@latest` is available on npm. The same package provides the Server and
Runner commands; install them on the relay server and the development machines
you want to control, or try both locally first.

| Environment | Deployment |
| --- | --- |
| Linux server for continuous use | Docker Compose, your own domain and Caddy HTTPS |
| Existing Node.js installation or local evaluation | npm and `homeagent-server` |
| Existing Nginx / Caddy | Keep the Server on loopback and use your reverse proxy |

Follow this order: **start the Server → open the Dashboard → pair a Runner →
connect your AI client to `/mcp`**. The Server uses built-in SQLite and does not
need a separate database service.

### 1. Deploy the Server

**Option A: Docker Compose with Caddy for a public Linux server.**

Install Docker Engine, Compose v2 and Git. Point your domain at the server and
allow inbound TCP ports 80/443. Replace `mcp.example.com` below with your domain.

```sh
git clone --branch v0.4.1 --depth 1 https://github.com/jhxxr/HomeAgent.git
cd HomeAgent

# Generate random secrets without installing Node.js on the host.
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  node:24.22.1-bookworm-slim node scripts/init.mjs
```

Edit the generated `.env`. Keep its random `ADMIN_PASSWORD` and `SESSION_SECRET`;
change or add:

```dotenv
PUBLIC_URL=https://mcp.example.com
DOMAIN=mcp.example.com
TRUST_PROXY_HOPS=1
```

```sh
docker compose --profile proxy up -d --build
docker compose --profile proxy ps
docker compose logs --tail=100 server
curl --fail https://mcp.example.com/health
```

Caddy obtains the certificate and proxies HTTP/WebSocket connections. Open
`https://mcp.example.com` and sign in with `ADMIN_PASSWORD` from `.env`. Port
`3210` is bound only to the host's loopback interface; it does not need public
access. Images build locally from source.

SQLite persists in the `server-data` named volume, and Compose configures
`restart: unless-stopped`. Back up the database and `.env` before upgrades,
retain `SESSION_SECRET`, and use ordinary restarts without deleting volumes.
See [deployment](docs/DEPLOYMENT.md) for backups, restore and an existing Nginx.

**Option B: npm on Linux / Windows or an existing Node.js server.**

Use Node.js 24 (minimum 24.14.0; `.nvmrc` contains the checked patch version)
and npm. These commands work in a Linux shell or Windows PowerShell:

```sh
npm install -g homeagent-mcp@latest
mkdir homeagent-server
cd homeagent-server
homeagent init
homeagent-server
```

Open `http://localhost:3210`. The generated `.env` contains `ADMIN_PASSWORD`;
initialization does not print the password or overwrite an existing file.
The database defaults to `data/server.sqlite` in this directory.

For public access, set `PUBLIC_URL` in `.env` to your fixed HTTPS origin. Set
`TRUST_PROXY_HOPS=1` for one trusted proxy and proxy Nginx/Caddy to
`127.0.0.1:3210`. The command runs in the foreground and reads `.env` from its
**current working directory**. Use a service manager for continuous operation;
a Linux user systemd example is in [native Server deployment](docs/DEPLOYMENT.md#原生部署-server).

### 2. Install and pair a Runner

Install Node.js 24 and npm on the development machine. Git operations also need
a local Git installation. The recommended flow is the interactive login:

```sh
npm install -g homeagent-mcp@latest
homeagent login
```

The terminal asks for the Web URL, device name and first project directory
(defaulting to the current directory), creates the private
`$HOME/.homeagent/runner.json`, and prints a browser approval link valid for
10 minutes:

```
Open the link in a browser already signed in to the Dashboard.
```

Confirm the device name in the browser and approve it. The Runner then claims
its credential automatically. Use the Dashboard's “设备与项目” section to add
more projects and configure read-only, command and Git permissions. The link
requires an existing administrator browser session; if it expires, run
`homeagent login` again.

```sh
# Add --run to start the foreground Runner after login:
homeagent login --run
# Or start it separately:
homeagent-runner run --config "$HOME/.homeagent/runner.json"
```

Windows project paths can use forward slashes, such as `E:/Projects/my-app`.
Both the configuration and state directory must be outside every exposed
project. To provide values up front, use
`homeagent-runner login --server https://mcp.example.com --project E:/Projects/my-app`.
The manual `homeagent init-runner`, `pair` and `run` commands remain available
for hand-maintained JSON configurations.

For automatic startup, finish pairing and stop the foreground Runner, then run
`homeagent-runner service-install --config "$HOME/.homeagent/runner.json"`.
Linux installs a user systemd service; Windows installs a current-user login
task. This command manages the Runner only, not the Server.

Command execution and Git writes are disabled by default. Configure local
`commands` or `commandAliases` to enable execution; Git writes also require
`allowGitWrite: true` and the client's `git` scope. Windows `.cmd` wrappers are
not implicitly run through a shell. See the
[development workflow](docs/DEVELOPMENT_WORKFLOW.md) for executable aliases
and environment profiles.

With `allowRemotePermissions: true` (the default in new Runner templates), the
Dashboard can edit the device policy and existing PAT/OAuth grants. Device
policy controls the upper limit; client grants separately control devices,
projects, scopes, individual tools, device-wide file access and unrestricted
execution. Either layer can be temporary. Expiration stops managed jobs and
restores the previous policy. Set `allowRemotePermissions: false` to require
local-only policy changes.

### 3. Connect an AI client

| Purpose | Public deployment example |
| --- | --- |
| Dashboard | `https://mcp.example.com` |
| Client MCP endpoint | `https://mcp.example.com/mcp` |
| Runner `server` configuration | `https://mcp.example.com`, without `/mcp` |
| Health check | `https://mcp.example.com/health` |

Use OAuth and approve the device/project permissions in your browser, or issue
a client token in the Dashboard with the intended `read / write / execute / git`
scopes and connect with Bearer authentication. Tokens are shown once; device
credentials are not client tokens.

For a local trial, use `http://localhost:3210`. Remote access requires a fixed
HTTPS origin, and the Server must be hosted at the origin root rather than a
URL subpath. See [client setup](docs/CLIENTS.md) for individual clients.

### Develop from source

Use a source checkout to change the code. npm or Compose handles ordinary
installation:

```sh
git clone https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
npm ci
npm run build
npm run init
npm run server
```

The source Runner commands are
`npm run runner -- pair --config "$HOME/.homeagent/runner.json"` and
`npm run runner -- run --config "$HOME/.homeagent/runner.json"`, with the same
configuration and approval flow.

## Typical development workflow

1. `list_devices` and `get_project_context`.
2. `search_files` and `read_files` for relevant code and full-file hashes.
3. `edit_files` or `apply_unified_diff` with explicit expected hashes.
4. `run_command`, then `wait_process` for long executions.
5. `git_diff`, `git_branches` and `git_commit_paths`.
6. `save_project_note` for a bounded handoff to the same client identity.

For a temporary maintenance task, open the device in the Dashboard, select the
needed project and capability preset, then edit the existing client
authorization if it also needs device-wide files or unrestricted execution.
Revoke the temporary grant early when finished; otherwise its expiry performs
the same cleanup.

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

`v0.4.1` has been published to npm and GitHub Release through GitHub Actions,
with the default install command using npm `latest`.
For subsequent releases, increment the version and update the version files
and changelog before pushing a matching `vX.Y.Z` tag. Configure
the repository's `NPM_TOKEN` Actions secret for token publishing. Prereleases use
the npm `next` tag; stable versions use `latest`. Existing npm versions must match
the verified tarball integrity to resume a failed GitHub Release. See the release
guide for required token permissions and migration to OIDC trusted publishing
with the `NPM_AUTH_MODE=oidc` repository variable.

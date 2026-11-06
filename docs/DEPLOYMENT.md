# Deployment, Pairing, and Operations

**English** · [简体中文](DEPLOYMENT.zh-CN.md)

## Preparation

We recommend Node.js 24.22.1 or a newer 24 LTS patch release, plus Git; the minimum supported version is Node 24.14. A native Server needs no additional database. The container path requires Docker Engine and Compose v2. The Runner is best installed natively on the development machine so it can use the existing compilers and toolchain.

All public traffic must use HTTPS/WSS. The Server's `PUBLIC_URL` must be a stable external origin without a subpath, for example `https://mcp.example.com`. Do not use a temporary tunnel address that changes on every restart as a long-term OAuth issuer.

## Native Server Deployment

### npm installation

The Server and Runner are separate npm packages; no source build is required. The Server package includes the Web Dashboard:

```sh
npm install -g homeagent-server@latest
mkdir homeagent-server
cd homeagent-server
homeagent-server init
```

Edit the `.env` in this directory and keep the generated password and session secret. For local verification use the default `http://localhost:3210`; for public access set `PUBLIC_URL=https://mcp.example.com` and, when there is exactly one trusted reverse proxy, `TRUST_PROXY_HOPS=1`, with the proxy connecting to `127.0.0.1:3210`. Then run:

```sh
homeagent-server
```

The command runs in the foreground and reads `.env` from the current directory; existing environment variables take precedence over the file. The database is written by default to `data/server.sqlite` in the current directory, so the service manager must set a fixed working directory. The install and launch commands are identical on Linux and in Windows PowerShell.

### Installing from source

```sh
git clone https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
npm ci
npm run build
npm run init
```

Open `.env` in an editor to see the generated administrator password and to edit `PUBLIC_URL`. For same-machine development keep `http://localhost:3210`; for public deployment set your own HTTPS domain and reverse-proxy to local `127.0.0.1:3210`. A non-loopback HTTP `PUBLIC_URL` is rejected.

```sh
npm run server
```

In production, use your own service manager to run `node dist/server/cli.js` and inject `.env` securely. The npm scripts use Node's `--env-file-if-exists=.env`; invoking `node` directly requires an explicit `--env-file=/absolute/path/.env` or a service environment.

### Linux user systemd service

The following applies to the npm installation method, under the dedicated low-privilege account that runs the Server. First confirm the actual paths:

```sh
command -v node
npm root -g
mkdir -p "$HOME/.config/systemd/user"
```

Create `$HOME/.config/systemd/user/homeagent-server.service`, replacing the three paths below with your real values:

- `WorkingDirectory`: the directory holding `.env`, which must be writable by that account for the database.
- `ExecStart` first path: the output of `command -v node`.
- `ExecStart` second path: `homeagent-server/bin/server.mjs` under the `npm root -g` output directory.

```ini
[Unit]
Description=HomeAgent MCP relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/homeagent/homeagent-server
ExecStart=/absolute/path/to/node /absolute/global/node_modules/homeagent-server/bin/server.mjs
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
```

When a path contains spaces, wrap each `WorkingDirectory` and `ExecStart` path in the double quotes supported by systemd; a unit cannot rely on shell `~` or variable expansion.

```sh
systemctl --user daemon-reload
systemctl --user enable --now homeagent-server
systemctl --user status homeagent-server
journalctl --user -u homeagent-server -f
```

To keep running after logout and to start at boot, an administrator should run `sudo loginctl enable-linger <service-account>` for that account. After updating the npm package, run `systemctl --user restart homeagent-server`. For long-running Windows deployments use your own service/process manager with the same fixed working directory; `homeagent service-install` installs Runner autostart only, not a Server service.

## Docker Compose

Check out the release source on a server with Docker Engine, Compose v2 and Git:

```sh
git clone --branch v0.4.21 --depth 1 https://github.com/jhxxr/HomeAgent.git
cd HomeAgent
```

On a Linux host you can generate `.env` through a container without Node.js on the host; the file is created with the current UID/GID so it is not owned by root and uneditable by a normal account:

```sh
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/work" -w /work \
  node:24.22.1-bookworm-slim node scripts/init.mjs
```

If the host already has Node.js, run `node scripts/init.mjs` directly. Initialization never overwrites an existing `.env`. Start in default local mode:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 server
```

By default only `127.0.0.1:3210` is mapped to the container; the plaintext port is never exposed directly to the public internet. SQLite lives in the `server-data` named volume. The Server runs as non-root with a read-only root filesystem, only the database volume and temp directory writable, and all Linux capabilities dropped.

The image contains compiled production dependencies and Dashboard static assets; runtime needs no npm, third-party API or build service. Building the image requires access to package and image registries; offline environments can build on a connected host, export the image and import it.

### Automatic TLS with Caddy

Point the domain A/AAAA records at your Server and open ports 80/443. In `.env` set:

```dotenv
PUBLIC_URL=https://mcp.example.com
DOMAIN=mcp.example.com
TRUST_PROXY_HOPS=1
```

```sh
docker compose --profile proxy up -d --build
```

Caddy automatically provisions TLS and proxies HTTP and WebSocket traffic. Both the Server and the Runner use the same domain; the Runner points to `https://mcp.example.com`. The client MCP URL is `https://mcp.example.com/mcp`.

### Existing Nginx

See [deploy/nginx.conf](../deploy/nginx.conf) and configure certificates yourself. `Host` must remain the external domain; WebSocket upgrade must be supported and proxy buffering disabled. Set `TRUST_PROXY_HOPS=1` to the real number of trusted proxies and never trust arbitrary `X-Forwarded-For` unconditionally.

### Optional Cloudflare Tunnel

This is an optional deployment that routes traffic through Cloudflare; for a fully self-controlled setup use your own server and reverse proxy.

In an existing named Tunnel, configure a fixed hostname `mcp.example.com` targeting `http://server:3210` (the cloudflared container shares the Server network). In `.env` set:

```dotenv
PUBLIC_URL=https://mcp.example.com
TRUST_PROXY_HOPS=1
CLOUDFLARE_TUNNEL_TOKEN=your-named-tunnel-credential
```

```sh
docker compose --profile cloudflare up -d --build
```

Do not use Cloudflare Access interactive login to intercept `/mcp`, OAuth metadata or `/runner` unless the client explicitly supports the extra authentication. This project does not depend on a tunnel and stores no Cloudflare API credentials in source.

## Runner Configuration and Pairing

On the development machine run `npm install -g homeagent-runner@latest`, then simply `homeagent`. When not logged in, a full-screen welcome page appears; press Enter to enter the Server URL and device name. While waiting for approval press `o` to open the browser; project directories are entered on the web page and stored on the Server. The connection is established automatically after approval. When already logged in, running `homeagent` again goes straight to the run overview, with no need to remember a login or start subcommand. A new Runner's local config holds only connection and runtime settings; `stateDir` holds credentials and job records, with no local project baseline.

Successful login and startup record the absolute config path, so `homeagent` still works after changing the working directory. With `--config` the explicit path wins; otherwise the recorded location is checked first, then `~/.homeagent/runner.json`. If the recorded file was moved or deleted, the full-screen UI keeps an error message and lets the user pick a config, so it never silently connects to another device. Press `s` for Settings to change the device name, concurrency, output and history limits, choose a config, re-login, switch service, toggle autostart and log out; press `a` for Activity, `o` to open the web page, `p` to pause/resume the connection. Changing runtime settings first asks for confirmation, then disconnects, stops hosted jobs and reconnects. Enabling autostart closes the foreground Runner and hands over to the background instance; the service is pinned to the current config path.

The local config contains only connection and runtime settings, for example:

```json
{"server":"https://mcp.example.com","name":"workstation","stateDir":"state"}
```

Project directories, Git permissions, command aliases and environment profiles are all managed on the web page. The local config accepts no project fields or permission switches, and Server and Runner must be upgraded together.

### Dashboard permission management

A Runner has no project permissions on first connect; projects open only after it receives and successfully validates the Server configuration. The Dashboard device editor can set, per project:

- `filesystemScope=project`: built-in file tools may access only the project directory;
- `filesystemScope=device`: device-wide absolute paths are allowed, but Runner configuration, `stateDir` and protected paths are still refused through file tools;
- `commandMode=allowlist`: only `commands` or aliases configured on the web page may run;
- `commandMode=unrestricted`: any executable may run, with privileges equal to the Runner account;
- Three independent switches for local Git writes, network fetch/pull and push.

The client authorization editor separately controls devices, projects, scopes, individual tools, and the visible "Allow all programs" and "Allow device-wide absolute paths" toggles. The device ceiling and the client authorization are intersected, so enabling a device-level capability does not automatically grant it to every client. Editing an existing PAT or OAuth authorization does not require copying the token again.

To use other Python/Conda environments on the machine you need not list every "allowed program": in the device project's "Allowed programs" choose "Allow all programs", and in the client authorization currently in use also check "Allow all programs" (with execute permission enabled). Use an absolute interpreter path such as `D:\Conda\envs\eeg\python.exe` and pass arguments separately in `args`. If the working directory `cwd` lies outside the project, also select device-wide absolute paths in the device project and allow the same capability in the current client authorization. Device-wide file scope does not by itself open all programs.

`list_devices` and `get_project_context` return the effective permissions for the current client; `executionPolicy` and `filesystemPolicy` explain both the device configuration and the client authorization. If `limitedBy=authorization`, edit the current client authorization; if `project`, edit the device project settings. The Dashboard device editor still shows the device configuration ceiling. After saving device settings, wait until the page shows the Runner has applied them before issuing new calls.

Both device and client authorizations support temporary minute-level durations. On expiry the Server increments the revision and cancels in-flight calls; the Runner stops hosted jobs started by that authorization and restores the previous permanent permissions. Permission edits use `expectedRevision`, so a browser with a stale editor gets a conflict instead of overwriting newer settings. Saving device permissions stops hosted jobs on that device; file edits already made are not rolled back.

Device project settings have a single source: the Server. Clearing all projects revokes access; a disconnect clears the in-memory project list and stops hosted jobs, and the Server re-delivers them on reconnect. The Server accepts only the current Runner protocol.

Interactive login flow:

1. Run `homeagent`, press Enter on the full-screen welcome page to log in, and enter the service address and device name; a private config is created and a pairing is created over outbound HTTPS.
2. The full-screen waiting page shows a 10-minute browser link and a fallback 10-character one-time code; press `o` to open the browser, Esc to cancel, Ctrl+C to exit.
3. In a browser already signed in to the Server Dashboard, open the link, verify the device name, enter the absolute directory of the hosted project and approve; projects can also be configured later in the Dashboard. The fallback code flow remains available.
4. The Runner uses its own independent `pollToken` to claim the long-lived device credential. Neither the code, nor the pollToken, nor the browser approval credential can be used to obtain another device's credential.
5. Credentials are saved to `stateDir/device.json`; on Linux the directory is 0700 and files 0600, on Windows the CLI sets a restricted ACL for the current account and SYSTEM. Pairing and running share the same `stateDir` mutex; stop a running instance before re-pairing.
6. After login the run overview appears automatically; the Dashboard should show the device online and its registered projects, with the effective directories in Recent Activity. On subsequent runs, just `homeagent`.

Use `homeagent check-config` to inspect local connection settings, the Runner version and runtime settings only. The terminal shows the actually applied directories after receiving the Server configuration.

On startup or login the terminal prints `HomeAgent Runner v<version> · Node <version> · <platform>/<arch>`; the Server prints its own version on startup. The interactive terminal (`homeagent`) uses a separate full-screen view that temporarily hides shell history and shows the app icon, device and runtime details, recent activity, connection status and reconnect countdown; the layout adapts on window resize and the original screen and cursor are restored on exit. Services, redirected output or `--plain` still use ordinary logs, and `NO_COLOR` or non-truecolor terminals fall back to a monochrome UI. The Dashboard header and footer show the Server version, "Connection & Security → Version Info" lists the Server, Runner protocol and each device's reported Runner version, and flags Runners that differ from the Server. `GET /health` and `GET /api/state` also return version fields for deployment scripts. `HOMEAGENT_TUI=0` (or `plain`) disables the interactive view; `HOMEAGENT_TUI=1` can enable it in a CI interactive terminal, but piped output and `TERM=dumb` always use plain logs.

If pairing times out or the claim response is lost, restart from the UI; an old pairing never returns a long-lived plaintext credential. Esc cancels pairing, terminates polling and releases the state-directory lock. Re-login or switching services asks for confirmation first, and cancelling keeps the existing login; switching services uses a separate credential directory. Logging out deletes only the local credentials of the chosen config and does not automatically revoke the Server's device record; revoke old devices in the Dashboard. The non-interactive `login` still refuses to overwrite existing credentials by default; only an explicit `homeagent login --force` replaces them.

After a Server domain change, existing credentials never silently connect to another origin: explicit re-pairing is required. Changing local connection settings requires restarting the Runner; web project and command policies are delivered live and are not modified through MCP tools.

### Environment variables

`HOMEAGENT_SERVER` can override the connection address. Project directories are not configured through environment variables; save project settings in the Dashboard for live delivery.

`HOMEAGENT_MOUSE=0` disables mouse tracking in the full-screen UI by default. Terminals with SGR mouse support allow clicking menus, footer buttons, the login entry and input boxes by default, and the wheel can scroll long menus and activity; outside input boxes press `m`, or click the mouse toggle button, to temporarily disable tracking for selecting/copying text. Keyboard and mouse share the current layout's control positions, which are recomputed after resize and menu scrolling; mouse tracking and bracketed paste are turned off on exit.

### Autostart

After pairing, stop the manually running Runner and install the service:

```sh
homeagent service-install
homeagent service-uninstall
```

On Linux this creates `~/.config/systemd/user/homeagent-<config-digest>.service` using user systemd, with no root required. To keep running after logout and at boot, explicitly run `sudo loginctl enable-linger <username>` as printed by the installer. Logs: `journalctl --user -u homeagent-<digest>.service -f`.

On Windows it creates a logon-triggered scheduled task named `HomeAgent-<config-digest>` running with least privilege, with no password stored in a system service. It starts "after user logon", not "at system boot with no user logged in". If unattended startup is required, an administrator should configure a service manager for a dedicated low-privilege account; this project never elevates privileges automatically. Check status with `Get-ScheduledTask -TaskName 'HomeAgent-*'`. Before upgrading or restarting, stop the old process for the same config so two Runners do not replace each other's connection.

Service installation starts immediately; do not also start the same device credentials manually. Do not keep an old service path after moving the source location.

Since early versions, a second Runner with the same `stateDir` explicitly refuses to start. On Windows, uninstall ends the scheduled task before deleting it; `CLI --version` shows version/Node/platform, and `homeagent check-config` inspects config without printing the device token. The Windows task relies on system PowerShell/.NET Add-Type; if organizational policy blocks it, the task fails closed and never auto-applies `ExecutionPolicy Bypass`.

Windows child processes explicitly use the system PowerShell module directory by default, avoiding module-discovery stalls caused by filtered environments and excluding user/project module load hooks. Source maintainers can run `node --import tsx scripts/diagnose-windows.mjs` to check supervisor startup with the real Runner environment functions; development dependencies are required first. That check prints only startup status and the output of a fixed test command. This is the current v0.4.18 behavior for persistent Windows PowerShell shell sessions.

### Container Runner (Linux, optional)

A native Runner suits an existing full development environment better. For isolation you can also build the runner target:

```sh
docker build --target runner -t homeagent-runner:local .
```

Set the local config's `stateDir` to `/state`, set the project root to `/workspace` in the Dashboard, mount only the actual project at `/workspace`, mount a state volume at `/state`, and mount the config read-only at `/config/runner.json`. The container UID/GID must have the right permissions on the mounts (the image defaults to the `node` user, UID 1000); never mount the Docker socket or the entire host root.

```sh
docker run --rm -it \
  --mount type=bind,src=/absolute/config/runner.json,dst=/config/runner.json,readonly \
  --mount type=bind,src=/absolute/project,dst=/workspace \
  --mount type=volume,src=homeagent-runner-state,dst=/state \
  homeagent-runner:local login --config /config/runner.json
```

After pairing, run `run --config /config/runner.json` with the same mounts and `--init --restart unless-stopped -d`; the run phase does not need `-it`. The image contains only Node, Git and CA certificates; build a derived image for other compilers.

## Configuration Reference

| Server environment variable | Default / requirement |
| --- | --- |
| HOST / PORT | `127.0.0.1` / `3210`; inside the Compose container `0.0.0.0:3210` |
| PUBLIC_URL | Fixed origin, no subpath, HTTPS required for public access |
| ADMIN_PASSWORD | Admin password, at least 16 characters; required when XAuth is not configured, or optional alongside XAuth |
| XAUTH_ISSUER | Optional [XAuth](https://github.com/jhxxr/XAuth) OIDC issuer origin (e.g. `https://auth.example.com`, no subpath) |
| XAUTH_CLIENT_ID | Optional XAuth OIDC client ID paired with `XAUTH_ISSUER` |
| XAUTH_CLIENT_SECRET | Optional client secret for a confidential (`web`) XAuth client |
| SESSION_SECRET | Required, at least 32 characters; also protects session signing and OAuth client secrets |
| HOMEAGENT_DB | `./data/server.sqlite`; `/app/data/server.sqlite` in the container |
| TRUST_PROXY_HOPS | 0; set to 1 with one trusted reverse proxy |
| AUDIT_RETENTION_DAYS | 90, range 1–3650 |

### XAuth Admin Single Sign-On (Optional)

The Web Dashboard supports administrator sign-in via a self-hosted [XAuth](https://github.com/jhxxr/XAuth) OIDC provider:

1. Register a client in XAuth with the redirect URI `<PUBLIC_URL>/login/xauth/callback` (e.g. `https://mcp.example.com/login/xauth/callback`).
2. Set `XAUTH_ISSUER` and `XAUTH_CLIENT_ID` (plus `XAUTH_CLIENT_SECRET` for a confidential client) in `.env`. Leave `ADMIN_PASSWORD` empty to enforce XAuth-only login, or keep `ADMIN_PASSWORD` set to allow both methods.
3. **Sole-administrator account binding**: The first XAuth account (`sub`) to sign in is permanently bound in SQLite as the sole administrator for the workspace; any subsequent XAuth account with a different `sub` is rejected (`403`).

## Pause, Revoke, and Backup

The Dashboard "Pause" action closes the connection and stops the Runner's hosted jobs; subsequent calls are rejected immediately. After "Resume" the Runner reconnects automatically. "Revoke" invalidates the long-lived device token and stops reconnection; using the device again requires pairing. Revoking a client token revokes the whole token family; revoking an OAuth client also prevents further authorization exchanges.

Use the SQLite backup API for online backups; do not copy a WAL database file that is being written:

```sh
node scripts/backup.mjs ./data/server.sqlite /safe/backups/homeagent.sqlite
```

In Docker, call the same API directly:

```sh
docker compose exec server node --input-type=module -e "import {DatabaseSync,backup} from 'node:sqlite'; const db=new DatabaseSync('/app/data/server.sqlite'); await backup(db,'/app/data/backup.sqlite'); db.close();"
docker compose cp server:/app/data/backup.sqlite ./homeagent-backup.sqlite
```

Beyond the Server database backup, also store `.env`'s `SESSION_SECRET` and each Runner's `stateDir` and original config securely. Do not place backups inside an exposed project root. Backups contain hashes of persistent credentials and encrypted OAuth client data and must still be treated as sensitive.

Before restoring, stop the Server, replace the database with the backup, and remove the old `server.sqlite-wal` and `server.sqlite-shm` as well (only after confirming the service is stopped and the path is correct), then restore the same owner and permissions. For containers, copy the backup back to `/app/data/server.sqlite` in the named volume and ensure the `node` user can read/write it. Do not use a new-version database directly with an old-version program; back up before upgrading and verify on a copy first.

The current schema version is `PRAGMA user_version=1`; this release only creates missing tables and does not claim support for arbitrary cross-version migrations.

## Troubleshooting

- `/health` unreachable: check the listening port, container health, Host forwarding and `PUBLIC_URL`. With non-default port mappings use the hostname configured in `PUBLIC_URL`; for example, when configured as `localhost` do not switch to `127.0.0.1` on the mapped external port, since strict Host validation may return 403.
- Dashboard API 403: refresh the page for a fresh CSRF token; make sure the browser domain matches `PUBLIC_URL`.
- MCP 401: confirm the client token has not expired or been revoked, or redo OAuth; a device token cannot be used as an MCP token.
- Runner 401: the device was revoked, credentials do not match, or the Server origin changed; never automatically send credentials to a redirect target.
- Runner paused: the Server returns 403 and the Runner backs off; it should come back online after the device is resumed.
- Dashboard job shown as unconfirmed/missing: offline-unconfirmed or not yet reported by a new snapshot; it does not mean success, and an old `processId` cannot be used to read or stop a job on another instance.
- Legacy v0.1 OAuth upgrade: old grants are not silently rewritten; revoke and re-authorize to enable concrete device/project scopes. After upgrading the Server, upgrade the Runner too for job snapshots, idempotency keys and process-tree supervision.
- Multi-device call failures: call `list_devices` first and fill in `deviceId` and `projectId` explicitly.
- Command denied: check that the project `commands` contains the exact executable string and that the client has `execute` scope.
- Git write denied: check the `git` scope, `allowGitWrite`, an independent repository root, Git identity and clean/process filters.
- `node:sqlite` ExperimentalWarning: a runtime notice from Node 24's built-in API, not a startup failure; production should still pin and test a Node patch release.

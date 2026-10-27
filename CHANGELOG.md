# Changelog

## 0.4.1 — Interactive Runner login and Dashboard refresh

### Runner login and Dashboard

- Add interactive Runner login with automatic private configuration creation,
  short-lived browser approval links and a fallback one-time pairing code.
- Refresh the Dashboard with a responsive monochrome layout, section navigation,
  clearer status cards and more consistent controls.

## 0.4.0 — Web-managed device and client permissions

### Permissions and control plane

- Add Dashboard editors for device capability limits and existing PAT/OAuth
  authorization grants; credentials do not need to be copied again.
- Add device-wide file access and unrestricted executable modes as separate
  explicit grants. The Runner still protects its configuration and private
  state from built-in file tools.
- Add temporary device and client permissions with expiry, revision checks,
  automatic task cancellation and restoration of the previous policy.
- Add per-tool authorization filtering and live `tools/list` updates.
- Reject stale or incompatible Runner connections when a stored remote device
  policy cannot be safely applied; provide a local-policy recovery path.
- Persist permission changes, expiry and application failures in the existing
  audit and Dashboard state.

### Git and packaging

- Add controlled `git_fetch`, fast-forward-only `git_pull` and separately
  enabled `git_push` for configured HTTPS/SSH remotes, including nested
  repositories.
- Add permission protocol negotiation, Runner acknowledgements and safe
  cancellation of in-flight calls and managed jobs during policy changes.
- Expand npm packaging and installation checks for the permission Dashboard
  asset.

## 0.3.1 — OAuth consent callback fix

- Fix browser authorization appearing unresponsive when the form's redirect to
  an external client callback is blocked by `form-action 'self'`.
- Complete the form navigation on the Server, then return to the registered
  callback through a same-origin completion page with a manual link fallback.
- Show submission progress and prevent double clicks while preserving the
  submitted allow/deny decision.
- Make identical consent retries return the same completion receipt for the
  same browser session, without issuing additional authorization codes.
  Callback URLs are encrypted at rest; codes remain short-lived and single-use.
- Preserve selections on validation errors, display actionable expiration
  messages and recheck client revocation before granting access.
- Expand Chinese/English deployment instructions for npm, Compose, HTTPS,
  Runner pairing and native Server service management.

## 0.3.0 — Initial public release

### Remote MCP

- Self-hosted relay with authenticated outbound WebSocket runners.
- Official MCP SDK serving both 2026-07-28 and legacy 2025 HTTP clients.
- Single-admin Dashboard, device pairing/revocation, OAuth with PKCE and scoped
  personal tokens.
- Project authorization, local policy, bounded outputs and tool audit records.

### Development workflow

- 32 MCP tools for project context, file/search/edit, commands, jobs and Git.
- Line-based batch reads, strict unified diffs and journaled multi-file edits.
- Local command aliases/environment profiles and short-command responses.
- Waitable jobs, idempotent starts, bounded prefix and rolling-tail logs.
- Selected-file commits that preserve unrelated staged entries; explicit linked
  worktree configuration.
- Project handoff notes and Runner job reconciliation.

### Deployment and validation

- Docker Compose, Caddy/Nginx examples and optional Cloudflare Tunnel.
- Linux user service and Windows login-task installers.
- Linux/Windows integration tests and reproducible Node/Python coding scenarios.
- Public npm packaging with `homeagent`, `homeagent-runner` and
  `homeagent-server` commands, safe configuration initialization and isolated
  installation checks.
- Version-tag automation for verified npm tarballs and GitHub Release assets,
  token-based npm authentication and optional OIDC trusted publishing.

This is an early self-hosted release. PTY/persistent shells, a detached supervisor,
automatic worktree registration, preview tunnels and a complete workflow-session
subsystem are not implemented. See [the workflow limits](docs/DEVELOPMENT_WORKFLOW.md)
and [validation record](docs/VALIDATION.md).

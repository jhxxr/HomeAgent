# Changelog

## 0.3.0 — Initial public source release

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

This is an early self-hosted release. PTY/persistent shells, a detached supervisor,
automatic worktree registration, preview tunnels and a complete workflow-session
subsystem are not implemented. See [the workflow limits](docs/DEVELOPMENT_WORKFLOW.md)
and [validation record](docs/VALIDATION.md).

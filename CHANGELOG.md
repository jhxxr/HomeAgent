# Changelog

## 0.4.8 — Compact live topology on mobile

- Restore the client → MCP Server → Runner layout on portrait screens, keeping
  the central activity ring, animated call paths and node highlighting visible.
- Simplify mobile node labels while retaining touch-sized targets and direct
  access to complete device and client permission settings.
- Center column titles and management actions, contain status text and scale
  the activity ring to avoid text overlap on narrow screens.
- Refresh the mobile README screenshot and verify layout boundaries at 320,
  390 and 430 pixels alongside the existing management workflows.

## 0.4.7 — Interactive control plane and mobile overview

- Add an interactive client → MCP Server → Runner topology with live audit
  activity, job output shortcuts and direct access to device and client permissions.
- Preserve all six workspace views, search, filters, native confirmations,
  temporary permissions, token management and session controls from v0.4.6.
- Use the project icon consistently, a segmented status bar and a readable
  vertical mobile layout with responsive audit charts and reduced-motion support.
- Derive overview statistics from the bounded Server snapshot and clearly
  distinguish live jobs, unconfirmed observations and synchronization failures.
- Refresh the bilingual README screenshots from an isolated browser demo;
  verify desktop/mobile workflows and include all console assets in package checks.

## 0.4.6 — Web workspace redesign and interaction improvements

- Rebuild the Web Dashboard as a responsive workspace with separate overview,
  device, job, client access, audit and session views.
- Add device search, state filters, human-readable task status and in-page
  confirmations with keyboard focus restoration.
- Preserve project selections, filters and task output during background refresh;
  retain the last available data when a connection fails.
- Clarify project permissions, selection counts and temporary-access duration in
  the permission editors.
- Refresh login and OAuth consent screens, add password visibility controls and
  inline feedback, and synchronize selected devices with available projects.
- Update the Dashboard screenshots and verify the packaged login script.

## 0.4.5 — Project identity, documentation and OAuth UI

- Introduce the blue terminal and orange agent icon across the Dashboard header,
  browser favicon, touch icon and project documentation.
- Refresh the Chinese and English READMEs with a centered project identity,
  package and CI badges, feature overview, architecture diagram and real
  Dashboard, permission-editor and task-output screenshots.
- Refresh OAuth authorization and result screens with grouped permissions,
  clearer project selection and a live authorization summary.
- Remove a stray CSS separator so the consent-page header style applies.
- Include README image assets in both npm packages, and explicitly allow only
  reviewed PNG assets in source release checks with format and size limits.

## 0.4.4 — Runner package publishing and dependency updates

- Publish the Runner as `homeagent-runner`, retaining the `homeagent` command.
  The npm package named `homeagent` belongs to another maintainer; install
  `homeagent-runner` to use this project's Runner.
- Update release validation, package installation checks and installation
  documentation for the available Runner package name.
- Upgrade Docker images to Node.js 26.12.1 and development dependencies to
  TypeScript 7.0.2 and Node.js 26 type definitions.
- Update the pinned GitHub Actions used for checkout, Node.js and Python setup,
  and release artifact upload and download.

## 0.4.3 — Split Server and Runner npm packages

- Publish the Web Dashboard and relay as `homeagent-server`.
- Publish the outbound Runner as the simplified `homeagent` package and
  command.
- Update npm packaging, release verification, Docker packaging and deployment
  documentation for the two-package distribution.

## 0.4.2 — Server-owned Runner configuration and Web permission UX

- Add `homeagent run` and automatic configuration discovery, remembering custom
  locations after successful login or startup.
- Store project paths for new devices on the Server, with an optional initial
  project in browser approval and no project paths in the generated local config.
- Allow a Runner to connect with no local projects; keep project access disabled
  until a Web policy applies and report effective directories in the terminal.
- Remove local project policies, root environment overrides, current-directory
  configuration fallback, the template initializer and manual pairing command.
- Require Runner protocol 2 with a Server policy on every connection. Disconnects
  and policy failures revoke all project access; no local baseline is restored.
- Manage command aliases and environment profiles in the Web permission editor,
  and recover interrupted edits only after Server projects are authorized.

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

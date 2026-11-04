# Remote Assist

**English** · [简体中文](REMOTE_ASSIST.zh-CN.md)

Remote Assist is HomeAgent's temporary connection mode. The device owner needs no administrator account or model API key: they approve 1–16 projects, per-project permissions and a shared duration in their own Runner, and the Runner independently decides whether a request may execute. Ordinary permanent Personal/Work pairings keep their existing behavior.

## Usage Flow

1. The operator first establishes an OAuth/PAT connection in the AI client and grants the required read/write/execute scopes.
2. In the Dashboard under **Devices & Projects → Invite a Friend**, choose that client authorization, the requester's display name, the permissions that may be requested and the maximum duration.
3. After generation, click **Copy connection command** and send it privately to the friend. The command contains the backend domain and a one-time invitation valid for 10 minutes, for example `homeagent assist "https://your-backend-domain/assist#id=…&token=…"`, so the friend does not need to configure a service address separately. The invitation link can also be copied alone; opening it does not consume the invitation. An invitation is a bearer capability: whoever holds it can claim it, not an identity verification of the friend.
4. After the friend installs the Runner, paste the full command into the terminal to enter local approval. The invitation key in the command may remain in terminal history; if you do not want that, run `homeagent assist` and enter the link, or run `homeagent` and choose "Join Remote Assist" in Settings before pasting the link.
5. Add, edit or remove projects in the local project list. The current directory uses manual absolute path input; each project separately selects read-only / file-write and specified programs — for example source code editable, reference material read-only. After finalizing the list, choose a shared duration of 30 minutes / 2 hours / 8 hours and verify each item.
6. Local timing starts immediately after final approval. Once permissions are applied, the bound client calls `list_devices` through the original `/mcp` and starts work with the exact returned `deviceId` and project IDs; no model or client credentials need to change. In the new flow project IDs are generated when the local draft is created and are not fixed to `assist`.
7. Local "Stop now", exit, expiry, disconnect or a change to the bound authorization ends the session for all projects. The list is fixed after approval; adding projects, changing directories or widening permissions requires ending the old session, creating a new invitation and re-approving locally.

The scopes an invitation permits requesting are not the actual execution permissions. The final scope is the intersection of the current client authorization, the invitation/session scopes and the local approval; other clients do not automatically gain permissions because the device appears.

## Local Limits

- 1–16 projects, unique IDs, project-level paths, with private configuration and default exclusions preserved; the Server cannot add roots, remove exclusions or open device-level paths. Duplicate and parent/child overlapping directories cannot be shared.
- Each project is read-only by default. File writes and program execution are confirmed separately; up to 16 programs per project and 64 for the whole session. Programs accept only absolute executable paths installed outside all shared roots, so another writable project cannot replace an approved entry point; arbitrary-program mode, remote aliases and environment profiles are not supported.
- Only controlled read-only Git tools are allowed; Git writes, push, network and external common directories of linked worktrees are not exposed by Remote Assist.
- The local fixed deadline uses monotonic timing and the earliest wall-clock cutoff; Server time changes or a system clock rollback cannot extend it.
- Temporary connections use a separate private state directory, do not overwrite ordinary Runner config/credentials, do not save auto-recoverable approvals and do not install autostart.
- New authorization requires an interactive local terminal; services and non-TTY scripts cannot approve silently. `--plain` changes only the display, not local approval.

## Version Compatibility

The ordinary Runner protocol 2 is unchanged. The new multi-project flow uses `remote-assist-multi-v1` with `/assist/v2/inspect` and `/assist/v2/claim`; the invitation link and connection command are unchanged. A new Runner meeting an older Server explicitly asks for an upgrade, does not downgrade to an ordinary pairing and does not share only the first project. A new Server keeps the legacy `remote-assist-v1` single-project flow; old persisted approval records can still be shown, but ended sessions cannot be resumed.

Web drive/directory pickers and local directory navigation are not integrated; ordinary devices can still enter multiple project paths manually on the web page, and newly added projects still need separate client authorization scope selection.

## Stopping and Observation

Stopping first blocks new operations and queued requests, then cancels calls and cleans up hosted process trees. The UI distinguishes access blocked, job stop confirmed, stop failed and offline-unconfirmed. A cleanup failure cannot restore access; another cleanup can be requested locally.

The Dashboard shows session and job metadata; administrator impersonation cannot bypass local authorization to read assistance content, and output is read by the bound MCP client. The local state directory keeps bounded argument-digest audits and existing job output, and the Activity view shows status. The Server audit is not an administrator-tamper-proof ledger.

## Risks You Must Understand

The Server still authenticates the client and asserts the operator identity. Local authorization limits the Server's execution scope but does not provide end-to-end proof of the requester's identity. Anyone holding the invitation link can claim it, so use a trusted Server and share the link privately.

**Allowing an interpreter or build tool still allows it to use the privileges of the Runner system account.** The program list restricts entry points, not the arguments an AI supplies or the behavior of project scripts; they may access files outside the project, the network, credentials or start external services. For strong isolation use a low-privilege account, container/VM, and cgroup/systemd constraints for Linux force-kill scenarios. A writable project may also trigger existing hot-reload services.

"no model API key" does not mean "no data transfer". Read code, files and execution results go back to the operator's AI client and may enter the chosen model service. Company devices and data must comply with organizational authorization, data policy and AI usage policy.

Revocation cannot roll back completed edits, terminate all external services or take back already-transmitted data. This feature is not an OS sandbox, remote desktop, offline supervisor or multi-tenant system.

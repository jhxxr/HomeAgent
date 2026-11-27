# Agent dispatch and calendar integration

The Server supports project workers and directory-free cloud agents through the
same `/mcp` endpoint. Runner protocol remains **2**; existing v0.4.21 Runners do not
need a protocol upgrade. These changes are server-side and introduce no external
runtime dependencies or destructive SQLite migrations.

## Authorize an Agent

Create a PAT or approve OAuth in the console. Choose an Agent role and binding:

| Field | Values and behavior |
| --- | --- |
| `agentRole` | `worker`, `supervisor`, `observer` (read-only) |
| `bindingMode` | `bound_projects` or `none` |
| `displayName` | Human-readable name; authorization still uses `principalId` |
| `tasks:self` | Inbox, claim, progress, blocking and submission |
| `tasks:dispatch` | Supervisor Agent directory and dispatch |
| `tasks:review` | Supervisor review actions |
| `calendar:read` | Supervisor access to cached personal-calendar context |

Roles and scopes are both required. An observer cannot change tasks or files even
if a write scope was selected. An unbound Agent uses `devices: []` and
`projectGrants: {}`. It cannot discover devices or invoke machine tools, including
by calling hidden names directly. Task assignment grants no filesystem authority.
Changing an existing authorization updates its tools immediately without rotating
the credential. Scope-restricted refresh tokens remain restricted.

Old credentials default to project-bound workers. Legacy write credentials receive
`tasks:self` at read time, never supervisor powers. Old tasks remain in the **`tasks`**
KV bucket, with defaults filled on read; reading does not persist migrations or
renew leases. OAuth consent creates a distinct Agent identity per authorization;
access/refresh rotation preserves that identity. Existing identities remain valid.

## Unified MCP workflow

| Tool | Required permission | Main arguments |
| --- | --- | --- |
| `task_inbox()` | `tasks:self` | None |
| `task_claim` | `tasks:self` | `taskId`, `expectedRevision`, optional `deviceId` |
| `task_update` | `tasks:self` | `taskId`, `expectedRevision`, optional `message`, `actualPaths`, `testJobId` |
| `task_block` | `tasks:self` | `taskId`, `expectedRevision`, `blockReason`, optional `needHuman` |
| `task_submit` | `tasks:self` | `taskId`, `expectedRevision`, optional `aiSummary`, `proposedCommitMessage`, `fileHashes`, `testJobId` |
| `agent_directory()` | Supervisor + `tasks:dispatch` | None |
| `task_dispatch` | Supervisor + `tasks:dispatch` | `title`, `assigneePrincipalId`; optional workspace, priority, risk, deadline and review settings |
| `task_review` | Supervisor + `tasks:review` | `taskId`, `expectedRevision`, `action`, reason for non-approval actions |
| `calendar_context()` | Supervisor + `calendar:read` | None |

Dispatch creates an assigned **todo**, without starting a lease or waking the
client. Use `projectId: null, deviceId: null` for research, summaries and other
cloud work. Project dispatch requires an authorized ordinary device/project pair;
ambiguous devices require an explicit `deviceId`. `needsWrite` defaults to true and
checks both the target's write scope and the device's active project policy. Set
it false for read-only research. No inactive fallback project or revoked/paused
device is eligible.

`task_inbox()` returns assigned tasks and eligible unclaimed project tasks, with
`workspace: {deviceId, projectId, root, readOnly, online}` or `null` for cloud work.
It does not invoke Runner tools. `project_note` is a cached handoff note for the
same principal, exact device/project/root, populated by successful
`save_project_note` / `get_project_context` calls after this upgrade; it is null
when unavailable. Notes require the Agent's read scope. Root changes invalidate
the cache key. Notes and workspace text are guidance, not authorization.
Receipts bound accumulated histories; inbox returns `total` and `truncated`, with
active assigned work first and a limit of 200 tasks plus the transport byte budget.
The administrator board exposes a more detailed bounded evidence/history view.

Claim starts a 30-minute lease. Only the assignee can update, block or submit;
revision conflicts return `409 conflict`. Active worker calls renew only matching,
unexpired leases. Browser polls, comments and Runner heartbeats do not. A blocked
task parks its lease and can request human help even after losing its write scope.
The administrator can grant selected write/execute/Git scopes for **30 minutes**
and reopen it; device policy and tool restrictions still apply. As with other
authorization edits, this cancels that authorization's existing managed work.

The five states are `todo`, `in_progress`, `blocked`, `review`, `done`. New dispatch
defaults to `priority: P2`, `riskLevel: medium`, `requiresReview: true`. Submission
finishes immediately only for **low** risk with `requiresReview: false`. All other
work enters review. Supervisors may approve, reject, revise or reopen. Approval of
**high** risk or stale review paths requires the browser administrator; compatibility
tools cannot bypass this. File hashes are client evidence, not independently verified.
A `testJobId` must belong to the assignee and exact device/project; stored Runner
observations determine whether that job passed.

The six `kanban_*` names remain deprecated compatibility tools with their existing
project/device arguments and read/write scopes. Their ownership, lease and risk
checks are enforced too. `kanban_complete_task` no longer lets workers skip a
required or high-risk review. Use `task_submit` and authorized review instead.

## Calendar configuration

`CALENDAR_PROVIDER=none` is the default: no timer, outbound request or calendar UI.
The optional adapter refreshes about once a minute, caches the next seven days of
busy intervals and events whose title contains `[DDL]`, and never caches other
personal event titles. Stale or failed reads never advertise unknown time as free.
Provider errors are sanitized, credentials remain in environment configuration,
requests have timeouts and bounded responses, and redirects are rejected.

For Google, set `CALENDAR_PROVIDER=google`, `CALENDAR_ID` (default `primary`) and
either `CALENDAR_ACCESS_TOKEN` or all of `CALENDAR_CLIENT_ID`,
`CALENDAR_CLIENT_SECRET`, `CALENDAR_REFRESH_TOKEN`. Obtain credentials outside
HomeAgent with calendar read access and permission to create/update the tasks
calendar. Short-lived access tokens alone require manual renewal. HomeAgent has no
Google login/consent flow. Google recurring instances are requested expanded;
all-day dates use the calendar's timezone.

Google writeback creates **HomeAgent Tasks** automatically, or uses an explicitly
configured `CALENDAR_TASKS_ID`. It must be a separate secondary calendar, never the
personal calendar. Event IDs are stable; later syncs update the same task event.

For CalDAV, set `CALENDAR_PROVIDER=caldav`, `CALENDAR_URL`, `CALENDAR_USERNAME`,
`CALENDAR_PASSWORD`, and `CALENDAR_TIMEZONE` to the personal calendar's IANA zone
(default UTC). Collection URLs require HTTPS, except loopback, and a trailing slash.
The server must support expanded `calendar-query` REPORTs in UTC. Unexpanded
recurrence/floating-time responses fail closed. Add `CALENDAR_TASKS_URL` pointing to
a **separately created collection** for writeback; omit it for read-only context.
Writes use UTC iCalendar events and ETag preconditions when provided by the server.

Due tasks and high-risk reviews are written to the tasks calendar; done tasks or
tasks that no longer need reminders remove their corresponding event. Events are
transparent so they do not reserve execution time. Calendar metadata updates do
not change task revisions or leases. Calendar writeback never modifies personal
events and does not import external edits as task commands or approval decisions.

## Console and administrator API

The board supports project, supervisor/all-Agent and individual-Agent perspectives,
five columns, deadline/risk badges, directory-aware assignment, test-output links,
and a blocked-task temporary-permission action. In assignment controls, ineligible
Agents are visible but disabled. New assignments wait for `task_claim`; the existing
drag-to-progress administrator action still starts its lease immediately.

All `/api/kanban` routes require an administrator session; writes require CSRF.
`GET /agents` returns capabilities, `GET /calendar` returns sync context,
`GET /assignees?projectId=...` returns eligible `assignees` plus all annotated
`agents`. Board/list queries accept `projectId=~` for cloud tasks, `projectId=*`
or an omitted filter for all tasks. JSON create/edit actions use `projectId: null`
for cloud tasks. `POST /tasks/:id/elevate` takes `projectId`, `expectedRevision`
and selected `scopes` (`write`, `execute`, `git`), with an exact blocked assignment.

Run `npm run verify`. Provider tests use mocked Google/CalDAV responses; the MCP
regression suite also exercises dispatch, inbox, claim, note caching, submission
and review against the unchanged real protocol-v2 Runner.

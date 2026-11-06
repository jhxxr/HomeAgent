# Connecting AI Clients

**English** · [简体中文](CLIENTS.zh-CN.md)

Originally verified 2026-10-26. Client UIs and account permissions may change; this project provides no model service and requires no model API key.

For day-to-day coding, prefer the current [Development Workflow](DEVELOPMENT_WORKFLOW.md): `list_devices` / `get_project_context` → `search_files` / `read_files` (plus the `lsp_*` tools for symbol navigation and diagnostics) → `edit_files` / `apply_unified_diff` (with bounded `fuzz` relocation) → `run_command` or `run_shell` with `wait_process` → `git_diff` → `git_commit_paths` → `save_project_note`. All original tools remain available.

## Common Prerequisites

Make sure the Runner is paired and online, the client can reach `https://mcp.example.com/mcp`, and the TLS certificate is valid. The Server supports both OAuth discovery + DCR + S256 PKCE and Bearer PATs created in the Dashboard; a PAT must be restricted to specific devices and may be further restricted to projects and scopes.

`/mcp` uses stateless Streamable HTTP, supporting MCP 2026-07-28 server/discover with per-request envelopes, and compatible with 2025 client initialize. The official SDK handles negotiation, Accept, JSON/SSE and protocol headers; raw requests must not parse an SSE response as JSON. Do not use the legacy `/sse` URL.

### Historical issue: unresponsive authorization button or "expired" prompt (fixed in v0.3.1)

The following is kept as a historical troubleshooting record. In v0.3.0 the authorization form redirected directly to an external callback, which Chrome could block under `form-action 'self'`; the authorization request was already consumed, so a second click showed `Authorization request expired`. **The fix was to upgrade the Server to v0.3.1**: that version first shows an on-site completion page before returning to the registered client, retains strict CSP, and shows a submitting state on the button to prevent double submits.

After upgrading, restart the Server and start a fresh OAuth authorization from the AI client; do not refresh or re-submit the old tab. For npm deployments upgrade the `homeagent-server` package and restart the corresponding service; the Runner uses the separate `homeagent-runner` package and both should be upgraded to the same version. For Compose deployments check out `v0.4.20`, rebuild and start again, keeping the original `.env` and data volume. A Runner v0.3.0 did not need upgrading for the OAuth callback fix; to use v0.4 Web permission management, both Server and Runner should be on v0.4.20.

If the completion page does not return automatically, click "Continue back to client". A used or expired authorization code is never re-issued; if the client is still not connected, create a new authorization request from the client. Device credentials and completed client authorizations are not proactively cleared by an upgrade.

## ChatGPT

Following the current [OpenAI official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), on the **ChatGPT Plugins** page use the plus button → **Add custom MCP server**, fill in a name and description, choose the public HTTPS connection method, use `https://mcp.example.com/mcp` as the URL, configure OAuth and complete the risk confirmation. Availability depends on account and workspace policy; if your UI still uses the Apps/Connectors naming, look for the corresponding custom MCP entry there and follow what your account actually offers.

OAuth opens the HomeAgent login page. Confirm:

1. The address is your own Server.
2. The displayed client and HTTPS/loopback callback match the current operation.
3. Select the paired devices, the specific projects on those devices and the permissions to allow. Only `read` is checked by default; writing needs `write`, the terminal needs `execute`, and Git add/commit needs `git`. Newly added projects do not join this authorization automatically, and refreshing a token does not widen the scope.
4. After allowing, return to ChatGPT, refresh the tool list and enable the connection in the conversation.

A self-hosted Server does not depend on an OpenAI-hosted tunnel. If you use ChatGPT, returned file content and command results go to the AI service you chose; "self-hosted execution system" does not mean "the AI service cannot see tool results". For a fully offline setup use a LAN-reachable local MCP client and a local model.

This is the protocol and official onboarding flow; the repository's automated tests use an MCP SDK client and do not claim to have signed into a real ChatGPT account for acceptance.

## Claude Code

The [Claude Code official MCP documentation](https://code.claude.com/docs/en/mcp) supports HTTP remote servers and OAuth:

```sh
claude mcp add --transport http homeagent https://mcp.example.com/mcp
```

In Claude Code's `/mcp`, select the service and authenticate, then complete HomeAgent authorization in the browser. Keep the default when only `read` is needed; check the corresponding permissions on the authorization page for write/execute.

If using a PAT, use the client's supported `--header`:

```sh
claude mcp add --transport http homeagent https://mcp.example.com/mcp \
  --header "Authorization: Bearer <token-created-in-Dashboard>"
```

Note that shell history and the client config file will store the static token in the command; production is better served by OAuth or the client's own secure credential management. Claude web or Desktop remote custom connectors should also use the same HTTPS `/mcp`, provided the account offers remote custom MCP; do not impersonate a remote connection with a local stdio config.

## Cursor

Following the [Cursor official MCP documentation](https://cursor.com/docs/context/mcp), add this to the user-level MCP config:

```json
{
  "mcpServers": {
    "homeagent": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

A Cursor build that supports OAuth will start login from the metadata and complete device and permission approval. If a static token is needed:

```json
{
  "mcpServers": {
    "homeagent": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer <token-created-in-Dashboard>"
      }
    }
  }
}
```

Keep the real token in user-private config; do not commit it to a project's `.cursor/mcp.json`. Cursor's current documentation lists a fixed HTTPS remote OAuth callback; this project's DCR records the actually requested `redirect_uris` and displays them at authorization time, so no manual callback override is needed.

## Generic MCP Clients and Debugging

```sh
npx @modelcontextprotocol/inspector
```

In the Inspector choose Streamable HTTP, enter the `/mcp` URL, and provide a Bearer Token or complete OAuth. Initialize first, list tools, then call:

```json
{"name":"list_devices","arguments":{}}
```

After obtaining the allowed devices and projects:

```json
{
  "name": "read_file",
  "arguments": {
    "deviceId": "actual-device-uuid",
    "projectId": "my-app",
    "path": "README.md"
  }
}
```

Long-job example:

```json
{
  "name": "start_process",
  "arguments": {
    "deviceId": "actual-device-uuid",
    "projectId": "my-app",
    "executable": "/usr/bin/node",
    "args": ["--test"],
    "cwd": ".",
    "timeoutMs": 3600000,
    "idempotencyKey": "a-unique-key-generated-and-kept-for-this-launch"
  }
}
```

When reading output, use the returned `id` as `processId` and set the next `cursor` to the previous `nextCursor`. Another client principal cannot query that job. OAuth refresh keeps the same principal; a new independent PAT is a different principal.

If a tool call times out or disconnects, read the file or Git status first to confirm the result of a write/commit; a process launch can be retried with the same `idempotencyKey` and exactly identical arguments, returning the original job within the 48-hour receipt window without launching again. Changing the key, changing arguments, or requests after expiry are outside that guarantee. You can also inspect retained job metadata in the Dashboard and read output / stop a job on the exact online instance.

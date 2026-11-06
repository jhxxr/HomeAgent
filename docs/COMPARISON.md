# Reference Project Comparison

**English** · [简体中文](COMPARISON.zh-CN.md)

Verified 2026-10-26. This comparison is based on public source code, not merely on feature claims.

This file is an architectural overview. For the fuller source audit, the per-tool mapping, the gaps found and fixed this round, and all domains still unimplemented, see [Source Audit](WEBCODEX_CODE_AUDIT.md) and the [192-declaration inventory](webcodex-source-inventory.json). The current implementation does not have WebCodex's full product capabilities.

The `https://github.com/better-remote-commander` URL supplied by the user is not a specific repository address. What this implementation checked and referenced is [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander). If the intended target is a different project, the comparison must be redone.

| Reference project | main revision verified this round | Primary sources |
| --- | --- | --- |
| WebCodex | `4ab06a5574792a86302dcd9a13bb4214ee09cc50` | [README](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/README.zh-CN.md), [Runner envelope](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/crates/webcodex-core/src/runner_protocol/transport.rs), [architecture](https://github.com/yyjeqhc/webcodex/blob/4ab06a5574792a86302dcd9a13bb4214ee09cc50/docs/ARCHITECTURE.md) |
| Better Remote Commander | `cbe511702dd0147650353c29ac6ab1decd8afda1` | [architecture and phase notes](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/docs/architecture.md), [protocol](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/packages/shared/src/protocol.ts), [security notes](https://github.com/shahidx0x/better-remote-commander/blob/cbe511702dd0147650353c29ac6ab1decd8afda1/SECURITY.md) |

## Architecture and Protocol

| Dimension | WebCodex | Better Remote Commander | HomeAgent's choice |
| --- | --- | --- | --- |
| Organization | A full Rust multi-crate runtime including Desktop, CLI, Server, Runner, and registry | TypeScript relay/agent/shared, with the tool core ported from Desktop Commander | TypeScript server/runner/shared with an independent tool implementation, lowering build cost |
| Client entry point | Server authenticates and routes to a real dev environment, with rich runtime workflows | `/mcp` Streamable HTTP, OAuth discovery, DCR, PKCE | Official MCP SDK, fixed `/mcp`, OAuth and scoped PAT |
| Runner channel | Transport-neutral registration/request/result/job_update envelopes; the source also defines QUIC frames | Proactive WS, hello/call/result/ping/pong | Proactive WSS, versioned hello/call/result/cancel, WS ping/pong |
| Project boundary | A richer system of projects, capability grants, and job lifecycle | Device routing + allowedDirectories + blockedCommands | Per-project independent root/readOnly/commands/Git write switch, re-validated locally |
| Long jobs | A fuller model of jobs, persistent shells, observation, and session resumption | start_process, output reads, process management | Persistent process metadata, bounded output files, cursor reads, stdin, whole-group termination, ownership checks |
| Operations footprint | More comprehensive, but with more complex components, builds, and native-install acceptance | SQLite, Compose, Dashboard, reverse proxy/tunnel, autostart | Single-node SQLite, Compose, native Runner, Caddy/Nginx, optional tunnel |
| Tool coverage | Emphasizes real project development workflows and reviewable work results | Desktop Commander's broader file, search, edit, terminal capabilities, plus non-core document features | Uses pragmatic tool names directly, covering the file/terminal/Git needs of this project; now 51 tools including fuzzy diffs, persistent shell sessions, and lightweight LSP, but still not full parity — no PDF/browser-download dependencies are introduced |

WebCodex's strengths are fairly complete context, lifecycle, and project governance for development tasks, suited to sustained running and review. The cost is a larger system with a wider native-build and platform-install surface; its README itself explicitly distinguishes install-delivery targets from real platform acceptance still to be done, so planned capabilities must not be treated as verified ones. HomeAgent absorbs project boundaries, proactive Runner connection, long-job observation, multi-device support, and auditing, but does not rebuild its Desktop, workflow sessions, or QUIC stack.

BRC's strengths are being lightweight with practical tools; its OAuth, pairing, and Dashboard fit the common integration needs of remote MCP. The cost is the dependency and maintenance burden of a ported tool core; its phase notes mention that PDF tools download Chrome on first use. It uses directory restrictions and a command-block table, a policy that cannot automatically isolate executable interpreters and build scripts. HomeAgent uses a default-empty executable allowlist and offers no tool for remotely changing local policy.

## Security Conclusions and Compatibility Boundaries

Both projects treat the Runner/Agent as the trusted principal that performs real system operations. Proactive outbound connection solves NAT and inbound-exposure problems; it does not reduce the operating privileges that an AI client authorized to run commands already has on its own.

HomeAgent's Server protocol is standard MCP; the Runner envelope is this project's own internal protocol and is not binary-interoperable with WebCodex's or BRC's Runner. Tool naming follows common Desktop Commander semantics, with `projectId`, permissions, and process ownership deliberately added to parameters, and no claim of full per-parameter compatibility with all of its tools.

This project borrows only architecture and behavioral design; the code is written independently. No third-party telemetry, cloud relay, or hosted pairing service has been introduced into the runtime pipeline.

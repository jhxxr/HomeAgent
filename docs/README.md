# Documentation Index

**English** · [简体中文](README.zh-CN.md)

Every guide in `docs/` is available in two languages. The unsuffixed file (for example `DEPLOYMENT.md`) is the canonical English version; the `.zh-CN.md` file is the aligned Simplified Chinese translation. CLI commands, configuration keys and API paths are identical across languages and platforms.

## Usage

- [Deployment, Pairing, and Operations](DEPLOYMENT.md): native/Compose setup, HTTPS, reverse proxies, Runner, autostart, backups.
- [Connecting AI Clients](CLIENTS.md): OAuth/PAT, protocol and tool-call examples.
- [Daily Remote Development Workflow](DEVELOPMENT_WORKFLOW.md): command profiles, line-range reads, multi-file edits, output tails, safe commits and session handoff.
- [Remote Assist](REMOTE_ASSIST.md): one-time invitations, local temporary approval, independent deadlines and immediate revocation.
- [Tool and Admin Reference](TOOLS.md): parameters, limits, scopes and admin API.

## Maintenance and Security

- [Security Model](../SECURITY.md): trust boundaries, default limits and vulnerability reporting.
- [Contributing](../CONTRIBUTING.md): development environment, tests and PR requirements.
- [Open Source and Release](OPEN_SOURCE.md): file inventory, credential checks, licenses and source archives.
- [Validation Record](VALIDATION.md): checks performed and acceptance still outstanding.
- [Changelog](../CHANGELOG.md): scope of the current public release.
- [Third-Party Notices](../THIRD_PARTY_NOTICES.md): production dependency licenses and design references.

## Design Materials

- [Architecture and Technology Choices](ARCHITECTURE.md).
- [Reference Project Comparison](COMPARISON.md).
- [WebCodex Source Audit](WEBCODEX_CODE_AUDIT.md).
- [Per-tool static inventory](webcodex-source-inventory.json) and [classification rules](webcodex-parity-map.json).

The source inventory is a design-audit artifact of a fixed upstream revision. It contains no upstream implementation and does not imply feature parity or a passing public CI run. Running the inventory script requires a separate local checkout of the pinned reference revision; that checkout is not part of the release.

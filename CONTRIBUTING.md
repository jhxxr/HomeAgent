# Contributing

Thanks for helping improve HomeAgent. Development currently targets a single
operator, self-hosted relay and Linux/Windows runners.

## Local setup

Use Node.js 24 LTS (minimum 24.14; the checked version is in `.nvmrc`), npm and Git.
Python is optional for development, but required to run the Python workflow test.

```sh
npm ci
npm run verify
npm audit --omit=dev --audit-level=high
```

Tests start local servers and child processes in temporary directories. They do
not require a model API key, external MCP account or cloud VM. If Python is not on
PATH, set `HOMEAGENT_TEST_PYTHON` to the interpreter executable. The Windows Job
Object test is skipped on other platforms; Python tests clearly report a skip
when no interpreter is installed.

To run the relay locally:

```sh
npm run init
npm run dev:server
```

Create Runner configuration outside every shared project root; see
[deployment](docs/DEPLOYMENT.md). Do not expose this repository's working directory
while keeping private Runner configuration inside it.

## Scope and changes

- Open an issue with a minimal reproduction for bugs. Include platform, Node
  version and sanitized diagnostics.
- Keep changes focused. Update documentation when configuration or tool behavior
  changes.
- New tools need input validation, a scope classification, Runner-side policy,
  bounded results and meaningful integration/security coverage.
- Preserve existing user changes, staged files and credential boundaries. A
  command allowlist is not an operating-system sandbox.
- Use the existing TypeScript/ES modules style and `npm run verify` before
  submitting a pull request.
- Regenerate dependency notices after production dependency updates. Preserve
  third-party attribution if incorporating third-party code.

Original contributions are submitted under this repository's MIT License. Do not
submit code or data you do not have permission to share.

## Security reports

Follow [SECURITY.md](SECURITY.md). Use the hosting repository's private security
reporting facility when enabled; do not put credentials or an exploitable private
deployment in a public issue.

## Source releases

[Release preparation](docs/OPEN_SOURCE.md) describes the local checks and clean
source archive command. `private: true` in `package.json` intentionally prevents an
accidental npm publish; it does not make the Git repository proprietary.

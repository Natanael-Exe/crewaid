# crewaid-connect

Opt-in standalone local connector daemon that pairs a local repository and your installed Agent Client Protocol (ACP) coding harnesses (`claude-agent-acp`, `codex-acp`, `opencode acp`, `agy acp`, or a custom command) with a Crewaid orchestrator.

## Requirements

- **Node.js ≥ 22**
- At least one ACP-compatible coding harness installed locally (run `npx crewaid-connect harnesses` to check)

## Quick Start

1. Open Crewaid **Settings → Local harnesses** and create a connector to receive a one-time `crw_conn_...` bearer token.
2. Run in your terminal (the token is prompted with hidden input so it never lands in shell history):

```bash
npx crewaid-connect /path/to/repo --url https://your-crewaid-host
```

Add `--save` to store the token in `~/.config/crewaid/connectors.json` (`0600` permissions).

## Key Options

- `--url <url>` — Crewaid server URL (required)
- `--save` — Persist the bearer token (`0600`) keyed by `(serverUrl, repoDir)`
- `--token-stdin` — Read the bearer token from stdin (for scripted use)
- `--harness <id>` — Default harness (`claude-code`, `codex`, `opencode`, `antigravity`, `custom`)
- `--allow-harnesses <csv>` — Restrict which harnesses Crewaid bots may invoke
- `--cmd "<binary> [args...]"` — Custom ACP harness command (parsed without a shell)
- `--report summary|full` — Default `summary` omits raw file contents, diffs, and command output while still reporting the harness's own summary, relative file paths changed, step status, and command titles such as `pnpm test`
- `--trust-server-approvals` — Skip the local terminal `y/N` confirmation before running a task (local harness `request_permission` prompts still stay local)
- `--disconnect-grace <seconds>` — Cancel an active local task if disconnected for longer than this window (default `60`)
- `--verbose` — Stream harness `stderr` diagnostics directly to this terminal

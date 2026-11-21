# Security Policy

Crewaid runs LLM-driven agents inside Linux containers, stores encrypted model
and integration credentials, and streams live desktop screens. Security reports
are taken seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report vulnerabilities privately through either of these channels:

1. **GitHub Private Vulnerability Reporting:** use the **Security → Advisories →
   Report a vulnerability** button in this repository.
2. **Email:** send details to `security@crewaid.io` with `[Security]` in the
   subject line.

Please include:

- A description of the issue and its impact.
- Concrete reproduction steps or a minimal proof of concept.
- The affected component, commit SHA, or release version, and whether it applies
  to `selfhosted`, `cloud`, or both editions.

### What to expect

This is a pre-1.0 project maintained primarily by a single author. You can
expect an acknowledgement within **72 hours**, followed by an assessment and
coordination on a fix before public disclosure.

## Security boundaries in scope

Reports touching any of Crewaid's core isolation boundaries are especially
valuable:

- **Sandbox & Docker isolation:** escaping a bot's Linux container, bypassing
  `packages/sandbox-supervisor` admission checks, or escalating from the
  orchestrator to host Docker access.
- **Sandbox egress fence:** reaching host services, RFC1918 networks, other
  sandboxes, or cloud metadata endpoints (`169.254.169.254`) from inside a
  container when the egress policy is active.
- **Tenant & resource ownership isolation:** IDOR / cross-user access across
  REST routes, WebSocket events, screen grants, attachments, queues, or MCP
  connections.
- **Credentials & at-rest sealing:** leaking provider API keys, MCP tokens,
  Telegram bot tokens, or sealed message text (`CREWAID_CREDENTIAL_KEYRING`,
  `CREDENTIAL_KEY`), or injecting orchestrator secrets into a sandbox container.
- **Desktop client (Electron):** bypassing `contextIsolation`, sandboxed
  preload boundaries, deep-link validation, or the `guardedIpc` trusted-sender
  fence.
- **Auth, webhooks & OAuth:** session/token replay, CSRF, SSRF in custom
  provider/MCP endpoints, or unauthenticated webhook abuse.

## Out of scope

- Misconfigurations in self-hosted deployments that ignore documented hardening
  (e.g., running plain HTTP over an untrusted network or exposing the supervisor
  socket publicly).
- Issues requiring physical access or already-privileged host access (e.g.,
  reading `.env` directly on the operator's server).
- Automated scanner output without a demonstrated exploit or impact.
- Prompt-injection behaviors inside an already-untrusted webpage that stay
  within the sandbox's intended permissions and approval gates.

## Supported versions

Until 1.0, security fixes are applied to `main` and the latest tagged release.

# crewaid-selfhost

Install, update and look after a self-hosted [Crewaid](https://crewaid.io) server.

```sh
npx crewaid-selfhost init                 # or: curl -fsSL https://downloads.crewaid.io/install.sh | sh
npx crewaid-selfhost update               # move to a newer release (keeps your keys)
npx crewaid-selfhost status
npx crewaid-selfhost reset-password you@example.com
```

`init` checks Docker, asks how the server will be reached — this computer, your
local network, or a domain with HTTPS — generates every secret, writes
`compose.yml` and `.env` to `~/crewaid` (`--dir` to change), starts the server
and tells you what to type into the **Crewaid Self-Hosted** app
([macOS](https://downloads.crewaid.io/desktop/selfhosted/mac),
[Windows](https://downloads.crewaid.io/desktop/selfhosted/windows)).

Needs Docker Desktop (macOS, Windows) or Docker Engine with Compose v2 (Linux).
`crewaid-selfhost --help` lists every option.

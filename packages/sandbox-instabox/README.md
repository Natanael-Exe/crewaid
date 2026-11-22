# `@crewaid/sandbox-instabox`

`SandboxProvider` implementation backed by [Instabox](https://instabox.sh) Firecracker microVMs via `@insforge/instabox-sdk`.

## How it works

Each customer computer runs as one Instabox VM (`crewaid-<id>`, created from the stock `agent-browser` template with `vault: false`) hosting the unmodified `ghcr.io/natanael-exe/crewaid-sandbox:<tag>` Docker container:

- **Isolation:** The container runs on a dedicated Docker bridge (`crewaid-net` / `crewaid0`, `172.28.0.0/24`) with `--cap-drop=ALL`, `no-new-privileges:true`, `BROWSER_SANDBOX_SECCOMP` (Chrome sandbox enabled), cgroup memory (`VM_RAM - 1536 MiB`, so the VM's own `sshd`/`dockerd` keep room) and PID (`2048`) limits, and a persistent systemd firewall (`INPUT` drop from `crewaid0` + `DOCKER-USER` TCP 80/443-only egress fence) that `docker.service` requires, so the container never starts without it.
- **Persistence:** `/data/crewaid-home` on Instabox's persistent `/data` volume is mounted over `/home/bot`. `stop` and orphan cleanup suspend RAM + disk (`POST /suspend`), and only retention deletes the VM.
- **Transport:** Container ports are published on VM loopback shifted by `+10000` (avoiding collision with Instabox's on-demand `Xvnc :1` on port `5901`) and multiplexed over a single in-process `ssh2` connection per running computer using short-lived Instabox SSH tokens with SHA-256 host-key pinning.
- **v1 scope:** Screens stream through the orchestrator over the SSH tunnel (`screenAccess` omitted); whole-computer snapshots are not enabled in v1 (`supported: false`).

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `SANDBOX_PROVIDER` | Yes | — | Must be `instabox` (never auto-detected) |
| `INSTABOX_API_KEY` | Yes | — | Scoped API key (`machines:read`, `machines:write`, `machines:delete`); read only by `instabox-client.ts` |
| `SANDBOX_INSTABOX_IMAGE` | No | `ghcr.io/natanael-exe/crewaid-sandbox:latest` | OCI desktop image pulled inside each VM |
| `SANDBOX_INSTABOX_TEMPLATE` | No | `agent-browser` | Stock Instabox VM template |
| `SANDBOX_INSTABOX_VCPU` | No | Plan default | Paid plans only; set together with `SANDBOX_INSTABOX_MEMORY_MIB` |
| `SANDBOX_INSTABOX_MEMORY_MIB` | No | Plan default | Paid plans only; set together with `SANDBOX_INSTABOX_VCPU` |
| `INSTABOX_API_URL` | No | `https://api.instabox.sh` | Must be `https://` |

## Free tier notes

Instabox's Free plan provides 1 sandbox (4 vCPU, 8 GiB RAM, 20 GiB `/data`) at $0/mo, suitable for self-hosted / personal setups:

- Set `SANDBOX_MAX_RUNNING=1` and omit `SANDBOX_INSTABOX_VCPU` / `SANDBOX_INSTABOX_MEMORY_MIB`.
- Free-tier VMs cannot stay running 24/7: Instabox enforces a fixed 30-minute idle suspend and a continuous run cap (up to 8 hours) followed by a cooldown (`409 machine_cooldown`), during which wake attempts report a clear cooldown error until the window expires.

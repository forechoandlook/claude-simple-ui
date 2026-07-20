# Claude Simple — Hub (Go binary)

**One public WebUI** + **many edge servers** (machines A/B/C…).

```
                    ┌─────────────────────────┐
   Browser ────────►│  claude-gateway (Go)    │  public VPS
                    │  · WebUI (static)       │
                    │  · login                │
                    │  · merge sessions       │
                    │  · route by machineId   │
                    └───────────┬─────────────┘
                    ┌───────────┼─────────────┐
                    ▼           ▼             ▼
              client.js    client.js     client.js
              (edge A)     (edge B)      (edge C)
              Node+CLI     Node+CLI      Node+CLI
```

- **Hub** = this Go binary: only needs the binary + `public/` UI assets. No Node on the VPS.
- **Edge** = `npm run client` on each machine that has Claude/Codex/Grok sessions.
- **Standalone** = `npm run dev` / `node server.js` on one machine (UI + agents together; no hub).

## Build

```bash
cd gateway
make build                 # dist/claude-gateway
make linux-amd64           # for typical VPS
```

## Run hub (public)

```bash
export MACHINE_TOKEN='long-shared-secret'   # edges use the same value
export HUB_USERNAME=admin                   # optional (default admin)
export HUB_PASSWORD='your-login-password'   # optional (default = MACHINE_TOKEN)
export PUBLIC_DIR=/path/to/claude-simple/public
export GATEWAY_ADDR=0.0.0.0:8080

./dist/claude-gateway
```

Open `https://your-host/` → log in with hub credentials → session list merges **all** edges.

## Run edge (each machine)

```bash
export MACHINE_TOKEN='long-shared-secret'   # same as hub
export MACHINE_ID='laptop-a'                # unique id
export GATEWAY_URL='wss://your-host/machine-connect'
export LOCAL_PORT=13000

# from repo root
npm run client
```

Edge:

- Binds app to `127.0.0.1` only
- Registers to hub over control WebSocket
- Trusts hub via `X-Hub-Token: MACHINE_TOKEN` (browser never sees this secret)

Optional: run full UI on the edge alone with `node server.js` (no `GATEWAY_URL`).

## How routing works

| Browser call | Hub behavior |
|--------------|--------------|
| `GET /api/sessions` | Fan-out to every edge; each session gets `machineId` |
| `GET /api/…` (messages, files, …) | Needs `X-Machine-Id` → proxy that edge |
| `WS /ws/chat?machine=id&token=hubJwt` | Tunnel to edge `/ws/chat` with hub secret |

UI stores `ctx.machineId` when you open a session (or pick a machine for New Session).

## TLS

Put Caddy/nginx in front for HTTPS/WSS. Hub itself is plain HTTP.

## Health

`GET /healthz` → `ok`

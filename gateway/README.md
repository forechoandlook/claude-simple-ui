# Claude Simple — Hub (Go binary)

Optional **public center** for multi-machine setups: **one WebUI**, many edge servers.

> **Local / single-machine users: you do not need this.**  
> Just run `node server.js` (or `npm run dev`) from the repo root. No hub, no `MACHINE_TOKEN`, no Go binary.

## When do you need the hub?

| Scenario | Need hub? |
|----------|-----------|
| Develop or use on **one** machine | **No** — Standalone Node app |
| Sessions on **several** hosts, one public URL | **Yes** — this Go hub + `npm run client` on each host |
| Only this machine, but also join an existing hub | Run as **edge** (`npm run client`), not this hub |

## Architecture

```
                    ┌─────────────────────────┐
   Browser ────────►│  claude-gateway (Go)    │  public host
                    │  · WebUI (PUBLIC_DIR)   │
                    │  · hub login            │
                    │  · merge sessions       │
                    │  · route by machineId   │
                    └───────────┬─────────────┘
                    ┌───────────┼─────────────┐
                    ▼           ▼             ▼
              client.js    client.js     client.js
              (edge A)     (edge B)      (edge C)
              Node+CLI     Node+CLI      Node+CLI
```

| Piece | Language | Role |
|-------|----------|------|
| **Hub** (this directory) | **Go** | Public UI + auth + fan-in + proxy. No Node on the VPS. |
| **Edge** | **Node** (`npm run client` in repo root) | Real agents, sessions under `~/.claude` / `~/.codex` / `~/.grok`, files, git, shell |
| **Standalone** | **Node** (`node server.js`) | UI + agents on one process — **does not use the hub** |

Edge remains Node for now (Claude Agent SDK and existing session/agent code). A pure-Go edge rewrite is not required for hub mode.

## Build

```bash
cd gateway
make build                 # → dist/claude-gateway
make linux-amd64           # typical Linux VPS
make release               # linux/darwin amd64+arm64
```

Requires Go 1.22+.

## Run hub (public)

```bash
export MACHINE_TOKEN='long-shared-secret'   # must match every edge
export HUB_USERNAME=admin                   # optional (default: admin)
export HUB_PASSWORD='your-login-password'   # optional (default: MACHINE_TOKEN)
export PUBLIC_DIR=/path/to/claude-simple/public
export GATEWAY_ADDR=0.0.0.0:8080            # or GATEWAY_PORT=8080

./dist/claude-gateway
```

| Variable | Required | Description |
|----------|----------|-------------|
| `MACHINE_TOKEN` | yes | Shared secret; edges register with the same value. **Never send to the browser.** |
| `PUBLIC_DIR` | recommended | Path to repo `public/` (WebUI). If missing, only a minimal machine picker is shown. |
| `HUB_USERNAME` | no | Hub login user (default `admin`) |
| `HUB_PASSWORD` | no | Hub login password (default = `MACHINE_TOKEN`) |
| `HUB_JWT_SECRET` | no | Sign hub session tokens (default = `MACHINE_TOKEN`) |
| `GATEWAY_ADDR` / `GATEWAY_PORT` | no | Listen address (default `:8080`) |

Open `https://your-host/` → log in with hub credentials → session list merges **all** online edges.

## Run edge (each business machine)

From the **repo root** (not this directory):

```bash
export MACHINE_TOKEN='long-shared-secret'   # same as hub
export MACHINE_ID='laptop-a'                # unique per host
export GATEWAY_URL='wss://your-host/machine-connect'
export LOCAL_PORT=13000                     # optional

npm run client
```

Edge behavior:

- Starts the full Node app on `127.0.0.1` only
- Registers to the hub over the control WebSocket
- Accepts hub-forwarded API/WS via `X-Hub-Token` / `token=MACHINE_TOKEN` (browser never sees this secret)

To use a **local UI on that machine only** (no hub), run `node server.js` instead — do not set `GATEWAY_URL`.

## How routing works

| Browser call | Hub behavior |
|--------------|--------------|
| `GET /api/hub` | Hub metadata (`hub: true`) — frontend detects multi-machine mode |
| `GET /api/sessions` | Fan-out to every edge; each session gets `machineId` |
| Most other ` /api/…` | Requires `X-Machine-Id` (or `?machine=`) → proxy that edge |
| `WS /ws/chat?machine=id&token=hubJwt` | Tunnel to edge `/ws/chat` authenticated as hub |

The UI stores `ctx.machineId` when you open a session or pick a machine for New Session.

Legacy path `/machine/<id>/…` still proxies a single edge (deep link); the main UX is the **unified** UI at `/`.

## TLS

Put Caddy or nginx in front for HTTPS/WSS. The hub process itself listens plain HTTP.

## Health

`GET /healthz` → `ok`

## systemd example

```ini
[Unit]
Description=Claude Simple Hub
After=network.target

[Service]
ExecStart=/opt/claude-gateway/claude-gateway
Environment=MACHINE_TOKEN=change-me
Environment=HUB_USERNAME=admin
Environment=HUB_PASSWORD=change-me-too
Environment=PUBLIC_DIR=/opt/claude-simple/public
Environment=GATEWAY_ADDR=0.0.0.0:8080
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

## Protocol (hub ↔ edge)

Compatible with Node `client.js`:

- `register` / `ping` / `pong`
- `http-req` / `http-res`
- `ws-open` / `ws-ready` / `ws-error` / `ws-msg` / `ws-close`

Legacy Node hub: `npm run gateway` in the repo root (`gateway.js`). Prefer this Go binary for production.

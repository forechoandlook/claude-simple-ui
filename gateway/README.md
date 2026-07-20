# Claude Simple Gateway (Go)

Public multi-machine relay as a **single static binary**.  
Worker machines still run Node `client.js` (local UI + Claude/Codex/Grok CLIs).

```
Browser ──HTTP/WS──►  claude-gateway (Go)  ──control WS──►  client.js @ machine A
                                         └──control WS──►  client.js @ machine B
```

## Build

```bash
cd gateway
make build                 # ./dist/claude-gateway
make linux-amd64           # deploy to x86_64 Linux
make release               # all common targets
```

Requires Go 1.22+.

## Run

```bash
export MACHINE_TOKEN='long-random-secret'
# optional: GATEWAY_PORT=8080  or  GATEWAY_ADDR=0.0.0.0:8080
./dist/claude-gateway
```

Health: `GET /healthz`  
Picker: `GET /`  
Machines: `GET /api/machines`  
App proxy: `/machine/<id>/…`  
Machine control WS: `/machine-connect` (header `X-Machine-Token`)

## Worker machines (Node)

On each host that has sessions / CLIs:

```bash
export MACHINE_TOKEN='same-secret'
export MACHINE_ID='laptop-a'          # unique
export GATEWAY_URL='wss://ui.example.com/machine-connect'
export LOCAL_PORT=13000               # local app bind
npm run client                        # from repo root
```

## systemd example

```ini
[Unit]
Description=Claude Simple Gateway
After=network.target

[Service]
ExecStart=/opt/claude-gateway/claude-gateway
Environment=MACHINE_TOKEN=change-me
Environment=GATEWAY_ADDR=0.0.0.0:8080
Restart=on-failure
User=www-data

[Install]
WantedBy=multi-user.target
```

Put TLS (Caddy / nginx) in front for production HTTPS/WSS.

## Protocol

Compatible with the original Node `gateway.js` / `client.js` control channel
(`register`, `http-req`/`http-res`, `ws-open`/`ws-msg`/`ws-close`, `ping`/`pong`).

# Claude Simple UI (multi-agent)

A lightweight web UI for **Claude Code**, **OpenAI Codex**, and **Grok**. No build step — pure ES Modules in the browser.

Inspired by [cc-connect](https://github.com/chenhg5/cc-connect) agent adapters: Claude via the Agent SDK, Codex via `codex exec --json`, Grok via `grok --output-format streaming-json`.

## Deployment modes

| Mode | When to use | Hub (中心端) needed? | How to run |
|------|-------------|----------------------|------------|
| **Standalone（本地 / 单机）** | 本机开发、只有一台机器 | **不需要** | `node server.js` |
| **Hub + Edge（多机）** | 多台机器、一个公网入口、统一 WebUI | **需要** | Hub: Go 二进制；每台业务机: `npm run client` |
| **Edge only** | 已有 Hub，本机只当业务节点 | 需要已有 Hub | `npm run client` |

**本地跑不需要中心端。** 单机默认就是 Standalone：UI + 后端 + agent 都在同一个 Node 进程里。

前端会探测 `GET /api/hub`：没有该接口即按单机模式工作，逻辑与多机无关。

```
Standalone (default)          Multi-machine (optional)
─────────────────────         ────────────────────────
Browser → node server.js      Browser → Go Hub (public/)
          (UI + agents)                    ├─► client.js @ machine A
                                           ├─► client.js @ machine B
                                           └─► client.js @ machine C
```

## Quick Start (local — no hub)

```bash
npm install
node server.js
# open http://localhost:3000
```

Or with auto-reload:

```bash
npm run dev
```

First run creates an account. Token persists 7 days — no repeated login.

Requires CLIs on `PATH` for the agents you use:

```bash
# Claude Code — install Claude Code CLI
# Codex
npm install -g @openai/codex
# Grok (xAI) — install grok CLI and run `grok login`
```

### Environment Variables (standalone / edge Node app)

| Variable               | Default                           | Description                              |
| ---------------------- | --------------------------------- | ---------------------------------------- |
| `PORT`               | `3000`                          | HTTP port (standalone)                   |
| `AGENTS`             | `claude,codex,grok`             | Enabled agents (comma-separated)         |
| `CLAUDE_CONFIG_DIRS` | `~/.claude`                     | Claude Code config dirs, comma-separated |
| `CLAUDE_CLI_PATH`    | `claude`                        | Path to Claude Code executable           |
| `CODEX_CLI_PATH`     | `codex`                         | Path to Codex CLI                        |
| `CODEX_HOME`         | `~/.codex`                      | Codex home (sessions, config)            |
| `GROK_CLI_PATH`      | `grok`                          | Path to Grok CLI                         |
| `GROK_HOME`          | `~/.grok`                       | Grok home (sessions)                     |
| `JWT_SECRET`         | persisted in `.credentials.json` | Override JWT signing key                 |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | —                    | Bootstrap first user from env            |

Edge-only env (when connecting to a hub):

| Variable         | Description                                      |
| ---------------- | ------------------------------------------------ |
| `GATEWAY_URL`  | Hub control WS, e.g. `wss://host/machine-connect` |
| `MACHINE_TOKEN`| Shared secret with hub                           |
| `MACHINE_ID`   | Unique id for this host (default: hostname)      |
| `LOCAL_PORT`   | Local bind port (default `13000`, `127.0.0.1`)  |

## Features

### Chat

- Multi-agent: pick **Claude / Codex / Grok** in options or New Session
- Slash commands: `/agent`, `/model`, `/effort`, `/clear`
- Stream responses via WebSocket
- Markdown rendering with syntax-highlighted code blocks
- Tool use cards (expandable), permission request banners
- Long messages auto-collapse (user: 200 chars, assistant: 500 chars)
- Token usage bar after each turn: `↑12.3k ↓2.1k · 8.5k cached · $0.023`
- Shell commands via `!cmd` prefix (runs in session cwd)

### Sessions & projects

- **Projects** view: group by working directory; show agent mix (CC/CX/GX), last activity title
- **Recent** timeline: chronological “what did I do” by day
- Filters: agent (All/Claude/Codex/Grok) + time range (Today / 7d / 14d / 30d / All) + **★ Fav**
- Search: metadata (path, title, session notes) + **deep content peek** via `GET /api/activity?q=…`
- Double-click a project header to open that cwd
- **Session conversion**: convert / clone sessions between Claude Code, Codex, and Grok
- **Project Goal + Notes**: one-line goal and multi-line notes per project (`.project_notes.json`)
- **Session favorites & notes**: star sessions; per-session notes (`.session_meta.json`)
- **Thin sessions**: ≤2 user turns show a `thin·N` badge
- Session history loads on click; sidebar is resizable

### Files preview

- Text / code: syntax highlighting (highlight.js)
- **docx / xlsx / pptx / pdf** preview (client-side libraries; binary over base64, ≤15MB)

### Workspaces

- Multiple Claude Code config dirs (different accounts, MCPs, settings) — Claude only
- Manage via ⚙️ → Settings: add name + path, delete
- Workspace tab bar appears when more than one workspace is configured

### Files / Git / Shell tabs

- **Files**: browse, upload, download, delete; custom root (`~` supported)
- **Git**: status, staged/unstaged diff, graph log; custom root
- **Shell**: interactive PTY via xterm.js + Python helper (`vim` / `htop` etc.)

### Meta Agent（内置 AI 助手）

Top bar **✦ Agent** — OpenAI-compatible tool agent (DeepSeek / OpenAI / local gateway…).

| Feature | Description |
|---------|-------------|
| **工作报告** | 手动生成今日 / 近 N 日「我做了啥」；可选整点自动日报 |
| **项目问答** | 搜会话、读摘要、项目 goal/notes、git status/log |
| **代码** | `write_file` + `run_command` 生成并运行（有危险命令拦截） |
| **VLM** | 粘贴/选图 → 上传为 `[imgN](路径)` 文本引用；需要时 `analyze_images`；`thread_id` 支持多轮追问 |

API Key 存在服务端 `.ai_config.json`（已 gitignore）。配置入口：Agent 面板 ⚙。

**Session 持久化（同一 sessionId；多图 = 多个 VLM thread 文件）**

```
.ai/sessions/                       # 或 AI_DATA_DIR/sessions
  index.json
  {sessionId}/
    meta.json
    messages.jsonl                  # 对话（一行一条，含 tool）
    vlm/
      {threadId}.jsonl              # 每个看图线程单独文件
                                    # 多图/多次 analyze → 多个 threadId
                                    # 文件内多行 = 该线程的多轮追问
```

删除会话会整目录删除。旧版 `session.json`、`vlm.jsonl`、`vlm/*.json`、全局 `.ai/vlm/` 会自动迁移。

Meta Agent 的实现入口：`src/agents/meta-agent.js`、`src/app.js`（`/api/ai/*`）与 `public/agent-panel.js`。

## Multi-machine (optional)

Only needed when sessions live on **several hosts** and you want **one public WebUI**.

For full hub/edge setup, env vars, and routing details see **[gateway/README.md](gateway/README.md)**.

### Quick overview

| Role | Tech | Responsibility |
|------|------|----------------|
| **Hub (中心端)** | **Go** binary `claude-gateway` + `public/` | Public UI, login, merge sessions, route by `machineId` |
| **Edge (业务机)** | **Node** `npm run client` | Agents, local sessions, files, git, shell on that machine |
| **Standalone** | **Node** `node server.js` | Everything on one machine — **no hub** |

```bash
# --- Hub (public VPS) ---
cd gateway && make linux-amd64
MACHINE_TOKEN=shared-secret \
HUB_USERNAME=admin HUB_PASSWORD=login-pass \
PUBLIC_DIR=/opt/claude-simple/public \
GATEWAY_ADDR=0.0.0.0:8080 \
./dist/claude-gateway-linux-amd64

# --- Edge on machine A ---
MACHINE_TOKEN=shared-secret MACHINE_ID=laptop-a \
  GATEWAY_URL=wss://ui.example.com/machine-connect npm run client

# --- Edge on machine B ---
MACHINE_TOKEN=shared-secret MACHINE_ID=build-b \
  GATEWAY_URL=wss://ui.example.com/machine-connect npm run client
```

In hub mode the UI:

- **Remembers** last machine in `localStorage` (no picker on every refresh)
- Full-screen picker only when first time or last machine is offline
- Top bar **Machines** menu: online/offline list + switch anytime
- Session list is filtered to the selected machine

An edge may still run `node server.js` for a **local-only** UI on that host (independent of the hub).

### Why Node on edges? (and Go later)

- **Hub is Go** — binary deploy, no Node on the public VPS.
- **Edge stays Node for now** — Claude Agent SDK, session scanners, and streaming agents are implemented in the existing Node app.
- A full Go rewrite of the edge is **not planned short-term** (install convenience can later use a Go wrapper around the Node app if needed).

Legacy Node hub: `npm run gateway` → `gateway.js` (prefer the Go binary).

## Stack

- **App backend (standalone / edge)**: Node.js + Express + `ws` + `@anthropic-ai/claude-agent-sdk` + Python PTY helper
- **Hub (optional multi-machine)**: Go (`gateway/`) — static UI, auth, fan-in sessions, HTTP/WS relay
- **Frontend**: ES modules + [mini-react](https://github.com/forechoandlook/mini-react) + DaisyUI + Tailwind + xterm.js
- **Storage**: IndexedDB (session cache) + JSON files (credentials, workspaces, project notes, session meta)
- **No build step** (dev): browser loads `public/*.js` directly; optional `npm run build` for `dist/`

## Agent backends

| Agent  | How it runs                                           | Resume            | Session store                            |
| ------ | ----------------------------------------------------- | ----------------- | ---------------------------------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` → Claude Code CLI | SDK `resume`    | `~/.claude/projects/**/*.jsonl`        |
| Codex  | `codex exec --json` / `codex exec resume <id>`    | thread_id         | `~/.codex/sessions/**/rollout-*.jsonl` |
| Grok   | `grok -p … --output-format streaming-json`         | `--resume <id>` | `~/.grok/sessions/<cwd>/<id>/`         |

The Memory tab lists files for the selected session's agent and loads their contents on click: Claude project memory, Codex account memory, or Grok session memory. Meta Agent can use `get_session_jsonl` to inspect a specific agent session's raw JSONL in bounded pages.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Standalone with `--watch` |
| `npm start` / `npm run serve` | Production standalone |
| `npm run build` | Bundle frontend into `dist/` |
| `npm run client` | Edge worker (requires hub) |
| `claude-edge status\|start\|stop\|restart\|logs` | Supervised edge (launchd / systemd). Also `claude-simple-edge`, `edge-daemon` |
| `npm run gateway` | Legacy Node hub |
| `npm run gateway:build` | Build Go hub via `gateway/Makefile` |

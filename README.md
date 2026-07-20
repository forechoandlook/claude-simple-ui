# Claude Simple UI (multi-agent)

A lightweight web UI for **Claude Code**, **OpenAI Codex**, and **Grok**. No build step — pure ES Modules in the browser.

Inspired by [cc-connect](https://github.com/chenhg5/cc-connect) agent adapters: Claude via the Agent SDK, Codex via `codex exec --json`, Grok via `grok --output-format streaming-json`.

## Quick Start

```bash
npm install
node server.js
# open http://localhost:3000
```

First run creates an account. Token persists 7 days — no repeated login.

Requires CLIs on `PATH` for the agents you use:

```bash
# Claude Code
# Codex
npm install -g @openai/codex
# Grok (xAI)
# install the grok CLI and run `grok login`
```

## Environment Variables

| Variable               | Default                           | Description                              |
| ---------------------- | --------------------------------- | ---------------------------------------- |
| `PORT`               | `3000`                          | HTTP port                                |
| `AGENTS`             | `claude,codex,grok`             | Enabled agents (comma-separated)         |
| `CLAUDE_CONFIG_DIRS` | `~/.claude`                     | Claude Code config dirs, comma-separated |
| `CLAUDE_CLI_PATH`    | `claude`                        | Path to Claude Code executable           |
| `CODEX_CLI_PATH`     | `codex`                         | Path to Codex CLI                        |
| `CODEX_HOME`         | `~/.codex`                      | Codex home (sessions, config)            |
| `GROK_CLI_PATH`      | `grok`                          | Path to Grok CLI                         |
| `GROK_HOME`          | `~/.grok`                       | Grok home (sessions)                     |
| `JWT_SECRET`         | persisted in`.credentials.json` | Override JWT signing key                 |

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
- Filters: agent (All/Claude/Codex/Grok) + time range (Today / 7d / 14d / 30d / All)
- Search: metadata (path, title) + **deep content peek** via `GET /api/activity?q=…`
- Double-click a project header to open that cwd
- **Session Conversion**: Convert / clone active sessions between Claude Code, Codex, and Grok on the fly (retaining conversation context)
- **Project Notes**: Manage project goals and notes centrally with inline editing in the chat header
- Session history loads on click; sidebar is resizable

### Workspaces

- Multiple Claude Code config dirs (different accounts, MCPs, settings) — Claude only
- Manage via ⚙️ → Settings: add name + path, delete
- Workspace tab bar appears automatically when more than one workspace is configured
- Each Claude session tagged with its workspace; correct `CLAUDE_CONFIG_DIR` is used when running Claude

### Files Tab

- Browse project files; click to view content
- Upload files (streaming, no size limit), download, delete
- Custom root path: type any path (supports `~`) → validated server-side via POST

### Git Tab

- Branch, working tree status with color-coded file statuses
- Unstaged / staged diff viewer
- Collapsible git graph (`git log --graph --oneline --all`)
- Custom root path: inspect any git repo regardless of session cwd

### Shell Tab

- Full interactive pseudoterminal (PTY) powered by `xterm.js` and a lightweight Python 3 `pty` fork helper
- Real-time character-by-character input mode (not line-buffered)
- Fully supports interactive TUI applications (e.g. `vim`, `top`, `htop`, `nano`)
- Interactive shell features: autocompletion (`Tab`), backspace, and native key navigation (`ArrowUp`/`ArrowDown` history)
- Auto-fit responsive terminal resizing (syncs terminal window dimensions dynamically between frontend and backend via PTY ioctls)
- Easy one-click reconnect and output clear

## Stack

- **Backend**: Node.js + Express + `ws` + `@anthropic-ai/claude-agent-sdk` + Python PTY subprocess helper (no native compilation required)
- **Frontend**: Vanilla ES Modules + [mini-react](https://github.com/forechoandlook/mini-react) (signals, keyedList, effects) + DaisyUI + Tailwind + xterm.js (local assets)
- **Storage**: IndexedDB (session cache, 5-min TTL) + JSON files (credentials, workspaces, JWT secret)
- **No build step** (dev): browser loads `.js` files directly; optional `npm run build` for dist/

## Agent backends

| Agent  | How it runs                                           | Resume            | Session store                            |
| ------ | ----------------------------------------------------- | ----------------- | ---------------------------------------- |
| Claude | `@anthropic-ai/claude-agent-sdk` → Claude Code CLI | SDK`resume`     | `~/.claude/projects/**/*.jsonl`        |
| Codex  | `codex exec --json` / `codex exec resume <id>`    | thread_id         | `~/.codex/sessions/**/rollout-*.jsonl` |
| Grok   | `grok -p … --output-format streaming-json`         | `--resume <id>` | `~/.grok/sessions/<cwd>/<id>/`         |

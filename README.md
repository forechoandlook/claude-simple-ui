# Claude Simple UI

A lightweight web UI for Claude Code. No build step — pure ES Modules in the browser.

## Quick Start

```bash
npm install
node server.js
# open http://localhost:3000
```

First run creates an account. Token persists 7 days — no repeated login.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `CLAUDE_CONFIG_DIRS` | `~/.claude` | Claude Code config dirs, comma-separated (e.g. `~/.claude,~/.claude-personal`) |
| `CLAUDE_CLI_PATH` | `claude` | Path to Claude Code executable |
| `JWT_SECRET` | persisted in `.credentials.json` | Override JWT signing key |

## Features

### Chat
- Stream responses from Claude Code via WebSocket
- Markdown rendering with syntax-highlighted code blocks
- Tool use cards (expandable), permission request banners
- Long messages auto-collapse (user: 200 chars, assistant: 500 chars)
- Token usage bar after each turn: `↑12.3k ↓2.1k · 8.5k cached · $0.023`
- Shell commands via `!cmd` prefix (runs in session cwd)

### Sessions
- Left sidebar lists all sessions across all workspaces
- Each item shows: absolute path + relative time
- Search by path or name, sort by time or project
- Session history loads on click (messages + per-turn token bars)
- Sidebar width is draggable; collapse/expand with the `◀` button

### Workspaces
- Multiple Claude Code config dirs (different accounts, MCPs, settings)
- Manage via ⚙️ → Settings: add name + path, delete
- Workspace tab bar appears automatically when more than one workspace is configured
- Each session tagged with its workspace; correct `CLAUDE_CONFIG_DIR` is used when running Claude

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
- Persistent bash session per WebSocket connection
- ANSI color rendering
- Command history (↑↓), Ctrl+C, Ctrl+D, Ctrl+L (clear)
- Authenticated via JWT token in query string
- No interactive TUI programs (no pty — vim/top won't work)

## Stack

- **Backend**: Node.js + Express + `ws` + `@anthropic-ai/claude-agent-sdk`
- **Frontend**: Vanilla ES Modules + [mini-react](https://github.com/forechoandlook/mini-react) (signals, keyedList, effects) + DaisyUI + Tailwind CDN
- **Storage**: IndexedDB (session cache, 5-min TTL) + JSON files (credentials, workspaces, JWT secret)
- **No build step**: browser loads `.js` files directly

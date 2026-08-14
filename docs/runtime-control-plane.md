# Runtime control plane (typed commands + low-pressure outbox)

Thin control plane inspired by T3’s orchestration/adapters split. Not a full
event-sourced engine — enough structure to make **command 透传** real and cut
mobile/Hub tunnel chatter.

## Client → server commands

Preferred shape:

```json
{ "type": "command", "cmd": "turn.start", "agent": "claude", "command": "…", "sessionId": "…", "options": { } }
```

| `cmd` | Purpose |
| ----- | ------- |
| `turn.start` | Start an agent turn (prompt + options) |
| `turn.interrupt` | Abort in-flight run |
| `approval.respond` | Allow/deny a `permission_request` (`requestId`, `allow`) |
| `shell.exec` | One-shot shell (`!cmd`) |
| `session.subscribe` | Bind socket to a session for run-status / reconnect |

Legacy aliases still work: `agent-command`, `abort-session`,
`claude-permission-response`, `shell-command`, `subscribe`.

## TODO: one active turn per session

Multiple WebSocket clients may subscribe to the same session: each client
should receive the live output and be able to reconnect while a turn is
running. However, a session must have **one writer**. Before dispatching
`turn.start`, atomically claim `(agent, sessionId)` in `activeSessions`; if it
is already busy, return a `session-busy` event rather than launching a second
`--resume <sessionId>` process. Release the claim on every completion, error,
and abort path.

The busy status must be broadcast to all subscribers. `turn.interrupt` remains
session-scoped, so any subscribed client can stop the single active turn.

## Server → client events

UI event types are **stable** (`assistant_delta`, `result`, `complete`, …).

New / important:

| type | Notes |
| ---- | ----- |
| `permission_request` | Claude `canUseTool` waiting on UI |
| `permission_resolved` | Clear permission banner |
| `batch` | `{ items: [ event, … ] }` — multiple events in one WS frame |

### Outbox (lower communication pressure)

Per chat socket:

1. **Drop** raw Claude SDK noise (`stream_event`, `user`, …) — was previously forwarded wholesale.
2. **Compact** large `tool_use.input` payloads.
3. **Coalesce** consecutive `assistant_delta` / `thought_delta` / `shell-output` (~45ms or ~720 chars).
4. **Batch** small non-urgent frames into `{ type: "batch", items }` (flush on timer, size, or urgent event).

Urgent (immediate): `error`, `complete`, `result`, `permission_request`, `session-created`, …

## Claude permission round-trip

When `permissionMode` is not auto/`bypassPermissions`:

```text
SDK canUseTool
  → permission_request (WS)
  → UI Allow/Deny
  → command approval.respond
  → resolve promise → SDK allow|deny
```

Codex/Grok still use headless CLI modes (no interactive approval IPC yet). Next
step for parity: Codex app-server / Grok ACP stdio adapters behind the same
command/event surface.

## File map

| Path | Role |
| ---- | ---- |
| `src/runtime/protocol.js` | `normalizeCommand`, `mapAgentEmit`, compact helpers |
| `src/runtime/outbox.js` | delta coalesce + batch frames |
| `src/runtime/approvals.js` | pending `canUseTool` promises |
| `src/agents/claude.js` | SDK adapter + permission bridge |
| `public/chat.js` | sends `command` / handles `batch` |

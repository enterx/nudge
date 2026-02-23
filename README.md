# Nudge

Approve AI coding tool actions from your phone.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node: 18+](https://img.shields.io/badge/Node-18%2B-green.svg)

Nudge sends permission requests and questions from your AI coding tool to your phone as push notifications. You approve or deny with a tap, and the tool continues -- no terminal required.

## How it works

```
┌──────────────┐     hooks      ┌─────────────┐     HTTPS     ┌──────────────┐
│  Claude Code │  ──────────>   │             │  ──────────>  │              │
│              │                │ Nudge Plugin│               │ Nudge Server │
│              │  <──────────   │             │  <──────────  │              │
└──────────────┘  allow/deny    └─────────────┘   SSE stream  └──────┬───────┘
                                                                     │
                                                                     │ FCM push
                                                                     v
                                                              ┌──────────────┐
                                                              │  Nudge App   │
                                                              │  (iOS)       │
                                                              └──────────────┘
```

1. Your AI tool triggers a permission-requiring action (Bash, Write, Edit, etc.)
2. The plugin hook intercepts it, creates an event on the Nudge server, and opens an SSE stream
3. The server sends a push notification to your phone via FCM
4. You tap Approve or Deny on your phone
5. The response flows back through the SSE stream to the hook
6. The AI tool receives `allow` or `deny` and continues

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **Nudge mobile app** installed on your phone
- **Claude Code**

## Installation

```bash
git clone https://github.com/user/nudge-plugin.git
cd nudge-plugin && bash build.sh
```

Then in Claude Code:
```
/plugin marketplace add /path/to/nudge-plugin/dist/claude-code
/plugin install nudge
```

## Quick start

```
1. /nudge:pair     → Generates a code. Enter it in the Nudge app.
2. Start coding    → Permission prompts appear on your phone.
3. /nudge:test     → Send a test notification to verify delivery.
```

## Commands

| Command | Description |
|---------|-------------|
| `/nudge:pair` | Pair your phone. Generates a 6-digit code. |
| `/nudge:test` | Send a test notification to verify push delivery. |
| `/nudge:status` | Check connection status, token validity, and server health. |
| `/nudge:mode` | Show or toggle ask mode. Usage: `/nudge:mode [nudge\|terminal]` |
| `/nudge:afk` | Switch to mobile mode (shortcut for `/nudge:mode nudge`). |
| `/nudge:desk` | Switch to terminal mode (shortcut for `/nudge:mode terminal`). |

## MCP tools

The plugin exposes three tools via its MCP server. The AI tool calls these directly.

### `nudge_ask_user`

Send a question to the user's phone. The user picks from options or types free text.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | The question to ask |
| `options` | array | Yes | 2-4 choices, each with `value` and `label` |
| `multiSelect` | boolean | No | Allow multiple selections. Default: `false` |
| `context` | string | No | Summary of what you are doing and why |
| `sessionName` | string | No | Session title shown on mobile |

### `nudge_approve`

Send an approval request (Approve / Deny).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `description` | string | Yes | What needs approval |
| `toolName` | string | No | Name of the action |
| `context` | string | No | Summary for the user |
| `toolInput` | object | No | Original tool input for rich display |
| `cwd` | string | No | Working directory |
| `sessionName` | string | No | Session title shown on mobile |

### `nudge_notify`

Send a one-way notification (fire-and-forget). Does not wait for a response.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Notification title |
| `body` | string | Yes | Notification body with details |
| `level` | string | No | `info` (default), `success`, `warning`, `error` |
| `context` | string | No | Conversation summary |
| `sessionName` | string | No | Session title shown on mobile |

## Hooks

| Hook event | Script | Mode | Purpose |
|------------|--------|------|---------|
| `SessionStart` | `nudge-session-start.sh` | sync | Injects ask-mode context |
| `PreToolUse` | `nudge-activity.mjs` | async | Activity notifications for WebSearch/WebFetch |
| `PermissionRequest` | `nudge-hook.mjs` | sync | Sends approval requests to phone |
| `SessionEnd` | `nudge-session-end.sh` | async | Notifies when the session ends |

### Graceful degradation

Every hook exits with code 0 on failure. The AI tool falls back to its built-in terminal prompt if Nudge is unreachable, unconfigured, or errors out. You never get stuck.

## Configuration

### Config file

Stored at `~/.nudge/config` (JSON, `chmod 600`). Created automatically by `/nudge:pair`.

```json
{
  "token": "<firebase-id-token>",
  "refreshToken": "<firebase-refresh-token>",
  "apiKey": "<firebase-web-api-key>",
  "userId": "<firebase-uid>",
  "apiUrl": "https://us-central1-enterx-nudge-dev.cloudfunctions.net",
  "pairingCode": "ABC-DEF",
  "askMode": "nudge"
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NUDGE_API_URL` | (from config) | Override the API URL |
| `NUDGE_DEBUG` | unset | Set to `1` for debug logging |

### Ask modes

- **`nudge`** (default): Questions go to your phone via `nudge_ask_user`.
- **`terminal`**: Questions stay in the terminal.

Toggle with `/nudge:mode`, `/nudge:afk`, or `/nudge:desk`.

## Repository structure

```
nudge-plugin/
├── core/                       # Shared code (source of truth)
│   ├── lib/                    # Node.js modules (api, config, sse, etc.)
│   ├── lib.sh                  # Shared bash utilities
│   ├── nudge-mcp-server.mjs    # MCP server (3 tools)
│   ├── nudge-*.sh              # Shared scripts (pair, mode, status, notify)
│   └── tests/                  # Test suite
├── adapters/
│   └── claude-code/            # Claude Code-specific files
│       ├── hooks/hooks.json    # Hook registration
│       ├── .mcp.json           # MCP server registration
│       ├── CLAUDE.md           # Context instructions
│       ├── commands/*.md       # Slash commands
│       └── scripts/            # Hook scripts (hook, activity, session)
├── build.sh                    # Assembles dist/ from core + adapters
└── dist/
    └── claude-code/            # Build output (self-contained, installable)
```

## Building

```bash
bash build.sh
```

This assembles a self-contained package in `dist/` by combining `core/` with the Claude Code adapter.

## Running tests

```bash
# Build first (tests run against dist)
bash build.sh

cd dist/claude-code/plugins/nudge && bash tests/run-all.sh
```

The test suite covers Node.js unit tests, MCP server tests, and shell script tests -- no live server required.

## Self-hosting

The Nudge backend (Cloud Functions + Firebase) is not included in this repository. The plugin communicates with the server via HTTPS REST endpoints:

- `POST /eventsCreate` -- Create an event (approval, elicitation, notification)
- `POST /eventsRespond/:eventId/respond` -- Respond to an event
- `POST /pairGenerate` -- Generate a pairing code
- `POST /pairVerify` -- Verify pairing status
- `POST /testNotification` -- Send a test push
- `GET /status` -- Health check

SSE streaming uses Firebase Realtime Database REST API for real-time response delivery.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) -- Copyright (c) 2026 EnterX LLC

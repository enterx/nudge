# Nudge

Approve AI coding tool actions from your phone -- with end-to-end encryption.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node: 18+](https://img.shields.io/badge/Node-18%2B-green.svg)
![Encryption: AES-256-GCM](https://img.shields.io/badge/Encryption-AES--256--GCM-brightgreen.svg)
![E2E: Zero Knowledge](https://img.shields.io/badge/E2E-Zero%20Knowledge-brightgreen.svg)

Nudge sends permission requests and questions from your AI coding tool to your phone as push notifications. You approve or deny with a tap, and the tool continues -- no terminal required.

**Your commands, code, and file paths are encrypted before leaving your machine.** The Nudge server only sees ciphertext -- it cannot read what you're approving. Push notifications are decrypted on-device via iOS Notification Service Extension / Android background handler. [See how it works.](#end-to-end-encryption)

## How it works

```
┌──────────────┐     hooks      ┌─────────────┐   encrypted   ┌──────────────┐
│  Claude Code │  ──────────>   │ Nudge Plugin│  ──────────>  │              │
│              │                │   AES-256   │   HTTPS/TLS   │ Nudge Server │
│              │  <──────────   │   encrypt   │  <──────────  │ (ciphertext  │
└──────────────┘  allow/deny    └─────────────┘   SSE stream  │  only)       │
                                                              └──────┬───────┘
                                                                     │
                                                                     │ FCM push
                                                                     │ (encrypted)
                                                                     v
                                                              ┌──────────────┐
                                                              │  Nudge App   │
                                                              │  decrypt on  │
                                                              │  device      │
                                                              └──────────────┘
```

1. Your AI tool triggers a permission-requiring action (Bash, Write, Edit, etc.)
2. The plugin **encrypts** the event (AES-256-GCM) and sends ciphertext to the Nudge server
3. The server forwards the encrypted push notification to your phone via FCM -- **it never sees plaintext**
4. Your phone **decrypts on-device** and shows the full command details
5. You tap Approve or Deny
6. The response flows back through the SSE stream, and the AI tool continues

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **Nudge mobile app** installed on your phone
- **Claude Code**

## Installation

In Claude Code:
```
/plugin marketplace add enterx/nudge-plugin
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
| `/nudge:afk` | Switch to mobile mode — questions go to your phone. |
| `/nudge:desk` | Switch to terminal mode — questions stay in the terminal. |

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

### AskUserQuestion routing — MCP recommended

The PermissionRequest hook also intercepts `AskUserQuestion` and forwards it to
mobile. However, this hook-based approach has **known event consistency issues**:
Claude Code sends SIGKILL to hook processes on cancellation (e.g., user presses
Escape), which cannot be caught — the hook has no opportunity to dismiss the
mobile card, leaving it in a pending state.

**The `nudge_ask_user` MCP tool is recommended** for questions in nudge mode.
MCP tools run within the MCP server process and are not subject to hook process
lifecycle, so event cleanup is reliable. The hook-based `AskUserQuestion`
forwarding remains available as an experimental fallback.

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
  "apiUrl": "https://your-nudge-api.cloudfunctions.net",
  "pairingCode": "ABC-DEF",
  "askMode": "nudge",
  "encryptionKey": "<base64-encoded-aes-256-key>"
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

Toggle with `/nudge:afk` or `/nudge:desk`.

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
│       ├── skills/             # Skill definitions
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
- `POST /pairKeyExchange` -- Store wrapped E2E encryption key
- `POST /testNotification` -- Send a test push
- `GET /status` -- Health check

SSE streaming uses Firebase Realtime Database REST API for real-time response delivery.

## End-to-end encryption

Nudge is **zero-knowledge by design**. All sensitive data is encrypted with **AES-256-GCM** before leaving your machine. The encryption key is generated locally and never sent to the server -- not even during pairing (the key is wrapped with PBKDF2 and only your phone can unwrap it).

**The Nudge server cannot read your commands, code, file paths, or project names.** It stores and forwards only ciphertext. Even if the server were compromised, your data remains encrypted.

### What's encrypted

| Field | Encrypted | Plaintext |
|-------|-----------|-----------|
| Tool input (commands, code, diffs) | Yes | — |
| Description (action summary) | Yes | — |
| Context (conversation summary) | Yes | — |
| Working directory (cwd) | Yes | — |
| Session name | Yes | — |
| Tool name (`Bash`, `Edit`, etc.) | — | Yes |
| Event pattern (`approval`, etc.) | — | Yes |

### How it works

```
1. /nudge:pair generates a random AES-256 key
2. Key is wrapped with PBKDF2(pairing_code, 600k iterations)
3. Wrapped key is uploaded — server can't unwrap it (code expires in 10 min)
4. Mobile app unwraps the key using the same pairing code
5. All subsequent events are encrypted before sending
```

### Push notifications

Encrypted payloads are decrypted **on your device** via iOS Notification Service Extension / Android background handler. Push notifications show full details (commands, file paths) without the server ever seeing plaintext.

### Audit the code

The encryption implementation is fully open-source:

- **Key generation & encryption**: [`core/lib/crypto.mjs`](core/lib/crypto.mjs)
- **Key exchange during pairing**: [`core/lib/setup-encryption.mjs`](core/lib/setup-encryption.mjs)
- **Event encryption before sending**: [`core/nudge-mcp-server.mjs`](core/nudge-mcp-server.mjs) (`encryptSensitiveFields`)

## Privacy & data handling

When you approve or deny an action, the following data is sent to the Nudge server:

- **Tool name** (e.g., `Bash`, `Edit`) -- plaintext, so push notification buttons work
- **Encrypted payload** -- your commands, code, descriptions, and context (AES-256-GCM ciphertext)
- **Your response** (approve/deny/selected options)

### How data is stored

| Data | Storage | Encrypted | Retention |
|------|---------|-----------|-----------|
| Event content (tool input, description, context, cwd, session name) | Firebase RTDB | Yes (AES-256-GCM) | 1h after response, 24h if unanswered |
| Tool name, pattern | Firebase RTDB | No | Same as above |
| Your response (approve/deny) | Firebase RTDB | No | Same as above |
| Device token (for push notifications) | Firestore | No | Until you unpair |
| Encryption key | Your device only | — | Never sent to server |

- A scheduled cleanup function runs every 24 hours to delete expired events.
- Deleting your account removes **all** stored data (events, device tokens, pairing records).
- Credentials in tool inputs (API keys, tokens, passwords) are **redacted before encryption** -- double protection.
- All communication uses HTTPS/TLS 1.3. Auth tokens are short-lived JWTs with automatic refresh.

### What the server NEVER sees

- Your source code, commands, or file contents (encrypted before sending)
- Your encryption key (generated and stored locally only)
- Conversation history or full prompts
- Environment variables or `.env` file contents

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting instructions.

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Anthropic, Google, or Firebase. "Claude Code" is a trademark of Anthropic. "Firebase" is a trademark of Google. All trademarks belong to their respective owners.

## License

[MIT](LICENSE) -- Copyright (c) 2026 EnterX LLC

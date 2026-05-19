# Nudge

Approve coding AI actions from your phone -- with end-to-end encryption.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node: 18+](https://img.shields.io/badge/Node-18%2B-green.svg)
![Encryption: AES-256-GCM](https://img.shields.io/badge/Encryption-AES--256--GCM-brightgreen.svg)
![E2E: Zero Knowledge](https://img.shields.io/badge/E2E-Zero%20Knowledge-brightgreen.svg)

Nudge sends permission requests and questions from your coding AI to your phone as push notifications. You approve or deny with a tap, and the tool continues -- no terminal required.

**Your commands, code, and file paths are encrypted before leaving your machine.** The Nudge server only sees ciphertext -- it cannot read what you're approving. Push notifications are decrypted on-device via iOS Notification Service Extension / Android background handler. [See how it works.](#end-to-end-encryption)

## How it works

```
┌──────────────┐     hooks      ┌─────────────┐   encrypted   ┌──────────────┐
│  Coding AI   │  ──────────>   │ Nudge Plugin│  ──────────>  │              │
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

1. Your AI tool (or your shell) triggers a permission-requiring action
2. The Nudge CLI / MCP server **encrypts** the event (AES-256-GCM) and sends ciphertext to the Nudge server
3. The server forwards the encrypted push notification to your phone via FCM -- **it never sees plaintext**
4. Your phone **decrypts on-device** and shows the full details
5. You tap Approve or Deny
6. The response flows back through the SSE stream, and the caller continues

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **Nudge mobile app** installed on your phone

## Three ways to use Nudge

| Capability | CLI (recommended) | MCP server (experimental) | Plugins / hooks (experimental) |
|---|:-:|:-:|:-:|
| Pair / unpair                                          | ○ | ○ | ○ |
| Connection & mode status                               | ○ | ○ | ○ |
| Send notification (`notify`)                           | ○ | ○ | ○ |
| Ask a question (`ask` / `nudge_ask_user`)              | ○ | ○ | ○ |
| Approval request (`approve` / `nudge_approve`)         | ○ | ○ | ○ |
| Switch ask mode (nudge / terminal)                     | ○ | ○ | ○ |
| End-to-end encryption                                  | ○ | ○ | ○ |
| **Auto-intercept tool calls (Bash / Edit / Write)**    | — | — | ○ (Claude Code) |
| Works in shell pipelines / CI / cron                   | ○ | — | — |
| Works without any AI-tool plugin framework             | ○ | — | — |
| Stability                                              | stable | experimental | experimental |

> The CLI is the recommended surface. The MCP server and the plugin/hooks integrations are experimental — use them only if you specifically need automatic interception of tool calls. Both rely on framework APIs that are still maturing.

## Installation

```bash
# Install the CLI globally (recommended)
npm install -g nudge-cli
```

Or clone & link from source:

```bash
git clone https://github.com/enterx/nudge.git
cd nudge
npm install -g .
```

This puts `nudge` on your `PATH`.

## Quick start

```bash
nudge pair                              # Generate code, enter it in the Nudge app
nudge notify --title "Build" --body "Tests passed" --level success
nudge ask "Pick env" -o dev:Dev -o prod:Prod
nudge approve "Deploy v1.2.3 to prod?" && ./deploy.sh
nudge status                            # Check connection / config
nudge mode terminal                     # Toggle ask mode (or `nudge`)
```

## CLI reference

### `nudge pair`

Pair your phone with this machine. Generates a pairing code; enter it in the Nudge app on your phone. Replaces any existing config.

### `nudge status [--mode nudge|terminal] [--json]`

Prints pairing state, server connectivity, auth token validity, current ask mode, and plugin/backend versions. Exits **3** if not paired.

### `nudge mode <nudge|terminal> [--json]`

Switch ask mode. `nudge` sends questions to your phone (AFK); `terminal` keeps them in the terminal (desk). Alias for `nudge status --mode <target>`.

### `nudge notify --title T --body B [options]`

Send a one-way push notification (fire-and-forget). Returns immediately.

| Option | Description |
|--------|-------------|
| `--title T` *(required)* | Notification title |
| `--body B` *(required)* | Notification body |
| `--level L` | `info` (default), `success`, `warning`, `error` |
| `--context C` | Free-form context shown on mobile |
| `--session S` | Session name shown on mobile |
| `--json` | Emit `{ "sent": true }` to stdout |

### `nudge ask <question> -o value:label [-o ...] [options]`

Send a question and wait for the user to pick on their phone. Default output is the selected `value`s, one per line, optionally followed by a blank line and a free-text reply. With `--json`, prints `{ selectedOptions, freeText }`.

| Option | Description |
|--------|-------------|
| `-o value:label[:description]` *(required, 2-4 times)* | A choice |
| `--multi` | Allow multiple selections |
| `--context C` | Free-form context shown on mobile |
| `--session S` | Session name shown on mobile |
| `--json` | Emit JSON to stdout |

### `nudge approve <description> [options]`

Send an approval request. **Exits 0 on approve, 1 on deny** — designed for shell chains like `nudge approve "..." && ./deploy.sh`.

| Option | Description |
|--------|-------------|
| `--tool NAME` | Tool name (e.g. `Deploy`, `Bash`) |
| `--cwd PATH` | Working directory shown on mobile |
| `--input JSON` | Original tool input (object) for rich mobile display |
| `--context C` | Free-form context shown on mobile |
| `--session S` | Session name shown on mobile |
| `--json` | Emit `{ approved, reason }` to stdout |

### Global options

| Option | Description |
|--------|-------------|
| `--json` | Print JSON to stdout instead of human-readable output |
| `-h`, `--help` | Show help (per-subcommand if positioned after the subcommand) |
| `-V`, `--version` | Print version |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success / approved |
| `1` | Denied (only for `approve`) |
| `2` | Usage / argument error |
| `3` | Not paired (run `nudge pair`) |
| `4` | Network / server error |
| `5` | Validation error |
| `130` | Cancelled by SIGINT (best-effort cancels the pending mobile event) |

## Recipes

```bash
# Notify when a long-running build finishes
make deploy && nudge notify --title "Deploy" --body "v1.2.3 live" --level success

# Approve a destructive op interactively
nudge approve "DROP TABLE users_old?" --tool Postgres && psql -c "DROP TABLE users_old"

# Ask which environment to deploy to from a CI job
ENV=$(nudge ask "Where should we ship?" -o staging:Staging -o prod:Prod --json | jq -r '.selectedOptions[0]')
./deploy.sh "$ENV"

# Use Nudge from a coding AI that doesn't speak MCP — just shell out
# (the AI calls Bash("nudge approve '...'") and reads the exit code)
```

## Experimental integrations

The CLI is the recommended way to use Nudge. The integrations below give richer UX (automatic tool-call interception) but depend on AI-tool framework APIs that are still maturing.

### MCP server (experimental)

Nudge ships an MCP server (`core/nudge-mcp-server.mjs`) exposing four tools that wrap the same handler code as the CLI:

| Tool | Equivalent CLI command |
|------|------------------------|
| `nudge_ask_user` | `nudge ask` |
| `nudge_approve` | `nudge approve` |
| `nudge_notify` | `nudge notify` |
| `nudge_status` | `nudge status` / `nudge mode` |

Use this if your AI tool's framework supports MCP and you want the model to invoke Nudge directly without shelling out. Register it like any other MCP server:

```jsonc
{
  "mcpServers": {
    "nudge": {
      "command": "node",
      "args": ["/path/to/nudge-cli/install/core/nudge-mcp-server.mjs"]
    }
  }
}
```

### Claude Code plugin (experimental)

The Claude Code plugin adds **hooks** that automatically intercept Bash / Write / Edit permission prompts and forward them to your phone — no model cooperation required.

Install from the published marketplace package:

```
/plugin marketplace add enterx/nudge
/plugin install nudge
```

| Hook event | Script | Mode | Purpose |
|------------|--------|------|---------|
| `SessionStart` | `nudge-session-start.sh` | sync | Injects ask-mode context |
| `PermissionRequest` | `nudge-hook.mjs` | sync | Sends approval requests to phone |
| `PostToolUse` | `nudge-cancel-pending.mjs` | async | Resolves orphaned events after tool completion |
| `PostToolUseFailure` | `nudge-cancel-pending.mjs` | async | Resolves orphaned events after tool failure |
| `SessionEnd` | `nudge-session-end.sh` | async | Cancels pending events, cleans up session |

**Known limitations:**
- `PermissionRequest` also intercepts `AskUserQuestion`, but Claude Code can send SIGKILL on cancellation (e.g., Escape) — the hook has no chance to dismiss the mobile card. Prefer `nudge_ask_user` (MCP) or `nudge ask` (CLI) when reliability matters.
- Every hook exits 0 on failure so Claude Code falls back to its built-in terminal prompt if Nudge is unreachable.

### Codex CLI plugin (experimental)

Codex CLI's hooks framework is still maturing — plugin-bundled hooks are opt-in (`[features].plugin_hooks = true`), `apply_patch` and MCP tool calls aren't reliably intercepted, and `PreToolUse` only honors `deny` decisions. Until those gaps close, the Codex adapter ships as **MCP tools + skills only**: tool-call approvals continue to use Codex's built-in terminal flow, and questions / notifications are routed to your phone via the MCP tools.

```bash
codex plugin marketplace add enterx/nudge
# then start Codex, run /plugins, find nudge, and enable it.
```

For local development:

```bash
codex plugin marketplace add /path/to/nudge
```

## Configuration

### Config file

Stored at `~/.nudge/config` (JSON, `chmod 600`). Created automatically by `nudge pair`.

```json
{
  "token": "<firebase-id-token>",
  "refreshToken": "<firebase-refresh-token>",
  "apiKey": "<firebase-web-api-key>",
  "userId": "<firebase-uid>",
  "apiUrl": "https://api.appnudge.dev",
  "pairingCode": "ABC-DEF",
  "encryptionKey": "<base64-encoded-aes-256-key>",
  "askMode": "nudge"
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NUDGE_API_URL` | (from config) | Override the API URL |
| `NUDGE_CONFIG_PATH` | `~/.nudge/config` | Override the config file location |
| `NUDGE_DEBUG` | unset | Set to `1` for debug logging |

### Ask modes

- **`nudge`** (default): Questions go to your phone.
- **`terminal`**: Questions stay in the terminal.

Toggle with `nudge mode nudge` / `nudge mode terminal`.

## Repository structure

```
nudge/
├── core/                       # Source of truth (shared by CLI, MCP, plugins)
│   ├── lib/                    # Node.js modules (api, config, sse, crypto, handlers, …)
│   ├── lib.sh                  # Shared bash utilities
│   ├── nudge-cli.mjs           # CLI entry (recommended surface)
│   ├── nudge-mcp-server.mjs    # MCP server (experimental)
│   ├── nudge-pair.sh           # Device pairing script
│   ├── nudge-notify.sh         # Notification helper script
│   └── tests/                  # Test suite
├── adapters/
│   ├── claude-code/            # Claude Code plugin (hooks + MCP + skills) — experimental
│   └── codex-cli/              # Codex CLI plugin (MCP + skills only) — experimental
├── package.json                # CLI npm package
├── build.sh                    # Assembles plugin dist/ packages
└── dist/                       # Plugin marketplace artifacts
    ├── claude-code/
    └── codex-cli/
```

## Building (plugin authors only)

You only need this if you're working on the experimental plugin adapters.

```bash
bash build.sh
```

Assembles self-contained packages in `dist/` by combining `core/` with each adapter. End users of the CLI (via `npm install`) do **not** need this.

## Running tests

```bash
# Plugin tests run against dist
bash build.sh
cd dist/claude-code/plugins/nudge && bash tests/run-all.sh

# CLI tests can also be run directly against core
bash core/tests/run-all.sh   # (run from a built dist directory; some shell tests require the bundled scripts)
```

The suite covers Node.js unit tests, MCP server tests, CLI argv tests, and shell script tests — no live server required.

## Self-hosting

The Nudge backend (Cloud Functions + Firebase) is not included in this repository. The CLI / MCP server / hooks communicate with the server via HTTPS REST endpoints:

- `POST /eventsCreate` -- Create an event (approval, elicitation, notification)
- `POST /eventsRespond/:eventId/respond` -- Respond to an event
- `POST /pushNotifyFn` -- Send a push notification (fire-and-forget)
- `POST /pairGenerate` -- Generate a pairing code
- `POST /pairVerify` -- Verify pairing status
- `POST /pairKeyExchange` -- Store wrapped E2E encryption key
- `POST /sessionEnd` -- Clean up session events
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
| Notification title | — | Yes |
| Session name | Yes | — |
| Tool name (`Bash`, `Edit`, etc.) | — | Yes |
| Event pattern (`approval`, etc.) | — | Yes |

### How it works

```
1. nudge pair generates a random AES-256 key
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
- **Event encryption before sending**: [`core/lib/handlers.mjs`](core/lib/handlers.mjs) (shared by CLI and MCP server), and [`adapters/claude-code/scripts/nudge-hook.mjs`](adapters/claude-code/scripts/nudge-hook.mjs) for the experimental hook path

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

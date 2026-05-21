# Nudge

Approve coding AI actions from your phone -- with end-to-end encryption.

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node: 18+](https://img.shields.io/badge/Node-18%2B-green.svg)
![Encryption: AES-256-GCM](https://img.shields.io/badge/Encryption-AES--256--GCM-brightgreen.svg)
![E2E: Zero Knowledge](https://img.shields.io/badge/E2E-Zero%20Knowledge-brightgreen.svg)

Nudge sends permission requests, questions, and status notifications from your terminal to your phone. You approve, deny, or answer from mobile, and the command continues.

**Your commands, code, and file paths are encrypted before leaving your machine.** The Nudge server only sees ciphertext -- it cannot read what you're approving. Push notifications are decrypted on-device via iOS Notification Service Extension / Android background handler. [See how it works.](#end-to-end-encryption)

## How it works

```
┌──────────────┐                ┌─────────────┐   encrypted   ┌──────────────┐
│  Terminal /  │  nudge ask /   │ Nudge CLI   │  ──────────>  │              │
│  script / AI │  approve /     │ AES-256     │   HTTPS/TLS   │ Nudge Server │
│  agent       │  notify        │ encrypt     │  <──────────  │ (ciphertext  │
└──────────────┘  <──────────   └─────────────┘   SSE stream  │  only)       │
                 answer / deny                               └──────┬───────┘
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

1. Your terminal, script, CI job, or coding agent runs `nudge ask`, `nudge approve`, or `nudge notify`
2. The Nudge CLI **encrypts** the event (AES-256-GCM) and sends ciphertext to the Nudge server
3. The server forwards the encrypted push notification to your phone via FCM -- **it never sees plaintext**
4. Your phone **decrypts on-device** and shows the full details
5. You tap Approve or Deny
6. The response flows back through the SSE stream, and the CLI exits with the right result

## Prerequisites

- **Node.js 18+** (uses built-in `fetch`)
- **Nudge mobile app** installed on your phone

## Install

```bash
npm install -g @enterx/nudge
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
nudge notify "Hello"                    # Send a test notification
nudge ask "Pick env" -o dev:Dev -o prod:Prod
nudge approve "Deploy v1.2.3 to prod?" && ./deploy.sh
nudge status                            # Check connection / config
nudge status --mode terminal            # Toggle ask mode (or `nudge`)
```

## CLI reference

### `nudge pair`

Pair your phone with this machine. Generates a pairing code; enter it in the Nudge app on your phone. Replaces any existing config.

### `nudge status [--mode nudge|terminal] [--json]`

Prints pairing state, server connectivity, auth token validity, current ask mode, and CLI/backend versions. Exits **3** if not paired.

### `nudge mode <nudge|terminal> [--json]` *(deprecated)*

Deprecated alias for `nudge status --mode <target>`. Prints a deprecation warning and forwards to `status`. Will be removed in v1.2.

### `nudge notify <body> [options]`

Send a one-way push notification (fire-and-forget). Returns immediately.
With one positional argument, the title defaults to `Nudge`. With two or more
positional arguments, the first is the title and the rest become the body.
`--title` and `--body` remain supported and override positional values.

| Option | Description |
|--------|-------------|
| `--title T` | Notification title |
| `--body B` | Notification body |
| `--level L` | `info` (default), `success`, `warning`, `error` |
| `--context C` | Free-form context shown on mobile |
| `--json` | Emit `{ "sent": true }` to stdout |

### `nudge ask <question> [options]`

Send a question and wait for the user to answer on their phone. You need **at least one** of `-o`, `--text`, or `--action` (or any combination).

Default output: one selected value per line, then a blank line, then the free-text reply, then `action: <key>` when the user picked a follow-up action. With `--json`, prints `{ selectedOptions, freeText, selectedAction? }`.

| Option | Description |
|--------|-------------|
| `-o value:label[:description]` *(0, or 2–4 times)* | A curated choice |
| `--multi` | Allow multiple `-o` selections |
| `--text` | Allow free-form text input (no `-o` required) |
| `--action key:label[:description]` *(repeatable)* | Follow-up action button (e.g. "Run /verify first"). The user's pick comes back as `selectedAction`. |
| `--context C` | Free-form context shown on mobile |
| `--diff <path>` | Attach a diff (file contents inlined into the encrypted payload) |
| `--files a,b,c` | Comma-separated list of affected files |
| `--exit-code N` | Numeric exit code (e.g. from a failing test) |
| `--tool-name S` | Short label for the tool/source (e.g. `go test`, `eslint`) |
| `--json` | Emit JSON to stdout |

### `nudge approve <description> [options]`

Send an approval request. **Exits 0 on approve, 1 on deny or follow-up action** — designed for shell chains like `nudge approve "..." && ./deploy.sh`. When the user taps a follow-up `--action` instead of approve/deny, exit is still `1` (shell chain skips the next step) and `selectedAction` is set so an agent reading JSON can react.

| Option | Description |
|--------|-------------|
| `--context C` | Free-form context shown on mobile |
| `--action key:label[:description]` *(repeatable)* | Follow-up action button (e.g. "Show diff first"). |
| `--diff <path>` / `--files a,b,c` / `--exit-code N` / `--tool-name S` | Structured context (same semantics as `ask`) |
| `--json` | Emit `{ approved, reason, selectedAction? }` to stdout |

### `nudge cancel <event-id|--last|--all|--session name>`

Cancel one or more in-flight mobile events **from another process**. Useful in CI cleanup traps, supervisor scripts, or when you want to dismiss an approval card from a different terminal without sending SIGINT to the original `nudge ask`/`approve` invocation.

Targets are resolved against `~/.nudge/pending-*.json` — the same tracking files written by the CLI and the Claude Code permission hook.

| Selector | Description |
|----------|-------------|
| `<event-id>` *(positional)* | Cancel exactly one event by its backend id |
| `--session <name>` | Cancel every pending event whose `sessionName` (or `sessionId`) matches |
| `--last` | Cancel only the most recently created pending event |
| `--all` | Cancel every pending event for this host |

Exactly one selector is required. `--last` / `--all` exit `0` when nothing is pending (no-op). `<event-id>` and `--session` exit `5` (validation) when no match is found.

```bash
# Safety net in CI: cancel any leftover mobile cards when the runner exits
trap 'nudge cancel --all' EXIT

# Cancel a specific approval from a sibling terminal
nudge cancel evt-XYZ123

# Cancel everything tagged with this work session
nudge cancel --session "Auth refactor"
```

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
make deploy && nudge notify "Deploy" "v1.2.3 live" --level success

# Approve a destructive op interactively
nudge approve "DROP TABLE users_old?" && psql -c "DROP TABLE users_old"

# Ask which environment to deploy to from a CI job
ENV=$(nudge ask "Where should we ship?" -o staging:Staging -o prod:Prod --json | jq -r '.selectedOptions[0]')
./deploy.sh "$ENV"

# Use Nudge from a coding AI — just shell out
# (the AI calls Bash("nudge approve '...'") and reads the exit code)

# Cancel a stuck approval from any process
nudge cancel --last
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
| `NUDGE_JSON_VERSION` | `1` | Set to `2` to opt into the unified JSON envelope (see below) |

### JSON output

By default, `--json` emits a per-command ad-hoc shape (e.g. `{ "approved": true, "reason": "" }`).

Set `NUDGE_JSON_VERSION=2` to opt into a unified envelope across every command:

```json
{ "ok": true,  "command": "ask",      "data": { "selectedOptions": ["dev"], "freeText": "" } }
{ "ok": true,  "command": "approve",  "data": { "approved": false, "reason": "rolling back" } }
{ "ok": false, "command": "ask",      "error": { "code": "NOT_PAIRED", "message": "..." } }
```

Error codes: `USAGE`, `NOT_PAIRED`, `NETWORK`, `VALIDATION`, `CANCELLED`, `ERROR`. In v2, errors are emitted to **stdout** (not stderr) so a single JSON parse covers both success and failure paths. The exit code still carries the same semantics (`0` success, `1` denied, `2` usage, `3` not paired, `4` network, `5` validation, `130` cancelled).

The v1 shape will remain available until v2.0.

### Ask modes

- **`nudge`** (default): Questions go to your phone.
- **`terminal`**: Questions stay in the terminal.

Toggle with `nudge status --mode nudge` / `nudge status --mode terminal`.

## Repository structure

```
nudge/
├── core/                       # CLI source of truth
│   ├── lib/                    # Node.js modules (api, config, sse, crypto, handlers, …)
│   ├── lib.sh                  # Shared bash utilities
│   ├── nudge-cli.mjs           # CLI entry (recommended surface)
│   ├── nudge-pair.sh           # Device pairing script
│   └── tests/                  # Test suite
├── package.json                # npm package
└── README.md
```

The repository also keeps legacy adapter code for Claude Code and Codex experiments, but the supported user-facing surface is the `nudge` CLI.

## Running tests

```bash
bash core/tests/run-all.sh
```

The suite covers config/token utilities, SSE parsing, CLI argv handling, and shell helper behavior. No live server is required.

## Self-hosting

The Nudge backend (Cloud Functions + Firebase) is not included in this repository. The CLI communicates with the server via HTTPS REST endpoints:

- `POST /eventsCreate` -- Create an event (approval, elicitation, notification)
- `POST /eventsRespond/:eventId/respond` -- Respond to an event
- `POST /pushNotifyFn` -- Send a push notification (fire-and-forget)
- `POST /pairGenerate` -- Generate a pairing code
- `POST /pairVerify` -- Verify pairing status
- `POST /pairKeyExchange` -- Store wrapped E2E encryption key
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
- **Event encryption before sending**: [`core/lib/handlers.mjs`](core/lib/handlers.mjs)

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

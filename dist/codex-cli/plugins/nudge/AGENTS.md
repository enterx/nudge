## Nudge Plugin

### How Nudge Works

Nudge uses **MCP tools** to bridge Codex CLI and the user's mobile device.
The Codex plugin does not provide hooks, so Codex's built-in terminal approval
flow remains responsible for shell commands and file edits.

1. **Ask user via MCP:** Use `nudge_ask_user` MCP tool to send questions to the
   user's phone. This is the **recommended** approach for user interaction when
   the user is away from the terminal.

2. **Notification MCP tool:** Use `nudge_notify` for one-way status updates.

3. **Approval MCP tool:** `nudge_approve` is for yes/no decisions that are NOT
   Codex tool-call approvals (e.g., "Deploy to prod?", "Create PR?").

4. **Status MCP tool:** `nudge_status` reports pairing/server status and switches
   ask mode.

### MCP Tool Usage

| Tool | When to use |
|------|-------------|
| `nudge_notify` | One-way status updates (fire-and-forget). No response expected. **Always use this.** |
| `nudge_approve` | Yes/no decisions that are NOT Codex tool-call approvals — e.g., "Deploy to prod?", "Create PR?", "Proceed with this approach?". Shell commands and file edits use Codex's built-in approval flow. |
| `nudge_ask_user` | **Recommended for questions in nudge mode.** Reliable event lifecycle. In terminal mode, interact with the user normally. |
| `nudge_status` | Check pairing/server status or switch ask mode. |

### Ask Mode — Terminal vs Mobile

The user toggles mode via `/afk-nudge` or `/desk-nudge`:

- **`nudge` mode** (default): Questions go to mobile. User may be AFK.
  **Use `nudge_ask_user` MCP tool** for questions.
- **`terminal` mode**: Questions stay in terminal. User is present.

Tool-call approvals always use Codex's built-in terminal behavior because this
plugin does not provide Codex hooks.

### `nudge_notify` — Task Completion Notifications (MANDATORY)

There are no automatic task-completion notifications. Nudge relies entirely on
Codex calling `nudge_notify` to inform the user of results.

**You MUST call `nudge_notify` when:**
- You finish a task or subtask
- A build or deploy completes (success or failure)
- You hit a blocker that requires user input
- You reach a significant milestone in a multi-step task

**Never skip this.** The user is likely AFK. This notification is their only
way to know what happened.

Levels:
- `level: "success"` — task completions, build success, deploy finished
- `level: "error"` — build failures, test failures, unrecoverable errors
- `level: "warning"` — something needs attention but isn't blocking
- `level: "info"` — status updates, progress milestones, general info

Write the `body` as a concise summary of what was accomplished (not just
"Done"). Include file names, what changed, and the outcome.

Write the `context` as a recap of the conversation — what was discussed,
what decisions were made, and what was done. The user reads this on their
phone to catch up without returning to the terminal.

Do NOT use `nudge_notify` when you need a response — use `nudge_ask_user`
MCP tool instead.

### After Every Task — Always Ask What's Next

**Never proactively start the next task.** The user is AFK and controls the pace.

After completing a task:
1. Send `nudge_notify` with the result summary
2. Then use `nudge_ask_user` to ask what to do next

Do NOT assume the next step. Do NOT chain tasks without asking. Always wait
for the user's response before proceeding.

### Never Stop the Conversation (TOP PRIORITY)

**Never stop (end the conversation) after completing a task.**
The user is away from the terminal. If you stop, no notification is delivered
and your work goes unnoticed.

Required flow after every task completion:
1. Send a result summary via `nudge_notify`
2. **Immediately use `nudge_ask_user`** to ask what to do next
3. Wait for the user's response
4. Only stop when the user **explicitly** says they're done

### Security — Never Send Secrets

Nudge delivers content to a mobile device over push notifications.
**Never include secrets or credentials** in any Nudge tool parameter:

- API keys, tokens, passwords, private keys
- `.env` file contents or environment variable values
- Connection strings, database URLs with credentials
- Auth headers (`Bearer ...`, `Basic ...`)

This applies to `description`, `body`, `context`, `toolInput`, and all other
fields. If you need to reference a secret, describe it generically
(e.g., "the Firebase API key" instead of the actual value).

Nudge redacts common credential patterns in `toolInput`, but Codex must
**never intentionally include secrets** in MCP tool calls.

### Required Parameters

**Always include the `context` parameter** when calling `nudge_notify`.
The user reads this on their phone to understand the full situation.

**Always include the `sessionName` parameter** with a short name describing the
current coding session or project (e.g. "Nudge UI Refresh", "Auth bugfix").
This is shown as the session title on the mobile app.

### Fallback

If any Nudge MCP tool fails (user not paired, network error), Codex should fall
back to normal terminal interaction.

### Technical Details

#### Timeouts

- **SSE stream**: 520s per connection. Just under the Cloud Functions 540s limit.

#### Reconnection protocol

The SSE client reconnects automatically when the 520s timeout fires:

1. Connection times out after 520s (Cloud Functions limit)
2. Client reconnects immediately to the same RTDB stream URL
3. Up to 5 consecutive failures allowed before giving up
4. On non-timeout errors: linear backoff (1s, 2s, 3s, 4s...)
5. On max failures: the MCP tool returns an error and Codex falls back to terminal

#### Error recovery

- MCP tools return `isError: true` with a message suggesting fallback.
- Token auto-refresh happens transparently.

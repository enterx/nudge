## Nudge Plugin

### How Nudge Works

Nudge uses **hooks** and **MCP tools** to bridge Codex CLI and the user's mobile device:

1. **Approval hook (automatic):** Intercepts shell commands and file-modifying tool
   calls via PreToolUse. The user approves/denies on their phone.
   This happens **automatically** — Codex does NOT need to do anything.
   Read-only tools (read_file, list_dir, search, etc.) are auto-allowed.

2. **Ask user via MCP:** Use `nudge_ask_user` MCP tool to send questions to the
   user's phone. This is the **recommended** approach for user interaction when
   the user is away from the terminal.

3. **Notification MCP tool (explicit):** `nudge_notify` is the only other MCP tool
   Codex should call directly, for one-way status updates.

4. **Approval MCP tool:** `nudge_approve` is for yes/no decisions that are NOT
   tool-call approvals (e.g., "Deploy to prod?", "Create PR?").

### Ask Mode — Terminal vs Mobile

The user toggles mode via `/afk-nudge` or `/desk-nudge`:

- **`nudge` mode** (default): Questions and approvals go to mobile. User is AFK.
  **Use `nudge_ask_user` MCP tool** for questions.
- **`terminal` mode**: Questions and approvals stay in terminal. User is present.

The active mode is injected via SessionStart hook.

### MCP Tool Usage

| Tool | When to use |
|------|-------------|
| `nudge_notify` | One-way status updates (fire-and-forget). No response expected. **Always use this.** |
| `nudge_approve` | Yes/no decisions that are NOT tool-call approvals — e.g., "Deploy to prod?", "Create PR?", "Proceed with this approach?". Tool-call approvals (shell, file edits) are handled automatically by hooks. |
| `nudge_ask_user` | **Recommended for questions in nudge mode.** Reliable event lifecycle. In terminal mode, interact with the user normally. |

### `nudge_notify` — Task Completion Notifications (MANDATORY)

**There are no automatic task-completion notification hooks.** Nudge relies
entirely on Codex calling `nudge_notify` to inform the user of results.

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

The hook automatically redacts common credential patterns in `toolInput`,
but Codex must **never intentionally include secrets** in MCP tool calls.

### Required Parameters

**Always include the `context` parameter** when calling `nudge_notify`.
The user reads this on their phone to understand the full situation.

**Always include the `sessionName` parameter** with a short name describing the
current coding session or project (e.g. "Nudge UI Refresh", "Auth bugfix").
This is shown as the session title on the mobile app.

### Fallback

If any nudge hook or tool fails (user not paired, network error), Codex CLI
falls back to the corresponding built-in behavior (terminal prompt for approvals).

### Tool Classification

The PreToolUse hook classifies tools as follows:

**Require mobile approval (write/execute):**
- `shell`, `bash`, `Bash` — shell command execution
- `write_file`, `create_file`, `edit_file`, `apply_patch` — file modifications
- `replace_in_file`, `delete_file`, `remove_file` — file mutations

**Auto-allowed (read-only):**
- `read_file`, `list_dir`, `search`, `grep`, `glob` — file reading
- `WebSearch`, `WebFetch` — web access

Unknown tools default to requiring approval (safe default).

### Technical Details

#### Timeouts

- **SSE stream**: 520s per connection. Just under the Cloud Functions 540s limit.
- **PreToolUse hook**: 86400s (24 hours). The user may be AFK for hours.
- **PostToolUse hook**: 10s. Cleanup of pending mobile events.
- **Stop hook**: 10s. Session cleanup.
- **SessionStart hook**: 5s. Reads config and outputs context.

#### Reconnection protocol

The SSE client reconnects automatically when the 520s timeout fires:

1. Connection times out after 520s (Cloud Functions limit)
2. Client reconnects immediately to the same RTDB stream URL
3. Up to 5 consecutive failures allowed before giving up
4. On non-timeout errors: linear backoff (1s, 2s, 3s, 4s...)
5. On max failures: throws error, hook exits 0, Codex CLI falls back to terminal

#### Error recovery

- All hooks exit 0 on any error. This triggers Codex CLI's built-in terminal
  fallback rather than blocking the session.
- MCP tools return `isError: true` with a message suggesting fallback.
- Token auto-refresh happens transparently.

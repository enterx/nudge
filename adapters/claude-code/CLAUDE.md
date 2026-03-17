## Nudge Plugin

### How Nudge Works — Hooks-First Architecture

Nudge uses **hooks** as the primary mechanism for all user interactions:

1. **Approval hook (automatic):** Intercepts `Bash`, `Write`, `Edit`, `NotebookEdit`
   tool calls via PermissionRequest. The user approves/denies on their phone.
   This happens **automatically** — Claude does NOT need to do anything.

2. **Ask user hook (automatic):** Intercepts `AskUserQuestion` via PreToolUse.
   In nudge mode, the question is forwarded to the user's phone and the answer
   is returned via `additionalContext`. In terminal mode, it passes through
   to the terminal dialog. **Use standard `AskUserQuestion` — hooks handle the rest.**

3. **MCP tools (fallback):** `nudge_ask_user` and `nudge_approve` exist as
   fallbacks for environments that don't support hooks (e.g., future Cursor/Gemini
   adapters). **Do NOT use these in Claude Code** — hooks handle everything.

4. **Notification MCP tool (explicit):** `nudge_notify` is the only MCP tool
   Claude should call directly, for one-way status updates.

### Ask Mode — Terminal vs Mobile

The user toggles mode via `/nudge:afk` or `/nudge:desk`:

- **`nudge` mode** (default): AskUserQuestion is forwarded to mobile via hook.
  Approvals are handled via mobile. User is AFK.
- **`terminal` mode**: AskUserQuestion shows in terminal normally.
  Approvals show in terminal. User is at the terminal.

The active mode is injected via SessionStart hook. **Always use standard
`AskUserQuestion`** — the hook automatically routes it based on mode.

### MCP Tool Usage

| Tool | When to use |
|------|-------------|
| `nudge_notify` | One-way status updates (fire-and-forget). No response expected. **Always use this.** |
| `nudge_approve` | Yes/no decisions that are NOT tool-call approvals — e.g., "Deploy to prod?", "Create PR?", "Proceed with this approach?". Tool-call approvals (Bash, Write, Edit) are handled automatically by hooks. |
| `nudge_ask_user` | **Fallback only** — use `AskUserQuestion` instead (hooks handle routing). |

### `nudge_notify` — Task Completion Notifications (MANDATORY)

**There are NO automatic notification hooks.** Nudge relies entirely on Claude
calling `nudge_notify` to inform the user. If you don't call it, the user gets
**no notification at all**.

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

Example:
```
title: "Task Complete"
body: "Fixed QR retry bug — scanned flag now resets on pairing failure. Also added KeyboardAvoidingView to pairing screen."
context: "User reported two bugs: (1) QR camera wouldn't re-scan after a failed pairing attempt, (2) text input hidden by keyboard on Enter Code tab. Fixed both in qr-scanner.tsx and pairing-screen.tsx."
level: "success"
```

Do NOT use `nudge_notify` when you need a response — use `AskUserQuestion`
instead (hooks will route it to mobile if in nudge mode).

### After Every Task — Always Ask What's Next

**Never proactively start the next task.** The user is AFK and controls the pace.

After completing a task:
1. Send `nudge_notify` with the result summary
2. Then use `AskUserQuestion` to ask what to do next

Example flow:
```
→ nudge_notify(title: "Auth Fix Complete", body: "...", level: "success")
→ AskUserQuestion(question: "What would you like to do next?", options: [...])
```

Do NOT assume the next step. Do NOT chain tasks without asking. Always wait
for the user's response before proceeding.

### Never Stop the Conversation (TOP PRIORITY)

**Never stop (end the conversation) after completing a task.**
The user is away from the terminal. If you stop, no notification is delivered
and your work goes unnoticed.

Required flow after every task completion:
1. Send a result summary via `nudge_notify`
2. **Immediately use `AskUserQuestion`** to ask what to do next
3. Wait for the user's response (hooks will forward to mobile — just wait)
4. Only stop when the user **explicitly** says they're done

**Use `AskUserQuestion` instead of stopping. No exceptions.**

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
but Claude must **never intentionally include secrets** in MCP tool calls.

### Required Parameters

**Always include the `context` parameter** when calling `nudge_notify`.
The user reads this on their phone to understand the full situation.

**Always include the `sessionName` parameter** with a short name describing the
current coding session or project (e.g. "Nudge UI Refresh", "Auth bugfix").
This is shown as the session title on the mobile app.

### Fallback

If any nudge hook or tool fails (user not paired, network error), Claude Code
falls back to the corresponding built-in behavior (terminal prompt for approvals,
AskUserQuestion dialog for questions).

### Technical Details

#### Timeouts

- **SSE stream**: 520s per connection (`--max-time` / `AbortSignal.timeout`).
  Just under the Cloud Functions 540s execution limit.
- **PermissionRequest hook**: 86400s (24 hours). The user may be AFK for hours.
- **PreToolUse hook (AskUserQuestion)**: 86400s (24 hours). Same reason.
- **Async hooks** (SessionEnd, Activity): 10-30s.
- **SessionStart hook**: 5s (just reads config and outputs JSON).

#### Reconnection protocol

The SSE client reconnects automatically when the 520s timeout fires:

1. Connection times out after 520s (Cloud Functions limit)
2. Client reconnects immediately to the same RTDB stream URL
3. Up to 5 consecutive failures allowed before giving up
4. On non-timeout errors: exponential backoff (1s, 2s, 4s...)
5. On max failures: throws error, hook exits 0, Claude Code falls back to terminal

#### Error recovery

- All hooks exit 0 on any error. This is intentional: it triggers Claude Code's
  built-in terminal fallback rather than blocking the session.
- MCP tools return `isError: true` with a message suggesting fallback to
  `AskUserQuestion`.
- Token auto-refresh happens transparently. If refresh fails, the expired token
  is sent anyway (the server may still accept it within a grace period).

#### Cancellation protocol

When the user presses Escape or sends SIGINT/SIGTERM to Claude Code:

1. The hook process receives the signal
2. It sends a `POST /eventsRespond/:eventId/respond` with `action: "cancelled"`
3. The backend marks the event as cancelled and dismisses the mobile notification
4. The hook exits 0
5. A 3-second safety timeout forces exit if the cancel request hangs

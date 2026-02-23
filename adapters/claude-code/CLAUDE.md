## Nudge Plugin

### How Nudge Works — Two Systems

Nudge has **two separate mechanisms**. Understanding the boundary prevents
double notifications:

1. **Hook (automatic):** Intercepts `Bash`, `Write`, `Edit`, `NotebookEdit`
   tool calls via PreToolUse. The user approves/denies on their phone.
   This happens **automatically** — Claude does NOT need to do anything.

2. **MCP tools (explicit):** Claude calls these directly for communication
   that is NOT a tool-call approval.

### Ask Mode — Terminal vs Mobile

The user can toggle how questions are delivered via `/nudge:mode`:

- **`nudge` mode** (default): Use `nudge_ask_user` for questions. User is AFK.
- **`terminal` mode**: Use standard `AskUserQuestion`. User is at the terminal.

The active mode is injected via SessionStart hook. Check the context message
at session start — it will say either "Ask mode: NUDGE" or "Ask mode: TERMINAL".
**Follow this instruction** — it overrides the default MCP tool usage below.

### MCP Tool Usage

| Tool | When to use |
|------|-------------|
| `nudge_ask_user` | Questions, choices, gathering preferences. Use **instead of** `AskUserQuestion` when in nudge mode. |
| `nudge_approve` | High-level decisions that are NOT tool calls (e.g., "Deploy to prod?", "Refactor this module?"). **Never** use for actions that will trigger a Bash/Write/Edit tool call — the hook already handles those. |
| `nudge_notify` | One-way status updates (fire-and-forget). No response expected. |

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

Do NOT use `nudge_notify` when you need a response — use `nudge_ask_user` or
`nudge_approve` instead.

### Required Parameters

**Always include the `context` parameter** when calling `nudge_ask_user`,
`nudge_approve`, or `nudge_notify`. The user reads this on their phone to
understand the full situation.

**Always include the `sessionName` parameter** with a short name describing the
current coding session or project (e.g. "Nudge UI Refresh", "Auth bugfix").
This is shown as the session title on the mobile app.

### Fallback

If any nudge tool fails (user not paired, network error), fall back to the
corresponding built-in tool (AskUserQuestion or terminal prompt).

### Technical Details

#### Timeouts

- **SSE stream**: 520s per connection (`--max-time` / `AbortSignal.timeout`).
  Just under the Cloud Functions 540s execution limit.
- **PermissionRequest hook**: 86400s (24 hours). The user may be AFK for hours.
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

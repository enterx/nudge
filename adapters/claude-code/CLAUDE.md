## Nudge Plugin

### How Nudge Works

Nudge uses **hooks** and **MCP tools** to bridge Claude Code and the user's mobile device:

1. **Approval hook (automatic):** Intercepts `Bash`, `Write`, `Edit`, `NotebookEdit`
   tool calls via PermissionRequest. The user approves/denies on their phone.
   This happens **automatically** — Claude does NOT need to do anything.

2. **Ask user via MCP (recommended):** Use `nudge_ask_user` MCP tool to send
   questions to the user's phone. This is the **recommended** approach because
   MCP tools have clean lifecycle management and reliable event consistency.

3. **Ask user via hook (experimental):** A PermissionRequest hook also intercepts
   `AskUserQuestion` and forwards it to mobile. However, this approach has
   **known event consistency issues** — see "Known Limitations" below.
   Use `nudge_ask_user` MCP tool instead when in nudge mode.

4. **Notification MCP tool (explicit):** `nudge_notify` is the only other MCP tool
   Claude should call directly, for one-way status updates.

5. **Approval MCP tool:** `nudge_approve` is for yes/no decisions that are NOT
   tool-call approvals (e.g., "Deploy to prod?", "Create PR?").

### Ask Mode — Terminal vs Mobile

The user toggles mode via `/nudge:afk` or `/nudge:desk`:

- **`nudge` mode** (default): Questions and approvals go to mobile. User is AFK.
  **Use `nudge_ask_user` MCP tool** for questions (not `AskUserQuestion`).
- **`terminal` mode**: Questions and approvals stay in terminal. User is present.
  Use standard `AskUserQuestion` — it shows in the terminal normally.

The active mode is injected via SessionStart hook.

### MCP Tool Usage

| Tool | When to use |
|------|-------------|
| `nudge_notify` | One-way status updates (fire-and-forget). No response expected. **Always use this.** |
| `nudge_approve` | Yes/no decisions that are NOT tool-call approvals — e.g., "Deploy to prod?", "Create PR?", "Proceed with this approach?". Tool-call approvals (Bash, Write, Edit) are handled automatically by hooks. |
| `nudge_ask_user` | **Recommended for questions in nudge mode.** Reliable event lifecycle — no consistency issues with cancellation. In terminal mode, use standard `AskUserQuestion` instead. |

### `nudge_notify` — Task Completion Notifications (MANDATORY)

**There are no automatic task-completion notification hooks.** Nudge relies
entirely on Claude calling `nudge_notify` to inform the user of results.
(Note: PreToolUse sends activity notifications for WebSearch/WebFetch
automatically, but task outcomes are NOT auto-notified.)

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

Do NOT use `nudge_notify` when you need a response — use `nudge_ask_user`
MCP tool instead (in nudge mode) or `AskUserQuestion` (in terminal mode).

### After Every Task — Always Ask What's Next

**Never proactively start the next task.** The user is AFK and controls the pace.

After completing a task:
1. Send `nudge_notify` with the result summary
2. Then use `nudge_ask_user` (nudge mode) or `AskUserQuestion` (terminal mode)
   to ask what to do next

Example flow:
```
→ nudge_notify(title: "Auth Fix Complete", body: "...", level: "success")
→ nudge_ask_user(question: "What would you like to do next?", options: [...])
```

Do NOT assume the next step. Do NOT chain tasks without asking. Always wait
for the user's response before proceeding.

### Never Stop the Conversation (TOP PRIORITY)

**Never stop (end the conversation) after completing a task.**
The user is away from the terminal. If you stop, no notification is delivered
and your work goes unnoticed.

Required flow after every task completion:
1. Send a result summary via `nudge_notify`
2. **Immediately use `nudge_ask_user`** (nudge mode) or **`AskUserQuestion`**
   (terminal mode) to ask what to do next
3. Wait for the user's response
4. Only stop when the user **explicitly** says they're done

**Use `nudge_ask_user` / `AskUserQuestion` instead of stopping. No exceptions.**

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

### Known Limitations — Hook-Based AskUserQuestion (Experimental)

The PermissionRequest hook for `AskUserQuestion` has **known event consistency
issues** due to how Claude Code manages hook process lifecycle:

- **SIGKILL on cancellation:** When the user presses Escape, Claude Code sends
  SIGKILL (signal 9) to the hook process — not SIGINT or SIGTERM. SIGKILL cannot
  be caught, so the hook has **no opportunity to clean up** or notify the backend.
  This leaves the mobile card in a pending state (not dismissed).

- **No graceful shutdown:** Because the process is killed immediately, any
  in-flight API calls (e.g., cancelling the event on the backend) are aborted.
  The `cancelAndExit` handler in the hook code never executes on Escape.

- **PostToolUse fallback is unreliable:** The `nudge-cancel-pending.mjs` hook
  attempts to clean up orphaned events, but PostToolUse/PostToolUseFailure hooks
  have known issues with cancelled tool calls (see Claude Code GitHub issues
  #4113, #19298).

**This is why `nudge_ask_user` MCP tool is recommended over `AskUserQuestion`
in nudge mode.** MCP tools are not subject to hook process lifecycle — they run
within the MCP server process and can manage event cleanup reliably.

The approval hook (PermissionRequest for Bash/Write/Edit) is less affected
because approvals have a clear terminal fallback: if the hook is killed, Claude
Code shows the terminal prompt and the PostToolUse hook resolves the mobile event.

### Technical Details

#### Timeouts

- **SSE stream**: 520s per connection (`--max-time` / `AbortSignal.timeout`).
  Just under the Cloud Functions 540s execution limit.
- **PermissionRequest hook**: 86400s (24 hours). The user may be AFK for hours.
  Also handles AskUserQuestion forwarding to mobile.
- **PreToolUse hook** (Activity): 15s. Sends activity notifications for WebSearch/WebFetch.
- **Async hooks** (PostToolUse, PostToolUseFailure, SessionEnd): 10-30s.
- **SessionStart hook**: 5s (just reads config and outputs JSON).

#### Reconnection protocol

The SSE client reconnects automatically when the 520s timeout fires:

1. Connection times out after 520s (Cloud Functions limit)
2. Client reconnects immediately to the same RTDB stream URL
3. Up to 5 consecutive failures allowed before giving up
4. On non-timeout errors: linear backoff (1s, 2s, 3s, 4s...)
5. On max failures: throws error, hook exits 0, Claude Code falls back to terminal

#### Error recovery

- All hooks exit 0 on any error. This is intentional: it triggers Claude Code's
  built-in terminal fallback rather than blocking the session.
- MCP tools return `isError: true` with a message suggesting fallback to
  `AskUserQuestion`.
- Token auto-refresh happens transparently. If refresh fails, the expired token
  is sent anyway (the server may still accept it within a grace period).

#### Cancellation protocol

**Intended behavior** (when the hook receives SIGINT/SIGTERM):

1. The hook process receives the signal
2. It sends a `POST /eventsRespond/:eventId/respond` with `action: "cancelled"`
3. The backend marks the event as cancelled and dismisses the mobile notification
4. The hook exits 0
5. A 3-second safety timeout forces exit if the cancel request hangs

**Actual behavior** (current Claude Code limitation):

Claude Code sends **SIGKILL** to hook processes on Escape, which cannot be caught.
The cancellation handler does not execute, and the mobile event remains pending.
For approval hooks, the PostToolUse fallback (`nudge-cancel-pending.mjs`) usually
resolves the orphaned event. For AskUserQuestion hooks, cleanup is unreliable —
this is a primary reason `nudge_ask_user` MCP tool is recommended instead.

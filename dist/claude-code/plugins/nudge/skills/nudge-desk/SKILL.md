---
name: nudge-desk
description: "Switch to terminal mode — questions stay in the terminal"
---

Switch Nudge to desk (terminal) mode by calling the `mcp__plugin_nudge_nudge-mcp__nudge_status` tool with `mode: "terminal"`.

Show the result to the user.

**IMPORTANT — Immediate mode switch:** From this point forward in the current session, you MUST use `AskUserQuestion` for all questions. Do NOT use `nudge_ask_user`. The user is at the terminal. This overrides any previous nudge-mode instruction.

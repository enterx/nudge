---
name: desk-nudge
description: "Switch to terminal mode — questions stay in the terminal"
---

Switch Nudge to desk (terminal) mode by calling the `nudge_status` MCP tool with `mode: "terminal"`.

Show the result to the user.

**IMPORTANT — Immediate mode switch:** From this point forward in the current session, interact with the user via the terminal for all questions. Do NOT use `nudge_ask_user`. The user is at the terminal. This overrides any previous "Ask mode: NUDGE" instruction from SessionStart.

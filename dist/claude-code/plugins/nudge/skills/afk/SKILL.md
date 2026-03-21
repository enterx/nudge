---
name: afk
description: "Switch to mobile mode — questions and approvals go to your phone"
---

Switch Nudge to AFK (mobile) mode by calling the `mcp__plugin_nudge_nudge-mcp__nudge_mode` tool with `mode: "nudge"`.

Show the result to the user.

**IMPORTANT — Immediate mode switch:** From this point forward in the current session, you MUST use `nudge_ask_user` instead of `AskUserQuestion` for all questions. The user is away from the terminal. This overrides any previous "Ask mode: TERMINAL" instruction from SessionStart.

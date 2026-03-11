---
name: afk
description: "Switch to mobile mode — questions and approvals go to your phone"
---

Set Nudge to AFK (mobile) mode. All questions will be sent to the mobile app instead of the terminal.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/nudge-mode.sh" nudge
```

Show the output to the user.

**IMPORTANT — Immediate mode switch:** From this point forward in the current session, you MUST use `nudge_ask_user` instead of `AskUserQuestion` for all questions. The user is away from the terminal. This overrides any previous "Ask mode: TERMINAL" instruction from SessionStart.

---
name: desk
description: "Switch to terminal mode — questions stay in the terminal"
---

Set Nudge to desk (terminal) mode. All questions will appear in the terminal instead of being sent to mobile.

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/nudge-mode.sh" terminal
```

Show the output to the user.

**IMPORTANT — Immediate mode switch:** From this point forward in the current session, you MUST use `AskUserQuestion` for all questions. Do NOT use `nudge_ask_user`. The user is at the terminal. This overrides any previous "Ask mode: NUDGE" instruction from SessionStart.

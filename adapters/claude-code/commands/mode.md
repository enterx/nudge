---
name: mode
description: "Toggle Nudge ask mode between mobile (nudge) and terminal"
---

Run the Nudge mode toggle script. Pass the user's argument if they provided one (e.g., `/nudge:mode terminal`).

If the user provided an argument:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/nudge-mode.sh" "$ARGUMENTS"
```

If no argument was provided:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/nudge-mode.sh"
```

Show the output to the user.

---
name: pair-nudge
description: "Pair your phone with your coding AI via Nudge"
---

Run the Nudge pairing script to connect your mobile device. If already paired, this resets the config and starts a fresh pairing. Generates a pairing code that you enter in the Nudge app on your phone.

Execute the following command and show the output to the user:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/nudge-pair.sh"
```

After the script completes, inform the user of the result.

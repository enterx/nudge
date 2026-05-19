---
name: nudge-pair
description: "Pair your phone with your coding AI via Nudge"
---

Run the Nudge pairing script to connect your mobile device. If already paired, this resets the config and starts a fresh pairing. Generates a pairing code that you enter in the Nudge app on your phone.

Execute the following command and show the output to the user:

```bash
plugin_root="${NUDGE_CODEX_ROOT:-}"
if [ -z "$plugin_root" ]; then
  for candidate in \
    "$HOME/.agents/plugins/nudge" \
    "$HOME/.codex/plugins/cache/nudge/nudge/1.0.0/plugins/nudge"; do
    if [ -f "$candidate/scripts/nudge-pair.sh" ]; then
      plugin_root="$candidate"
      break
    fi
  done
fi

if [ -z "$plugin_root" ]; then
  echo "Nudge plugin root not found. Set NUDGE_CODEX_ROOT to the installed plugins/nudge directory." >&2
  exit 1
fi

bash "$plugin_root/scripts/nudge-pair.sh"
```

After the script completes, inform the user of the result.

---
name: pair-nudge
description: "Pair your phone with your coding AI via Nudge"
---

Pair the user's phone with Nudge. This is a two-step process:

1. Call the `mcp__plugin_nudge_nudge-mcp__nudge_pair` tool to generate a pairing code.
2. Show the pairing code to the user. Tell them to enter it in the Nudge app on their phone.
3. Call the `mcp__plugin_nudge_nudge-mcp__nudge_pair_wait` tool to wait for pairing to complete.
4. Show the pairing result to the user.

If pairing succeeds, suggest running /test-nudge to verify push notifications.
If pairing fails or times out, suggest running /pair-nudge again.

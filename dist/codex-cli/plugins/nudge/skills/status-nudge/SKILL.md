---
name: status-nudge
description: "Check Nudge connection and configuration status"
---

Check the Nudge connection and configuration status by calling the `nudge_status` MCP tool.

Summarize the result for the user:
- If not paired: Tell them to run /pair-nudge
- If paired: Show user ID, pairing code, server status, auth status, and current ask mode
- If server is unreachable or auth is invalid: Suggest running /pair-nudge to re-pair

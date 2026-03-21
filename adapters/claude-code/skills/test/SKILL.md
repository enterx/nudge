---
name: test
description: "Send a test push notification to your phone via Nudge"
---

Test push notification delivery by sending an approval request to the user's phone via the Nudge MCP tool.

Use the `mcp__plugin_nudge_nudge-mcp__nudge_approve` tool with the following parameters:

- **description**: "This is a test notification from Nudge. Tap Approve to confirm delivery works!"
- **toolName**: "nudge:test"

After the tool returns, show the result to the user:
- If `approved: true` — report success: the user received and approved the test notification.
- If `approved: false` — report that the user denied the test (but delivery itself worked).
- If the tool errors — report the failure and suggest running `/status` or `/pair`.

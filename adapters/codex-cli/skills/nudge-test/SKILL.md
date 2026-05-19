---
name: nudge-test
description: "Send a test push notification to your phone via Nudge"
---

Test push notification delivery by sending an approval request to the user's phone via the Nudge MCP tool.

Use the `nudge_approve` MCP tool with the following parameters:

- **description**: "This is a test notification from Nudge. Tap Approve to confirm delivery works!"
- **toolName**: "nudge:test"

After the tool returns, show the result to the user:
- If `approved: true` — report success: the user received and approved the test notification.
- If `approved: false` — report that the user denied the test (but delivery itself worked).
- If the tool errors — report the failure and suggest running `/nudge-status` or `/nudge-pair`.

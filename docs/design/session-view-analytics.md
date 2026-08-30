# Design: managed-agent session view + analytics

Status: draft / Owner: rayuron / 2026-06-13

## Reference model — Claude managed agents

What Claude's surfaces show, and what we borrow:

- **Managed agent session states**: `idle` / `running` / `rescheduling` /
  `terminated` (platform.claude.com/docs/en/managed-agents/session-operations).
- **Remote Control**: per-session presence dot (online/offline), computer
  icon, "awaiting approval" badge, title auto-derived from first meaningful
  message (code.claude.com/docs/en/remote-control).
- **Session card metadata** (claude.ai/code): name, status, last activity,
  branch, diff stats.
- **Analytics API** (manage-claude/claude-code-analytics-api): num_sessions,
  LOC added/removed, commits/PRs, per-tool acceptance rate, tokens/cost per
  model.

## Current nudge model

Sessions exist only **implicitly**: every event carries `sessionId` +
`sessionName` (`core/lib/handlers.mjs:257`), and mobile groups events under
the name. There is no lifecycle, presence, or status.

## Proposed session states

Derived state machine, in display priority:

| State | Signal | UI |
|---|---|---|
| **needs you** | open ask/approve event | red badge + push |
| **open channel** | open `ask --text` receptive prompt (AFK loop) | input-ready accent |
| **working** | heartbeat within N min, nothing pending | animated green dot |
| **idle / offline** | no heartbeat > N min | gray dot |
| **done** | explicit session end | checkmark, collapses |

"needs you" and "open channel" are already derivable from existing event
data — **mobile can ship that much with zero CLI change**.

## New signal: `session.status` events

For working/done, add a cheap lifecycle event (plaintext `kind`, encrypted
one-line summary of current activity):

- Sources: the Claude Code adapter already ships hooks
  (`adapters/claude-code/`); add `SessionStart` / `Stop` hooks, and throttle
  the existing `PostToolUse` hook into a heartbeat (≤1 per 60 s).
- `provider` (claude-code/codex/CI, already detected in
  `core/lib/constants.mjs:121`) and `installId` (M4 computer) are already
  plaintext → card gets a provider icon + computer name for free.
- Status events must **not** count against the 30 events/day quota — they
  need a separate (or uncounted) lane server-side.

## Session card (managed-agent style)

```
● auth bugfix                 [claude-code] MacBook-M4
  fixing token refresh…             last 2 min ago
  ⚠ 1 approval pending      today: 6 asks · 4 ok · 1 deny
```

## Analytics

E2E encryption splits analytics in two layers:

- **Server-side**: only plaintext metadata (kind, pattern, provider,
  timestamps, sizes) — keep it to quota/health counters, as today.
- **On-device (the real dashboard)**: the phone decrypts everything, so all
  metrics compute locally from stored events:
  - **time-to-answer** (created → answered): the signature nudge metric —
    "how long do your agents sit blocked on you"; median + p90, by hour.
  - approval / deny / timeout(TTL-expired) rates — analog of Claude's
    edit-acceptance rate.
  - events per day by provider, computer, session; busiest hours.
  - `nudge run` durations and exit codes (already in those events).

## Privacy note (pre-existing, surfaced by this work)

`sessionName`, `options`, and `actions` are sent **plaintext at top level**
of `eventsCreate` even when an encrypted payload exists
(`core/lib/handlers.mjs:259-263`), while the same sessionName is also inside
`encryptedNotif`. Either move them under the encrypted payload (mobile can
decrypt) or document why the server needs them. Analytics should not create
pressure to add more plaintext fields.

## Sequencing

1. Mobile-only: derive needs-you/open-channel states + card redesign.
2. CLI: `session.status` lifecycle/heartbeat via hooks (+ uncounted lane).
3. Mobile: on-device analytics tab.

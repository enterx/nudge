# Design: Skill Hand — local skills as cards on the phone

Status: draft / Owner: rayuron / 2026-06-13

## Goal

Expose the Mac's local agent skills (Claude Code / Codex `SKILL.md` files) on the
phone as a "hand of cards", so the user can deal the next move from mobile.

## Constraint

There is no unsolicited phone→CLI path. The CLI only receives input while an
`ask` event is open (SSE). Everything below works within or around that.

## Step 1 — `nudge ask --hand` (no backend change)

`--action` already exists in the event payload (`core/lib/handlers.mjs`), so the
hand can ship as a CLI-only patch:

1. **Discovery**: scan, in order, `.claude/skills/*/SKILL.md` (project),
   `~/.claude/skills/*/SKILL.md` (user), and installed plugin skill dirs.
   Parse frontmatter `name` + `description` (first sentence only).
2. **Mapping**: each skill becomes an action `{ value: "skill:<name>", label: "<name> — <desc>" }`.
   Cap the hand (e.g. 8 cards); `--hand <glob>` filters, `--hand` alone takes
   the most recently used.
3. **Flow**: `nudge ask "次の一手は?" --hand --text` → phone shows cards +
   free-text. Answer comes back as `selectedAction: "skill:<name>"`; the host
   loop (nudge-afk) invokes the skill and re-opens the hand on the next pause.

Notes:
- Skill names/descriptions travel in `actions`, which today is **plaintext** in
  `eventsCreate` — acceptable for skill names, but see the privacy note in
  `session-view-analytics.md`.
- The nudge-afk SKILL.md should document the `--hand` loop as the canonical
  AFK pattern.

## Step 2 — persistent hand (backend + mobile)

For a hand that is visible without an open ask:

1. **Manifest**: on session start the CLI uploads an encrypted skill manifest
   (`kind: skill.manifest`, payload = list of {name, description}).
2. **Mobile UI**: a per-computer "hand" section rendered from the latest
   manifest; cards are visible even when no ask is pending.
3. **Command events**: tapping a card creates a `command` event addressed to
   the computer/session. Delivery requires a long-lived listener:
   `nudge listen` (daemon mode of the SSE loop) or the nudge-afk loop.
4. **Offline queue**: commands created while no listener is connected are
   queued server-side and delivered on next `listen` (TTL applies).

## Sequencing

Step 1 first — it validates the UX with one CLI patch. Step 2 only if the
hand proves sticky and after `nudge listen` exists (also a prerequisite for
durable waits beyond the SSE ~43 min ceiling).

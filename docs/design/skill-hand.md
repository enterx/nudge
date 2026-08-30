# Design: Skill Hand — local skills as cards on the phone

Status: draft / Owner: rayuron / 2026-06-13

## Goal

Expose the Mac's local agent skills (Claude Code / Codex `SKILL.md` files) on the
phone as a "hand of cards", so the user can deal the next move from mobile.

## Constraint

There is no unsolicited phone→CLI path. The CLI only receives input while an
`ask` event is open (SSE). Everything below works within or around that.

## Step 1 — embedded `availableSkills` (implemented: `feat/ask-available-skills`, d1bd5fb)

Implemented while this doc was being drafted — and with a better shape than
the `--hand`/`--action` mapping this doc originally proposed:

- `core/lib/skills.mjs` scans `.claude/skills/` (project),
  `~/.claude/skills/` (global), and the plugin cache; dedupes with
  project > global > plugin precedence; caps at 24 cards; 60 s scan cache;
  `NUDGE_DISABLE_SKILLS` opt-out.
- Every `nudge ask` / `nudge_ask_user` embeds the cards as
  `availableSkills` **inside the encrypted payload** — no plaintext
  exposure, unlike the `actions` route first considered here.
- Mobile renders them as a reply hand; playing a card answers
  `/skill-name [args]` through the existing freeText path — no new
  phone→computer channel needed.

Follow-ups once that branch merges:
- nudge-afk SKILL.md should document the hand as the canonical AFK loop
  (open `ask --text`, play a card, repeat).
- Mobile UX: recently-played cards first; collapse beyond ~8.

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

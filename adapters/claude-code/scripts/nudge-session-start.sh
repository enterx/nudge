#!/bin/bash
# nudge-session-start.sh — SessionStart hook for Claude Code
# Reads askMode from config and injects context to tell Claude which
# question tool to use (nudge_ask_user vs AskUserQuestion).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Consume stdin (hook protocol requires it)
cat > /dev/null

# --- Check if configured ---

if ! config_exists; then
  # Not paired — no context to inject
  exit 0
fi

# --- Read askMode from config ---

ASK_MODE=$(config_read "askMode" 2>/dev/null) || true
ASK_MODE="${ASK_MODE:-nudge}"  # Default to nudge if not set

# --- Build context message ---

case "${ASK_MODE}" in
  terminal)
    CONTEXT="[Nudge] Ask mode: TERMINAL — Use standard AskUserQuestion for all questions. Do NOT use nudge_ask_user. The user is at the terminal."
    ;;
  nudge)
    CONTEXT="[Nudge] Ask mode: NUDGE — Use nudge_ask_user instead of AskUserQuestion. The user may be away from the terminal."
    ;;
  *)
    CONTEXT="[Nudge] Ask mode: NUDGE (default) — Use nudge_ask_user instead of AskUserQuestion."
    ;;
esac

# --- Output JSON with additionalContext ---

if command -v jq &>/dev/null; then
  jq -n --arg ctx "${CONTEXT}" \
    '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }'
else
  SAFE_CTX=$(printf '%s' "${CONTEXT}" | sed 's/\\/\\\\/g; s/"/\\"/g')
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"${SAFE_CTX}\"}}"
fi

exit 0

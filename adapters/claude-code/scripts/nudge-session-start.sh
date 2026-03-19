#!/bin/bash
# nudge-session-start.sh — SessionStart hook for Claude Code
# Reads askMode from config and injects context to confirm that
# AskUserQuestion is routed via hooks to mobile (nudge mode)
# or passes through to terminal (terminal mode).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Read stdin (required by hook protocol) and persist session_id.
# Uses bash built-in string ops only (no grep/cut/jq) for speed.
STDIN_DATA="$(cat)"
if [[ "${STDIN_DATA}" =~ \"session_id\":\"([^\"]+)\" ]]; then
  echo -n "${BASH_REMATCH[1]}" > "${NUDGE_CONFIG_DIR}/session_id"
fi

# --- Check if configured ---

if ! config_exists; then
  # Not paired — no context to inject
  exit 0
fi

# --- Read askMode from config ---

ASK_MODE=$(_get_ask_mode)

# --- Build context message ---

case "${ASK_MODE}" in
  terminal)
    CONTEXT="[Nudge] Ask mode: TERMINAL — Use standard AskUserQuestion for all questions. The user is at the terminal. Hooks will handle approval requests automatically."
    ;;
  nudge)
    CONTEXT="[Nudge] Ask mode: NUDGE — Use standard AskUserQuestion for questions (hooks will automatically forward to mobile). The user may be away from the terminal."
    ;;
  *)
    CONTEXT="[Nudge] Ask mode: NUDGE (default) — Use standard AskUserQuestion for questions (hooks will automatically forward to mobile)."
    ;;
esac

# --- Output JSON with additionalContext ---

if _has_jq; then
  jq -n --arg ctx "${CONTEXT}" \
    '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }'
else
  SAFE_CTX=$(_safe_json_string "${CONTEXT}")
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"${SAFE_CTX}\"}}"
fi

exit 0

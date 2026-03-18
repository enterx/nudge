#!/bin/bash
# nudge-session-start.sh — SessionStart hook for Claude Code
# Reads askMode from config and injects context to confirm that
# AskUserQuestion is routed via hooks to mobile (nudge mode)
# or passes through to terminal (terminal mode).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Read stdin to extract session_id (hook protocol sends JSON on stdin)
STDIN_DATA="$(cat)"

# Persist Claude Code's session_id so MCP server can use the same ID.
# CLAUDE_ENV_FILE is only available during SessionStart; writing here
# makes the var available for the rest of the session.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if _has_jq; then
    HOOK_SESSION_ID=$(echo "${STDIN_DATA}" | jq -r '.session_id // empty' 2>/dev/null)
  else
    # Lightweight extraction without jq
    HOOK_SESSION_ID=$(echo "${STDIN_DATA}" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  fi
  if [ -n "${HOOK_SESSION_ID}" ]; then
    echo "NUDGE_SESSION_ID=${HOOK_SESSION_ID}" >> "${CLAUDE_ENV_FILE}"
  fi
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

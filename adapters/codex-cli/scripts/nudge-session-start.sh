#!/bin/bash
# nudge-session-start.sh — SessionStart hook for Codex CLI
# Reads askMode from config and injects context via additionalContext.
# Codex supports plain text or hookSpecificOutput with additionalContext.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Read stdin (required by hook protocol) and persist session_id to a
# per-PPID file. Both hooks and MCP server share the same parent (Codex),
# so PPID is the unique key that avoids cross-session overwrites.
STDIN_DATA="$(cat)"
if [[ "${STDIN_DATA}" =~ \"session_id\":\"([^\"]+)\" ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
  echo -n "${SESSION_ID}" > "${NUDGE_CONFIG_DIR}/session_id.${PPID}"
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
    CONTEXT="[Nudge] Ask mode: TERMINAL — The user is at the terminal. Hooks will handle approval requests automatically for write operations."
    ;;
  nudge)
    CONTEXT="[Nudge] Ask mode: NUDGE — Use nudge_ask_user MCP tool for questions. The user may be away from the terminal. Write operations (shell, file edits) will be sent to the user's phone for approval."
    ;;
  *)
    CONTEXT="[Nudge] Ask mode: NUDGE (default) — Use nudge_ask_user MCP tool for questions. Write operations will be sent to the user's phone for approval."
    ;;
esac

# --- Output context ---
# Codex supports hookSpecificOutput with additionalContext for SessionStart

if _has_jq; then
  jq -n --arg ctx "${CONTEXT}" \
    '{ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $ctx } }'
else
  SAFE_CTX=$(_safe_json_string "${CONTEXT}")
  echo "{\"hookSpecificOutput\":{\"hookEventName\":\"SessionStart\",\"additionalContext\":\"${SAFE_CTX}\"}}"
fi

exit 0

#!/bin/bash
# nudge-session-start.sh — SessionStart hook for Claude Code
# Reads askMode from config and injects context to confirm that
# AskUserQuestion is routed via hooks to mobile (nudge mode)
# or passes through to terminal (terminal mode).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Read stdin (required by hook protocol) and persist session_id to a
# per-PPID file. Both hooks and MCP server share the same parent (Claude Code),
# so PPID is the unique key that avoids cross-session overwrites.
STDIN_DATA="$(cat)"
if [[ "${STDIN_DATA}" =~ \"session_id\":\"([^\"]+)\" ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] SessionStart: session_id=${SESSION_ID}, PPID=${PPID}" >> "${NUDGE_CONFIG_DIR}/hook-debug.log" 2>/dev/null
  # Write PPID-keyed file (primary) — matches what MCP server reads via process.ppid
  echo -n "${SESSION_ID}" > "${NUDGE_CONFIG_DIR}/session_id.${PPID}"
else
  echo "[$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)] SessionStart: no session_id found in stdin" >> "${NUDGE_CONFIG_DIR}/hook-debug.log" 2>/dev/null
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

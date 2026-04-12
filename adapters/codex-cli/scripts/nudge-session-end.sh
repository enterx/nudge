#!/bin/bash
# nudge-session-end.sh — Stop hook for Codex CLI
# Cancels pending events for this session. No push notification is sent.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# --- Read hook input ---

INPUT=$(cat)
log_debug "Stop hook input received"

# --- Check if configured ---

if ! config_exists; then
  exit 0
fi

TOKEN=$(get_token)
if [ -z "${TOKEN}" ]; then
  exit 0
fi

# --- Extract session data ---

RAW_SESSION_ID=$(json_extract "${INPUT}" "session_id")
SESSION_ID=$(get_session_id "${RAW_SESSION_ID}")

# --- Cancel pending events for this session ---

if [ -n "${SESSION_ID}" ]; then
  if _has_jq; then
    CANCEL_PAYLOAD=$(jq -n --arg sid "${SESSION_ID}" '{ sessionId: $sid }')
  else
    CANCEL_PAYLOAD="{\"sessionId\":\"${SESSION_ID}\"}"
  fi
  CANCEL_RESULT=$(api_post "sessionEnd" "${CANCEL_PAYLOAD}" 2>/dev/null) || true
  CANCELLED=$(json_extract_raw "${CANCEL_RESULT}" "cancelled" 2>/dev/null) || CANCELLED="0"
  log_debug "Cancelled ${CANCELLED} pending event(s) for session ${SESSION_ID}"
fi

# Clean up per-session files
rm -f "${NUDGE_CONFIG_DIR}/last_stop" 2>/dev/null || true
rm -f "${NUDGE_CONFIG_DIR}/session_id.${PPID}" 2>/dev/null || true

log_debug "Stop processed (no notification sent)"
exit 0

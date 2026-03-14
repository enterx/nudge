#!/bin/bash
# nudge-session-end.sh — SessionEnd hook for Claude Code (async, fire-and-forget)
# Sends a push notification when a Claude Code session ends.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# --- Read hook input ---

INPUT=$(cat)
log_debug "SessionEnd hook input received"

# --- Check if configured ---

if ! config_exists; then
  exit 0
fi

TOKEN=$(get_token)
if [ -z "${TOKEN}" ]; then
  exit 0
fi

# --- Extract session data ---

SESSION_ID=$(json_extract "${INPUT}" "session_id")
REASON=$(json_extract "${INPUT}" "reason")

# Map reason to human-readable message
case "${REASON}" in
  clear)
    BODY="Session was cleared by user." ;;
  logout)
    BODY="User logged out." ;;
  prompt_input_exit)
    BODY="User exited the session." ;;
  bypass_permissions_disabled)
    BODY="Session ended — bypass permissions was disabled." ;;
  *)
    BODY="Session ended." ;;
esac

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

# --- Send notification ---

if _has_jq; then
  EVENT_PAYLOAD=$(jq -n \
    --arg body "${BODY}" \
    '{
      title: "Session ended",
      body: $body,
      level: "info"
    }')
else
  SAFE_BODY=$(_safe_json_string "${BODY}")
  EVENT_PAYLOAD="{\"title\":\"Session ended\",\"body\":\"${SAFE_BODY}\",\"level\":\"info\"}"
fi

api_post "pushNotifyFn" "${EVENT_PAYLOAD}" >/dev/null 2>&1 || true

# Clean up stop cooldown file on session end
rm -f "${NUDGE_CONFIG_DIR}/last_stop" 2>/dev/null || true

log_debug "SessionEnd notification sent (reason: ${REASON})"
exit 0

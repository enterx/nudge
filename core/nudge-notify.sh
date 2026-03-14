#!/bin/bash
# nudge-notify.sh — Notification hook handler for Nudge
#
# Receives notification events from Claude Code and forwards
# relevant ones to the user's phone via the Nudge API.
#
# Input (stdin JSON):
#   { "notification_type": "idle_prompt|elicitation_dialog|permission_prompt",
#     "message": "...", "title": "...", "session_id": "..." }
#
# Exit 0 in all cases (errors → silent fallback).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source shared library
if [ -f "${SCRIPT_DIR}/lib.sh" ]; then
  source "${SCRIPT_DIR}/lib.sh"
else
  exit 0
fi

# --- Read stdin (limit to 64KB to prevent unbounded memory usage) ---
INPUT=$(head -c 65536 2>/dev/null) || INPUT=""
if [ -z "${INPUT}" ]; then
  exit 0
fi

# --- Check config ---
if ! config_exists; then
  exit 0
fi

TOKEN=$(config_read "token" 2>/dev/null) || true
if [ -z "${TOKEN}" ]; then
  exit 0
fi

# --- Parse notification ---
NOTIFICATION_TYPE=$(json_extract "${INPUT}" "notification_type")
MESSAGE=$(json_extract "${INPUT}" "message")
TITLE=$(json_extract "${INPUT}" "title")
SESSION_ID=$(json_extract "${INPUT}" "session_id")

log_debug "Notification: type=${NOTIFICATION_TYPE} title=${TITLE}"

# --- Cooldown check (30s between notifications) ---
COOLDOWN_MS=30000
LAST_NOTIFY_FILE="${NUDGE_CONFIG_DIR}/last_notify"

if _check_cooldown "${LAST_NOTIFY_FILE}" "${COOLDOWN_MS}"; then
  log_debug "Cooldown active, skipping"
  exit 0
fi

# --- Ask mode filtering ---
ASK_MODE=$(_get_ask_mode)

# elicitation_dialog: skip in terminal mode (user is at the terminal)
if [ "${NOTIFICATION_TYPE}" = "elicitation_dialog" ] && [ "${ASK_MODE}" = "terminal" ]; then
  log_debug "Skipping elicitation_dialog in terminal mode"
  exit 0
fi

# --- Recent approval check for permission_prompt ---
if [ "${NOTIFICATION_TYPE}" = "permission_prompt" ]; then
  APPROVAL_COOLDOWN_MS=600000  # 10 minutes
  LAST_APPROVAL_FILE="${NUDGE_CONFIG_DIR}/last_approval"
  if _check_cooldown "${LAST_APPROVAL_FILE}" "${APPROVAL_COOLDOWN_MS}"; then
    log_debug "Recent approval, skipping permission_prompt"
    exit 0
  fi
fi

# --- Send notification ---
API_URL=$(get_api_url)

if _has_jq; then
  BODY=$(jq -n \
    --arg type "${NOTIFICATION_TYPE}" \
    --arg title "${TITLE}" \
    --arg message "${MESSAGE}" \
    --arg sessionId "${SESSION_ID}" \
    '{type: $type, title: $title, message: $message, sessionId: $sessionId}')
else
  # Fallback: escape backslashes, quotes, tabs, and newlines
  SAFE_TITLE=$(_safe_json_string "${TITLE}")
  SAFE_MESSAGE=$(_safe_json_string "${MESSAGE}")
  BODY="{\"type\":\"${NOTIFICATION_TYPE}\",\"title\":\"${SAFE_TITLE}\",\"message\":\"${SAFE_MESSAGE}\",\"sessionId\":\"${SESSION_ID}\"}"
fi

log_debug "Sending notification to API..."
api_post "notify" "${BODY}" "${TOKEN}" >/dev/null 2>&1 || true

# Update last_notify timestamp
printf '%s' "$(( $(date +%s) * 1000 ))" > "${LAST_NOTIFY_FILE}" 2>/dev/null || true

exit 0

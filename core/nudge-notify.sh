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

# --- Read stdin ---
INPUT=$(cat 2>/dev/null) || INPUT=""
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

if [ -f "${LAST_NOTIFY_FILE}" ]; then
  LAST_TS=$(cat "${LAST_NOTIFY_FILE}" 2>/dev/null) || LAST_TS=0
  NOW_MS=$(( $(date +%s) * 1000 ))
  ELAPSED=$(( NOW_MS - LAST_TS ))
  if [ "${ELAPSED}" -lt "${COOLDOWN_MS}" ] 2>/dev/null; then
    log_debug "Cooldown active (${ELAPSED}ms < ${COOLDOWN_MS}ms), skipping"
    exit 0
  fi
fi

# --- Ask mode filtering ---
ASK_MODE=$(config_read "askMode" 2>/dev/null) || true
ASK_MODE="${ASK_MODE:-nudge}"

# elicitation_dialog: skip in terminal mode (user is at the terminal)
if [ "${NOTIFICATION_TYPE}" = "elicitation_dialog" ] && [ "${ASK_MODE}" = "terminal" ]; then
  log_debug "Skipping elicitation_dialog in terminal mode"
  exit 0
fi

# --- Recent approval check for permission_prompt ---
if [ "${NOTIFICATION_TYPE}" = "permission_prompt" ]; then
  APPROVAL_COOLDOWN_MS=600000  # 10 minutes
  LAST_APPROVAL_FILE="${NUDGE_CONFIG_DIR}/last_approval"
  if [ -f "${LAST_APPROVAL_FILE}" ]; then
    LAST_APPROVAL_TS=$(cat "${LAST_APPROVAL_FILE}" 2>/dev/null) || LAST_APPROVAL_TS=0
    NOW_MS=$(( $(date +%s) * 1000 ))
    ELAPSED=$(( NOW_MS - LAST_APPROVAL_TS ))
    if [ "${ELAPSED}" -lt "${APPROVAL_COOLDOWN_MS}" ] 2>/dev/null; then
      log_debug "Recent approval (${ELAPSED}ms < ${APPROVAL_COOLDOWN_MS}ms), skipping permission_prompt"
      exit 0
    fi
  fi
fi

# --- Send notification ---
API_URL=$(get_api_url)

if command -v jq &>/dev/null; then
  BODY=$(jq -n \
    --arg type "${NOTIFICATION_TYPE}" \
    --arg title "${TITLE}" \
    --arg message "${MESSAGE}" \
    --arg sessionId "${SESSION_ID}" \
    '{type: $type, title: $title, message: $message, sessionId: $sessionId}')
else
  # Fallback: escape double quotes in values
  SAFE_TITLE=$(printf '%s' "${TITLE}" | sed 's/"/\\"/g')
  SAFE_MESSAGE=$(printf '%s' "${MESSAGE}" | sed 's/"/\\"/g')
  BODY="{\"type\":\"${NOTIFICATION_TYPE}\",\"title\":\"${SAFE_TITLE}\",\"message\":\"${SAFE_MESSAGE}\",\"sessionId\":\"${SESSION_ID}\"}"
fi

log_debug "Sending notification to API..."
api_post "notify" "${BODY}" "${TOKEN}" >/dev/null 2>&1 || true

# Update last_notify timestamp
printf '%s' "$(( $(date +%s) * 1000 ))" > "${LAST_NOTIFY_FILE}" 2>/dev/null || true

exit 0

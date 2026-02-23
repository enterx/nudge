#!/bin/bash
# nudge-status.sh — Check Nudge connection and config status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

echo ""
echo "━━━ Nudge Status ━━━"
echo ""

# --- Config check ---

if ! config_exists; then
  echo "Status:  Not paired"
  echo ""
  echo "Run /nudge:pair to connect your phone."
  exit 0
fi

TOKEN=$(get_token)
USER_ID=$(get_user_id)
API_URL=$(get_api_url)
PAIRING_CODE=$(config_read "pairingCode" 2>/dev/null) || true

echo "Config:  ~/.nudge/config"
echo "User:    ${USER_ID:-unknown}"
echo "Code:    ${PAIRING_CODE:-unknown}"
echo "Server:  ${API_URL}"
echo ""

# --- Server connectivity check ---

echo -n "Server:  "
HEALTH=$(api_get "status" "") || {
  echo "Unreachable"
  echo ""
  echo "Could not connect to the Nudge server."
  exit 0
}

SERVER_STATUS=$(json_extract "${HEALTH}" "status")
if [ "${SERVER_STATUS}" = "ok" ]; then
  echo "Connected"
else
  echo "Error (${SERVER_STATUS})"
fi

# --- Token validity check ---

echo -n "Auth:    "
if [ -z "${TOKEN}" ]; then
  echo "No token"
else
  # Try a simple authenticated request
  AUTH_CHECK=$(api_get "status" "${TOKEN}") || {
    echo "Token may be expired"
    echo ""
    echo "Try re-pairing with /nudge:pair"
    exit 0
  }
  echo "Valid"
fi

echo ""
echo "All systems operational."

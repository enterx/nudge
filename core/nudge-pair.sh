#!/bin/bash
# nudge-pair.sh — Device pairing flow
# Generates a pairing code, then polls until mobile claims it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

echo ""
echo "━━━ Nudge: Pairing ━━━"
echo ""

# If already paired, reset config for a fresh pairing
if config_exists; then
  EXISTING_TOKEN=$(get_token)
  if [ -n "${EXISTING_TOKEN}" ]; then
    rm -f "${NUDGE_CONFIG_FILE}"
    rm -f "${NUDGE_LOG_FILE}"
  fi
fi

# --- Generate pairing code ---

API_URL=$(get_api_url)

PAIR_RESPONSE=$(api_post "pairGenerate" "{}") || {
  echo "Error: Could not connect to Nudge server."
  echo "Check your internet connection and try again."
  exit 1
}

PAIRING_CODE=$(json_extract "${PAIR_RESPONSE}" "pairingCode")
PAIR_ID=$(json_extract "${PAIR_RESPONSE}" "pairId")
TOKEN=$(json_extract "${PAIR_RESPONSE}" "token")
REFRESH_TOKEN=$(json_extract "${PAIR_RESPONSE}" "refreshToken")
API_KEY_VALUE=$(json_extract "${PAIR_RESPONSE}" "apiKey")
EXPIRES_AT=$(json_extract_raw "${PAIR_RESPONSE}" "expiresAt")

if [ -z "${PAIRING_CODE}" ] || [ -z "${TOKEN}" ]; then
  echo "Error: Could not generate pairing code."
  exit 1
fi

echo "  Code: ${PAIRING_CODE}  (expires 10 min)"
echo ""
echo "  Scan QR or enter code in the Nudge app."
echo ""

if command -v qrencode &>/dev/null; then
  qrencode -t UTF8 -m 2 "${PAIRING_CODE}"
else
  echo "  Tip: brew install qrencode for QR pairing."
fi

echo ""
echo "Waiting for pairing..."

# --- Poll for pairing completion ---

POLL_INTERVAL=3  # seconds
MAX_POLLS=200    # 200 * 3s = 10 minutes
POLL_COUNT=0

# Normalize code for API (remove hyphen)
RAW_CODE=$(echo "${PAIRING_CODE}" | tr -d '-')

while [ ${POLL_COUNT} -lt ${MAX_POLLS} ]; do
  sleep ${POLL_INTERVAL}

  VERIFY_RESPONSE=$(api_post "pairVerify" "{\"code\": \"${RAW_CODE}\"}") || {
    POLL_COUNT=$((POLL_COUNT + 1))
    continue
  }

  STATUS=$(json_extract "${VERIFY_RESPONSE}" "status")

  case "${STATUS}" in
    "paired")
      USER_ID=$(json_extract "${VERIFY_RESPONSE}" "userId")

      # Token was received from pairGenerate, not from pairVerify
      # Save config with refresh token and API key for auto-refresh
      if command -v jq &>/dev/null; then
        config_write_json "$(jq -n \
          --arg token "${TOKEN}" \
          --arg refreshToken "${REFRESH_TOKEN}" \
          --arg apiKey "${API_KEY_VALUE}" \
          --arg userId "${USER_ID}" \
          --arg apiUrl "${API_URL}" \
          --arg pairingCode "${PAIRING_CODE}" \
          '{
            token: $token,
            refreshToken: $refreshToken,
            apiKey: $apiKey,
            userId: $userId,
            apiUrl: $apiUrl,
            pairingCode: $pairingCode
          }')"
      else
        config_write_json "{
  \"token\": \"${TOKEN}\",
  \"refreshToken\": \"${REFRESH_TOKEN}\",
  \"apiKey\": \"${API_KEY_VALUE}\",
  \"userId\": \"${USER_ID}\",
  \"apiUrl\": \"${API_URL}\",
  \"pairingCode\": \"${PAIRING_CODE}\"
}"
      fi

      echo ""
      echo "Paired! Run /nudge:test to verify."
      exit 0
      ;;
    "expired")
      echo ""
      echo "Pairing code expired. Run /nudge:pair again."
      exit 1
      ;;
    "pending")
      # Still waiting
      POLL_COUNT=$((POLL_COUNT + 1))
      ;;
    *)
      log_debug "Unknown status: ${STATUS}"
      POLL_COUNT=$((POLL_COUNT + 1))
      ;;
  esac
done

echo ""
echo "Timed out waiting for pairing. Run /nudge:pair to try again."

exit 1

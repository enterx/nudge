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
  rm -f "${NUDGE_CONFIG_FILE}"
  rm -f "${NUDGE_LOG_FILE}"
fi

# --- Generate pairing code ---

API_URL=$(get_api_url)

PAIR_RESPONSE=$(api_post "pairGenerate" "{}") || {
  echo "Error: Could not connect to Nudge server."
  echo "Check your internet connection and try again."
  exit 1
}

PAIRING_CODE=$(json_extract "${PAIR_RESPONSE}" "pairingCode")
TOKEN=$(json_extract "${PAIR_RESPONSE}" "token")
REFRESH_TOKEN=$(json_extract "${PAIR_RESPONSE}" "refreshToken")
API_KEY_VALUE=$(json_extract "${PAIR_RESPONSE}" "apiKey")

if [ -z "${PAIRING_CODE}" ] || [ -z "${TOKEN}" ]; then
  echo "Error: Could not generate pairing code."
  exit 1
fi

PAIR_ID=$(json_extract "${PAIR_RESPONSE}" "pairId")

# --- Generate and upload encryption key BEFORE showing code ---
# Must happen before mobile can claim, so wrappedKey is available in pairVerify.
# Sensitive args passed via stdin to avoid exposure in ps aux.

ENCRYPTION_KEY=$(printf '{"pairingCode":"%s","userId":"%s","token":"%s","apiUrl":"%s"}' \
  "${PAIRING_CODE}" "${PAIR_ID}" "${TOKEN}" "${API_URL}" \
  | node "${SCRIPT_DIR}/lib/setup-encryption.mjs" 2>/dev/null) || {
  echo "Warning: E2E encryption setup failed. Continuing without encryption."
  ENCRYPTION_KEY=""
}

if command -v qrencode &>/dev/null; then
  qrencode -t UTF8 -m 2 "${PAIRING_CODE}"
  echo ""
fi

echo "  ▶ ${PAIRING_CODE} ◀  Enter in Nudge app."

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

      # Multi-CLI mode (M3): mobile rebound the pairing to its existing UID.
      # Adopt the mobile's tokens + encryption key; the pairId/token/key we
      # generated in pairGenerate are now orphaned and discarded.
      MULTI_CLI=$(json_extract_raw "${VERIFY_RESPONSE}" "multiCli")
      if [ "${MULTI_CLI}" = "true" ]; then
        CLI_ID_TOKEN=$(json_extract "${VERIFY_RESPONSE}" "cliIdToken")
        CLI_REFRESH_TOKEN=$(json_extract "${VERIFY_RESPONSE}" "cliRefreshToken")
        WRAPPED_KEY=$(json_extract "${VERIFY_RESPONSE}" "wrappedKey")
        WRAPPING_IV=$(json_extract "${VERIFY_RESPONSE}" "wrappingIv")

        if [ -z "${CLI_ID_TOKEN}" ] || [ -z "${CLI_REFRESH_TOKEN}" ]; then
          echo "Error: Multi-CLI pairing response missing CLI tokens."
          exit 1
        fi

        # Adopt the mobile UID's tokens; the orphan pairId tokens no longer work.
        TOKEN="${CLI_ID_TOKEN}"
        REFRESH_TOKEN="${CLI_REFRESH_TOKEN}"

        # Unwrap the mobile's encryption key. PBKDF2 salt MUST be the mobile UID
        # (USER_ID from this response), not the orphan pairId.
        if [ -n "${WRAPPED_KEY}" ] && [ -n "${WRAPPING_IV}" ]; then
          ENCRYPTION_KEY=$(printf '{"pairingCode":"%s","userId":"%s","wrappedKey":"%s","wrappingIv":"%s"}' \
            "${PAIRING_CODE}" "${USER_ID}" "${WRAPPED_KEY}" "${WRAPPING_IV}" \
            | node "${SCRIPT_DIR}/lib/unwrap-key.mjs" 2>/dev/null) || {
            echo "Error: Failed to unwrap encryption key for multi-CLI pairing."
            exit 1
          }
        fi
      fi

      # Validate required fields before writing config
      if [ -z "${TOKEN}" ] || [ -z "${USER_ID}" ]; then
        echo "Error: Incomplete pairing response from server."
        exit 1
      fi

      # Token was received from pairGenerate, not from pairVerify
      # Save config with refresh token and API key for auto-refresh
      if _has_jq; then
        config_write_json "$(jq -n \
          --arg token "${TOKEN}" \
          --arg refreshToken "${REFRESH_TOKEN}" \
          --arg apiKey "${API_KEY_VALUE}" \
          --arg userId "${USER_ID}" \
          --arg apiUrl "${API_URL}" \
          --arg pairingCode "${PAIRING_CODE}" \
          --arg encryptionKey "${ENCRYPTION_KEY}" \
          '{
            token: $token,
            refreshToken: $refreshToken,
            apiKey: $apiKey,
            userId: $userId,
            apiUrl: $apiUrl,
            pairingCode: $pairingCode,
            encryptionKey: $encryptionKey
          }')"
      else
        config_write_json "{
  \"token\": \"${TOKEN}\",
  \"refreshToken\": \"${REFRESH_TOKEN}\",
  \"apiKey\": \"${API_KEY_VALUE}\",
  \"userId\": \"${USER_ID}\",
  \"apiUrl\": \"${API_URL}\",
  \"pairingCode\": \"${PAIRING_CODE}\",
  \"encryptionKey\": \"${ENCRYPTION_KEY}\"
}"
      fi

      echo ""
      echo "Paired! Run /test to verify."
      exit 0
      ;;
    "expired")
      echo ""
      echo "Pairing code expired. Run /pair again."
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
echo "Timed out waiting for pairing. Run /pair to try again."

exit 1

#!/bin/bash
# lib.sh — Shared utilities for Nudge plugin scripts
# shellcheck disable=SC2155

set -euo pipefail

# --- Constants ---

NUDGE_CONFIG_DIR="${HOME}/.nudge"
NUDGE_CONFIG_FILE="${NUDGE_CONFIG_DIR}/config"
NUDGE_LOG_FILE="${NUDGE_CONFIG_DIR}/nudge.log"
NUDGE_DEFAULT_API_URL="${NUDGE_API_URL:-https://us-central1-enterx-nudge-dev.cloudfunctions.net}"

# SSE connection settings
SSE_MAX_TIME=520       # curl --max-time for SSE (just under Cloud Functions 540s limit)
SSE_MAX_FAILURES=5     # Max consecutive connection failures before fallback
SSE_HEARTBEAT_TIMEOUT=60  # Consider connection dead if no data for 60s

# Retry settings
RETRY_MAX=3
RETRY_DELAY_BASE=1     # Exponential backoff: 1s, 2s, 4s

# --- Logging ---

# Redact auth tokens / credentials from log messages
_redact() {
  echo "$*" \
    | sed -E 's/auth=[^&[:space:]]+/auth=[REDACTED]/g' \
    | sed -E 's/(Bearer\s+)[A-Za-z0-9_.~+/-]+={0,2}/\1[REDACTED]/g' \
    | sed -E 's/(token"?\s*:\s*"?)[A-Za-z0-9_.~+/-]{20,}[^"[:space:]]*/\1[REDACTED]/g'
}

log_debug() {
  if [ "${NUDGE_DEBUG:-}" = "1" ]; then
    echo "[nudge:debug] $(_redact "$*")" >&2
  fi
}

log_info() {
  echo "[nudge] $(_redact "$*")" >&2
}

log_error() {
  echo "[nudge:error] $(_redact "$*")" >&2
}

log_to_file() {
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "${timestamp} $(_redact "$*")" >> "${NUDGE_LOG_FILE}" 2>/dev/null || true
}

# --- Config I/O ---

config_exists() {
  [ -f "${NUDGE_CONFIG_FILE}" ]
}

config_read() {
  local key="$1"
  if ! config_exists; then
    return 1
  fi

  if command -v jq &>/dev/null; then
    jq -r ".${key} // empty" "${NUDGE_CONFIG_FILE}" 2>/dev/null
  else
    # Fallback: grep-based JSON parsing (simple key-value only)
    grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "${NUDGE_CONFIG_FILE}" 2>/dev/null \
      | sed 's/.*:[[:space:]]*"\(.*\)"/\1/'
  fi
}

config_write() {
  local key="$1"
  local value="$2"

  mkdir -p "${NUDGE_CONFIG_DIR}"
  chmod 700 "${NUDGE_CONFIG_DIR}" 2>/dev/null || true

  if config_exists && command -v jq &>/dev/null; then
    local tmp
    tmp=$(mktemp) || { log_error "mktemp failed"; return 1; }
    if jq --arg k "${key}" --arg v "${value}" '.[$k] = $v' "${NUDGE_CONFIG_FILE}" > "${tmp}" 2>/dev/null; then
      mv "${tmp}" "${NUDGE_CONFIG_FILE}"
    else
      rm -f "${tmp}"
      log_error "jq config update failed"
      return 1
    fi
  elif config_exists; then
    # Simple fallback: read existing config, rebuild with the new key
    local tmp
    tmp=$(mktemp) || { log_error "mktemp failed"; return 1; }
    # Read existing config and collect all key-value pairs except the one being updated
    local existing_content
    existing_content=$(cat "${NUDGE_CONFIG_FILE}" 2>/dev/null) || existing_content="{}"
    # Extract existing key-value pairs (simple flat JSON only)
    echo '{' > "${tmp}"
    local first=1
    while IFS= read -r line; do
      # Match lines like "key": "value" (with optional trailing comma)
      if echo "${line}" | grep -q "\"[^\"]*\"[[:space:]]*:[[:space:]]*\"[^\"]*\""; then
        local existing_key
        existing_key=$(echo "${line}" | sed 's/.*"\([^"]*\)"[[:space:]]*:.*/\1/')
        if [ "${existing_key}" != "${key}" ]; then
          local existing_val
          existing_val=$(echo "${line}" | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/')
          if [ ${first} -eq 0 ]; then
            echo "," >> "${tmp}"
          fi
          printf '  "%s": "%s"' "${existing_key}" "${existing_val}" >> "${tmp}"
          first=0
        fi
      fi
    done <<< "${existing_content}"
    # Add the new/updated key
    if [ ${first} -eq 0 ]; then
      echo "," >> "${tmp}"
    fi
    printf '  "%s": "%s"\n' "${key}" "${value}" >> "${tmp}"
    echo '}' >> "${tmp}"
    mv "${tmp}" "${NUDGE_CONFIG_FILE}"
  else
    # Create new config
    cat > "${NUDGE_CONFIG_FILE}" << EOF
{
  "${key}": "${value}"
}
EOF
  fi

  chmod 600 "${NUDGE_CONFIG_FILE}"
}

config_write_json() {
  local json="$1"
  mkdir -p "${NUDGE_CONFIG_DIR}"
  chmod 700 "${NUDGE_CONFIG_DIR}" 2>/dev/null || true
  echo "${json}" > "${NUDGE_CONFIG_FILE}"
  chmod 600 "${NUDGE_CONFIG_FILE}"
}

get_api_url() {
  local url
  url=$(config_read "apiUrl" 2>/dev/null) || true
  echo "${url:-${NUDGE_DEFAULT_API_URL}}"
}

get_token() {
  local token
  token=$(config_read "token" 2>/dev/null) || true

  if [ -z "${token}" ]; then
    return 0
  fi

  # Auto-refresh if expired
  if is_token_expired "${token}"; then
    log_debug "Token expired, refreshing..."
    local new_token
    new_token=$(refresh_token 2>/dev/null) || true
    if [ -n "${new_token}" ]; then
      echo "${new_token}"
      return 0
    fi
    log_debug "Token refresh failed, returning expired token"
  fi

  echo "${token}"
}

# Check if a JWT token is expired (decode payload, check exp claim)
is_token_expired() {
  local token="$1"
  local payload

  # JWT format: header.payload.signature — extract payload
  payload=$(echo "${token}" | cut -d. -f2)
  if [ -z "${payload}" ]; then
    return 0  # Can't decode, assume expired
  fi

  # Add base64 padding if needed (POSIX-compatible, no seq)
  local remainder=$(( ${#payload} % 4 ))
  if [ ${remainder} -ne 0 ]; then
    local padding=$(( 4 - remainder ))
    local pad_str=""
    local i=0
    while [ ${i} -lt ${padding} ]; do
      pad_str="${pad_str}="
      i=$((i + 1))
    done
    payload="${payload}${pad_str}"
  fi

  local exp
  if command -v jq &>/dev/null; then
    exp=$(echo "${payload}" | base64 -d 2>/dev/null | jq -r '.exp // 0' 2>/dev/null) || exp=0
  else
    exp=$(echo "${payload}" | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*' | head -1 | sed 's/"exp"://') || exp=0
  fi

  local now
  now=$(date +%s)

  # Expired if less than 5 minutes remaining
  [ "${exp:-0}" -lt $((now + 300)) ]
}

# Refresh the ID token using the stored refresh token
refresh_token() {
  local refresh_tok
  refresh_tok=$(config_read "refreshToken" 2>/dev/null) || true
  local api_key
  api_key=$(config_read "apiKey" 2>/dev/null) || true

  if [ -z "${refresh_tok}" ] || [ -z "${api_key}" ]; then
    return 1
  fi

  local response
  response=$(curl -s --max-time 10 \
    "https://securetoken.googleapis.com/v1/token?key=${api_key}" \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"${refresh_tok}\"}" 2>/dev/null) || return 1

  local new_id_token
  new_id_token=$(json_extract "${response}" "id_token")
  local new_refresh_token
  new_refresh_token=$(json_extract "${response}" "refresh_token")

  if [ -n "${new_id_token}" ]; then
    config_write "token" "${new_id_token}"
    if [ -n "${new_refresh_token}" ]; then
      config_write "refreshToken" "${new_refresh_token}"
    fi
    echo "${new_id_token}"
    return 0
  fi

  return 1
}

get_user_id() {
  config_read "userId" 2>/dev/null || true
}

# --- JSON Helpers ---

json_extract() {
  local json="$1"
  local key="$2"

  if command -v jq &>/dev/null; then
    echo "${json}" | jq -r ".${key} // empty" 2>/dev/null
  else
    echo "${json}" | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null \
      | head -1 \
      | sed 's/.*:[[:space:]]*"\(.*\)"/\1/'
  fi
}

json_extract_raw() {
  local json="$1"
  local key="$2"

  if command -v jq &>/dev/null; then
    echo "${json}" | jq -r ".${key}" 2>/dev/null
  else
    # For non-string values (numbers, booleans)
    echo "${json}" | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*[^,}]*" 2>/dev/null \
      | head -1 \
      | sed 's/.*:[[:space:]]*//' \
      | sed 's/[[:space:]]*$//'
  fi
}

# --- HTTP Helpers ---

api_post() {
  local endpoint="$1"
  local data="$2"
  local token="${3:-$(get_token)}"
  local api_url
  api_url=$(get_api_url)

  local auth_header=""
  if [ -n "${token}" ]; then
    auth_header="-H \"Authorization: Bearer ${token}\""
  fi

  local attempt=0
  local delay=${RETRY_DELAY_BASE}

  while [ ${attempt} -lt ${RETRY_MAX} ]; do
    local response
    if [ -n "${token}" ]; then
      response=$(curl -s -w "\n%{http_code}" --max-time 30 \
        -X POST "${api_url}/${endpoint}" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "${data}" 2>/dev/null) || true
    else
      response=$(curl -s -w "\n%{http_code}" --max-time 30 \
        -X POST "${api_url}/${endpoint}" \
        -H "Content-Type: application/json" \
        -d "${data}" 2>/dev/null) || true
    fi

    if [ -n "${response}" ]; then
      local http_code
      http_code=$(echo "${response}" | tail -1)
      local body
      body=$(echo "${response}" | sed '$d')

      if [ "${http_code}" -ge 200 ] && [ "${http_code}" -lt 300 ] 2>/dev/null; then
        echo "${body}"
        return 0
      elif [ "${http_code}" = "429" ]; then
        log_debug "Rate limited, retrying in ${delay}s..."
      else
        log_debug "HTTP ${http_code}: ${body}"
      fi
    fi

    attempt=$((attempt + 1))
    if [ ${attempt} -lt ${RETRY_MAX} ]; then
      sleep ${delay}
      delay=$((delay * 2))
    fi
  done

  return 1
}

api_get() {
  local endpoint="$1"
  local token="${2:-$(get_token)}"
  local api_url
  api_url=$(get_api_url)

  local response
  if [ -n "${token}" ]; then
    response=$(curl -s -w "\n%{http_code}" --max-time 30 \
      -X GET "${api_url}/${endpoint}" \
      -H "Authorization: Bearer ${token}" 2>/dev/null) || true
  else
    response=$(curl -s -w "\n%{http_code}" --max-time 30 \
      -X GET "${api_url}/${endpoint}" 2>/dev/null) || true
  fi

  if [ -n "${response}" ]; then
    local http_code
    http_code=$(echo "${response}" | tail -1)
    local body
    body=$(echo "${response}" | sed '$d')

    if [ "${http_code}" -ge 200 ] && [ "${http_code}" -lt 300 ] 2>/dev/null; then
      echo "${body}"
      return 0
    fi
  fi

  return 1
}

# --- Graceful Exit ---
# Every failure mode exits 0 so Claude Code falls back to terminal prompt

graceful_exit() {
  local msg="${1:-}"
  if [ -n "${msg}" ]; then
    log_info "${msg}"
    log_to_file "FALLBACK: ${msg}"
  fi
  exit 0
}

#!/bin/bash
# lib.sh — Shared utilities for Nudge plugin scripts
# shellcheck disable=SC2155

set -euo pipefail

# --- Constants ---

NUDGE_CONFIG_DIR="${HOME}/.nudge"
NUDGE_CONFIG_FILE="${NUDGE_CONFIG_DIR}/config"
NUDGE_LOG_FILE="${NUDGE_CONFIG_DIR}/nudge.log"
NUDGE_DEFAULT_API_URL="${NUDGE_API_URL:-https://api.appnudge.dev}"

# SSE connection settings
SSE_MAX_TIME=520       # curl --max-time for SSE (just under Cloud Functions 540s limit)
SSE_MAX_FAILURES=5     # Max consecutive connection failures before fallback
SSE_HEARTBEAT_TIMEOUT=60  # Consider connection dead if no data for 60s

# Retry settings
RETRY_MAX=3
RETRY_DELAY_BASE=1     # Exponential backoff: 1s, 2s, 4s

# --- Session ID ---

# Derive a deterministic session ID from the host tool's environment.
# Must match the logic in core/lib/constants.mjs:getSessionId().
# Priority: hook session_id → per-PPID file → unknown
# Uses PPID (parent PID = Claude Code process) as key to avoid
# cross-session overwrites when multiple sessions share a port.
get_session_id() {
  local hook_session_id="${1:-}"
  # Hooks always have session_id — use it directly
  if [ -n "${hook_session_id}" ]; then
    echo "${hook_session_id}"
    return
  fi
  # Read from PPID-keyed file (for scripts without hook input)
  local ppid_key="${PPID:-}"
  local session_id_file
  if [ -n "${ppid_key}" ]; then
    session_id_file="${NUDGE_CONFIG_DIR}/session_id.${ppid_key}"
  else
    session_id_file="${NUDGE_CONFIG_DIR}/session_id"
  fi
  if [ -f "${session_id_file}" ]; then
    local file_id
    file_id="$(cat "${session_id_file}" 2>/dev/null)"
    if [ -n "${file_id}" ]; then
      echo "${file_id}"
      return
    fi
  fi
  echo "unknown"
}

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

# --- Internal Helpers ---

_has_jq() {
  command -v jq &>/dev/null
}

_ensure_config_dir() {
  mkdir -p "${NUDGE_CONFIG_DIR}"
  chmod 700 "${NUDGE_CONFIG_DIR}" 2>/dev/null || true
}

# Escape a string for safe embedding in JSON (handles backslashes, quotes, tabs, newlines)
_safe_json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g' | tr '\n' ' '
}

_parse_http_response() {
  local response="$1"
  HTTP_CODE=$(echo "${response}" | tail -1)
  HTTP_BODY=$(echo "${response}" | sed '$d')
}

_is_http_success() {
  local code="$1"
  [ "${code}" -ge 200 ] 2>/dev/null && [ "${code}" -lt 300 ] 2>/dev/null
}

# Check if a cooldown period is still active
# Usage: _check_cooldown "/path/to/timestamp_file" cooldown_ms
# Returns 0 (true) if cooldown is active, 1 (false) if expired
_check_cooldown() {
  local file="$1"
  local cooldown_ms="$2"
  if [ -f "${file}" ]; then
    local last_ts
    last_ts=$(cat "${file}" 2>/dev/null) || last_ts=0
    # Validate that timestamp is numeric
    if ! echo "${last_ts}" | grep -qE '^[0-9]+$'; then
      last_ts=0
    fi
    local now_ms=$(( $(date +%s) * 1000 ))
    local elapsed=$(( now_ms - last_ts ))
    if [ "${elapsed}" -lt "${cooldown_ms}" ] 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Read askMode from config with default fallback
_get_ask_mode() {
  local mode
  mode=$(config_read "askMode" 2>/dev/null) || true
  echo "${mode:-nudge}"
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

  if _has_jq; then
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

  _ensure_config_dir

  if config_exists && _has_jq; then
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
          local safe_val
          safe_val=$(_safe_json_string "${existing_val}")
          printf '  "%s": "%s"' "${existing_key}" "${safe_val}" >> "${tmp}"
          first=0
        fi
      fi
    done <<< "${existing_content}"
    # Add the new/updated key
    if [ ${first} -eq 0 ]; then
      echo "," >> "${tmp}"
    fi
    local safe_value
    safe_value=$(_safe_json_string "${value}")
    printf '  "%s": "%s"\n' "${key}" "${safe_value}" >> "${tmp}"
    echo '}' >> "${tmp}"
    mv "${tmp}" "${NUDGE_CONFIG_FILE}"
  else
    # Create new config
    local safe_value
    safe_value=$(_safe_json_string "${value}")
    cat > "${NUDGE_CONFIG_FILE}" << EOF
{
  "${key}": "${safe_value}"
}
EOF
  fi

  chmod 600 "${NUDGE_CONFIG_FILE}"
}

config_write_json() {
  local json="$1"
  _ensure_config_dir
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
  if _has_jq; then
    exp=$(echo "${payload}" | base64 -d 2>/dev/null | jq -r '.exp // 0' 2>/dev/null) || exp=0
  else
    exp=$(echo "${payload}" | base64 -d 2>/dev/null | grep -o '"exp":[0-9]*' | head -1 | sed 's/"exp"://') || exp=0
  fi

  # Validate that exp is numeric
  if ! echo "${exp}" | grep -qE '^[0-9]+$'; then
    return 0  # Can't parse exp, assume expired
  fi

  local now
  now=$(date +%s)

  # Expired if less than 5 minutes remaining
  [ "${exp}" -lt $((now + 300)) ]
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

  if _has_jq; then
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

  if _has_jq; then
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
      _parse_http_response "${response}"

      if _is_http_success "${HTTP_CODE}"; then
        echo "${HTTP_BODY}"
        return 0
      elif [ "${HTTP_CODE}" = "429" ]; then
        log_debug "Rate limited, retrying in ${delay}s..."
      else
        log_debug "HTTP ${HTTP_CODE}: ${HTTP_BODY}"
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
    _parse_http_response "${response}"

    if _is_http_success "${HTTP_CODE}"; then
      echo "${HTTP_BODY}"
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

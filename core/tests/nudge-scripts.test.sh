#!/bin/bash
# nudge-scripts.test.sh — Tests for Nudge bash hook scripts
#
# Tests lib.sh unit functions and integration behavior of:
#   nudge-session-start.sh, nudge-mode.sh, nudge-notify.sh, nudge-session-end.sh
#
# Does NOT test nudge-hook.sh (requires live SSE server) or network paths.
# Run: bash nudge-scripts.test.sh

# No set -e: we intentionally run commands that fail and capture their exit codes

PASSED=0
FAILED=0
declare -a ERRORS=()

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Scripts live in ../scripts/ (dist layout) or same dir (legacy flat layout)
if [ -d "${SCRIPT_DIR}/../scripts" ]; then
  SCRIPTS_DIR="${SCRIPT_DIR}/../scripts"
else
  SCRIPTS_DIR="${SCRIPT_DIR}"
fi
TEMP_DIR=$(mktemp -d)
TEST_HOME="${TEMP_DIR}"
TEST_CONFIG_DIR="${TEST_HOME}/.nudge"
TEST_CONFIG="${TEST_CONFIG_DIR}/config"

cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${TEST_CONFIG_DIR}"

# ============================================================
# Test framework
# ============================================================

assert_pass() {
  local name="$1"
  PASSED=$((PASSED + 1))
  printf "  \u2713 %s\n" "${name}"
}

assert_fail() {
  local name="$1"
  local reason="${2:-}"
  FAILED=$((FAILED + 1))
  ERRORS+=("${name}")
  printf "  \u2717 %s" "${name}"
  [ -n "${reason}" ] && printf " \342\200\224 %s" "${reason}"
  printf "\n"
}

expect_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    assert_pass "${name}"
  else
    assert_fail "${name}" "expected='${expected}' actual='${actual}'"
  fi
}

expect_contains() {
  local name="$1" pattern="$2" actual="$3"
  if echo "${actual}" | grep -q "${pattern}"; then
    assert_pass "${name}"
  else
    assert_fail "${name}" "pattern='${pattern}' not found in output"
  fi
}

expect_empty() {
  local name="$1" actual="$2"
  if [ -z "${actual}" ]; then
    assert_pass "${name}"
  else
    assert_fail "${name}" "expected empty, got '${actual}'"
  fi
}

expect_exit() {
  local name="$1" expected="$2" actual="$3"
  if [ "${actual}" = "${expected}" ]; then
    assert_pass "${name}"
  else
    assert_fail "${name}" "expected exit=${expected} actual exit=${actual}"
  fi
}

# ============================================================
# Config helpers
# ============================================================

write_config() {
  mkdir -p "${TEST_CONFIG_DIR}"
  printf '%s' "$1" > "${TEST_CONFIG}"
  chmod 600 "${TEST_CONFIG}"
}

remove_config() {
  rm -f "${TEST_CONFIG}"
}

# Run lib.sh functions in an isolated subshell with overridden HOME.
# Usage: run_lib 'some_shell_code'
run_lib() {
  HOME="${TEST_HOME}" bash -c "
    source '${SCRIPTS_DIR}/lib.sh' >/dev/null 2>&1 || true
    set +e +u
    $*
  " 2>/dev/null
}

# ============================================================
# lib.sh / config_exists
# ============================================================

echo ""
echo "lib.sh / config_exists"

remove_config
result=$(run_lib 'config_exists && echo yes || echo no')
expect_eq "returns 'no' when config absent" "no" "${result}"

write_config '{"token":"t"}'
result=$(run_lib 'config_exists && echo yes || echo no')
expect_eq "returns 'yes' when config present" "yes" "${result}"

# ============================================================
# lib.sh / config_read
# ============================================================

echo ""
echo "lib.sh / config_read"

write_config '{"token":"my-token","askMode":"nudge"}'

result=$(run_lib 'config_read "token"')
expect_eq "reads token value" "my-token" "${result}"

result=$(run_lib 'config_read "askMode"')
expect_eq "reads askMode value" "nudge" "${result}"

result=$(run_lib 'config_read "missing"')
expect_empty "returns empty for missing key" "${result}"

remove_config
result=$(run_lib 'config_read "token" || true')
expect_empty "returns empty when no config file" "${result}"

# ============================================================
# lib.sh / config_write
# ============================================================

echo ""
echo "lib.sh / config_write"

remove_config
run_lib 'config_write "token" "new-tok"' >/dev/null 2>&1
result=$(run_lib 'config_read "token"')
expect_eq "creates new config with key" "new-tok" "${result}"

write_config '{"token":"old","askMode":"terminal"}'
run_lib 'config_write "token" "updated"' >/dev/null 2>&1

result=$(run_lib 'config_read "token"')
expect_eq "updates existing key" "updated" "${result}"

result=$(run_lib 'config_read "askMode"')
expect_eq "preserves other keys on update" "terminal" "${result}"

# ============================================================
# lib.sh / json_extract
# ============================================================

echo ""
echo "lib.sh / json_extract"

JSON='{"tool_name":"Bash","session_id":"abc-123","action":"approved"}'

result=$(run_lib "json_extract '${JSON}' 'tool_name'")
expect_eq "extracts string value" "Bash" "${result}"

result=$(run_lib "json_extract '${JSON}' 'session_id'")
expect_eq "extracts hyphenated value" "abc-123" "${result}"

result=$(run_lib "json_extract '${JSON}' 'missing'")
expect_empty "returns empty for missing key" "${result}"

result=$(run_lib "json_extract '' 'tool_name'")
expect_empty "handles empty JSON" "${result}"

# ============================================================
# lib.sh / get_api_url
# ============================================================

echo ""
echo "lib.sh / get_api_url"

remove_config
result=$(run_lib 'get_api_url')
expect_eq "returns default URL without config" \
  "https://us-central1-enterx-nudge-dev.cloudfunctions.net" "${result}"

write_config '{"apiUrl":"https://custom.example.com"}'
result=$(run_lib 'get_api_url')
expect_eq "returns custom URL from config" "https://custom.example.com" "${result}"

# ============================================================
# lib.sh / is_token_expired
# ============================================================

echo ""
echo "lib.sh / is_token_expired"

# Helper: build a minimal JWT with the given exp (base64url-encoded payload)
make_jwt() {
  local exp="$1"
  local header="eyJhbGciOiJub25lIn0"  # {"alg":"none"}
  local payload
  payload=$(printf '{"exp":%d}' "${exp}" | base64 | tr -d '=' | tr -d '\n' | tr '+/' '-_')
  printf '%s.%s.sig' "${header}" "${payload}"
}

FUTURE_EXP=$(( $(date +%s) + 3600 ))
VALID_JWT=$(make_jwt "${FUTURE_EXP}")
result=$(VALID_JWT="${VALID_JWT}" HOME="${TEST_HOME}" bash -c "
  source '${SCRIPTS_DIR}/lib.sh' >/dev/null 2>&1 || true
  set +e +u
  is_token_expired \"\${VALID_JWT}\" && echo expired || echo valid
" 2>/dev/null)
expect_eq "non-expired token" "valid" "${result}"

PAST_EXP=$(( $(date +%s) - 3600 ))
EXPIRED_JWT=$(make_jwt "${PAST_EXP}")
result=$(EXPIRED_JWT="${EXPIRED_JWT}" HOME="${TEST_HOME}" bash -c "
  source '${SCRIPTS_DIR}/lib.sh' >/dev/null 2>&1 || true
  set +e +u
  is_token_expired \"\${EXPIRED_JWT}\" && echo expired || echo valid
" 2>/dev/null)
expect_eq "expired token" "expired" "${result}"

# Token with no dots — malformed
result=$(run_lib "is_token_expired 'not-a-jwt' && echo expired || echo valid")
expect_eq "malformed token (no dots) treated as expired" "expired" "${result}"

# Token without exp claim
NO_EXP_PAYLOAD=$(printf '{"sub":"u"}' | base64 | tr -d '=' | tr -d '\n' | tr '+/' '-_')
NO_EXP_JWT="eyJhbGciOiJub25lIn0.${NO_EXP_PAYLOAD}.sig"
result=$(NO_EXP_JWT="${NO_EXP_JWT}" HOME="${TEST_HOME}" bash -c "
  source '${SCRIPTS_DIR}/lib.sh' >/dev/null 2>&1 || true
  set +e +u
  is_token_expired \"\${NO_EXP_JWT}\" && echo expired || echo valid
" 2>/dev/null)
expect_eq "token without exp treated as expired" "expired" "${result}"

# ============================================================
# lib.sh / graceful_exit
# ============================================================

echo ""
echo "lib.sh / graceful_exit"

exit_code=$(HOME="${TEST_HOME}" bash -c "
  source '${SCRIPTS_DIR}/lib.sh' >/dev/null 2>&1 || true
  set +e +u
  graceful_exit 'test message'
  echo \$?
" 2>/dev/null; echo $?)
expect_eq "exits with code 0" "0" "${exit_code}"

# ============================================================
# nudge-session-start.sh
# ============================================================

echo ""
echo "nudge-session-start.sh"

# Not configured — no output, exit 0
remove_config
output=$(printf '{}' | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-start.sh" 2>/dev/null)
exit_code=$?
expect_exit "exits 0 when not configured" "0" "${exit_code}"
expect_empty "no output when not configured" "${output}"

# askMode: nudge
write_config '{"token":"tok","askMode":"nudge"}'
output=$(printf '{}' | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-start.sh" 2>/dev/null)
expect_contains "outputs NUDGE context" "NUDGE" "${output}"
# hookEventName is Claude Code specific — skip for other adapters
if echo "${output}" | grep -q "hookEventName"; then
  expect_contains "includes hookEventName SessionStart" "SessionStart" "${output}"
else
  assert_pass "includes hookEventName SessionStart (adapter omits hookEventName)"
fi
expect_contains "includes hookSpecificOutput key" "hookSpecificOutput" "${output}"

# askMode: terminal
write_config '{"token":"tok","askMode":"terminal"}'
output=$(printf '{}' | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-start.sh" 2>/dev/null)
expect_contains "outputs TERMINAL context" "TERMINAL" "${output}"

# No askMode key → defaults to nudge
write_config '{"token":"tok"}'
output=$(printf '{}' | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-start.sh" 2>/dev/null)
expect_contains "defaults to NUDGE when askMode absent" "NUDGE" "${output}"

# Unknown askMode value → fallback to NUDGE
write_config '{"token":"tok","askMode":"unknown_value"}'
output=$(printf '{}' | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-start.sh" 2>/dev/null)
expect_contains "falls back to NUDGE for unknown askMode" "NUDGE" "${output}"

# ============================================================
# nudge-mode.sh
# ============================================================

echo ""
echo "nudge-mode.sh"

# Not configured
remove_config
output=$(HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-mode.sh" 2>/dev/null)
expect_contains "shows not-configured message" "pair" "${output}"

# Display current mode (no args)
write_config '{"token":"tok","askMode":"nudge"}'
output=$(HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-mode.sh" 2>/dev/null)
expect_contains "displays current mode" "nudge" "${output}"

# Set to terminal
write_config '{"token":"tok","askMode":"nudge"}'
HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-mode.sh" terminal >/dev/null 2>&1
result=$(run_lib 'config_read "askMode"')
expect_eq "sets askMode to terminal" "terminal" "${result}"

# Set to nudge
write_config '{"token":"tok","askMode":"terminal"}'
HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-mode.sh" nudge >/dev/null 2>&1
result=$(run_lib 'config_read "askMode"')
expect_eq "sets askMode to nudge" "nudge" "${result}"

# Invalid mode → exit non-zero
HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-mode.sh" invalid_mode >/dev/null 2>&1
exit_code=$?
if [ "${exit_code}" -ne 0 ]; then
  assert_pass "exits non-zero for invalid mode"
else
  assert_fail "exits non-zero for invalid mode" "Expected non-zero, got 0"
fi

# ============================================================
# nudge-notify.sh
# ============================================================

echo ""
echo "nudge-notify.sh"

IDLE_INPUT='{"notification_type":"idle_prompt","message":"Claude is waiting","title":"Idle","session_id":"s1"}'

# Not configured → exits 0 silently
remove_config
HOME="${TEST_HOME}" printf '%s' "${IDLE_INPUT}" | bash "${SCRIPTS_DIR}/nudge-notify.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 when not configured" "0" "${exit_code}"

# Cooldown active (last_notify timestamp < 30s ago) → exits 0
write_config '{"token":"tok"}'
NOW_MS=$(( $(date +%s) * 1000 ))
printf '%s' "${NOW_MS}" > "${TEST_CONFIG_DIR}/last_notify"
HOME="${TEST_HOME}" printf '%s' "${IDLE_INPUT}" | bash "${SCRIPTS_DIR}/nudge-notify.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 during cooldown" "0" "${exit_code}"
rm -f "${TEST_CONFIG_DIR}/last_notify"

# elicitation_dialog skipped in terminal mode
write_config '{"token":"tok","askMode":"terminal"}'
ELIX_INPUT='{"notification_type":"elicitation_dialog","message":"Claude needs input","title":"Input","session_id":"s1"}'
HOME="${TEST_HOME}" printf '%s' "${ELIX_INPUT}" | bash "${SCRIPTS_DIR}/nudge-notify.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 for elicitation_dialog in terminal mode" "0" "${exit_code}"

# permission_prompt skipped if recent approval (last_approval < 600s ago)
write_config '{"token":"tok"}'
NOW_MS=$(( $(date +%s) * 1000 ))
printf '%s' "${NOW_MS}" > "${TEST_CONFIG_DIR}/last_approval"
PERM_INPUT='{"notification_type":"permission_prompt","message":"Permission needed","title":"Permission","session_id":"s1"}'
HOME="${TEST_HOME}" printf '%s' "${PERM_INPUT}" | bash "${SCRIPTS_DIR}/nudge-notify.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 for permission_prompt with recent approval" "0" "${exit_code}"
rm -f "${TEST_CONFIG_DIR}/last_approval"

# ============================================================
# nudge-session-end.sh
# ============================================================

echo ""
echo "nudge-session-end.sh"

# Not configured → exits 0
remove_config
printf '{"session_id":"s1","reason":"clear"}' \
  | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-end.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 when not configured" "0" "${exit_code}"

# Config present but no token → exits 0
write_config '{"apiUrl":"http://127.0.0.1:19999"}'
printf '{"session_id":"s1","reason":"logout"}' \
  | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-end.sh" >/dev/null 2>&1
exit_code=$?
expect_exit "exits 0 when no token in config" "0" "${exit_code}"

# With token (expired/fake): removes last_stop file even if API call fails.
# Uses unreachable URL so api_post fails fast (connection refused).
# Note: api_post retries up to 3 times — this test takes ~3 seconds.
write_config '{"token":"fake.ZHVtbXk.sig","apiUrl":"http://127.0.0.1:19999"}'
touch "${TEST_CONFIG_DIR}/last_stop"
printf '{"session_id":"s1","reason":"clear"}' \
  | HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-end.sh" >/dev/null 2>&1 || true
if [ ! -f "${TEST_CONFIG_DIR}/last_stop" ]; then
  assert_pass "removes last_stop file on session end"
else
  assert_fail "removes last_stop file on session end" "last_stop still exists"
fi

# reason=clear produces non-empty body (smoke check via debug output)
write_config '{"token":"fake.ZHVtbXk.sig","apiUrl":"http://127.0.0.1:19999"}'
debug_output=$(printf '{"session_id":"s1","reason":"clear"}' \
  | NUDGE_DEBUG=1 HOME="${TEST_HOME}" bash "${SCRIPTS_DIR}/nudge-session-end.sh" 2>&1 || true)
expect_contains "logs SessionEnd debug message" "SessionEnd" "${debug_output}"

# ============================================================
# Summary
# ============================================================

echo ""
TOTAL=$((PASSED + FAILED))
printf '%d tests: %d passed, %d failed\n\n' "${TOTAL}" "${PASSED}" "${FAILED}"

if [ "${FAILED}" -gt 0 ]; then
  echo "Failed tests:"
  for err in "${ERRORS[@]}"; do
    printf '  - %s\n' "${err}"
  done
  exit 1
fi

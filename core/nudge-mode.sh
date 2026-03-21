#!/bin/bash
# nudge-mode.sh — Toggle askMode between nudge and terminal
# Usage: nudge-mode.sh [nudge|terminal]
# If no argument, displays current mode.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# --- Check if configured ---

if ! config_exists; then
  echo "❌ Nudge is not configured. Run /pair first."
  exit 0
fi

# --- Read current mode ---

CURRENT_MODE=$(_get_ask_mode)

# --- Handle arguments ---

NEW_MODE="${1:-}"

if [ -z "${NEW_MODE}" ]; then
  # Display current mode
  echo "Current ask mode: ${CURRENT_MODE}"
  echo ""
  echo "Available modes:"
  if [ "${CURRENT_MODE}" = "nudge" ]; then
    echo "  ● nudge     — Questions go to mobile (current)"
  else
    echo "  ○ nudge     — Questions go to mobile"
  fi
  if [ "${CURRENT_MODE}" = "terminal" ]; then
    echo "  ● terminal  — Questions stay in terminal (current)"
  else
    echo "  ○ terminal  — Questions stay in terminal"
  fi
  echo ""
  echo "Usage: /afk (mobile)   or   /desk (terminal)"
  exit 0
fi

# --- Validate and set mode ---

case "${NEW_MODE}" in
  nudge|terminal)
    config_write "askMode" "${NEW_MODE}"
    echo "✅ Ask mode changed: ${CURRENT_MODE} → ${NEW_MODE}"
    if [ "${NEW_MODE}" = "nudge" ]; then
      echo "Questions will now be sent to your mobile device."
    else
      echo "Questions will now appear in the terminal."
    fi
    echo ""
    echo "Mode switch takes effect immediately."
    ;;
  *)
    echo "Invalid mode: ${NEW_MODE}"
    echo "Valid modes: nudge, terminal"
    graceful_exit "Invalid mode: ${NEW_MODE}"
    ;;
esac

exit 0

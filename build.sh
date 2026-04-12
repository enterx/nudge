#!/bin/bash
# build.sh — Assembles self-contained dist/ packages per adapter
#
# Usage: bash build.sh
#
# Produces:
#   dist/claude-code/  — Installable plugin for Claude Code

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="${REPO_ROOT}/core"
ADAPTERS="${REPO_ROOT}/adapters"
DIST="${REPO_ROOT}/dist"

echo "Building Nudge plugin..."

# Clean
rm -rf "${DIST}"

# ----------------------------------------------------------------
# Claude Code
# ----------------------------------------------------------------
CC_DIST="${DIST}/claude-code/plugins/nudge"
mkdir -p "${CC_DIST}/scripts/lib" "${CC_DIST}/servers" "${CC_DIST}/hooks" "${CC_DIST}/skills"
mkdir -p "${DIST}/claude-code/.claude-plugin"

# Read version from constants.mjs (single source of truth)
PLUGIN_VERSION=$(grep "SERVER_VERSION" "${CORE}/lib/constants.mjs" | sed "s/.*'\(.*\)'.*/\1/")
echo "  Version: ${PLUGIN_VERSION}"

# Marketplace wrapper (version injected from constants.mjs)
cat > "${DIST}/claude-code/.claude-plugin/marketplace.json" <<MKJSON
{
  "name": "nudge-marketplace",
  "description": "Nudge - Mobile push notifications for AI coding tool approvals",
  "owner": { "name": "EnterX LLC" },
  "plugins": [
    {
      "name": "nudge",
      "description": "Mobile push notifications for AI coding tool approvals. Approve or deny actions from your phone.",
      "version": "${PLUGIN_VERSION}",
      "author": { "name": "EnterX LLC" },
      "source": "./plugins/nudge",
      "category": "productivity",
      "license": "MIT"
    }
  ]
}
MKJSON

# Copy adapter-specific files
cp -R "${ADAPTERS}/claude-code/"* "${CC_DIST}/"
cp -R "${ADAPTERS}/claude-code/".mcp.json "${CC_DIST}/" 2>/dev/null || true

# Copy core lib/ (adapter files take precedence — copy core first, then overlay)
for f in "${CORE}/lib/"*.mjs; do
  base=$(basename "$f")
  if [ ! -f "${CC_DIST}/scripts/lib/${base}" ]; then
    cp "$f" "${CC_DIST}/scripts/lib/${base}"
  fi
done

# Copy core bash lib
cp "${CORE}/lib.sh" "${CC_DIST}/scripts/lib.sh"

# Copy core shared scripts
for f in "${CORE}/"*.sh; do
  base=$(basename "$f")
  [ "$base" = "lib.sh" ] && continue
  cp "$f" "${CC_DIST}/scripts/${base}"
done

# Copy MCP server (rewrite import paths for dist layout: ./lib/ → ../scripts/lib/)
sed 's|from '\''./lib/|from '\''../scripts/lib/|g' \
  "${CORE}/nudge-mcp-server.mjs" > "${CC_DIST}/servers/nudge-mcp-server.mjs"

# Copy tests (rewrite import paths for dist layout: ../lib/ → ../scripts/lib/, ../nudge-mcp-server.mjs → ../servers/nudge-mcp-server.mjs)
cp -R "${CORE}/tests" "${CC_DIST}/tests"
for f in "${CC_DIST}/tests/"*.mjs; do
  [ -f "$f" ] || continue
  sed -i '' \
    -e "s|from '../lib/|from '../scripts/lib/|g" \
    -e "s|import('../lib/|import('../scripts/lib/|g" \
    -e "s|'..', 'nudge-mcp-server.mjs'|'..', 'servers', 'nudge-mcp-server.mjs'|g" \
    "$f"
done

echo "  Built: dist/claude-code/"

# ----------------------------------------------------------------
# Codex CLI
# ----------------------------------------------------------------
CX_DIST="${DIST}/codex-cli/plugins/nudge"
mkdir -p "${CX_DIST}/scripts/lib" "${CX_DIST}/servers" "${CX_DIST}/hooks" "${CX_DIST}/skills"
mkdir -p "${DIST}/codex-cli/.codex-plugin"

# Plugin manifest (Codex format — version injected from constants.mjs)
cat > "${DIST}/codex-cli/.codex-plugin/plugin.json" <<PJSON
{
  "name": "nudge",
  "version": "${PLUGIN_VERSION}",
  "description": "Mobile push notifications for coding AI approvals. Approve or deny actions from your phone with end-to-end encryption.",
  "author": { "name": "EnterX LLC" },
  "skills": "./plugins/nudge/skills/",
  "hooks": "./plugins/nudge/hooks/hooks.json",
  "mcpServers": "./plugins/nudge/.mcp.json",
  "interface": {
    "displayName": "Nudge",
    "shortDescription": "Approve coding AI actions from your phone",
    "category": "Productivity"
  }
}
PJSON

# Copy adapter-specific files
cp -R "${ADAPTERS}/codex-cli/"* "${CX_DIST}/"
cp -R "${ADAPTERS}/codex-cli/".mcp.json "${CX_DIST}/" 2>/dev/null || true

# Copy core lib/ (adapter files take precedence — skip if already present)
for f in "${CORE}/lib/"*.mjs; do
  base=$(basename "$f")
  if [ ! -f "${CX_DIST}/scripts/lib/${base}" ]; then
    cp "$f" "${CX_DIST}/scripts/lib/${base}"
  fi
done

# Copy core bash lib
cp "${CORE}/lib.sh" "${CX_DIST}/scripts/lib.sh"

# Copy core shared scripts
for f in "${CORE}/"*.sh; do
  base=$(basename "$f")
  [ "$base" = "lib.sh" ] && continue
  cp "$f" "${CX_DIST}/scripts/${base}"
done

# Copy MCP server (rewrite import paths for dist layout: ./lib/ → ../scripts/lib/)
sed 's|from '\''./lib/|from '\''../scripts/lib/|g' \
  "${CORE}/nudge-mcp-server.mjs" > "${CX_DIST}/servers/nudge-mcp-server.mjs"

# Copy tests (rewrite import paths for dist layout)
cp -R "${CORE}/tests" "${CX_DIST}/tests"
for f in "${CX_DIST}/tests/"*.mjs; do
  [ -f "$f" ] || continue
  sed -i '' \
    -e "s|from '../lib/|from '../scripts/lib/|g" \
    -e "s|import('../lib/|import('../scripts/lib/|g" \
    -e "s|'..', 'nudge-mcp-server.mjs'|'..', 'servers', 'nudge-mcp-server.mjs'|g" \
    "$f"
done

echo "  Built: dist/codex-cli/"

# ----------------------------------------------------------------
# Post-processing
# ----------------------------------------------------------------

# Set executable permissions on all shell scripts
find "${DIST}" -name "*.sh" -exec chmod +x {} +

# Verify key files exist
echo ""
echo "Verifying build..."
ERRORS=0
BASE="${DIST}/claude-code/plugins/nudge"

for f in "scripts/lib/api.mjs" "scripts/lib/config.mjs" "scripts/lib/constants.mjs" \
         "scripts/lib/sse.mjs" "scripts/lib/token-utils.mjs" "scripts/lib/logger.mjs" \
         "scripts/lib/crypto.mjs" "scripts/lib/encrypt-json.mjs" \
         "servers/nudge-mcp-server.mjs" "scripts/nudge-hook.mjs"; do
  if [ ! -f "${BASE}/${f}" ]; then
    echo "  MISSING: ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done

CX_BASE="${DIST}/codex-cli/plugins/nudge"
for f in "scripts/lib/api.mjs" "scripts/lib/config.mjs" "scripts/lib/constants.mjs" \
         "scripts/lib/sse.mjs" "scripts/lib/token-utils.mjs" "scripts/lib/logger.mjs" \
         "scripts/lib/crypto.mjs" "scripts/lib/encrypt-json.mjs" \
         "servers/nudge-mcp-server.mjs" "scripts/nudge-hook.mjs"; do
  if [ ! -f "${CX_BASE}/${f}" ]; then
    echo "  MISSING (codex-cli): ${f}"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ $ERRORS -eq 0 ]; then
  echo "  All checks passed."
else
  echo "  ${ERRORS} file(s) missing!"
  exit 1
fi

echo ""
echo "Build complete."
echo "  Claude Code: /plugin marketplace add $(pwd)/dist/claude-code"
echo "  Codex CLI:   Copy dist/codex-cli/ to ~/.codex/plugins/ or set NUDGE_CODEX_ROOT"

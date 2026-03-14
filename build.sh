#!/bin/bash
# build.sh — Assembles self-contained dist/ package for Claude Code
#
# Usage: bash build.sh
#
# Produces:
#   dist/claude-code/  — Installable Claude Code plugin

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

# Marketplace wrapper
cat > "${DIST}/claude-code/.claude-plugin/marketplace.json" << 'MKJSON'
{
  "name": "nudge-marketplace",
  "description": "Nudge - Mobile push notifications for AI coding tool approvals",
  "owner": { "name": "EnterX LLC" },
  "plugins": [
    {
      "name": "nudge",
      "description": "Mobile push notifications for AI coding tool approvals. Approve or deny actions from your phone.",
      "version": "2.0.0",
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
         "servers/nudge-mcp-server.mjs" "scripts/nudge-hook.mjs"; do
  if [ ! -f "${BASE}/${f}" ]; then
    echo "  MISSING: ${f}"
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
echo "  /plugin marketplace add $(pwd)/dist/claude-code"

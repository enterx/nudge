#!/bin/bash
# run-all.sh — Run Codex MCP-only Nudge plugin tests
set -e

cd "$(dirname "$0")/.."

echo ""
echo "=== Node.js unit tests ==="
echo ""

echo "--- config.test.mjs ---"
node tests/config.test.mjs

echo ""
echo "--- token-utils.test.mjs ---"
node tests/token-utils.test.mjs

echo ""
echo "--- sse.test.mjs ---"
node tests/sse.test.mjs

echo ""
echo "=== MCP server tests ==="
echo ""
node tests/nudge-mcp-server.test.mjs

echo ""
echo "========================================"
echo "  All tests passed."
echo "========================================"

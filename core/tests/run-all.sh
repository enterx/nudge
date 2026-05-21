#!/bin/bash
# run-all.sh — Run all Nudge plugin tests
#
# Executes Node.js unit tests, MCP server tests, and shell tests.
# Exit 1 on any failure.
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
echo "--- session-id.test.mjs ---"
node tests/session-id.test.mjs

echo ""
echo "--- provider.test.mjs ---"
node tests/provider.test.mjs

echo ""
echo "--- hook.test.mjs ---"
node tests/hook.test.mjs

echo ""
echo "--- pending-files.test.mjs ---"
node tests/pending-files.test.mjs

echo ""
echo "--- hook-runtime.test.mjs ---"
node tests/hook-runtime.test.mjs

echo ""
echo "--- run-wrap.test.mjs ---"
node tests/run-wrap.test.mjs

echo ""
echo "--- sse.test.mjs ---"
node tests/sse.test.mjs

echo ""
echo "=== MCP server tests ==="
echo ""
node tests/nudge-mcp-server.test.mjs

echo ""
echo "=== CLI tests ==="
echo ""
node tests/nudge-cli.test.mjs

echo ""
echo "=== Shell tests ==="
echo ""
bash tests/nudge-scripts.test.sh

echo ""
echo "========================================"
echo "  All tests passed."
echo "========================================"

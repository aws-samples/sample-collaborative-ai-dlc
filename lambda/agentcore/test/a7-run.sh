#!/usr/bin/env bash
# A7 — run a real `claude` CLI against the seeded local MCP server with the real
# upstream stage prompt. Single-file so shell line-wrapping can't drop the flags.
set -euo pipefail

cd "$(dirname "$0")/.."   # lambda/agentcore

PROMPT="$(cat test/a7-prompt.txt)"

echo "=== sanity: MCP config exists, tools wired ==="
test -f test/a7-mcp-config.json && echo "config: test/a7-mcp-config.json OK"

echo "=== running claude (stream-json) ==="
claude -p "$PROMPT" \
  --mcp-config test/a7-mcp-config.json \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose 2>&1 | tail -80

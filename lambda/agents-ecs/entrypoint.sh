#!/bin/bash
set -e

# ---------------------------------------------------------------------------
# AI-DLC Agent Entrypoint
#
# All CLI discovery and authentication is handled by pool-worker.js at startup.
# It probes which CLI binaries are installed in the image and attempts auth for
# each one — no configuration needed.
# ---------------------------------------------------------------------------

echo "Starting agent entrypoint (WORKER_ID=${WORKER_ID})"

exec node /opt/acp-client/pool-worker.js

#!/usr/bin/env bash
# Starts sea-lite over stdio for mcp-writecheck, on the job's own store only. It refuses to start
# without SEA_LITE_DATA_DIR, so a run can never fall back to a user's default store.
set -euo pipefail
: "${SEA_LITE_DATA_DIR:?SEA_LITE_DATA_DIR must name the store of this job}"
cd "$(dirname "$0")/../../srv"
exec node dist/cli.js serve --actor dogfood --data-dir "$SEA_LITE_DATA_DIR"

#!/usr/bin/env bash
# Builds mcp-writecheck from the checkout made just before (path mws-cli, the commit `cli-ref.sh`
# chose) and exports MWSC_CLI_PATH for the action's `cli-path` input.
#
# Why the workflows build the CLI themselves instead of passing `cli-token` to the action: the token
# is then used by one checkout step that runs before any server code or third-party npm tree is
# installed or started in the job, and no later step sees it. (It stays in the runner's own memory
# for the job; see dogfood/README.md.) Install scripts are off; the CLI's lockfile pins its tree.
set -euo pipefail
dir=mws-cli/packages/writecheck
[ "$(git -C mws-cli rev-parse HEAD)" = "${CLI_REF:?}" ] || { echo "::error::mws-cli is not at $CLI_REF"; exit 1; }
( cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run build --silent )
[ -f "$dir/dist/src/cli/main.js" ] || { echo "::error::the CLI build produced no entry script"; exit 1; }
echo "MWSC_CLI_PATH=$dir" >> "$GITHUB_ENV"
echo "mcp-writecheck built at $CLI_REF"

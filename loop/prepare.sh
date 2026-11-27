#!/usr/bin/env bash
# Set-up of the writecheck loop worker's job, shared by .github/workflows/corpus.yml (the worker the pump
# dispatches) and .github/workflows/loop-fixture.yml (its pull-request proof run). Run from the workspace root.
#
#   loop/prepare.sh fetch      mcp-writecheck at CLI_REF (built by dogfood/build-cli.sh), mcp-surface-corpus at
#                              SANDBOX_REF (the sandbox), tool-qa's seed at SEED_REF, and mcp-check's live-probe
#                              resolver at MCP_CHECK_REF (OCI images, WC14: its corpus/ module and the src/ and engine/
#                              it imports, no dependency installed); every checkout is a public repository fetched by
#                              its full commit SHA, with no token, and checked to be at it
#
# gVisor, the firewall and the sandbox self test are not here: the workflows call mcp-surface-corpus's reusable
# sandbox-conformance.yml and, in the job itself, its sandbox-guard action, both at SANDBOX_REF.
#
# Nothing here runs third-party server code: the CLI is built before anything else, from its own lockfile with
# install scripts off (dogfood/build-cli.sh).
set -euo pipefail

sha_re='^[0-9a-f]{40}$'

fetch_at() { # repo sha dir [sparse path...]
  local repo=$1 sha=$2 dir=$3
  shift 3
  [[ "$sha" =~ $sha_re ]] || { echo "::error::$repo: not a full commit SHA"; exit 1; }
  rm -rf "$dir"
  git init -q "$dir"
  git -C "$dir" remote add origin "https://github.com/$repo.git"
  if [ "$#" -gt 0 ]; then
    git -C "$dir" sparse-checkout set --no-cone "$@"
  fi
  git -C "$dir" -c protocol.version=2 fetch -q --depth 1 --filter=blob:none origin "$sha"
  git -C "$dir" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] || { echo "::error::$repo is not at $sha"; exit 1; }
  echo "$repo at $sha"
}

case "${1:-}" in
  fetch)
    : "${CLI_REF:?}" "${SANDBOX_REF:?}" "${SEED_REF:?}" "${MCP_CHECK_REF:?}"
    fetch_at isokron-ai/mcp-write-safety "$CLI_REF" mws-cli /packages/writecheck/ /spec/mws.md
    dogfood/build-cli.sh
    fetch_at isokron-ai/mcp-surface-corpus "$SANDBOX_REF" msc
    fetch_at isokron-ai/tool-qa "$SEED_REF" toolqa /history/seed-v1.json
    fetch_at isokron-ai/mcp-check "$MCP_CHECK_REF" mck /corpus/live-probe.mjs /corpus/tool-commit.mjs /corpus/mcpb.mjs /corpus/pypi-entry.mjs /corpus/scan-static.mjs /corpus/static-read.cjs /corpus/ast-grep/ /corpus/oracles/ /corpus/fixtures/live-probe/ /src/ /engine/ /package.json
    ;;
  *)
    echo "usage: loop/prepare.sh fetch" >&2
    exit 2
    ;;
esac

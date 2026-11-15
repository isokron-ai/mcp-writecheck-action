#!/usr/bin/env bash
# Chooses the mcp-writecheck commit for this run: the dispatch input `cli-ref` (env INPUT_REF), or the
# action's own default (contract.mjs CLI_DEFAULT_REF). Only a full 40-character SHA is accepted.
# Writes CLI_REF to GITHUB_ENV and to the step output `ref`.
set -euo pipefail
ref=${INPUT_REF:-}
if [ -z "$ref" ]; then
  ref=$(node --input-type=module -e "import { CLI_DEFAULT_REF } from './contract.mjs'; console.log(CLI_DEFAULT_REF)")
fi
if ! [[ $ref =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::cli-ref must be a full 40-character lower-case commit SHA"
  exit 1
fi
echo "CLI_REF=$ref" >> "$GITHUB_ENV"
echo "ref=$ref" >> "$GITHUB_OUTPUT"
echo "mcp-writecheck commit: $ref"

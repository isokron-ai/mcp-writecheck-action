#!/usr/bin/env bash
# Runs one shard. corpus/run-shard.mjs prints only the label and "run finished, exit N" lines;
# its exit status (0: every target ran to completion; 1: a CLI or harness problem) goes to the step
# output rc, and the step itself always succeeds so that the results are encrypted and uploaded.
set -uo pipefail
c="$RUNNER_TEMP/corpus"
node corpus/run-shard.mjs --targets "$c/targets.json" --cli "${MWSC_CLI_PATH:?}" --cli-commit "${CLI_REF:?}" \
  --out "$c/out" --work "$c/work" --lane ci --shard "${SHARD:?}" --shards "${CORPUS_SHARDS:?}" | tee "$c/public.txt"
rc=${PIPESTATUS[0]}
rm -f "$c/targets.json"
echo "rc=$rc" >> "$GITHUB_OUTPUT"
exit 0

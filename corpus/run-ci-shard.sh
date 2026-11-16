#!/usr/bin/env bash
# Runs one shard. corpus/run-shard.mjs prints only the label and "run finished, exit N" lines;
# its exit status (0: every target ran to completion; 1: a CLI or harness problem) goes to the step
# output rc, and the step itself always succeeds so that the results are encrypted and uploaded.
set -uo pipefail
c="$RUNNER_TEMP/corpus"
mkdir -p "$c/out/_shard"
# The driver's own stderr (a Node warning, a crash) goes to the encrypted bundle, never to the log.
node corpus/run-shard.mjs --targets "$c/targets.json" --consume-targets --cli "${MWSC_CLI_PATH:?}" --cli-commit "${CLI_REF:?}" \
  --out "$c/out" --work "$c/work" --lane ci --shard "${SHARD:?}" --shards "${CORPUS_SHARDS:?}" \
  2>>"$c/out/_shard/driver-stderr.log" | tee "$c/public.txt"
rc=${PIPESTATUS[0]}
rm -f "$c/targets.json"
# Last sweep: any process started for a target (marked CORPUS_SANDBOX=1) that is still alive. The runner
# would otherwise name it in the public "Terminate orphan process" lines at the end of the job.
for p in /proc/[0-9]*; do
  if tr '\0' '\n' < "$p/environ" 2>/dev/null | grep -qx 'CORPUS_SANDBOX=1'; then kill -KILL "${p#/proc/}" 2>/dev/null || true; fi
done
echo "rc=$rc" >> "$GITHUB_OUTPUT"
exit 0

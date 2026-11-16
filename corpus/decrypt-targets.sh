#!/usr/bin/env bash
# Decrypts corpus/targets.json.age with the CORPUS_TARGETS_KEY secret (an age identity, the whole
# AGE-SECRET-KEY-1... line). The identity lives in a 0600 file for the length of this step only.
# Prints nothing about the list; a failure here is a harness error.
set -euo pipefail
umask 077
if [ -z "${CORPUS_TARGETS_KEY:-}" ]; then
  echo "harness error: the CORPUS_TARGETS_KEY secret is not set"
  exit 1
fi
mkdir -p "$RUNNER_TEMP/corpus"
k="$RUNNER_TEMP/corpus/.id"
trap 'rm -f "$k"' EXIT
printf '%s\n' "$CORPUS_TARGETS_KEY" > "$k"
age -d -i "$k" -o "$RUNNER_TEMP/corpus/targets.json" corpus/targets.json.age

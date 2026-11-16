#!/usr/bin/env bash
# The job summary: the label and the "run finished, exit N" lines, and nothing else (any other line
# is dropped, so no change to the driver can put target text here).
set -euo pipefail
p="$RUNNER_TEMP/corpus/public.txt"
{
  echo "automated candidate, unreviewed: not a finding"
  echo
  if [ -f "$p" ]; then grep -E '^run finished, exit [0-9]+$' "$p" | sed 's/^/- /' || true; else echo "- run finished, exit 125"; fi
} >> "$GITHUB_STEP_SUMMARY"

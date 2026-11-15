#!/usr/bin/env bash
# Uses the tiny-tracker manifest of the chosen CLI commit (checked out at mwsm/ by the step before)
# instead of dogfood/tiny-tracker/writecheck.yaml: a newer CLI can need keys an older one refuses.
# The only change made to it is the server's cwd, which points at the checked-out tiny-tracker.
# Exports TT_MANIFEST.
set -euo pipefail
src=mwsm/examples/tiny-tracker/writecheck.yaml
out=dogfood/tiny-tracker/writecheck.from-cli.yaml
[ -f "$src" ] || { echo "::error::the CLI commit has no examples/tiny-tracker/writecheck.yaml"; exit 1; }
sed 's|^  cwd: \.  .*|  cwd: ../../tt/examples/tiny-tracker   # the checked-out tiny-tracker, relative to this file|' "$src" > "$out"
grep -q '^  cwd: \.\./\.\./tt/examples/tiny-tracker ' "$out" || { echo "::error::the manifest's cwd line was not found"; exit 1; }
echo "TT_MANIFEST=$out" >> "$GITHUB_ENV"
echo "using the tiny-tracker manifest of the CLI commit (sha256 $(sha256sum "$out" | cut -c1-16))"

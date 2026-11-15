#!/usr/bin/env bash
# The defects job passes only when the action failed the full run because of violated MUST records:
# the run completed (CLI exit 1), the action decided status 1, and results.json holds violated MUSTs.
# Env: OUTCOME EXIT_STATUS CLI_EXIT RESULTS (from the full step's outcome and outputs).
set -euo pipefail
echo "step outcome: $OUTCOME, action exit-status: $EXIT_STATUS, CLI exit: $CLI_EXIT"
fail() { echo "::error::$1"; exit 1; }
[ "$OUTCOME" = failure ] || fail "the full run with every defect on did not fail the step"
[ "$EXIT_STATUS" = 1 ] || fail "the action's exit-status is '$EXIT_STATUS', expected 1"
[ "$CLI_EXIT" = 1 ] || fail "the CLI exited '$CLI_EXIT', expected 1 (a completed run with a violated MUST)"
[ -f "$RESULTS/results.json" ] || fail "no results.json in '$RESULTS'"
n=$(node -e 'const d=require(process.argv[1]); console.log(d.results.filter(r=>r.verdict==="violated"&&r.level==="MUST").length)' "$RESULTS/results.json")
[ "$n" -gt 0 ] || fail "results.json has no violated MUST record"
echo "violated MUST records present; the action failed the run as it should"

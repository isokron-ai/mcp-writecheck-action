#!/usr/bin/env bash
# One known CLI bug, tracked as an expected failure (the known-bug matrix).
#   TRAP=<name> CLI_EXIT=<exit> EXIT_STATUS=<action status> RESULTS=<run folder> [CRASH_LOG=<file>] \
#     dogfood/tiny-tracker/expect-trap.sh
# backend-crash  the backend is killed during the run (CRASH_LOG must show it happened before the run
#                ended). Known bug at CLI 0295ed6: the run is reported complete with exit 0. Fixed when
#                it exits 4 (stopped or failed) or is not complete. The action must fail the job either way.
# setup-fails    every resource's set-up fails (results.json must show it). Known bug at 0295ed6: exit 0.
#                Fixed when non-zero.
# While the bug is present the step passes with a notice; once the CLI is fixed it fails, so that the
# trap is flipped to a plain expectation. A trap that did not happen as designed fails the step.
set -euo pipefail
fail() { echo "::error::$1"; exit 1; }
[ -n "${CLI_EXIT:-}" ] || fail "trap $TRAP did not run (no CLI exit status)"
[ -n "${RESULTS:-}" ] && [ -f "$RESULTS/results.json" ] || fail "trap $TRAP: no results.json"
status=$(node -e 'console.log(require(process.argv[1]).run?.status ?? "")' "$RESULTS/results.json")
echo "trap $TRAP: CLI exit $CLI_EXIT, run status $status, action exit-status ${EXIT_STATUS:-none}"
case "$TRAP" in
  backend-crash)
    [ -f "${CRASH_LOG:-}" ] && cat "$CRASH_LOG"
    crashed=$(sed -n 's/^crashed at \([0-9]*\).*/\1/p' "${CRASH_LOG:-/dev/null}" | head -1)
    [ -n "$crashed" ] || fail "trap backend-crash: the backend was not crashed (see the crash log above); nothing to judge"
    ended=$(node -e 'const t=Date.parse(require(process.argv[1]).run?.ended ?? ""); console.log(Number.isFinite(t) ? t : 0)' "$RESULTS/results.json")
    [ "$ended" -gt "$crashed" ] || fail "trap backend-crash: the backend was killed after the run ended; nothing to judge"
    [ "${EXIT_STATUS:-}" = 1 ] || fail "the action did not fail the job whose backend crashed"
    buggy=$([ "$CLI_EXIT" = 0 ] && [ "$status" = complete ] && echo yes || echo no)
    ;;
  setup-fails)
    n=$(node -e 'const d=require(process.argv[1]); console.log(d.results.filter((r) => /^setup failed:/.test(r.reason ?? "")).length)' "$RESULTS/results.json")
    [ "$n" -gt 0 ] || fail "trap setup-fails: no record says the set-up failed; the trap did not happen as designed"
    buggy=$([ "$CLI_EXIT" = 0 ] && echo yes || echo no)
    ;;
  *) fail "unknown trap $TRAP" ;;
esac
if [ "$buggy" = yes ]; then
  echo "::notice::known CLI bug still present ($TRAP): expected failure"
  exit 0
fi
fail "the CLI no longer shows the known bug ($TRAP): flip this trap to an expectation in the workflow"

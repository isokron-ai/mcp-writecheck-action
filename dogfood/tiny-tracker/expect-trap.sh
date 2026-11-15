#!/usr/bin/env bash
# One known CLI bug, tracked as an expected failure (NOTE: "known-bug matrix").
#   TRAP=<name> CLI_EXIT=<exit> RESULTS=<run folder> dogfood/tiny-tracker/expect-trap.sh
# backend-crash  the backend is killed during the run. Known bug at CLI 0295ed6: the run is reported
#                complete with exit 0. Fixed when it exits 4 (stopped or failed) or is not complete.
# setup-fails    every resource's set-up fails. Known bug at 0295ed6: exit 0. Fixed when non-zero.
# While the bug is present the step passes with a notice; once the CLI is fixed it fails, so that the
# trap is flipped to a plain expectation.
set -euo pipefail
status=
[ -n "${RESULTS:-}" ] && [ -f "$RESULTS/results.json" ] && status=$(node -e 'console.log(require(process.argv[1]).run?.status ?? "")' "$RESULTS/results.json")
echo "trap $TRAP: CLI exit ${CLI_EXIT:-none}, run status ${status:-no results}, action exit-status ${EXIT_STATUS:-none}"
# Whatever the CLI says, the action must fail a job whose backend crashed (its clean-up rule).
if [ "$TRAP" = backend-crash ] && [ "${EXIT_STATUS:-}" != 1 ]; then
  echo "::error::the action did not fail the job whose backend crashed"
  exit 1
fi
case "$TRAP" in
  backend-crash) buggy=$([ "${CLI_EXIT:-}" = 0 ] && [ "$status" = complete ] && echo yes || echo no) ;;
  setup-fails) buggy=$([ "${CLI_EXIT:-}" = 0 ] && echo yes || echo no) ;;
  *) echo "::error::unknown trap $TRAP"; exit 1 ;;
esac
if [ "$buggy" = yes ]; then
  echo "::notice::known CLI bug still present ($TRAP): expected failure"
  exit 0
fi
echo "::error::the CLI no longer shows the known bug ($TRAP): flip this trap to an expectation in the workflow"
exit 1

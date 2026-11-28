#!/usr/bin/env bash
# After the sandbox-guard step of a dogfood worker: the guard passed, it ran the sandbox at SANDBOX_REF, and the
# checkout dogfood/sbx.mjs loads (msc/, loop/prepare.sh sandbox) is that same commit.
#   env: VERDICT and GUARD_SHA (the guard's outputs), SANDBOX_REF
set -euo pipefail
[ "${VERDICT:-}" = pass ] || { echo "::error::the sandbox self test did not pass"; exit 1; }
[ "${GUARD_SHA:-}" = "${SANDBOX_REF:?}" ] || { echo "::error::the sandbox guard ran another commit than SANDBOX_REF"; exit 1; }
[ "$(git -C msc rev-parse HEAD)" = "$SANDBOX_REF" ] || { echo "::error::the driver's sandbox checkout is not SANDBOX_REF"; exit 1; }
echo "sandbox guard passed at $SANDBOX_REF"

#!/usr/bin/env bash
# The cli-known-bugs job passes only while the CLI still gives exactly its known false results on
# writecheck-claim.yaml, and nothing else is violated:
#   MWS-ANN-2 and MWS-ANN-5 on sea_claim: a claim placed on an unclaimed ticket (claim: null -> an
#     object) is read as data removed or replaced;
#   MWS-RETRY-1 on sea_create: `violated` because the manifest names no idempotency key, although
#     sea_create's input schema declares one (idempotency_key).
# When either disappears, this job fails on purpose: the CLI was fixed, so move sea_claim back into
# writecheck.yaml, drop the fixed entry here, and remove the job once both are gone.
# Env: OUTCOME EXIT_STATUS CLI_EXIT RESULTS (from the full step).
set -euo pipefail
echo "step outcome: $OUTCOME, action exit-status: $EXIT_STATUS, CLI exit: $CLI_EXIT"
fail() { echo "::error::$1"; exit 1; }
[ -f "$RESULTS/results.json" ] || fail "no results.json in '$RESULTS'"
got=$(node -e '
const d = require(process.argv[1]);
const v = d.results.filter((r) => r.verdict === "violated").map((r) => `${r.requirement} ${r.write_path.tool}`);
console.log([...new Set(v)].sort().join(","));
' "$RESULTS/results.json")
want="MWS-ANN-2 sea_claim,MWS-ANN-5 sea_claim,MWS-RETRY-1 sea_create"
echo "violated records: ${got:-none}"
[ "$got" = "$want" ] || fail "the violated records changed (expected exactly: $want). If a known CLI false result is gone, the CLI was fixed: update writecheck.yaml and this script."
[ "$OUTCOME" = failure ] && [ "$EXIT_STATUS" = 1 ] && [ "$CLI_EXIT" = 1 ] || fail "the action did not fail the step on the violated MUST"
echo "only the known CLI false results are present"

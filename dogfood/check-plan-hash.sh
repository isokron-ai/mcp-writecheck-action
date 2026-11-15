#!/usr/bin/env bash
# Compares the plan hash a plan step printed with the one a person read and accepted (pinned in the
# workflow). A difference means the plan changed: the full run would be refused. Read the new plan
# in the plan step's job summary, then update the pinned hash in the workflow.
#   dogfood/check-plan-hash.sh <accepted> <seen>
set -euo pipefail
accepted=${1:?accepted hash}
seen=${2:-}
if [ -z "$seen" ]; then
  echo "::error::the plan step printed no plan hash (see its summary)"
  exit 1
fi
if [ "$seen" != "$accepted" ]; then
  echo "::error::the plan changed: hash $seen, accepted $accepted. Read the new plan in the plan step's summary; if it is right, update PLAN_HASH in this workflow."
  exit 1
fi
echo "plan hash $seen is the accepted one"

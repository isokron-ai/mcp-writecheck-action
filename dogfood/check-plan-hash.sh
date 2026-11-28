#!/usr/bin/env bash
# Compares the plan hash a plan step printed with the one a person read and accepted, and exports the
# accepted hash as ACCEPTED_PLAN_HASH for the full step.
#
#   dogfood/check-plan-hash.sh <pinned> <seen> [<job key>]
#
# <pinned> is the hash pinned in the workflow for the CLI it pins. A run dispatched with another
# `cli-ref` gives other plans: the person who dispatches it reads them (run once without hashes; this
# step then fails and names each hash) and passes the accepted ones in the `plan-hashes` input as
# space-separated `<job key>=<hash>` pairs (env PLAN_HASHES). A pair for this job replaces <pinned>.
#
# A difference means the plan changed and the full run would be refused: read the new plan in the plan
# step's job summary; if it is right, update the pinned hash (or the dispatch input).
set -euo pipefail
set -f   # no globbing of the input
pinned=${1:?pinned hash}
seen=${2:-}
key=${3:-}
accepted=$pinned
source="pinned in the workflow"
if [ -n "$key" ] && [ -n "${PLAN_HASHES:-}" ]; then
  for pair in $PLAN_HASHES; do
    case "$pair" in
      "$key="*) accepted=${pair#*=}; source="from the plan-hashes input" ;;
    esac
  done
fi
# One machine-readable row per comparison, read by .github/workflows/hash-table.yml (dogfood/hash-table.mjs):
# a notice annotation titled plan-hash-row plus a line in the job summary. Written before any check, so a
# failing comparison still reports its hashes. HASH_CELL names a matrix cell. Nothing here accepts a hash.
row_val() { printf '%s' "$1" | tr -c 'A-Za-z0-9._:=-' '_' | cut -c1-64; }
row=$(printf '{"workflow":"%s","job":"%s","key":"%s","cell":"%s","pinned":"%s","accepted":"%s","seen":"%s"}' \
  "$(row_val "${GITHUB_WORKFLOW:-}")" "$(row_val "${GITHUB_JOB:-}")" "$(row_val "$key")" "$(row_val "${HASH_CELL:-}")" \
  "$(row_val "$pinned")" "$(row_val "$accepted")" "$(row_val "$seen")")
echo "::notice title=plan-hash-row::$row"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "plan-hash-row: $row" >> "$GITHUB_STEP_SUMMARY"
if ! printf '%s' "$accepted" | grep -Eq '^[0-9a-f]{16}$'; then
  echo "::error::the accepted plan hash for ${key:-this job} is not a plan hash"
  exit 1
fi
if [ -z "$seen" ]; then
  echo "::error::the plan step printed no plan hash (see its summary)"
  exit 1
fi
if [ "$seen" != "$accepted" ]; then
  echo "::error::the plan changed: hash $seen, accepted $accepted ($source). Read the new plan in the plan step's summary; if it is right, update the pinned hash, or dispatch again with plan-hashes '${key:-<job>}=$seen'."
  exit 1
fi
echo "ACCEPTED_PLAN_HASH=$accepted" >> "$GITHUB_ENV"
echo "plan hash $seen is the accepted one ($source)"

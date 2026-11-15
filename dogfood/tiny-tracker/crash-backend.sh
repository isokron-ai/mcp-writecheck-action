#!/usr/bin/env bash
# Trap "backend crash": started in the background before a full run, it waits until the run is under
# way (its ledger in <results-dir>/state/ has 30 entries, or 10 s after the run's state folder
# appears) and then kills tiny-tracker's backend, as if it had crashed.
#   dogfood/tiny-tracker/crash-backend.sh <results-dir> &
set -uo pipefail
state=${1:?results dir}/state
pidfile="${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.pid"
seen=
for _ in $(seq 1 1200); do
  ledger=$(find "$state" -mindepth 2 -name ledger.jsonl 2>/dev/null | head -1)
  if [ -n "$ledger" ]; then
    [ -n "$seen" ] || seen=$SECONDS
    if [ "$(wc -l < "$ledger")" -ge 30 ] || [ $((SECONDS - seen)) -ge 10 ]; then
      kill -9 "$(cat "$pidfile")" 2>/dev/null && echo "crash-backend: killed the backend $((SECONDS - seen)) s into the run"
      exit 0
    fi
  fi
  sleep 0.25
done
echo "crash-backend: the run never started"

#!/usr/bin/env bash
# Trap "backend crash": started in the background before a full run, it waits until the run is under
# way (its ledger in <results-dir>/state/ has 30 entries, or 10 s after the run's state folder
# appears), kills tiny-tracker's backend with SIGKILL, as if it had crashed, and checks that the
# backend's port is closed. It writes "crashed at <epoch ms>" only when both held.
#   dogfood/tiny-tracker/crash-backend.sh <results-dir> &
set -uo pipefail
state=${1:?results dir}/state
pidfile="${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.pid"
port=${TRACKER_BACKEND_URL##*:}
seen=
for _ in $(seq 1 1200); do
  ledger=$(find "$state" -mindepth 2 -name ledger.jsonl 2>/dev/null | head -1)
  if [ -n "$ledger" ]; then
    [ -n "$seen" ] || seen=$SECONDS
    if [ "$(wc -l < "$ledger")" -ge 30 ] || [ $((SECONDS - seen)) -ge 10 ]; then
      kill -9 "$(cat "$pidfile")" 2>/dev/null || { echo "crash-backend: could not kill the backend"; exit 1; }
      for _ in $(seq 1 20); do
        if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
          echo "crashed at $(node -e 'console.log(Date.now())') ($((SECONDS - seen)) s into the run, ledger $(wc -l < "$ledger") entries)"
          exit 0
        fi
        sleep 0.25
      done
      echo "crash-backend: the backend's port is still open after the kill"
      exit 1
    fi
  fi
  sleep 0.25
done
echo "crash-backend: the run never started"

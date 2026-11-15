#!/usr/bin/env bash
# Starts or stops tiny-tracker's in-memory backend for one job.
#   dogfood/tiny-tracker/backend.sh start|stop
# start: makes a backend token for this job only (masked, exported through GITHUB_ENV), starts the
# backend on TRACKER_BACKEND_URL's port and waits for it.
set -euo pipefail
dir=tt/examples/tiny-tracker
pidfile="${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.pid"
case "${1:?start or stop}" in
  start)
    port=${TRACKER_BACKEND_URL##*:}
    token=$(openssl rand -hex 16)
    echo "::add-mask::$token"
    echo "TRACKER_BACKEND_TOKEN=$token" >> "$GITHUB_ENV"
    ( cd "$dir" && TRACKER_BACKEND_TOKEN=$token nohup node dist/src/cli.js backend --port "$port" > "${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.log" 2>&1 & echo $! > "$pidfile" )
    for _ in $(seq 1 60); do
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "backend up on $port"; exit 0; fi
      sleep 0.5
    done
    echo "::error::the tiny-tracker backend did not start"; cat "${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.log"; exit 1
    ;;
  stop)
    [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null || true
    ;;
esac

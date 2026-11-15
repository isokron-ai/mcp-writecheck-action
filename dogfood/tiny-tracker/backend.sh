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
    # Not `cd && node &`: that backgrounds a subshell, and $! would be the subshell, not node.
    ( cd "$dir" || exit 1; TRACKER_BACKEND_TOKEN=$token nohup node dist/src/cli.js backend --port "$port" > "${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.log" 2>&1 & echo $! > "$pidfile" )
    for _ in $(seq 1 60); do
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "backend up on $port"; exit 0; fi
      sleep 0.5
    done
    echo "::error::the tiny-tracker backend did not start"; cat "${RUNNER_TEMP:-/tmp}/tiny-tracker-backend.log"; exit 1
    ;;
  stop)
    port=${TRACKER_BACKEND_URL##*:}
    if [ -f "$pidfile" ]; then
      pid=$(cat "$pidfile")
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$pidfile"
    fi
    # The port must be free before another backend starts on it.
    for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null || exit 0; sleep 0.25; done
    echo "::error::port $port is still in use after stopping the backend"; exit 1
    ;;
esac

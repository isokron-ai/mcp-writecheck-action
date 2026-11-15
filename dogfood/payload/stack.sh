#!/usr/bin/env bash
# The experiment's sandbox app for one CI job (the experiment repository is checked out at ./exp).
#   dogfood/payload/stack.sh build research|vendor   pnpm install; research: harness/build/build.sh app research-v2-1
#   dogfood/payload/stack.sh start research|vendor   writes the app's .env (random PAYLOAD_SECRET), starts `next dev`
#                                                    on 127.0.0.1:4960 and waits until /api answers
#   dogfood/payload/stack.sh shim                    starts dogfood/payload/shim.mjs on 127.0.0.1:4961 in front of the app
#   dogfood/payload/stack.sh stop
# Env: DATABASE_URL (Postgres service container, loopback). Nothing secret is printed.
set -euo pipefail
EXP=$PWD/exp/harness
PORT=4960
LOG=${RUNNER_TEMP:-/tmp}/payload-next.log
PIDFILE=${RUNNER_TEMP:-/tmp}/payload-next.pid
appdir() { case "$1" in research) echo "$EXP/build/app-research-v2-1" ;; vendor) echo "$EXP/app" ;; *) echo "research or vendor" >&2; exit 2 ;; esac; }
case "${1:?build, start or stop}" in
  build)
    (cd "$EXP/app" && pnpm install --frozen-lockfile)
    if [ "$2" = research ]; then
      "$EXP/build/build.sh" check-patches
      "$EXP/build/build.sh" app research-v2-1
    fi
    ;;
  start)
    APP=$(appdir "$2")
    secret=$(openssl rand -hex 24)
    echo "::add-mask::$secret"
    umask 077
    printf 'DATABASE_URL=%s\nPAYLOAD_SECRET=%s\n' "${DATABASE_URL:?DATABASE_URL}" "$secret" > "$APP/.env"
    umask 022
    cd "$APP"
    NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--no-deprecation nohup node_modules/.bin/next dev -H 127.0.0.1 -p "$PORT" > "$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    # next dev compiles the /api route on the first request and pushes the schema to Postgres
    for _ in $(seq 1 180); do
      code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/users/init" || true)
      [ "$code" = 200 ] && { echo "app up: $(curl -s "http://127.0.0.1:$PORT/api/users/init")"; exit 0; }
      kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "::error::next dev exited"; tail -50 "$LOG"; exit 1; }
      sleep 2
    done
    echo "::error::the app did not answer in 6 minutes"; tail -50 "$LOG"; exit 1
    ;;
  shim)
    nohup node dogfood/payload/shim.mjs --listen 4961 --upstream "http://127.0.0.1:$PORT" > "${RUNNER_TEMP:-/tmp}/payload-shim.log" 2>&1 &
    echo $! > "$PIDFILE.shim"
    for _ in $(seq 1 30); do
      (exec 3<>/dev/tcp/127.0.0.1/4961) 2>/dev/null && { echo "shim up: $(head -1 "${RUNNER_TEMP:-/tmp}/payload-shim.log")"; exit 0; }
      sleep 0.5
    done
    echo "::error::the shim did not start"; cat "${RUNNER_TEMP:-/tmp}/payload-shim.log"; exit 1
    ;;
  stop)
    for f in "$PIDFILE.shim" "$PIDFILE"; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
    ;;
esac

#!/usr/bin/env bash
# The experiment's sandbox app for one CI job (the experiment repository is checked out at ./exp). Every mode runs
# inside the job's sandbox (dogfood/sbx.mjs, .github/workflows/dogfood-payload.yml): Postgres is the sandbox service
# `pg` at 10.213.53.6:5432 and the app (`next dev`) the service `app` at 10.213.53.5:4960, which the unit (where these
# modes, the seeding and the CLI run) reaches as 127.0.0.1:4960.
#   dogfood/payload/stack.sh build research|vendor   pnpm install; research: harness/build/build.sh app research-v2-1
#                                                    (a sandbox build step: registry.npmjs.org only, pnpm on PATH)
#   dogfood/payload/stack.sh pg                      waits for Postgres; DATABASE_URL (the password is the file the
#                                                    service was started with) goes to the sandbox's own GITHUB_ENV
#   dogfood/payload/stack.sh env research|vendor     writes the app's .env (DATABASE_URL, a random PAYLOAD_SECRET)
#   (the workflow then starts the app as the sandbox service `app`, in the app's folder)
#   dogfood/payload/stack.sh wait                    waits until the app's /api answers (next dev compiles on demand)
#   dogfood/payload/stack.sh shim-wait               waits for dogfood/payload/shim.mjs on 127.0.0.1:4961
# Nothing secret is printed. Env: RUNNER_TEMP, GITHUB_ENV (inside the sandbox: loop/sandbox/dogfood-in.mjs).
set -euo pipefail
EXP=$PWD/exp/harness
PORT=4960
appdir() { case "$1" in research) echo "$EXP/build/app-research-v2-1" ;; vendor) echo "$EXP/app" ;; *) echo "research or vendor" >&2; exit 2 ;; esac; }
tcp_wait() { # host port seconds
  node -e '
    const net = require("net"); const [h, p, s] = process.argv.slice(1);
    const until = Date.now() + Number(s) * 1000;
    (function go() { const c = net.connect(Number(p), h, () => { c.end(); process.exit(0); }); c.on("error", () => { if (Date.now() > until) process.exit(1); setTimeout(go, 500); }); })();
  ' "$1" "$2" "$3"
}
case "${1:?build, pg, env, wait or shim-wait}" in
  build)
    (cd "$EXP/app" && pnpm install --frozen-lockfile)
    if [ "$2" = research ]; then
      "$EXP/build/build.sh" check-patches
      "$EXP/build/build.sh" app research-v2-1
    fi
    ;;
  pg)
    pw=$(cat "$RUNNER_TEMP/pg-secrets/pw")
    [[ $pw =~ ^[0-9a-f]{36}$ ]] || { echo "::error::the Postgres password file is not one the driver made"; exit 1; }
    tcp_wait 10.213.53.6 5432 90 || { echo "Postgres did not become ready"; exit 1; }
    echo "DATABASE_URL=postgresql://payload:$pw@10.213.53.6:5432/payload" >> "$GITHUB_ENV"
    echo "Postgres up at 10.213.53.6:5432"
    ;;
  env)
    APP=$(appdir "$2")
    secret=$(node -p 'require("crypto").randomBytes(24).toString("hex")')
    umask 077
    printf 'DATABASE_URL=%s\nPAYLOAD_SECRET=%s\n' "${DATABASE_URL:?DATABASE_URL}" "$secret" > "$APP/.env"
    echo "wrote $APP/.env"
    ;;
  wait)
    node -e '
      const u = "http://127.0.0.1:" + process.argv[1] + "/api/users/init";
      (async () => {
        for (let i = 0; i < 180; i++) {
          try { const r = await fetch(u); if (r.status === 200) { console.log("app up: " + (await r.text()).slice(0, 200)); return; } } catch {}
          await new Promise((r) => setTimeout(r, 2000));
        }
        console.error("the app did not answer in 6 minutes"); process.exit(1);
      })();
    ' "$PORT"
    ;;
  shim-wait)
    tcp_wait 127.0.0.1 4961 15 || { echo "the shim did not start"; cat "$RUNNER_TEMP/payload-shim.log" 2>/dev/null; exit 1; }
    echo "shim up: $(head -1 "$RUNNER_TEMP/payload-shim.log" 2>/dev/null)"
    ;;
esac

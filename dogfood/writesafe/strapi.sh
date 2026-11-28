#!/usr/bin/env bash
# The writesafe test app for one CI job: Strapi 5 with the plugin installed from its packed tarball, on
# SQLite. Every step runs inside the job's sandbox (dogfood/sbx.mjs; .github/workflows/dogfood-writesafe.yml):
# Strapi is a service of the sandbox's run network at 10.213.53.5:4812, which the unit (where these steps, the CLI
# and the plugin's own token script run) reaches as 127.0.0.1:4812. Every credential is generated in the
# sandbox, for a Strapi that nothing outside it can reach, and is never printed.
#
#   dogfood/writesafe/strapi.sh prepare   build the app from ws/ (the checked-out plugin repository); a sandbox build step
#   dogfood/writesafe/strapi.sh env       write the app's .env and the first admin's credentials
#   (the workflow then starts Strapi as the sandbox service `strapi`, in the app folder)
#   dogfood/writesafe/strapi.sh seed      wait for Strapi, register the first admin, make the tokens (WS_MCP_TOKEN and
#                                          WS_REST_TOKEN, through the sandbox's own GITHUB_ENV), seed test data
#
# Env: STRAPI_VERSION (default 5.62.0), RUNNER_TEMP, GITHUB_ENV (inside the sandbox: loop/sandbox/dogfood-in.mjs).
set -euo pipefail
WS=${WS_DIR:-$PWD/ws}
APP=${RUNNER_TEMP:?}/ws-app
SECRETS=$RUNNER_TEMP/ws-secrets
PORT=4812
BASE=http://127.0.0.1:$PORT

rnd() { node -e 'process.stdout.write(require("crypto").randomBytes(+process.argv[1]).toString("base64url"))' "$1"; }

case "${1:?prepare, env or seed}" in
  prepare)
    "$WS/ci/prepare_app.sh" "${STRAPI_VERSION:-5.62.0}" "$APP"
    ;;

  env)
    mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
    umask 077
    {
      echo "HOST=0.0.0.0"
      echo "PORT=$PORT"
      echo "APP_KEYS=$(rnd 24),$(rnd 24),$(rnd 24),$(rnd 24)"
      echo "API_TOKEN_SALT=$(rnd 24)"
      echo "ADMIN_JWT_SECRET=$(rnd 24)"
      echo "TRANSFER_TOKEN_SALT=$(rnd 24)"
      echo "JWT_SECRET=$(rnd 24)"
      echo "ENCRYPTION_KEY=$(rnd 24)"
      echo "STRAPI_TELEMETRY_DISABLED=true"
      echo "DO_NOT_TRACK=1"
      echo "DATABASE_CLIENT=sqlite"
      echo "WRITESAFE_MODULES=create,delete,bulk,replace,copy,localize"
    } > "$APP/.env"
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ email: "ci-admin@example.test", password: "Ci9" + require("crypto").randomBytes(18).toString("base64url") }), { mode: 0o600 })' "$SECRETS/admin.json"
    umask 022
    rm -rf "$APP/.tmp"
    echo "wrote the app's .env and the admin credentials"
    ;;

  seed)
    node -e '
      const base = process.argv[1];
      (async () => {
        for (let i = 0; i < 180; i++) {
          try { const r = await fetch(base + "/_health"); if (r.status === 204) { console.log("Strapi is up"); return; } } catch {}
          await new Promise((r) => setTimeout(r, 1000));
        }
        console.error("Strapi not healthy after 180 s"); process.exit(1);
      })();
    ' "$BASE"

    export SPIKE_BASE=$BASE SPIKE_ADMIN=$SECRETS/admin.json SPIKE_TOKENS=$SECRETS/tokens.json
    node -e '
      const a = JSON.parse(require("fs").readFileSync(process.env.SPIKE_ADMIN, "utf8"));
      fetch(process.env.SPIKE_BASE + "/admin/register-admin", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstname: "CI", lastname: "Admin", email: a.email, password: a.password }) })
        .then(async (r) => { if (!r.ok) { console.error("register-admin", r.status); process.exit(1); } console.log("admin registered"); });
    '
    node "$WS/scripts/setup_tokens.mjs" > /dev/null
    node -e '
      const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const fs = require("fs");
      const all = [t.admin["agent-a"], t.admin["agent-b"], t.rest["rest-a"], t.rest["rest-b"]];
      // Values from the server: refuse anything that is not a plain token (a newline would inject into the env file).
      if (!all.every((v) => typeof v === "string" && /^[A-Za-z0-9._~+\/=-]+$/.test(v))) { console.error("a token has an unexpected form"); process.exit(1); }
      fs.appendFileSync(process.env.GITHUB_ENV, "WS_MCP_TOKEN=" + t.admin["agent-a"] + "\nWS_REST_TOKEN=" + t.rest["rest-a"] + "\n");
      console.log("tokens made");
    ' "$SECRETS/tokens.json"
    node - "$SECRETS/tokens.json" <<'EOF'
const fs = require('fs');
const rest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).rest['rest-a'];
const base = process.env.SPIKE_BASE;
async function post(path, data) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + rest }, body: JSON.stringify({ data }) });
  if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`);
}
(async () => {
  await post('/api/pages', { title: 'mwsws-guard', summary: 'guard page' });
  for (const n of [1, 2, 3]) await post('/api/pages', { title: `mwsws-by-${n}`, summary: `bystander ${n}`, note: 'do not touch' });
  await post('/api/articles?locale=en', { title: 'mwsws-by-article', slug: 'mwsws-by-article', code: 'by-code', level: 'basic' });
  console.log('seeded the guard page and the bystanders');
})().catch((e) => { console.error(e.message); process.exit(1); });
EOF
    ;;

esac

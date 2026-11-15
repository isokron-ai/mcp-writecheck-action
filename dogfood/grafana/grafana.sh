#!/usr/bin/env bash
# The disposable Grafana for one job.
#   dogfood/grafana/grafana.sh start      start Grafana (docker), make the admin password and an Editor
#                                         service-account token for this job (masked; the token is
#                                         exported as GRAFANA_SERVICE_ACCOUNT_TOKEN through GITHUB_ENV)
#   dogfood/grafana/grafana.sh fixtures   the folder and dashboards the manifest names, and the objects
#                                         the tester does not create (bystanders)
#   dogfood/grafana/grafana.sh snap <out> what the tester did not create, as checksums (dogfood/grafana/snap.py)
#   dogfood/grafana/grafana.sh stop       remove the container
# Env: GRAFANA_URL (http://127.0.0.1:<port>), GRAFANA_IMAGE (pinned by digest).
set -euo pipefail
G=${GRAFANA_URL:?GRAFANA_URL}
port=${G##*:}
sec="${RUNNER_TEMP:?RUNNER_TEMP}/grafana-secrets"
name=dogfood-grafana
pw() { cat "$sec/admin-pw"; }
api() { # method path [json]: as the admin, with the password from the file (never on the command line)
  local m=$1 p=$2 d=${3:-}
  curl -sS -f --config <(printf 'user = "admin:%s"\n' "$(pw)") -H 'content-type: application/json' -X "$m" "$G$p" ${d:+-d "$d"}
}
case "${1:?start, fixtures, snap or stop}" in
  start)
    mkdir -p "$sec" && chmod 700 "$sec"
    ( umask 077; openssl rand -hex 16 > "$sec/admin-pw" )
    echo "::add-mask::$(pw)"
    GF_SECURITY_ADMIN_PASSWORD="$(pw)" docker run -d --name "$name" -p "127.0.0.1:$port:3000" \
      -e GF_SECURITY_ADMIN_PASSWORD \
      -e GF_INSTALL_PLUGINS="" -e GF_PLUGINS_PREINSTALL_SYNC="" -e GF_PLUGINS_PREINSTALL_DISABLED=true \
      -e GF_ANALYTICS_REPORTING_ENABLED=false -e GF_ANALYTICS_CHECK_FOR_UPDATES=false \
      -e GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false -e GF_NEWS_NEWS_FEED_ENABLED=false \
      -e GF_FEATURE_TOGGLES_ENABLE=dashboardNewLayouts -e GF_LOG_LEVEL=info \
      "${GRAFANA_IMAGE:?GRAFANA_IMAGE}" > /dev/null
    for _ in $(seq 1 90); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "$G/api/health")" = 200 ] && break
      sleep 2
    done
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$G/api/health")" = 200 ] || { echo "::error::Grafana did not become healthy"; docker logs --tail 50 "$name"; exit 1; }
    id=$(api POST /api/serviceaccounts '{"name":"mwsv-editor","role":"Editor"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
    [[ $id =~ ^[0-9]+$ ]] || { echo "::error::unexpected service account id"; exit 1; }
    token=$(api POST "/api/serviceaccounts/$id/tokens" '{"name":"mwsv-editor-token"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
    echo "::add-mask::$token"
    # A value from Grafana: refuse anything but a service-account token before it reaches GITHUB_ENV.
    [[ $token =~ ^glsa_[A-Za-z0-9_]+$ ]] || { echo "::error::unexpected token format"; exit 1; }
    echo "GRAFANA_SERVICE_ACCOUNT_TOKEN=$token" >> "$GITHUB_ENV"
    echo "Grafana up on $port; Editor service account made"
    ;;
  fixtures)
    api POST /api/folders '{"uid":"mwsv-fixture","title":"mwsv-fixture"}' > /dev/null
    api POST /api/dashboards/db '{"dashboard":{"uid":"mwsv-canary","title":"mwsv canary (never written by the run)","description":"canary","tags":["mwsv"],"panels":[{"id":1,"type":"text","title":"C1","gridPos":{"x":0,"y":0,"w":8,"h":4}}]},"folderUid":"mwsv-fixture","overwrite":true}' > /dev/null
    api POST /api/dashboards/db '{"dashboard":{"uid":"mwsv-annhost","title":"mwsv annotation host","tags":["mwsv"],"panels":[{"id":1,"type":"text","title":"A1","gridPos":{"x":0,"y":0,"w":8,"h":4}}]},"folderUid":"mwsv-fixture","overwrite":true}' > /dev/null
    # bystanders: objects the tester did not create, which must be unchanged after the run
    api POST /api/folders '{"uid":"mwsv-bystander","title":"mwsv-bystander"}' > /dev/null
    api POST /api/dashboards/db '{"dashboard":{"uid":"mwsv-bystander-dash","title":"mwsv bystander dashboard","description":"bystander","tags":["mwsv"],"panels":[{"id":1,"type":"text","title":"B1","gridPos":{"x":0,"y":0,"w":8,"h":4}}]},"folderUid":"mwsv-bystander","overwrite":true}' > /dev/null
    for n in 1 2; do
      api POST /api/annotations "{\"dashboardUID\":\"mwsv-annhost\",\"time\":179470000${n}000,\"text\":\"mwsv bystander annotation $n\",\"tags\":[\"mwsv\",\"bystander\"]}" > /dev/null
    done
    echo "fixtures and bystanders made"
    ;;
  snap)
    GRAFANA_ADMIN_PW_FILE="$sec/admin-pw" python3 "$(dirname "$0")/snap.py" "$G" > "${2:?out file}"
    cat "$2"
    ;;
  stop)
    docker rm -f "$name" > /dev/null 2>&1 || true
    rm -rf "$sec"
    ;;
esac

#!/usr/bin/env bash
# The disposable Grafana of one job, in the job's sandbox (dogfood/sbx.mjs), from the runner's side:
#   dogfood/grafana/sandbox.sh start         Grafana (GRAFANA_IMAGE, pinned by digest) as the sandbox service `grafana` at
#                                            10.213.53.5:3000, its data under the container's own /tmp; the admin
#                                            password is made by the driver and written to grafana-secrets/admin-pw in the
#                                            work volume only; then dogfood/grafana/setup.mjs start and fixtures in the unit
#   dogfood/grafana/sandbox.sh snap <file>   dogfood/grafana/snap.py in the sandbox's Python image, straight to Grafana's
#                                            address; the snapshot (checksums and counts) comes back to <file> as data,
#                                            never printed (compare-snaps.py reads it)
# Env: GRAFANA_IMAGE, RUNNER_TEMP.
set -euo pipefail
sbx() { node dogfood/sbx.mjs "$@"; }
case "${1:?start or snap}" in
  start)
    sbx svc --name grafana --ip 5 --image-ref "${GRAFANA_IMAGE:?}" --workdir /usr/share/grafana \
      --entrypoint /usr/share/grafana/bin/grafana \
      --secret-env "GF_SECURITY_ADMIN_PASSWORD=$RUNNER_TEMP/grafana-secrets/admin-pw" \
      --env GF_PATHS_DATA=/tmp/grafana --env GF_PATHS_LOGS=/tmp/grafana/logs --env GF_PATHS_PLUGINS=/tmp/grafana/plugins \
      --env GF_INSTALL_PLUGINS= --env GF_PLUGINS_PREINSTALL_SYNC= --env GF_PLUGINS_PREINSTALL_DISABLED=true \
      --env GF_ANALYTICS_REPORTING_ENABLED=false --env GF_ANALYTICS_CHECK_FOR_UPDATES=false \
      --env GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES=false --env GF_NEWS_NEWS_FEED_ENABLED=false \
      --env GF_FEATURE_TOGGLES_ENABLE=dashboardNewLayouts --env GF_LOG_LEVEL=info \
      -- server --homepath=/usr/share/grafana --config=/etc/grafana/grafana.ini
    sbx exec -- node dogfood/grafana/setup.mjs start
    sbx exec -- node dogfood/grafana/setup.mjs fixtures
    ;;
  snap)
    out=${2:?out file}
    sbx run --image python --env "GRAFANA_ADMIN_PW_FILE=$RUNNER_TEMP/grafana-secrets/admin-pw" \
      -- sh -c 'python3 dogfood/grafana/snap.py http://10.213.53.5:3000 > "$1"' sh "$out"
    sbx pull "$out" "$out"
    ;;
esac

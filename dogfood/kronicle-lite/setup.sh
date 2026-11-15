#!/usr/bin/env bash
# Makes a fresh kronicle-lite data directory for this job and seeds it: the guard document the
# manifest's target.guard reads, and two bystander documents the run must leave as they are.
# Exports KRONICLE_LITE_DATA_DIR and KRONICLE_LITE_PROJECT through GITHUB_ENV.
#   dogfood/kronicle-lite/setup.sh   (from the workspace root, kronicle-lite built in ./kl)
set -euo pipefail
data="${RUNNER_TEMP:?}/kronicle-lite-data"
rm -rf "$data"; mkdir -p "$data"
export KRONICLE_LITE_DATA_DIR="$data" KRONICLE_LITE_PROJECT=dogfood
echo "KRONICLE_LITE_DATA_DIR=$data" >> "$GITHUB_ENV"
echo "KRONICLE_LITE_PROJECT=dogfood" >> "$GITHUB_ENV"
seed="${RUNNER_TEMP}/kronicle-lite-seed"; mkdir -p "$seed"
printf '# Dogfood guard\n\nThis store belongs to one CI job and is thrown away after it.\n' > "$seed/guard.md"
printf '# Bystander one\n\nNot created by the tester.\n' > "$seed/by1.md"
printf '# Bystander two\n\nAlso not created by the tester.\n' > "$seed/by2.md"
node kl/dist/cli.js put dogfood-guard "$seed/guard.md" --title "dogfood guard"
node kl/dist/cli.js put dogfood-bystander-1 "$seed/by1.md" --title "bystander one"
node kl/dist/cli.js put dogfood-bystander-2 "$seed/by2.md" --title "bystander two"

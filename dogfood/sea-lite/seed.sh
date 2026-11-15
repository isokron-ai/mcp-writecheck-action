#!/usr/bin/env bash
# Makes sea-lite's store for one job and seeds it: the guard ticket the manifest's target.guard
# reads, and two bystander tickets the run must leave as they are (the manifest's canary).
#   SEA_LITE_DATA_DIR=<empty folder> dogfood/sea-lite/seed.sh
set -euo pipefail
: "${SEA_LITE_DATA_DIR:?}"
mkdir -p "$SEA_LITE_DATA_DIR"
chmod 700 "$SEA_LITE_DATA_DIR"
cd srv
export SEA_LITE_ACTOR=dogfood-seed
node dist/cli.js create dogfoodguard --body "The guard ticket of the dogfood run." > /dev/null
node dist/cli.js create dogfoodby1 --body "A bystander ticket." --kind docs > /dev/null
node dist/cli.js create dogfoodby2 --triaged --priority low --tags keep > /dev/null
node dist/cli.js list --all --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const t=d.tickets??d;console.log("seeded:",t.map(x=>x.title).join(", "))})'

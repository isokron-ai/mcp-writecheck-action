#!/usr/bin/env bash
# Refuses a ref that is not a full 40-character commit SHA (a branch or tag can move).
#   NAME=<what> REF=<value> dogfood/check-ref.sh
set -euo pipefail
if ! [[ ${REF:-} =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::${NAME:-the ref} must be a full 40-character lower-case commit SHA"
  exit 1
fi

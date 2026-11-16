#!/usr/bin/env bash
# Installs age from its release tarball, checked against the pinned sha256 (AGE_URL, AGE_SHA256).
set -euo pipefail
d="$RUNNER_TEMP/age-dl"
mkdir -p "$d"
curl -fsSL --retry 3 -o "$d/age.tgz" "$AGE_URL"
echo "$AGE_SHA256  $d/age.tgz" | sha256sum -c --quiet -
tar -xzf "$d/age.tgz" -C "$d"
echo "$d/age" >> "$GITHUB_PATH"
"$d/age/age" --version >/dev/null

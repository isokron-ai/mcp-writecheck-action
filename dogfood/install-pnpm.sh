#!/usr/bin/env bash
# Installs pnpm 9.15.9 globally from its npm tarball after checking the tarball's sha512 against the
# integrity pinned here (the value npm publishes for pnpm@9.15.9), so a changed tarball is refused.
set -euo pipefail
VERSION=9.15.9
INTEGRITY='sha512-aARhQYk8ZvrQHAeSMRKOmvuJ74fiaR1p5NQO7iKJiClf1GghgbrlW1hBjDolO95lpQXsfF+UA+zlzDzTfc8lMQ=='
dir=$(mktemp -d "${RUNNER_TEMP:-/tmp}/pnpm.XXXXXX")
trap 'rm -rf "$dir"' EXIT
( cd "$dir" && npm pack --silent "pnpm@$VERSION" > /dev/null )
tgz="$dir/pnpm-$VERSION.tgz"
got="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
[ "$got" = "$INTEGRITY" ] || { echo "::error::pnpm $VERSION tarball integrity mismatch"; exit 1; }
npm install --global --no-audit --no-fund --ignore-scripts "$tgz"
echo "pnpm $(pnpm --version) installed (integrity checked)"

#!/usr/bin/env bash
# Installs pnpm 9.15.9 globally from its npm tarball after checking the tarball's sha512 against the
# integrity pinned here (the value npm publishes for pnpm@9.15.9), so a changed tarball is refused.
#
# Two steps, so a network failure is told apart from a refusal (the T0 result, loop/t0-bundle.mjs, treats only the download as
# infrastructure; an integrity mismatch is never infrastructure):
#   install-pnpm.sh fetch     downloads the tarball (npm pack) into $RUNNER_TEMP/pnpm-tarball
#   install-pnpm.sh install   checks the integrity, then installs it
set -euo pipefail
VERSION=9.15.9
INTEGRITY='sha512-aARhQYk8ZvrQHAeSMRKOmvuJ74fiaR1p5NQO7iKJiClf1GghgbrlW1hBjDolO95lpQXsfF+UA+zlzDzTfc8lMQ=='
dir="${RUNNER_TEMP:-/tmp}/pnpm-tarball"
tgz="$dir/pnpm-$VERSION.tgz"
case "${1:-}" in
  fetch)
    mkdir -p "$dir"
    ( cd "$dir" && npm pack --silent "pnpm@$VERSION" > /dev/null )
    ;;
  install)
    [ -f "$tgz" ] || { echo "::error::the pnpm tarball was not downloaded"; exit 1; }
    got="sha512-$(openssl dgst -sha512 -binary "$tgz" | openssl base64 -A)"
    [ "$got" = "$INTEGRITY" ] || { echo "::error::pnpm $VERSION tarball integrity mismatch"; exit 1; }
    npm install --global --no-audit --no-fund --ignore-scripts "$tgz"
    echo "pnpm $(pnpm --version) installed (integrity checked)"
    rm -rf "$dir"
    ;;
  *) echo "usage: install-pnpm.sh fetch|install" >&2; exit 2 ;;
esac

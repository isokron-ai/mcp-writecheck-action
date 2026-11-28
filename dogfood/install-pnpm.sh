#!/usr/bin/env bash
# Unpacks pnpm 9.15.9 from its npm tarball into .sbx-pnpm/ of the workspace after checking the tarball's sha512 against
# the integrity pinned here (the value npm publishes for pnpm@9.15.9), so a changed tarball is refused. pnpm itself runs
# only inside the job's sandbox (dogfood/sbx.mjs mirrors the workspace there; .sbx-pnpm/bin goes on PATH with --path),
# never on the runner: nothing of the tarball is run here.
#
# Two steps, so a network failure is told apart from a refusal (the T0 result, loop/t0-bundle.mjs, treats only the download as
# infrastructure; an integrity mismatch is never infrastructure):
#   install-pnpm.sh fetch     downloads the tarball (npm pack) into $RUNNER_TEMP/pnpm-tarball
#   install-pnpm.sh install   checks the integrity, then unpacks it (tar, as data) and writes the pnpm wrapper
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
    dest="${GITHUB_WORKSPACE:-$PWD}/.sbx-pnpm"
    rm -rf "$dest"; mkdir -p "$dest/bin"
    tar -xzf "$tgz" -C "$dest" --no-same-owner --no-same-permissions
    [ -f "$dest/package/bin/pnpm.cjs" ] || { echo "::error::the pnpm tarball has no bin/pnpm.cjs"; exit 1; }
    printf '#!/bin/sh\nexec node "$(dirname "$0")/../package/bin/pnpm.cjs" "$@"\n' > "$dest/bin/pnpm"
    chmod 755 "$dest/bin/pnpm"
    echo "pnpm $VERSION unpacked into .sbx-pnpm (integrity checked); it runs in the sandbox only"
    rm -rf "$dir"
    ;;
  *) echo "usage: install-pnpm.sh fetch|install" >&2; exit 2 ;;
esac

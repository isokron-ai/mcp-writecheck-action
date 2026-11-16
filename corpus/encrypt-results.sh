#!/usr/bin/env bash
# Packs this shard's results folder and encrypts it to the archive key(s) in corpus/recipients.txt.
# Removes every clear-text file the job wrote (results, work folders, the target list) afterwards.
# The upload holds one file, corpus-shard-N.tgz.age; its name says nothing about the targets.
set -euo pipefail
umask 077
c="$RUNNER_TEMP/corpus"
up="$RUNNER_TEMP/corpus-upload"
mkdir -p "$up" "$c/out/_shard"
rm -f "$c/targets.json"
if [ -f "$c/public.txt" ]; then cp "$c/public.txt" "$c/out/_shard/public.txt"; fi
tar -C "$c/out" -czf - . | age -R corpus/recipients.txt -o "$up/corpus-shard-${SHARD:?}.tgz.age"
rm -rf "$c/out" "$c/work"
# A clear-text leftover of a target's work folder would be a leak; there must be none.
[ -z "$(find "$c" -mindepth 1 ! -name public.txt -print -quit 2>/dev/null)" ] || { echo "harness error: clear-text files left"; exit 1; }

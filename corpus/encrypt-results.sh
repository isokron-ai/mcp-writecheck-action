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
# The upload folder must hold exactly one file, and it must be age ciphertext (binary header) with one
# X25519 recipient stanza: a wrong recipients file or a tampered step fails here, before the upload.
f="$up/corpus-shard-${SHARD}.tgz.age"
[ "$(find "$up" -mindepth 1 | wc -l)" -eq 1 ] && [ "$(head -c 22 "$f")" = "age-encryption.org/v1" ] \
  && [ "$(head -c 4096 "$f" | grep -ac '^-> X25519 ')" -eq 1 ] || { echo "harness error: the upload is not age ciphertext"; rm -rf "$up"; exit 1; }

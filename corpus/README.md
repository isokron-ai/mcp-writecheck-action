# Corpus: nightly runs against third-party MCP servers

`.github/workflows/corpus.yml` runs `mcp-writecheck` every night against a pinned list of open-source
MCP servers that IsoKron did not write. Its purpose is to test this action and the CLI on servers
built by other people: crashes, time limits, harness errors and false positives are what it is
looking for. It is not a findings channel, and it publishes no verdicts.

## What is public and what is not

| Item | Where |
|---|---|
| The workflow, the driver (`run-shard.mjs`) and the helper scripts | This folder, in clear text |
| The target list (package, version, artifact sha256, licence, how to start the backend and the server) | `targets.json.age`, encrypted; decrypted at run time with the `CORPUS_TARGETS_KEY` secret |
| Results: `results.json`, `report.md`, the CLI's ledger, logs and run metadata | Encrypted to the archive key in `recipients.txt` before upload; the private key is held by IsoKron on its own machine, never in this repository or in CI |
| Logs and job summary | Only `automated candidate, unreviewed: not a finding` and one `run finished, exit N` line per target |

Job and artifact names are generic (`corpus-shard-N`). Nothing is cached between runs.

## What `exit N` means

`N` is the status of our tool or of the harness for one target, never a verdict:

| N | Meaning |
|---|---|
| 0 | The CLI ran to completion (whatever it found) |
| 2, 3, 4, 130 | The CLI's own usage or manifest error, refusal, stopped run, interruption |
| 70 | The CLI crashed |
| 124 | The target hit its time limit |
| 125 | Harness error: download, checksum, install, backend start or set-up |

A shard fails only when some target's `N` is not 0. A server's verdicts never fail a job.

## Rules the corpus keeps

- Every backend runs inside the job (Docker on the runner, or local files). No target is pointed at
  an external service or account.
- Every target is pinned: the exact registry artifact by sha256, dependencies resolved as of a fixed
  date, backend images by digest. Each run records the server version and artifact sha256, the
  source commit where the registry carries one, the CLI commit, the spec version, the manifest hash,
  the runner image and the date.
- Open-source licences that permit running the software, only.
- Standard GitHub-hosted runners and a few dozen targets at most; the long tail runs on IsoKron's own
  hardware with the same driver and record format.
- Schedule and manual dispatch only, from `main`. No `pull_request` or `pull_request_target` trigger,
  so no pull request runs with either secret.
- Catalog and plan modes for every target. A full run happens only for a target whose hand-written
  manifest and plan hash a person has read and accepted, and only against its in-job backend.

## Secrets

| Secret | Use |
|---|---|
| `MWS_CLI_TOKEN` | Read-only checkout of the CLI, as in the dogfood workflows; one step, before any third-party code runs |
| `CORPUS_TARGETS_KEY` | The age identity that decrypts `targets.json.age`; used by one step |

## Running the driver locally

```sh
node corpus/run-shard.mjs --targets targets.json --cli <built mcp-writecheck package> \
  --out out --work work --lane ci [--shard 1 --shards 4] [--only t01,t02]
```

Unit tests: `node --test test/corpus.test.mjs`.

# Corpus: nightly runs against third-party MCP servers

`.github/workflows/corpus.yml` runs `mcp-writecheck` every night against a pinned list of open-source
MCP servers that IsoKron did not write. Its purpose is to test this action and the CLI on servers
built by other people: crashes, time limits, harness errors and false positives are what it is
looking for. It is not a findings channel, and it publishes no verdicts.

## What is public and what is not

| Item | Where |
|---|---|
| The workflow, the driver (`run-shard.mjs`), the helper scripts and the container images (`images.json`) | This folder, in clear text |
| The target list (package, version, artifact sha256, lockfiles, licence, how to start the backend and the server) | `targets.json.age`, encrypted; decrypted at run time with the `CORPUS_TARGETS_KEY` secret |
| Results: `results.json`, `report.md`, the CLI's ledger, logs and run metadata | Encrypted to the archive key in `recipients.txt` before upload; the private key is held by IsoKron on its own machine, never in this repository or in CI |
| Logs and job summary | Only `automated candidate, unreviewed: not a finding` and one `run finished, exit N` line per target, in an order shuffled per run |

Job and artifact names are generic (`corpus-shard-N`). Nothing is cached between runs.

## How a target is isolated

Every target is treated as hostile. Nothing a target ships runs on the runner itself:

- Install, set-up, the CLI and the server run in containers of the digest-pinned image in
  `images.json`, as user `10001`, with `--cap-drop ALL`, `no-new-privileges`, a read-only root,
  a tmpfs `/tmp`, and pid, memory and CPU limits (`--cpus 2`, or fewer if Docker has fewer).
  The target's own `bin` folder comes last on `PATH`, so a package that ships a `node`, `npm`, `uv`
  or `sh` cannot replace the tools that run the CLI.
- Only Docker volumes are mounted: the target's own work volume, the CLI (read-only) and, for PyPI
  targets, `uv` (read-only). Never the workspace, `RUNNER_TEMP`, `_actions`, the home folder or the
  Docker socket. Files go in through stdin; results come out through a helper that copies regular
  files and folders only, under a size cap. Our helper containers carry the target's label and a
  time limit, so one stuck on something the target planted is removed with it.
- Output is bounded: each command's log keeps 64 MiB, captured output 16 MiB, and a `results.json`
  over 64 MiB is recorded by sha256 and size only. One target's output never stops the shard, and
  every target gets its `meta.json`.
- The install step has network egress (registries). Everything after it (set-up, the CLI, the
  server) runs on an `--internal` network that only that target's backends share. `net-guard.sh`
  keeps every container network away from the runner and the cloud metadata addresses; it stops
  the job if forwarded traffic does not pass through its rules. Docker Engine 26.0.0 or later is
  required (older engines let `--internal` networks resolve outside names, CVE-2024-29018).
- Backends are digest-pinned too, on the internal network only, with every capability dropped
  except a short allowlist a backend may ask for (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`,
  `SETGID`, `KILL`, `NET_BIND_SERVICE`). No host port is published.
- Containers get a fixed environment: no GitHub file commands (`GITHUB_ENV`, `GITHUB_STEP_SUMMARY`
  and the rest), no `ACTIONS_*` or `RUNNER_*`, no token, and a `HOME` and caches inside the target's
  own volume.
- Dependencies are hash-locked: npm targets install with `npm ci` from a pinned `package-lock.json`
  (install scripts off unless the list says otherwise, and then only inside the container); PyPI
  targets with `uv pip install --require-hashes` from a lock compiled for the platform, wheels only
  unless the list says otherwise. Before installing, the driver checks the lock: npm packages only
  from `https://registry.npmjs.org/`, each with an integrity hash (the target itself only from its
  checked artifact); PyPI lines only `name==version` with sha256 hashes (no URL, VCS, file or index
  option). Anything else is a harness error.
- On IsoKron's Mac (lane `mac`, or the driver running on macOS), the install network reaches the
  Mac's own loopback and LAN through Docker Desktop, and no guard runs inside its VM. So targets
  with `install_scripts` or `allow_build` (target code during install) are refused there; they run
  on the CI runners only.

What stays on the runner: the decrypted list (deleted by the driver before the first target
runs), the secrets, the encrypt step and the upload.

## What `exit N` means

`N` is the status of our tool or of the harness for one target, never a verdict:

| N | Meaning |
|---|---|
| 0 | The CLI ran to completion (whatever it found) |
| 2, 3, 4, 130 | The CLI's own usage or manifest error, refusal, stopped run, interruption |
| 70 | The CLI crashed |
| 124 | The target hit its time limit |
| 125 | Harness error: download, checksum, a missing lock, install, backend start, set-up, a container that did not start |

A shard fails only when some target's `N` is not 0. A server's verdicts never fail a job.

## Rules the corpus keeps

- Every backend runs inside the job (Docker on the runner). No target is pointed at an external
  service or account.
- Every target is pinned: the exact registry artifact by sha256, the dependency tree by lockfile
  hashes, images by digest. Each run records the server version and artifact sha256, the lock's
  sha256, the source commit where the registry carries one, the CLI commit, the spec version, the
  manifest hash, the image digests, the runner image and the date.
- Open-source licences that permit running the software, only.
- Standard GitHub-hosted runners and a few dozen targets at most; the long tail runs on IsoKron's own
  hardware with the same driver, the same containers and the same record format.
- Schedule and manual dispatch only, from `main`. No `pull_request` or `pull_request_target` trigger.
- Catalog and plan modes for every target. A full run happens only for a target whose hand-written
  manifest and plan hash a person has read and accepted, and only against its in-job backend.

## Secrets

| Secret | Where | Use |
|---|---|---|
| `CORPUS_TARGETS_KEY` | The `corpus` environment only (deployment branch `main`); never a repository secret, or the environment's branch rule does not protect it | The age identity that decrypts `targets.json.age`; used by one step |
| `MWS_CLI_TOKEN` | A repository secret (the dogfood workflows use it), so the environment cannot keep it out of this job | Read-only checkout of the CLI while its repository is private. The corpus workflow is enabled only once the repository variable `MWS_CLI_PUBLIC` is `true`: the CLI is then checked out without a token, and the corpus job never holds it |

## Running the driver locally

Needs Docker Engine 26.0.0 or later (Linux containers; Docker Desktop or colima on a Mac).

```sh
node corpus/run-shard.mjs --targets targets.json --cli <built mcp-writecheck package> \
  --out out --lane ci [--shard 1 --shards 4] [--only t01,t02] [--consume-targets]
```

Unit tests: `node --test test/corpus.test.mjs test/corpus-workflow.test.mjs`. The sandbox against a
real daemon: `CORPUS_DOCKER_TESTS=1 node --test test/corpus-container.test.mjs` (add
`CORPUS_SMOKE_CLI=<built mcp-writecheck package>` for the real CLI, `CORPUS_DOCKER_NET=1` for the PyPI
test, which needs registry egress from containers).

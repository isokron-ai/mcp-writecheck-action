# Loop worker: writecheck

`.github/workflows/corpus.yml` is the writecheck lane of IsoKron's testing loop. The loop's pump (in `isokron-ai/tool-qa`) dispatches it with a shard of up to 10 subjects; the worker runs `mcp-writecheck` against each one inside a hardened sandbox and hands back one encrypted result bundle per subject. No model is called and no secret is used.

The hand-dispatched batch workflow that used to be `corpus.yml` is now `corpus-batch.yml`, unchanged (see "The older corpus path" below). The dogfood workflows are separate and not affected.

## Inputs

| Input | What it is |
|---|---|
| `shard_id` | The shard's id. The run is named `shard <shard_id>`. |
| `attempt_id` | The dispatch's id; every result quotes it. |
| `items` | JSON list of 1 to 10 `{"subject": "owner/name", "run_key": "<64 hex>", "fence": <n>}` |
| `tool_sha` | Optional, empty by default: the commit of this repository to run (tool-qa R-PIN-01). The pump sends it for a lane whose `pin_check` is `enforce`. |

Every input is checked as a whole string before use (a newline anywhere is refused; `tool_sha` is empty or a full commit SHA), then `loop/items.mjs` checks the items in full.

### Version pins

tool-qa files every result under the versions it pins for this lane (`pump/workflows.json`, writecheck `versions`), and its ingest refuses a result whose manifest reports another version (`pin_mismatch`) or, on an `enforce` lane, cannot prove one (`pin_unverified`). The job that runs the items checks out `tool_sha` (else the run's own commit) and stops unless `git rev-parse HEAD` is exactly that commit (R-WC-28); the YAML itself still runs from `main`. The driver reports in the manifest's `tools`, by the pin keys: `mcp-writecheck` at `CLI_REF`, `mcp-writecheck-action` at the commit checked out (`ACTION_SHA`, never `GITHUB_SHA`), `mcp-surface-corpus` at `SANDBOX_REF`, and gVisor's release (R-WC-29). A merge to `main` changes the commit a run without `tool_sha` reports. While the lane's `pin_check` is `label`, a pin that lags such a merge is only noted by ingest (`self_pin_moved`, tool-qa R-PIN-02) and the result is accepted; on `enforce` the pump sends `tool_sha`, and a result that does not prove its pins is refused and the lane paused for an hour. Bump the pin with each merge either way, so results are filed under the code that ran.

## How a subject is run

1. **Which package.** `loop/items.mjs` maps the subject the way the live-probe lane does: IsoKron's own fixture servers first (`loop/fixtures.json`: an exact npm version published by the isokron-ai npm account, installed with `npm ci` from a committed lockfile pinned by the package's sha512 integrity; one with install scripts installs in the sandbox's build image, where a native module compiles from source and the install reaches registry.npmjs.org only), else the subject's registry packages in tool-qa's seed (`history/seed-v1.json` at a pinned tool-qa commit), npm first, then PyPI, at the latest version (the record keeps the version that was resolved). A subject whose seed entry has no npm or PyPI package but an OCI image or a crate (WC14, `loop/launch.mjs`):
   - **OCI image**: chosen by the live-probe lane's own resolver, `resolveSubject` of `isokron-ai/mcp-check`'s `corpus/live-probe.mjs`, used as a library from a checkout at `MCP_CHECK_REF` (the commit tool-qa's live-probe lane runs, `pump/workflows.json`), so both lanes run the same image for the same subject: the official MCP Registry entry of the subject or of its seed packages (an entry that only names the repository must show signed provenance or a ghcr.io namespace of the owner), the image pinned by the digest its registry serves, only from the OCI hosts that resolver allows, at most 2 GB, with the arguments and environment names the entry declares (dummy values only). When it gives no runnable package, its own reason and fault side (its `DETAILS` table) are the skip's.
   - **Crate**: only when the resolver gives none and the seed lists a crate. The resolver has no crate path, and this lane keeps its own plan rather than the sandbox's crate kind (added at 4504c0b): `cargo install --locked` of the latest version into `/work/pkg` (`--locked` uses the Cargo.lock the crate published, when it published one; without one cargo warns and resolves the dependencies afresh), in the digest-pinned `rust-build` image of the sandbox (`images.json` there) (a build image: the 15-minute build limit applies), with the install reaching only index.crates.io and static.crates.io through the allowlist proxy (a git dependency or a build script that downloads is refused, and that is our limit). `loop/sandbox/cargo-entry.mjs` picks the server from cargo's own record: the only binary, else the one named for the crate, else the only one named for MCP; it never guesses between others. The build folders are removed before the server starts, and the server runs in the same image.
   - Go servers in the seed are listed by their OCI images (it lists no Go module), so they run as images.
   A subject with none of these (MCPB bundles, NuGet), one whose registry entry offers streamable HTTP only, or one not in the seed gets a skip (`no_runnable_artifact`, `unsupported_transport`, `policy_excluded`).
2. **The sandbox.** Everything runs in the sandbox of `isokron-ai/mcp-surface-corpus`, fetched at a pinned commit and used as a library (`src/docker.mjs`, `src/sandbox-run.mjs`, `src/sandbox-net.mjs`, `src/runsc.mjs`, `src/telemetry.mjs`, `src/targets.mjs` and its `sandbox/` helpers): gVisor (`runsc`) for every container, user 65534, every capability dropped, a read-only root, memory, process and CPU limits, named volumes only, and no runner environment. The install reaches only its package registry, through the allowlist proxy; the server and the CLI run on an internal network where every name resolves to the network logger and the host firewall logs and drops anything that tries to leave. Before the shard job starts, mcp-surface-corpus's reusable `sandbox-conformance.yml` must pass; inside the job, before any target, its `sandbox-guard` action installs gVisor and the firewall on that runner and runs the hostile self test, and the job stops unless the telemetry check recomputes a pass. Both are pinned to the same commit as the library (`SANDBOX_REF`, 78a7834). This repository's older sandbox (`corpus/`) is not used here.
3. **The checks.** The CLI is `mcp-writecheck`, built from `isokron-ai/mcp-write-safety` at the action's pinned commit, before anything else in the job. For every subject (and the forgery control) the server and the CLI run **split**, in two sandbox containers: the server in one of its own at `.3` of the run network, behind our bridge (`loop/sandbox/bridge.mjs`), with its install volume read-only and nothing else of ours; the CLI in another at `.4`, with the output volume the server's container never mounts, reaching the server over TCP through our relay (`loop/sandbox/relay.mjs`) as if it were a stdio server. Each is its own gVisor sandbox, so the server cannot see the CLI's files or processes, write into its output or its stdout, or signal or trace it: its only channel to the CLI is the protocol. IsoKron's own fixture servers (locked, below) run in one container with the CLI, because the full write test needs the CLI's loopback gate in front of their backend and restarts the server.

   An OCI subject's server container is its own image (WC14): pulled by the runner's Docker by the digest the resolver read, started under gVisor with the same limits as every sandbox container, in the image's own working folder, with the command `docker run` would start (its entrypoint, then the entry's arguments or else its command), and with no volume of ours but the read-only tools. Our bridge starts there through a portable runtime: Node and the bridge from the tools volume, run by the glibc loader with the libraries copied from our Node image (`rt/`), so it starts in any Linux image (musl, distroless, scratch) and sets no `LD_` variable for the server it spawns. The bridge starts with the image's Node, OpenSSL and glibc variables emptied (`NODE_OPTIONS`, `OPENSSL_CONF`, `GCONV_PATH`, `GLIBC_TUNABLES` and the like); the server gets the image's own environment back, with ours on top, as an argument of the bridge. An image that sets `LD_PRELOAD` or `LD_AUDIT` is refused, and a bridge that does not start in an image is not retried (R-WC-37). The bridge is not a trust boundary: it runs inside the subject's own sandbox and only carries the server's stdio. Before the pull, live-probe's own checks are made again on what the resolver returned: an allowed OCI host, at most 2 GB, and four times that free on Docker's data root (else a retryable `infra` skip); after it, the unpacked image must be within 6 GB (R-WC-38). An image declaring more than three `VOLUME` paths (each a writable anonymous volume) is refused (R-WC-39). The image is removed when the item's containers have gone.

   What runs:
   - `init` (reads `tools/list` and drafts a manifest), `plan` (no tool call; gives the plan hash) and `catalog` (reads `tools/list` only; judges MWS-ANN-4) for every subject, with a generic catalog manifest that calls no tool;
   - the full write test (`run`) only for a fixture server whose plan hash a person accepted (`loop/fixtures.json`, `full.plan_hash`), against a disposable backend inside the same container: tiny-tracker's in-memory backend, kronicle-lite's own data folder. A fixture runs its dogfood manifest byte for byte (the plan hash covers the manifest's bytes), written at `/work/m/x/writecheck.yaml` with a link that makes its relative `cwd` land on the installed package, so the hash accepted in the dogfood workflow applies. A plan that gives another hash is recorded as drift, and the full run does not start. A third-party server is never given a manifest that writes.
4. **Teardown.** After the last item every container is removed and the Docker daemon is stopped (`loop/teardown.sh`); the job fails, and nothing is uploaded, if a gVisor process or any host process of the sandbox user (UID 65534) is still there. Only then do the worker-kit steps seal and upload.

## What a bundle holds

One bundle per item, sealed by `isokron-ai/tool-qa/worker-kit` (pinned) to the ingest key and uploaded as `result-<attempt_id>-<i>.tar.age`. Every item gets one, a skipped one too.

| Folder | Contents |
|---|---|
| `observations/writecheck.ndjson` | Field records of the `isokron-ai/mcp-results` registry (below) |
| `results/writecheck.json` | The summary: which package and version, each step's exit and time, the plan hash and whether it drifted, the catalog's and the full run's verdict counts per requirement |
| `raw/` | Captured bytes, data only: everything the steps left in their output folder (the CLI's `results.json`, `report.md`, `catalog.json`, the init draft, the backend's log), each step's output, the unit's sandbox telemetry. At most 4 MiB a file and 32 MiB in all; `logs/driver.json` lists every file with its original size and sha256 and whether it was cut |
| `logs/driver.json` | Our own record: the install steps, the step list, the evidence the sandbox could not give, the raw index |
| `controls/` | The shard's three controls (below), with their captured bytes under `raw/control-*/` |

Everything the CLI wrote ran next to the server under test, in the same container and as the same user, so it is kept only in `raw/`. Outside `raw/`, the worker writes only values it checked one by one: requirement ids, the CLI's verdict words, tool, resource and parameter names (letters, digits, `.`, `_`, `-`), the four annotation hints as booleans, counts, the plan hash and the run status. No description, schema text or log line of a target is copied, and no object is keyed by a name the target chose.

### Field records

| Field | When | Value |
|---|---|---|
| `our_tool_versions` | always | the CLI commit, this repository's commit, the sandbox commit, the gVisor release |
| `sandbox_tier` | when the item ran | `gvisor` |
| `observation_coverage` | always | which stages ran, and whether the sandbox evidence (syscall traces, firewall log) is complete |
| `step_telemetry` | when the item ran | each step's exit, time limit and duration |
| `tool_annotations_declared` | catalog read | `{ tools: [{ tool, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }], tool_count }` |
| `annotation_completeness` | catalog read | counts of tools with each hint, with any hint, with none |
| `idempotency_evidence_params`, `concurrency_guard_params`, `safety_params` | catalog read | `[{ tool, param }]` for parameters named like idempotency keys, version or ETag guards, and dry-run or confirm switches |
| `requirement_verdicts` | catalog read; full run | `[{ requirement, verdict, resource, tool, mode }]` |
| `plan_hash_and_drift` | plan ran | `{ plan_hash, accepted, drift, full_run }` |
| `annotation_honesty_behaviour_confirmed`, `idempotency_evidence_behaviour`, `conflict_behaviour` | full run | the MWS-ANN, MWS-RETRY and MWS-CONC records and their counts |

With incomplete sandbox evidence (a container that left no syscall trace, an unreadable firewall log) only the first four are written, with a `trace_unavailable` skip.

### Skips and their fault side

Every stage that did not run is a skip in the meta file, and every skip says who it is down to (`fault`, tool-qa `worker-kit/contract.mjs` `SKIP_FAULTS`; `loop/skips.mjs`, R-WC-24). Our own limits are always `tool`, so a server we cannot start yet is counted as a gap of ours, never as the server's failure.

| Skip | Stages | Fault | Why |
|---|---|---|---|
| `policy_excluded` | install, init, plan, catalog | `policy` | the subject is not in the seed this lane reads, or the item names a fixture that is not its own |
| `no_runnable_artifact` | install, init, plan, catalog | `tool` | no package of a kind this lane installs (MCPB, NuGet; OCI images and crates when the resolver is not loaded) |
| the live-probe resolver's own reason (`no_runnable_artifact`, `too_large`, `install_failed_registry`, `remote_only`, `rate_limited`, `upstream_unavailable`) | install, init, plan, catalog | its `DETAILS` fault: `tool` for our limits (an OCI host we do not pull from, over 2 GB, an entry we cannot verify), `subject` for the registry's own refusal of the image or a remote-only server, `infra` (retryable) for a rate limit or outage | an OCI or crate subject with no runnable image and no crate (WC14) |
| `unsupported_transport` | install, init, plan, catalog | `tool` | the registry offers streamable HTTP only; this lane starts stdio servers |
| `timeout_start` (retryable) | install, init, plan, catalog | `tool` | not started: the shard used its time budget first |
| `tool_error` (retryable) | the stages that did not run | `tool` | our harness failed around the unit (a helper, the proxy, the bridge, Docker); R-WC-25 |
| `install_failed_registry`, or `timeout_start` when the install ran out of time | init, plan, catalog | `subject` or `tool` | `subject` only when the install's own output shows a package-level error (no such package or version, nothing to run, an image with no command, a crate with no binary); our proxy refusing a host, our time or memory limit, a native or crate build, an image that would not pull, a crate with several binaries and none named for it, or no evidence at all is `tool` (R-WC-26, R-WC-30, R-WC-31, R-WC-36) |
| `unsupported_transport` | init (fixtures started over HTTP) | `tool` | init drafts from a stdio command |
| `timeout_start`, `no_runnable_artifact` or `tool_error` (`stage_detail` in `logs/driver.json`) | each of init, plan, catalog that was attempted and did not run | `tool` | a stage ran only when its step exited 0 or 1 within our time limit (R-WC-40). Otherwise: `start_needs_config` (the server's stderr asks for configuration we did not give it), `not_a_server` (a usage block: a command line tool, not a stdio server, or one that needs arguments we did not give; `no_runnable_artifact`), `step_timeout` (our step time limit), `cli_refused` (exit 2 or 3: our manifest or the CLI's guard; `tool_error`), `start_failed` (anything else), `not_attempted` (an earlier step of ours stopped the unit; `tool_error`). Never `subject`: the step's status and the server's stderr cannot prove a defect of its own; never `policy` |
| `policy_excluded` | full | `policy` | a third-party server is never given a manifest that writes; a fixture runs only under its accepted plan hash |
| `tool_error`, or `timeout_start` and the other `stage_detail` codes above | full | `tool` | a fixture whose plan did not run never reached the hash check, and a full write test that started and did not finish (exit 4, our time limit) is ours (R-WC-40) |
| `trace_unavailable` | catalog | `tool` | incomplete sandbox evidence |

## Backends

The fixtures' backends are disposable and live inside the sandbox container: tiny-tracker's in-memory store, kronicle-lite's data folder and, since WC12, a real PostgreSQL server for `pg-tracker` and, since WC13, a real Redis server for `redis-tracker` (`loop/fixtures/redis-tracker/`, no dependency; its `redis-server` is copied out of a digest-pinned official image, see `BACKENDS.md`; its plan is accepted) (`loop/fixtures/pg-tracker/`, a fixture whose package is the committed folder, pinned by a digest in `fixtures.json`). Every result of a full write test is labelled `hermetic` (`backend_environment` in `observation_coverage` and in each full-run verdict record). The design, the cells that run against PostgreSQL, the known-bad builds, the cost per item and the Redis fixture are in [`BACKENDS.md`](BACKENDS.md). pg-tracker is not in tool-qa's seed, so the live lane does not dispatch it; the pull-request proof (`loop-fixture.yml`) runs it in the sandbox with the other fixtures, and `test.yml` runs the pinned CLI over it against a real PostgreSQL on the runner, known good and known bad.

## Min mode (proposed contract, tool-qa PR #119)

`loop/min-mode.mjs` is the worker's side of min mode: a shard whose `mode` is `min` names one `backend` and one `spec_url`, and the worker looks both up in its own pinned allowlist, `loop/min-specs.json` (backend id → spec URL, format, sha256, base-URL names). Nothing named only by an input is fetched: the description is fetched from the pinned URL, outside the sandbox, without redirects, and used only if its sha256 is the pinned one. The CLI then runs `mcp-writecheck min` (isokron-ai/mcp-write-safety, `packages/writecheck/src/min/`) with the mock inside the sandbox network, the item's base-URL env names pointed at it and every other name given a dummy or a canary; egress stays denied. `minSummary` turns its `results.json` into checked values: `mode: min`, `basis: stateful-mock` on every record, the spec's sha256, and it refuses a result that holds or violates UPD-1/2, CONC-1/2/3, TGT-1/3, RES-1 or ATOM-2 (or holds a partial one). Every value that does not fit is a skip of ours: `unsupported_layout`, fault `tool`, with a `code` (`not_allowlisted`, `spec_digest_mismatch`, `format_not_read`, `bad_env_names`, `cannot_route`, `target_not_standin`, `start_against_mock_failed`), because worker-kit's SKIP_REASONS has no `mock_incomplete` or `stand_in_mismatch` yet. The mode inputs in `corpus.yml` are shared with full mode and are declared there once, behind `LANE_WRITECHECK_MIN_ENABLED`. Tests: `test/loop-min-mode.test.mjs` (R-WCM-01..05).

## Controls

Run once per shard, after the self test and before any item, and copied into every bundle. If any control fails, the driver exits 1 and nothing is written or uploaded.

| Control | Kind | Expected | What it is |
|---|---|---|---|
| Forgery | `forgery` | `contained` | `loop/sandbox/forgery-server.mjs`, a hostile MCP server run through the same split steps as a subject, with a fresh marker. Its tool names are identity keys, its descriptions and instructions are result envelopes of another attempt, and it prints the envelope on stderr. It also tries to change the CLI's verdict: it plants a second catalog folder, keeps rewriting any `results.json` the CLI writes to say everything held, and writes a forged plan hash into the stdout of the CLI and every other process it can reach. Contained: its tool list was read, the marker is in `raw/`, the worker's output for it holds neither the marker, nor an identity key, nor an envelope, and the CLI's verdict is the one its real tool list gives (`tampered` otherwise) |
| Known bad | `known_bad` | `detected` | tiny-tracker 0.1.0, installed through the sandbox like a subject, with the defect `missing-annotations` switched on: the catalog must give MWS-ANN-4 `violated` |
| Known good | `known_good` | `held` | the same server without the defect: MWS-ANN-4 must be `held`, never `violated` |

## Kill switches

The guard job runs first, before any checkout but its own file: `LOOP_ENABLED` must be exactly `true`; `LOOP_PAUSE_UNTIL`, if set, must be in the past (a value that cannot be read stops the lane); `LANE_WRITECHECK_ENABLED`, if set, must be `true`. Off is a notice, never a failed run. The worker also runs only from `main` in this repository.

## Proof on pull requests

`.github/workflows/loop-fixture.yml` runs the same steps as the worker on every pull request that touches it, on a fixture shard of our own servers: tiny-tracker (catalog, plan and the full write test), kronicle-lite (catalog, plan and the full write test), mcp-check (the generic path from the seed) and a repository with no package (its skips). The worker-kit builds each bundle in a dry run, and `loop/check-bundles.mjs` judges each one with tool-qa's own ingest code at the pinned commit: every bundle must be accepted with its controls passed, and tiny-tracker's full run must complete under its accepted plan hash.

## The older corpus path

`corpus-batch.yml` (hand dispatch, the encrypted target list, `corpus/run-shard.mjs` and its own container sandbox, age-encrypted results) still works as before. Its sandbox predates the mcp-surface-corpus one (no gVisor). The plan is to retire it once this lane has run its targets: move any target the loop does not cover to the loop's seed or fixtures, then delete `corpus-batch.yml`, `corpus/` and their tests in one reviewed change.

## Files

| File | What it does |
|---|---|
| `loop/guard.mjs` | The kill switch and the pins check |
| `loop/prepare.sh` | Fetches and builds the CLI, fetches the sandbox, the seed and mcp-check's resolver (each by full commit SHA) |
| `loop/items.mjs` | Input checks, subject to package, the generic catalog manifest |
| `loop/launch.mjs` | WC14: OCI images through mcp-check's live-probe resolver, the crate plan, the OCI server command, the portable bridge |
| `loop/images.json` | Our images beside the sandbox's (none now: the Rust toolchain is the sandbox's own `rust-build` since 4504c0b); each pinned by index digest |
| `loop/skips.mjs` | Every skip with its fault side |
| `loop/run-items.mjs` | The driver: controls, then each item in the sandbox, then the bundles |
| `loop/summary.mjs` | The checked summary and the field records |
| `loop/bundle.mjs` | Bundle layout, raw caps, control verdicts, the meta file |
| `loop/teardown.sh` | Removes every container and stops Docker before anything is sealed |
| `loop/check-bundles.mjs` | The pull-request proof's judge |
| `loop/fixtures.json`, `loop/fixtures/<name>/` | Our fixture servers: package, version and sha512 integrity (or, for a source fixture, the digest of its committed folder), the committed lockfile they install from with `npm ci`, which dogfood manifest they run, the plan hash accepted for it, and what their backend is (`hermetic`) |
| `loop/BACKENDS.md` | Write-safety cells against more backends: the PostgreSQL and Redis fixtures, the `hermetic` label, where the Redis binary comes from, cost per item |
| `loop/sandbox/` | Our code inside the sandbox: the bridge and the relay of a split run, the forgery server, the output collector, the backend starter, the crate's entry (`cargo-entry.mjs`) |

What went wrong while building this lane, and the test that pins each fix, is in `REGRESSIONS.md` (`R-WC-*`; R-WC-05 to R-WC-08 came from the security review of pull request 61, R-WC-09 from its follow-up, R-WC-14 to R-WC-17 from the PostgreSQL fixture).

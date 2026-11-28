# Dogfood workflows

The workflows `.github/workflows/dogfood-<server>.yml` run this action against MCP servers that
IsoKron builds or maintains, every night and on demand, to find bugs in the action, in the
`mcp-writecheck` CLI and in the servers themselves. Each one checks out the server repository it
tests at a pinned commit (all public; tiny-tracker lives in the CLI's repository,
`isokron-ai/mcp-write-safety`), starts the server's backend inside the job, and runs the action in modes `plan`, `catalog`
and `full`. A dispatch can pick another CLI commit (`cli-ref`) and pass the plan hashes accepted for
it (`plan-hashes`, `job=hash` pairs).

| Folder | What |
|---|---|
| `dogfood/<server>/writecheck.yaml` | The manifest for that server, as used in CI |
| `dogfood/<server>/*.sh` | Set-up for the server's backend in the job |
| `dogfood/kronicle-lite/candidate-manifest.sh` | Builds the kronicle-lite candidate manifest (a put_document resource with a re-put key) for a dispatch with `candidate-manifest`; `kronicle-lite-ref` picks another kronicle-lite commit |
| `dogfood/check-plan-hash.sh` | Compares a plan step's hash with the accepted one |
| `dogfood/install-pnpm.sh` | pnpm from its npm tarball, checked against a pinned sha512 integrity (`fetch`, then `install`: two steps, so a network failure is not confused with an integrity refusal), unpacked into `.sbx-pnpm/` for the sandbox; it never runs on the runner |
| `dogfood/sbx.mjs`, `dogfood/sbx-cli/` | The sandbox of the dogfood workers (below), and the `cli-path` that runs the CLI in it |
| `dogfood/sandbox-guarded.sh` | After the `sandbox-guard` step: it passed, at `SANDBOX_REF`, and `msc/` is that commit |
| `loop/sandbox/dogfood-in.mjs`, `loop/sandbox/dogfood-unit.mjs` | Ours, inside the sandbox: a step's environment (the sandbox's own `GITHUB_ENV`), and the unit's loopback forwards to the services |
| `dogfood/kubernetes/vendor-npm/` | The upstream Kubernetes server for the disabled vendor job, installed with `npm ci` from a committed lockfile |

## The sandbox

Since 28 Nov 2026 the dogfood workers that run third-party code (kronicle-lite, sea-lite, writesafe, grafana and
payload) run every install, build and run of it inside the sandbox of `isokron-ai/mcp-surface-corpus` at the commit
`SANDBOX_REF` names (78a7834), the one the writecheck lane (`corpus.yml`) uses: gVisor, user 65534, every capability
dropped, a read-only root, the sandbox's resource limits and no runner environment. Each work job needs the reusable
`sandbox-conformance` job, then runs the `sandbox-guard` action on its own runner, both at `SANDBOX_REF`, before
`dogfood/sbx.mjs up`. The driver:

- mirrors the workspace into one work volume at its own path, so every manifest, `cwd`, argument and environment value
  is the same inside the sandbox as on the runner, and the accepted plan hashes still apply;
- runs builds (`sbx.mjs build`) on the sandbox's install network, whose only way out is the allowlist proxy to the
  hosts the step names (registry.npmjs.org, or the Go module proxy and checksum database);
- runs the CLI (the action's `cli-path` is `dogfood/sbx-cli`) and the stdio server it starts in a unit container on
  the run network, which has no way out at all; services (the app's web server, Grafana, Postgres) are containers of
  that network at fixed addresses, forwarded to the unit's 127.0.0.1 ports the manifests name;
- brings files back only as data, through the sandbox's collect helper: the CLI's results, the Grafana snapshots;
- ends with `sbx.mjs down` (every container, network and volume removed; network log and firewall drops recorded)
  and `loop/teardown.sh`.

Backend credentials are made inside the sandbox, for backends nothing outside it can reach. The action itself, the
plan-hash check and the checks after the full run run on the runner and read only the results that came back. The
bundle is built by `t0-manifest`, another job that runs none of this code. Each sandboxed worker also takes
`workflow_call`: `dogfood-sandbox-proof.yml` calls the five on a pull request that touches what they run, with
`proof: true` (the worker-kit builds the bundle in a dry run).

### Threat notes

- **The harness is read-only.** `dogfood/` (our scripts, the snapshot and set-up code, the manifests) is not in the
  read-write work volume: `up` puts it in a volume of its own, owned by root, mounted read-only over
  `<workspace>/dogfood` in every container of the job. A third-party install script can rewrite its own tree and the
  results folders, never the harness a later step or the CLI reads.
- **Files come back from paused containers.** While the collect helper or `pull` reads the work volume, the unit and
  every service are paused (`docker pause`), so nothing changes a file during the read; a pause that fails reads nothing.
- **What remains: a subject can fake its own result.** The CLI runs in the unit with the server it tests (a full run
  needs the CLI's loopback gate in front of the backend, and restarts the server), and the unit lives for the whole job.
  A process that the server, or an earlier sandboxed step, leaves running in the unit or in a service can change what
  the CLI reads or writes, and its results, before they are collected. So a dogfood worker's verdict is only as
  trustworthy as the code it runs: a hostile subject could make its own job green (and hide a lead) or red. It cannot
  reach the runner, its token, the job's other steps or the result bundle: the sandbox has no network out, the runner's
  steps only read what comes back as data, and `t0-manifest` runs on another runner and reads only job results. The
  subjects are IsoKron's own builds and pinned upstream code.

`dogfood-kubernetes.yml` is the exception. kind runs the cluster in privileged Docker containers, which the sandbox
cannot give, and the server under test must reach the cluster's API, so that workflow still runs third-party code on
the plain runner. It is therefore not a T0 worker: it builds no result bundle and must not be in the loop's lanes
(any job of a run can upload an artifact with the run's own token, so a run with unsandboxed third-party code cannot
be the one whose result bundle is trusted).

Rules every dogfood workflow follows:

- Triggers: `workflow_dispatch` only, since 23 Nov 2026. These workflows are T0 workers of the tool-qa loop:
  the loop dispatches them with `shard_id`, `attempt_id`, `fence` and `run_key`, and each one ends with a sealed tool-qa result bundle (`loop/t0-bundle.mjs`); each one checks this repository's
  `LOOP_ENABLED` variable first (anything but `true` skips every job, green). There is no schedule, `push` or
  `pull_request` trigger, so a change to `action.yml` or `src/` is exercised against real servers when the loop next
  dispatches these, not on the pull request; `test.yml` still runs the unit tests on every push and pull request.
  Never `pull_request_target`. Standard GitHub-hosted runners only, never self-hosted.
- `permissions: contents: read`; third-party actions pinned by full commit SHA; `timeout-minutes`
  on every job; checkouts with `persist-credentials: false`.
- No secret. The CLI's repository, `isokron-ai/mcp-write-safety`, is public (16 Nov 2026), so no
  checkout or fetch needs a token. Workflows that install or start third-party code (a server's npm
  or Go tree) check the CLI out in one step that runs first, build it there (`dogfood/cli-ref.sh`,
  `dogfood/build-cli.sh`) and give the action `cli-path` (the sandboxed workers: `dogfood/sbx-cli`, which runs
  that build in the sandbox). writesafe, whose server installs an unlocked dependency tree, runs on dispatch only,
  like the others. Every backend credential is generated inside the job (inside the sandbox, for the sandboxed
  workers), checked, and never printed.
- Full mode only against a backend started inside the job. The plan hash is pinned in the workflow
  after a person has read the plan; when the plan changes, the full run is refused and the
  workflow fails at the hash check until the hash is updated.
- Only builds IsoKron publishes as its own are run. A job for an upstream (vendor) build may be
  present, but it stays disabled (`if: false`) until the owner decides otherwise: job logs and
  summaries of this repository are public.
- Artifacts hold the full results folder (catalog, traffic, report) and are public like the logs.

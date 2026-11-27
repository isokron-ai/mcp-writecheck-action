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
| `dogfood/install-pnpm.sh` | pnpm from its npm tarball, checked against a pinned sha512 integrity (`fetch`, then `install`: two steps, so a network failure is not confused with an integrity refusal) |
| `dogfood/kubernetes/vendor-npm/` | The upstream Kubernetes server for the disabled vendor job, installed with `npm ci` from a committed lockfile |

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
  `dogfood/build-cli.sh`) and give the action `cli-path`. writesafe, whose server installs an
  unlocked dependency tree, runs on dispatch only, like the others. Every backend credential is generated
  inside the job, checked and masked.
- Full mode only against a backend started inside the job. The plan hash is pinned in the workflow
  after a person has read the plan; when the plan changes, the full run is refused and the
  workflow fails at the hash check until the hash is updated.
- Only builds IsoKron publishes as its own are run. A job for an upstream (vendor) build may be
  present, but it stays disabled (`if: false`) until the owner decides otherwise: job logs and
  summaries of this repository are public.
- Artifacts hold the full results folder (catalog, traffic, report) and are public like the logs.

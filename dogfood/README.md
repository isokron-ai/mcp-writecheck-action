# Dogfood workflows

The workflows `.github/workflows/dogfood-<server>.yml` run this action against MCP servers that
IsoKron builds or maintains, every night and on demand, to find bugs in the action, in the
`mcp-writecheck` CLI and in the servers themselves. Each one checks out the server repository it
tests at a pinned commit (public, except tiny-tracker, which lives in the CLI's repository until
launch), starts the server's backend inside the job, and runs the action in modes `plan`, `catalog`
and `full`. A dispatch can pick another CLI commit (`cli-ref`) and pass the plan hashes accepted for
it (`plan-hashes`, `job=hash` pairs).

| Folder | What |
|---|---|
| `dogfood/<server>/writecheck.yaml` | The manifest for that server, as used in CI |
| `dogfood/<server>/*.sh` | Set-up for the server's backend in the job |
| `dogfood/check-plan-hash.sh` | Compares a plan step's hash with the accepted one |

Rules every dogfood workflow follows:

- Triggers: `workflow_dispatch`, a nightly `schedule`, and for the light workflows `pull_request`
  and `push` to `main` on their own paths. Never `pull_request_target`. A pull request from a fork
  runs no job (each job's `if:` checks that the head is this repository), so a fork never gets the
  secret. Standard GitHub-hosted runners only, never self-hosted.
- `permissions: contents: read`; third-party actions pinned by full commit SHA; `timeout-minutes`
  on every job; checkouts with `persist-credentials: false`.
- One secret, `MWS_CLI_TOKEN` (read-only on the CLI's repository), and only until the CLI is
  published. Workflows that install or start third-party code (a server's npm or Go tree) use it in
  one checkout step that runs first, build the CLI there (`dogfood/cli-ref.sh`,
  `dogfood/build-cli.sh`) and give the action `cli-path`, never `cli-token`. Residual risk, accepted
  until launch: the runner keeps a job's secrets in its own memory for the whole job, so code that
  runs later in the job could in principle read the token; its reach is read access to a repository
  that becomes public at launch. Workflows whose server installs an unlocked dependency tree
  (writesafe) run on dispatch only until then. Every backend credential is generated inside the job,
  checked and masked.
- Full mode only against a backend started inside the job. The plan hash is pinned in the workflow
  after a person has read the plan; when the plan changes, the full run is refused and the
  workflow fails at the hash check until the hash is updated.
- Only builds IsoKron publishes as its own are run. A job for an upstream (vendor) build may be
  present, but it stays disabled (`if: false`) until the owner decides otherwise: job logs and
  summaries of this repository are public.
- Artifacts hold the full results folder (catalog, traffic, report) and are public like the logs.

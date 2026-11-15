# Dogfood workflows

The workflows `.github/workflows/dogfood-<server>.yml` run this action against MCP servers that
IsoKron builds or maintains, every night and on demand, to find bugs in the action, in the
`mcp-writecheck` CLI and in the servers themselves. Each one checks out the public server repository
it tests at a pinned commit, starts the server's backend inside the job, and runs the action in
modes `plan`, `catalog` and `full`.

| Folder | What |
|---|---|
| `dogfood/<server>/writecheck.yaml` | The manifest for that server, as used in CI |
| `dogfood/<server>/*.sh` | Set-up for the server's backend in the job |
| `dogfood/check-plan-hash.sh` | Compares a plan step's hash with the accepted one |

Rules every dogfood workflow follows:

- Triggers: `workflow_dispatch` and a nightly `schedule` only. Never `pull_request_target`; a fork
  gets no secret.
- `permissions: contents: read`; third-party actions pinned by full commit SHA; `timeout-minutes`
  on every job; checkouts with `persist-credentials: false`.
- One secret, `MWS_CLI_TOKEN` (read-only on the CLI's repository), and only until the CLI is
  published. Every backend credential is generated inside the job and masked.
- Full mode only against a backend started inside the job. The plan hash is pinned in the workflow
  after a person has read the plan; when the plan changes, the full run is refused and the
  workflow fails at the hash check until the hash is updated.
- Only builds IsoKron publishes as its own are run. A job for an upstream (vendor) build may be
  present, but it stays disabled (`if: false`) until the owner decides otherwise: job logs and
  summaries of this repository are public.

# mcp-writecheck GitHub Action

Runs [`mcp-writecheck`](https://github.com/isokron-ai/mcp-write-safety/tree/main/packages/writecheck) in the CI of a repository that holds an MCP server, and reports the result against the MCP Write-Safety Requirements (MWS 0.9) in the job summary.

Status: draft. No release is tagged yet, and it is not listed on the Marketplace. It is pinned to `mcp-writecheck` at commit `0295ed6` (branch `cli/resync-516`) and to the requirement registry of MWS 0.9 at spec commit `e2bb9b0`. Everything that depends on the CLI or the spec is in [`contract.mjs`](contract.mjs).

**Mode `full` makes real writes.** It creates, changes and deletes objects in whatever system the manifest points at. Point it only at a test environment that you are allowed to change. The default mode, `plan`, writes nothing.

## What it does

1. Fetches `mcp-writecheck` at the commit given by `cli-ref` and builds it, in a step of its own: that step is the only one that gets `cli-token`.
2. Runs it in one of three modes: `plan`, `catalog` or `full`.
3. Writes the job summary. In modes `catalog` and `full`: first anything the tester's own safety checks saw (objects it did not create that were lost, setup it could not release, objects left behind), then one row per requirement with the verdicts by write path, every `violated` record in full with its attribution, and a folded table of every record. Each requirement ID links to its anchor on the public spec page.
4. Uploads the results folder as an artifact.
5. Sets the job status.

It reports per requirement and per write path, as MWS requires of any tester. It prints no total, no percentage, no score and no badge, and a job that does not fail is not a statement that the server meets MWS. It sends no telemetry.

## Use

```yaml
# Every pull request: no tool call, no write, no test environment, no secret.
- uses: isokron-ai/mcp-writecheck-action@<full commit SHA>
  with:
    manifest: writecheck.yaml
    mode: plan

# Every pull request, optionally: the verdicts that need only tools/list (MWS-ANN-4).
- uses: isokron-ai/mcp-writecheck-action@<full commit SHA>
  with:
    manifest: writecheck.yaml
    mode: catalog
    fail-on: any

# On main: real writes to the test environment the manifest points at.
- uses: isokron-ai/mcp-writecheck-action@<full commit SHA>
  with:
    manifest: writecheck.yaml
    mode: full
    fail-on: must
    confirm-target: staging-tracker.internal   # the manifest's target.confirm
    plan-hash: 0123456789abcdef                # from the plan, after a person has read it
```

[`examples/mcp-writecheck.yml`](examples/mcp-writecheck.yml) is a complete workflow. The job needs Node 22 or later (`actions/setup-node`); the action checks this and does not install Node itself.

The manifest is the file `mcp-writecheck init` drafts and you complete. The CLI's README and `MANIFEST.md` describe it.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `manifest` | (required) | Path of the manifest, relative to the workspace (the repository root after checkout). |
| `mode` | `plan` | `plan`, `catalog` or `full`. See [Modes](#modes). |
| `fail-on` | `must` | `none`, `must` or `any`. See [Job status](#job-status). |
| `cli-ref` | `0295ed6494d99ce5467f0d6e94e91a5c436a18c2` | The commit of `mcp-writecheck` to fetch and build: a full 40-character lower-case SHA. A branch, a tag or a short SHA is refused; the fetched commit is checked against it. |
| `confirm-target` | | Mode `full`, required. The manifest's `target.confirm`, typed back. |
| `plan-hash` | | Mode `full`, required. The hash of the plan a person has read. |
| `catalog` | | Modes `plan` and `catalog`, optional. A saved `tools/list` answer, a list of tools, or the `catalog.json` of an earlier run. With it, no server is started. |
| `spec-url` | `https://isokron.ai/mws` | Base URL of the public spec page. A requirement links to `<spec-url>#<id in lower case>`, for example `https://isokron.ai/mws#mws-conc-2`. |
| `results-dir` | `mwsc-results` | Folder the results are written to and the artifact is made from, relative to the workspace. |
| `artifact-name` | `mcp-writecheck-results` | Name of the artifact. Give each job of a matrix its own. |
| `cli-path` | | Folder of an `mcp-writecheck` package that is already built. When set, nothing is fetched and `cli-ref` is not used. |
| `cli-token` | | A token that can read the `mcp-writecheck` repository. Needed while that repository is private and the CLI is not on npm. Give it the least scope: a fine-grained token for that one repository, Contents read-only, with a short expiry. Only the step that fetches the CLI gets it; it goes to git as an HTTP header for the fetch alone (never in a URL or on a command line), and it is masked in the log. |

Outputs: `plan-hash`, `results-path`, `cli-exit-code` (the CLI's own exit status) and `exit-status` (0 or 1, the job status the action decided).

Environment variables of the job reach the CLI and, through the manifest's `server.env_passthrough` and `server.env_public` lists, the server it starts. That is how the server gets its backend URL and its test credential.

## Modes

### `plan`: no test environment needed

`plan` runs `mcp-writecheck plan`. The CLI reads the manifest and the server's catalog, and prints every call a full run would make, the largest number of writes and created objects, what would not be tested and why, and the plan hash. It calls no tool and writes nothing.

- Without `catalog`, the CLI starts the server for one `tools/list` request and stops it. The server has to be built and has to be able to start in the job. A server that refuses to start without its backend URL needs that variable set; nothing is sent to the backend.
- With `catalog`, no server is started at all.

A plan has no verdicts. The summary shows the plan and the hash, and the job fails only if the plan could not be built.

### `catalog`: verdicts from the catalog alone

`catalog` runs `mcp-writecheck catalog`. It reads `tools/list` (from the server, or from the `catalog` input) and judges what needs nothing else: MWS-ANN-4, whether each tool declares `readOnlyHint` and `destructiveHint`. It calls no tool and writes nothing. Every other requirement is recorded `not tested`. MWS-ANN-4 is a SHOULD, so only `fail-on: any` can fail the job on it.

### `full`: real writes, test environment required

`full` runs `mcp-writecheck run`. It needs:

- **A test environment.** A backend that the job starts for itself (a container, an in-memory build) or a tenant that exists only for testing. The run creates objects whose names start with `mwsc-<run id>-`, updates and deletes them, starts the server several times with different settings, and deletes what it created at the end. The plan states the largest number of writes.
- **A credential that is valid only there.** Pass it as a job secret, and list its variable under `server.env_passthrough` in the manifest so that its value is redacted from the results.
- **A manifest that declares the target.** `target.environment: test`; `target.confirm`, a string that names the target; `target.guard`, a read-only tool call whose result must match a pattern (for example the tenant name) before any write. The CLI refuses hosts that look like production unless the manifest lists them.
- **Both confirmations.** `confirm-target` and `plan-hash`. The CLI has no `--yes`, and this action does not add one: it never takes the hash from a plan it has just built. The hash covers the manifest, the catalog, the suite version, the limits and every host named by a URL in the server's environment. When any of them changes, the run is refused, the summary shows both hashes, and a person reads the new plan and updates the input. Use a fixed port for a backend the job starts; with a random port the hash changes on every run.

The empty and match-all selector forms of MWS-TGT-2 delete or change everything a selector tool can reach. The CLI sends them only where the manifest opts in with `selector.send_empty_forms: true`, for a backend that is disposable. Around every targeting call it lists the objects it did not create and reads them back afterwards (the bystander inventory).

None of these checks proves that a target is a test system. They refuse obvious mistakes. The decision to point the manifest at a system is yours.

Do not run this action, in any mode, on `pull_request_target`, `workflow_run` or any other event where code from a fork runs with your secrets: modes `plan` and `catalog` start the server under test too (unless `catalog` is given), and the job holds `cli-token` and, in mode `full`, the test credential. Use `pull_request`, which gives a fork's pull request no secrets. Run one full job at a time against one environment (`concurrency:`); two runs would act as each other's second writer.

If a full run is cancelled or the runner dies, objects can be left behind. The artifact then holds `state/<run id>/`, the run's ledger; download it and run `mcp-writecheck cleanup -m <manifest> --state <that state folder>` against the same target, or search the test environment for the prefix `mwsc-`.

## Job status

These fail the job whatever `fail-on` says:

- **A run that lost an object it did not create.** The bystander inventory found an object outside the tester's own gone, changed, or missing from every listing after a targeting call (`numbers.bystanders_lost` in `results.json`). The summary lists them first. Check them, and restore what was lost from your backup.
- **A clean-up that did not finish:** deletes that failed, creates whose outcome is unknown, or a clean-up that stopped (`cleanup.failed`, `cleanup.unknown`, `cleanup.stopped`). Objects of the run may still be in the test environment, and the next run against it is refused until `mcp-writecheck cleanup` has run with the artifact's `state` folder. This is also how a test environment that failed during the run shows: the CLI then reports the run as complete, with every later check `not tested`.
- **Setup left on the platform.** Setup the run made through the platform's own API that it could not release or confirm released (`safety.setup_unresolved`, written by CLI releases that make such setup; the CLI then exits 4).
- **A run that did not complete:** a usage or manifest error (CLI exit 2), a refusal (3), a run that stopped or failed (4, or a `stopped` status in the results), an interruption (130), or results the action cannot read. There is then nothing to judge, and a green job would hide that.

Otherwise only `violated` records can fail the job:

| `fail-on` | The job fails when |
|---|---|
| `none` | never, for a completed run that lost nothing and cleaned up |
| `must` | a record of a MUST is `violated` |
| `any` | any record is `violated` |

`platform`, `not observed`, `not tested`, `not applicable` and `self-attested` records never fail a job, including a `self-attested` record whose answer is "no". Objects left behind on purpose (`cleanup: leave`, `ephemeral` or `archive` in the manifest) get one plain line and no warning. Other leftovers, a changed canary and a fixture not put back are shown under "Needs attention" and do not fail the job by themselves.

A requirement counts as a MUST when the spec says MUST or the CLI's record says MUST. At the pinned commit the two agree on all 37 requirements; the rule stays so that a future difference errs on the strict side, and the summary marks any such record.

The CLI's `--baseline` (known violations that do not fail a run) and `--sign` options are not exposed by this draft.

## The artifact

The artifact is the `results-dir` folder:

- `<run id>/report.md`, `results.json`, `junit.xml`, `catalog.json`, `plan.json`, a redacted copy of the manifest, `capture/` (every call and result of the run), `history.jsonl`, `ledger.jsonl` and `SHA256SUMS` (mode `full`);
- `state/`, the CLI's ledgers (mode `full`);
- `catalog-<fingerprint>/` with `report.md`, `results.json`, `junit.xml`, `catalog.json` and `SHA256SUMS` (mode `catalog`);
- `plan/plan.txt` (mode `plan`).

The capture holds what the server returned from the test environment. The ledger (`state/` and `<run id>/ledger.jsonl`) also records, in the CLI at the pinned commit, up to 200 characters of a server's error text for a failed create or delete, and that text is not redacted: a server that echoes a credential in an error message puts it into the artifact. The CLI redacts the values of the credentials the manifest names (the variables under `server.env_passthrough`, and those used for request headers and for the control arm), when they are six characters or longer. Anything else the test environment returns is in the artifact as it came. Anyone with read access to the repository can download the artifacts of its workflow runs, so keep real data out of the test environment.

## What the action contacts

- the git host of the `mcp-writecheck` repository, once, to fetch the pinned commit (not with `cli-path`);
- the npm registry, to install the CLI's build dependencies from its lockfile (not with `cli-path`); `npm` runs with scripts, audit, funding messages and the update check switched off;
- GitHub's artifact service, through `actions/upload-artifact`, pinned by commit SHA.

The CLI itself connects to the server, to the hosts the manifest names, and to nothing else.

## Until the CLI is published

The CLI will be published to npm as `@mcp-write-safety/writecheck`. Until then the action fetches it from the `isokron-ai/mcp-write-safety` repository, which is private, so **every workflow that uses this action needs the `cli-token` input**: a token that can read that repository. This holds even though the action's own repository is public. GitHub does not give secrets to workflows run for a pull request from a fork, so on such a pull request the fetch fails until then, and a pull request from a fork cannot run this action at all before the CLI is published. The example workflow skips its jobs for such pull requests until then (`if: github.event.pull_request.head.repo.full_name == github.repository`). Do not switch to `pull_request_target` to get around this (see [Modes](#full-real-writes-test-environment-required)). The input goes away when the CLI is on npm or the repository is public; `contract.mjs` is where the source of the CLI changes.

## Skills

Two agent skills, one for building MCP servers whose write tools meet MWS and one for agents that call write tools, will be published here with the MWS launch.

## Licence

Apache-2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Made by [IsoKron](https://isokron.ai/?utm_source=github&utm_medium=readme&utm_campaign=mcp-writecheck-action).

## Tests

[`TESTING.md`](TESTING.md) shows the local test against tiny-tracker, the MWS sample server, and lists what has not been tested. [`RUNNER-TEST.md`](RUNNER-TEST.md) is the plan for the first run on a GitHub runner, which has not happened yet.

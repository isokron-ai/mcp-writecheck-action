<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/mws-mark-dark.svg">
    <img src="assets/mws-mark.svg" alt="MCP Write-Safety Requirements mark" width="72" height="72">
  </picture>
</p>

<sub>The MWS mark is not covered by this repository's licence; its use is described in the specification's <a href="https://github.com/isokron-ai/mcp-write-safety/blob/main/TRADEMARKS.md">TRADEMARKS.md</a>.</sub>

# mcp-writecheck GitHub Action

Runs [`mcp-writecheck`](https://github.com/isokron-ai/mcp-write-safety/tree/main/packages/writecheck) in the CI of a repository that holds an MCP server, and reports the result against the MCP Write-Safety Requirements (MWS 0.9) in the job summary.

Status: 0.1 (preview). Use `isokron-ai/mcp-writecheck-action@v0` for updates within 0.x, or pin a release tag or commit SHA. It is pinned to commit [`7b95215`](https://github.com/isokron-ai/mcp-write-safety/commit/7b952151dddd84260d057cdb506081820003fe56) of the public [`isokron-ai/mcp-write-safety`](https://github.com/isokron-ai/mcp-write-safety) repository: MWS 0.9 (the public draft, 37 requirements) and `mcp-writecheck` 0.1.0, which is also published to npm as [`@mcp-write-safety/writecheck`](https://www.npmjs.com/package/@mcp-write-safety/writecheck). Everything that depends on the CLI or the spec is in [`contract.mjs`](contract.mjs). Commit SHAs in this repository's notes from before 16 November 2026 refer to the private pre-publication history of the spec and the CLI and do not resolve publicly.

**Mode `full` makes real writes.** It creates, changes and deletes objects in whatever system the manifest points at. Point it only at a test environment that you are allowed to change. The default mode, `plan`, writes nothing.

## What it does

1. Fetches `mcp-writecheck` at the commit given by `cli-ref` from the public repository and builds it, in a step of its own. No token is needed.
2. Runs it in one of three modes: `plan`, `catalog` or `full`.
3. Writes the job summary. In modes `catalog` and `full`: first anything the tester's own safety checks saw (objects it did not create that were lost, setup it could not release, objects left behind), then one row per requirement with the verdicts by write path, every `violated` record in full with its attribution (and, where one exists, the helpers of the MCP Write-Safety kits for TypeScript and Python that address it, linked to each kit's table), and a folded table of every record. Each requirement ID links to its anchor on the public spec page.
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
| `cli-ref` | `7b952151dddd84260d057cdb506081820003fe56` | The commit of `mcp-writecheck` to fetch and build: a full 40-character lower-case SHA. A branch, a tag or a short SHA is refused; the fetched commit is checked against it. |
| `confirm-target` | | Mode `full`, required. The manifest's `target.confirm`, typed back. |
| `plan-hash` | | Mode `full`, required. The hash of the plan a person has read. |
| `catalog` | | Modes `plan` and `catalog`, optional. A saved `tools/list` answer, a list of tools, or the `catalog.json` of an earlier run. With it, no server is started. |
| `spec-url` | `https://isokron.ai/mws` | Base URL of the public spec page. A requirement links to `<spec-url>#<id in lower case>`, for example `https://isokron.ai/mws#mws-conc-2`. |
| `results-dir` | `mwsc-results` | Folder the results are written to and the artifact is made from, relative to the workspace. |
| `artifact-name` | `mcp-writecheck-results` | Name of the artifact. Give each job of a matrix its own. |
| `max-rss-mb` | | Optional. A memory ceiling in MB (1 MB = 1024 KiB) for the CLI and the processes under it. A peak that reaches it is shown under "Needs attention"; it never changes the job status. See [Time and memory](#time-and-memory).
| `cli-path` | | Folder of an `mcp-writecheck` package that is already built. When set, nothing is fetched and `cli-ref` is not used. |
| `cli-token` | | Not needed: the `mcp-writecheck` repository is public. Kept, optional and unset by default, so that workflows that still pass it keep working; it will be removed in a later version. If given, only the step that fetches the CLI gets it; it goes to git as an HTTP header for the fetch alone (never in a URL or on a command line), and it is masked in the log. |

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
- **A clean-up that did not finish:** deletes that failed, creates whose outcome is unknown, or a clean-up that stopped (`cleanup.failed`, `cleanup.unknown`, `cleanup.stopped`). Objects of the run may still be in the test environment, and the next run against it is refused until `mcp-writecheck cleanup` has run with the artifact's `state` folder. With CLI `0295ed6` this was also how a test environment that failed during the run showed (the run was reported complete); since `e613620` the CLI stops such a run itself (exit 4).
- **A run in which the set-up of every object under test failed.** Every resource with an object under test (an update tool and two fields, created by the run or named as a fixture) has its checks recorded `not tested` with "setup failed: …", so none of their write paths was tested. The action reads this from `results.json` and the run's `plan.json`. The CLI at the pinned commit stops such a run itself (exit 4), and the job then fails as a run that did not complete; the action's own rule stays as a guard for CLIs before `e613620`, which reported it complete with exit 0. Where only some set-ups failed, the others were tested: the failed ones are listed under "Needs attention" and `fail-on` decides. A plan, a catalog-only run, and a manifest whose resources have no object under test have no set-up, so this never applies to them.
- **Setup left on the platform.** Setup the run made through the platform's own API that it could not release or confirm released (`safety.setup_unresolved`, written by CLI releases that make such setup; the CLI then exits 4).
- **A run that did not complete:** a usage or manifest error (CLI exit 2), a refusal (3), a run that stopped or failed (4, or a `stopped` status in the results), an interruption (130), or results the action cannot read. There is then nothing to judge, and a green job would hide that.

Otherwise only `violated` records can fail the job:

| `fail-on` | The job fails when |
|---|---|
| `none` | never, for a completed run that lost nothing, cleaned up, and did not fail the set-up of every object under test it had |
| `must` | a record of a MUST is `violated` |
| `any` | any record is `violated` |

`platform`, `not observed`, `not tested`, `not applicable` and `self-attested` records never fail a job, including a `self-attested` record whose answer is "no". Objects left behind on purpose (`cleanup: leave`, `ephemeral` or `archive` in the manifest) get one plain line and no warning. Other leftovers, a changed canary and a fixture not put back are shown under "Needs attention" and do not fail the job by themselves.

A requirement counts as a MUST when the spec says MUST or the CLI's record says MUST. At the pinned commit the two agree on all 37 requirements; the rule stays so that a future difference errs on the strict side, and the summary marks any such record.

The CLI's `--baseline` (known violations that do not fail a run) and `--sign` options are not exposed by this draft.

### Time and memory

While the CLI runs, the action samples the memory of the CLI and every process under it (the server under test and what it starts) and shows the peak in the summary:

| Runner | How | Shown as |
|---|---|---|
| Linux | every second from `/proc`: the sum of the resident memory of the tree, and each process's own peak | exact (a spike shorter than a second can fall between two readings) |
| macOS | every two seconds from `ps` | approximate |
| Windows | | not measured |

With `max-rss-mb`, a peak that reaches the ceiling gets a line under "Needs attention" and a warning annotation. In mode `full`, a server process that ended by SIGKILL the CLI did not send (most often the system's out-of-memory killer) gets one too; the action reads this from the run's capture, where CLI releases that record `stop_sent` on a server's exit write it (the CLI at the pinned commit does not, and then nothing is shown). None of this changes the job status, and an error while sampling only makes the figure "not measured". A backend the job starts itself is not under the CLI, so it is not in the figure. In the workflow:

- **Set `timeout-minutes` on the job.** Without it a job can run for six hours. When the timeout cancels the job, the action forwards the cancellation to the CLI, which stops the run and cleans up as for any cancellation, within the runner's grace period before it kills the job; what it could not delete is in the artifact's `state/` folder (see [`full` mode](#full-real-writes-test-environment-required)).
- **Know your runner's memory limit.** GitHub lists the memory of its hosted runners under [Supported runners and hardware resources](https://docs.github.com/en/actions/reference/runners/github-hosted-runners); a self-hosted runner has what its machine or container gives it. The CLI, the server under test, a backend the job starts and the runner itself share that memory, and when it runs out the system kills one of them.
- **Limit and check what you start.** On a self-hosted runner, set a memory limit on the runner's service or container, so that a run that grows ends the job and not the machine. Give a backend the job starts its own limit (`docker run --memory 1g …`, or `options: --memory 1g` on a service container), and check after the run that it is still up and was not killed:

  ```yaml
  - name: Check the test backend after the run
    if: ${{ always() }}
    run: |
      out=$(docker inspect --format '{{.State.Running}} {{.State.OOMKilled}} {{.State.ExitCode}}' test-backend) \
        || { echo "test backend: container not found"; exit 1; }
      read -r running oom code <<< "$out"
      echo "test backend: running=$running oom_killed=$oom exit_code=$code"
      if [ "$running" != true ] || [ "$oom" != false ]; then exit 1; fi
  ```

  For a service container, put `${{ job.services.<id>.id }}` in the `docker inspect` line in place of `test-backend`. A backend that was killed part-way, or restarted empty, makes the results describe that and not the server; this step tells the two apart.
- **An out-of-memory kill of the CLI already fails the job.** The CLI is then ended by SIGKILL and has no exit status of its own (a shell would show 137), which is not a status after which a complete results folder exists, so the job fails whatever `fail-on` says, as for any run that did not complete. A green job from a killed process would hide that nothing was judged. The results folder is still uploaded, with the `state/` folder for `mcp-writecheck cleanup`.

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

## Where the CLI comes from

`mcp-writecheck` 0.1.0 is published to npm as `@mcp-write-safety/writecheck`, and its source is in the public [`isokron-ai/mcp-write-safety`](https://github.com/isokron-ai/mcp-write-safety/tree/main/packages/writecheck) repository. The action still fetches it from that repository at the commit given by `cli-ref` and builds it, so no secret and no `cli-token` is needed. Still do not run the action on `pull_request_target` (see [Modes](#full-real-writes-test-environment-required)). Moving the source to npm is a later change in `contract.mjs`.

## Skills

Two agent skills, in [`skills/`](skills/):

- [`mcp-write-safe-builder`](skills/mcp-write-safe-builder/SKILL.md): for agents that build or change the write tools of an MCP server. It walks the requirements, the result shape and the helper kits ([`@mcp-write-safety/kit`](https://github.com/isokron-ai/mcp-write-safety-kits/tree/main/ts) and [`mcp-write-safety-kit`](https://github.com/isokron-ai/mcp-write-safety-kits/tree/main/py)), and ends with running this Action.
- [`mcp-write-safe-caller`](skills/mcp-write-safe-caller/SKILL.md): for agents that call write tools. It treats a tool with no annotations as destructive, retries with the same key and the same arguments, and reads back before acting on an unknown outcome.

Each is a single `SKILL.md`. Copy its folder into your agent's skills directory, or install both with the `skills` CLI:

```sh
npx skills add isokron-ai/mcp-writecheck-action
```

It lists the two skills and asks which agents to install them for. `--skill '*' --agent claude-code --yes` installs both into `.claude/skills/` without prompts.

### Install as a plugin

The repository is also a marketplace, `isokron` ([`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json)), that lists one plugin, `mcp-write-safety`, in [`plugin/`](plugin/). The plugin holds the two skills above (copies kept identical by a test), plus its README, LICENSE, SECURITY.md and icon; no hooks, MCP servers or scripts.

```sh
claude plugin marketplace add isokron-ai/mcp-writecheck-action
claude plugin install mcp-write-safety@isokron
```

Or in a session (version 2.1.275 or later), in one step:

```text
/plugin install mcp-write-safety --marketplace isokron-ai/mcp-writecheck-action
```

The skills then load as `mcp-write-safety:mcp-write-safe-builder` and `mcp-write-safety:mcp-write-safe-caller`. `claude plugin update mcp-write-safety@isokron` fetches a new version when one is released.

## Licence

Apache-2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

Made by [IsoKron](https://isokron.ai/?utm_source=github&utm_medium=readme&utm_campaign=mcp-writecheck-action).

## Tests

[`TESTING.md`](TESTING.md) shows the local test against tiny-tracker, the MWS sample server, and lists what has not been tested. [`RUNNER-TEST.md`](RUNNER-TEST.md) is the plan for the first run on a GitHub runner, which has not happened yet.

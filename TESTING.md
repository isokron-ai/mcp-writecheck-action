# Testing

> **History note (16 November 2026).** The action is now pinned to commit `3af41c6` of the public `isokron-ai/mcp-write-safety` (MWS 0.9, `mcp-writecheck` 0.1.0), which needs no token. Commit SHAs below from before that date (`17851d7`, `0295ed6`, `f573a24`, `15f71e5` and the others) refer to the private pre-publication history of the spec and the CLI and do not resolve publicly; `MWS_CLI_TOKEN` and `cli-token` are no longer needed.

This file records the local test of the action's script logic and says what has not been tested. Since 16 November 2026 the action also runs on GitHub-hosted runners (`selftest.yml`, the `dogfood-*.yml` workflows, `test.yml`); `RUNNER-TEST.md` is the historical plan for the first such run.

## What was run

`test/local-test.sh` does what a job would do around the action, without GitHub:

1. It runs the unit tests (`node --test test/*.test.mjs`): the job-status rule, the safety facts, the summary text, and `contract.mjs` checked against the built CLI's own help, registry and results schema, and against Annex C of the spec.
2. It starts the backend of tiny-tracker, the MWS sample server, on `127.0.0.1:4610` with a throwaway token. That is the test environment.
3. For each case it runs the action's one script, `src/main.mjs`, exactly as `action.yml` does: inputs as `INPUT_*` variables, `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` pointing at files. It then applies the rule of the last step of `action.yml`: the job status is the `exit-status` output.

The manifest is tiny-tracker's `examples/tiny-tracker/writecheck.yaml` from the CLI branch, with its `cwd` pointed at the tiny-tracker build, as `mcp-writecheck demo` does. It opts in to the empty selector forms (`selector.send_empty_forms: true`; the backend is in memory) and declares `patterns` (strict rule 11). A broken build is selected with `TRACKER_DEFECTS=<name>`. Mode `full` goes through the same path as in CI: `mcp-writecheck run` with `--confirm-target` and `--plan-hash`, the hash taken from a preceding `plan` case.

The cases:

| Case | How | Shows |
|---|---|---|
| correct build: `plan` from the server, `plan` from the saved `catalog.json`, `catalog` both ways, `full` with `must` and `any` | | Nothing fails. The saved-catalog plan has the live plan's hash. |
| wrong plan hash; no `confirm-target` | | The CLI refuses (exit 3) and the job fails under `none`; without the input the action stops before the CLI. |
| `force-by-default` (MWS-CONC-1, a MUST) | `full`, `must`, `none`, `any` | Fails under `must` and `any`, not under `none`. Violated records carry their attribution. |
| `no-idempotency-key` (MWS-RETRY-1, a SHOULD) | `full`, `must`, `any` | The CLI exits 0; the job fails only under `any`. |
| `empty-filter-deletes-all` (MWS-TGT-2, a MUST) | `full`, `none`, `must` | The opt-in empty forms reach the tool; only the tester's own container is emptied; the inventory finds no bystander lost, so `fail-on` decides. |
| `missing-annotations` (MWS-ANN-4, a SHOULD) | `catalog`, `must`, `any` | Catalog-only verdicts: fails only under `any`. |
| a lost bystander | the server of the CLI's regression case S1 (`test/bystander-fixture.mjs`), `full`, `none` | **The job fails although `fail-on` is `none`.** The summary names the lost objects first. The fixture's backend confirms both seeded bystanders were deleted. |
| a run that stopped | write budget 40 | CLI exit 4, `run.status` `stopped`; the job fails under `none`. |
| a cancelled run | SIGTERM to the action's script (20 s into the run; since the review, once the run has written 100 ledger entries) | The script passes the signal on; the CLI cleans up and exits 130; the job fails under `none`; the ledger is in `<results-dir>/state/`. |
| a crashed test environment | tiny-tracker's backend killed (20 s into the run; since the review, once the run has written 100 ledger entries) | The CLI reports the run `complete` and exits 0 (NOTES.md, CLI problem 14). **The job fails under `none`** on the unfinished clean-up, and the summary says what was left. |
| fetch and build | `WITH_FETCH` | `src/install.mjs` fetches `0295ed6` from a local clone by full SHA, runs `npm ci` and the build; the result gives the same plan hash. |

```sh
CLI_DIR=/tmp/av2/cli/packages/writecheck \
TINY_TRACKER_DIR=/tmp/av2/tt/examples/tiny-tracker \
MWS_SPEC=/tmp/av2/spec/mws.md \
WITH_FETCH=<local clone of mcp-write-safety> \
MWS_REPO=<mcp-write-safety checkout> \
  test/local-test.sh <out-dir>
```

Run on 15 November 2026, 19:35:55 to 19:46:32 UTC, Linux, Node v22.23.4, git 2.43.0:

- `mcp-writecheck` 0.1.0-dev.0 at commit `0295ed6` (`cli/resync-516`), built from `git archive` of that commit (CLI_DIR, with its compiled tests);
- tiny-tracker 0.1.0 at `b9265fe` (`examples/tiny-tracker-resync`; no newer head on origin, so no P-8 change), built the same way;
- spec `spec/mws.md` at `e2bb9b0` (`spec/0.9-review`).

An earlier run of the same script on the same builds (19:12 to 19:33 UTC) had every case as expected except the crashed environment, where the job was green under `none`; that led to the clean-up rule (NOTES.md, design choice 3). The run below is the first with that rule. Changed between the two runs: the rule and its unit test in `src/summary.mjs` and `test/summary.test.mjs`, the crashed case's expectation in `test/local-test.sh`, and the `show` filter there, which leaves the bystander-inventory lines out of this output.

## Output

Lines longer than 230 characters are cut here (`…`); the summaries in `<out-dir>` are whole.

```text
== unit tests (CLI_DIR set, MWS_SPEC set)
# tests 23
# pass 23
# fail 0
# skipped 0
== correct build
plan (tools/list from the server)  job status 0 (want 0)   cli exit 0 (want 0)   ok
   plan hash ce76d1cd4c55d4f5
full, fail-on must                 job status 0 (want 0)   cli exit 0 (want 0)   ok
   **Job status: not failed.** `fail-on` is `must`, and no record of a MUST is `violated`.
full, fail-on any                  job status 0 (want 0)   cli exit 0 (want 0)   ok
catalog (tools/list from the server), any job status 0 (want 0)   cli exit 0 (want 0)   ok
catalog (saved catalog, no server), any job status 0 (want 0)   cli exit 0 (want 0)   ok
plan (saved catalog, no server)    job status 0 (want 0)   cli exit 0 (want 0)   ok
   same plan hash as the live plan: yes
full, wrong plan hash, fail-on none job status 1 (want 1)   cli exit 3 (want 3)   ok
full, no confirm-target            job status 1 (want 1)   cli exit none (want none)   ok
== defect force-by-default
   plan hash ce76d1cd4c55d4f5
full, fail-on must                 job status 1 (want 1)   cli exit 1 (want 1)   ok
   **Job status: failed.** `fail-on` is `must`, and a record of a MUST is `violated`.
   - [MWS-CONC-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-2) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**, attribution: server
   - [MWS-CONC-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-1) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `barrier-pairs v1`: **violated (MUST)**, attribution: unresolved
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `held-request v1`: **violated (MUST)**, attribution: server
full, fail-on none                 job status 0 (want 0)   cli exit 1 (want 1)   ok
   **Job status: not failed.** `fail-on` is `none`, so no verdict fails this job.
   - [MWS-CONC-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-2) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**, attribution: server
   - [MWS-CONC-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-1) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `barrier-pairs v1`: **violated (MUST)**, attribution: unresolved
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `held-request v1`: **violated (MUST)**, attribution: server
full, fail-on any                  job status 1 (want 1)   cli exit 1 (want 1)   ok
   **Job status: failed.** `fail-on` is `any`, and a record is `violated`.
   - [MWS-CONC-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-2) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**, attribution: server
   - [MWS-CONC-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-1) on `ticket-replace:replace_ticket`, scenario `stale-write v3`: **violated (MUST)**
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `barrier-pairs v1`: **violated (MUST)**, attribution: unresolved
   - [MWS-CONC-3](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-conc-3) on `ticket-replace:replace_ticket`, scenario `held-request v1`: **violated (MUST)**, attribution: server
== defect no-idempotency-key
   plan hash 4b3ae351dc81496f
full, fail-on must                 job status 0 (want 0)   cli exit 0 (want 0)   ok
   **Job status: not failed.** `fail-on` is `must`, and no record of a MUST is `violated`.
   - [MWS-RETRY-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-retry-1) on `ticket:add_comment`, scenario `creates v1`: **violated (SHOULD)**
full, fail-on any                  job status 1 (want 1)   cli exit 0 (want 0)   ok
   **Job status: failed.** `fail-on` is `any`, and a record is `violated`.
   - [MWS-RETRY-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-retry-1) on `ticket:add_comment`, scenario `creates v1`: **violated (SHOULD)**
== defect empty-filter-deletes-all
   plan hash ce76d1cd4c55d4f5
full, fail-on none                 job status 0 (want 0)   cli exit 1 (want 1)   ok
   **Job status: not failed.** `fail-on` is `none`, so no verdict fails this job.
   - [MWS-TGT-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-tgt-2) on `ticket:delete_tickets`, scenario `targeting v1`: **violated (MUST)**
full, fail-on must                 job status 1 (want 1)   cli exit 1 (want 1)   ok
   **Job status: failed.** `fail-on` is `must`, and a record of a MUST is `violated`.
   - [MWS-TGT-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-tgt-2) on `ticket:delete_tickets`, scenario `targeting v1`: **violated (MUST)**
== defect missing-annotations, catalog mode
catalog, fail-on must              job status 0 (want 0)   cli exit 0 (want 0)   ok
   **Job status: not failed.** `fail-on` is `must`, and no record of a MUST is `violated`.
   - [MWS-ANN-4](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-ann-4) on `(catalog):remove_label`, scenario `catalog v1`: **violated (SHOULD)**
catalog, fail-on any               job status 1 (want 1)   cli exit 0 (want 0)   ok
   **Job status: failed.** `fail-on` is `any`, and a record is `violated`.
   - [MWS-ANN-4](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-ann-4) on `(catalog):remove_label`, scenario `catalog v1`: **violated (SHOULD)**
== a run that lost objects it did not create (the CLI's regression server, case S1)
plan                               job status 0 (want 0)   cli exit 0 (want 0)   ok
full, fail-on none                 job status 1 (want 1)   cli exit 1 (want 1)   ok
   **Job status: failed.** Objects the tester did not create were changed or deleted during the run. A lost bystander fails the job whatever `fail-on` says.
   ### Objects the tester did not create were changed or deleted
   - `MWS-TGT-2` on `ticket:tickets_delete` (violated): `"inbox"/"B1"`, `"inbox"/"B2"`
   - [MWS-TGT-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-tgt-2) on `ticket:tickets_delete`, scenario `targeting v1`: **violated (MUST)**
   - [MWS-RETRY-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-retry-1) on `ticket:ticket_create`, scenario `creates v1`: **violated (SHOULD)**
   ground truth from the fixture's backend: {"seeded":["B1","B2"],"left":[]}
== a run that stopped before it finished (write budget 40)
full, fail-on none                 job status 1 (want 1)   cli exit 4 (want 4)   ok
   **Job status: failed.** mcp-writecheck exited with status 4 (stopped or failed). A run that did not complete fails the job whatever `fail-on` says. The run stopped before it finished (stopped: MWS-RETRY-2 simultaneous pair 14 …
== a cancelled run (SIGTERM to the action's script after 20 s)
full, fail-on none                 job status 1 (want 1)   cli exit 130 (want 130)   ok
   **Job status: failed.** mcp-writecheck exited with status 130 (interrupted). A run that did not complete fails the job whatever `fail-on` says. The run stopped before it finished (interrupted by SIGTERM). The records below are…
   state folder in the results folder: yes (64fdbe6e2d throttle )
== a crashed test environment (the backend killed 20 s into the run)
full, fail-on none                 job status 1 (want 1)   cli exit 0 (want 0)   ok
   **Job status: failed.** The clean-up did not finish (3 cleanup calls failed in a row; the rest is left in the ledger): objects of this run may still be in the test environment, and the next run against it is refused until `mcp…
   ### Needs attention
   - Objects of this run were left behind in the test environment: ticket `"T-983"` (could not read the object to verify it is this run's (The tracker backend answered 502 (gate: the backend could not be reached (connect ECONNREF…
   - Clean-up could not delete: ticket `"T-983"` (could not read the object to verify it is this run's (The tracker backend answered 502 (gate: the backend could not be reached (connect ECONNREFUSED 127.0.0.1:4610)). It is n…); n…
   - Clean-up stopped: 3 cleanup calls failed in a row; the rest is left in the ledger.
   - Creates whose outcome is unknown are still open in the ledger (ticket, ticket, ticket, ticket, ticket, project, project, ticket, ticket-replace). Download the artifact and run `mcp-writecheck cleanup` with its `state` folder…
== fetch and build the CLI at the pinned commit
plan with a fetched CLI            job status 0 (want 0)   cli exit 0 (want 0)   ok
   same plan hash as the prebuilt CLI: yes

All cases as expected. Summaries, outputs and logs: <out-dir>
```

## The job summary of the run that lost a bystander

`<out-dir>/full-bystander-none.summary.md`, up to the per-requirement table (long lines cut at 600 characters):

````markdown
## mcp-writecheck: gate2-regression

Scope: server node <CLI_DIR>/dist/test/regression/server.js (catalog sha256:cc045b8459232bb2…), resources project through project\_create; ticket through ticket\_update (fields assignee, status). Results are per write path; requirements marked not tested or not applicable say why.

| | |
|---|---|
| Tester | mcp-writecheck 0.1.0-dev.0 (MWS 0.9) |
| Run | `4637090509`, 2026-11-15T19:44:53.801Z to 2026-11-15T19:45:04.953Z, complete |
| Plan hash | `d5cfed120a51aff8` |
| Manifest | sha256 `fc4d604371b5b266fee86baccc0537b1c6bd3ec865c111a50938720f932677ad` |
| Catalog | `sha256:cc045b8459232bb229a7eb3b3700a5284f05398d4e25bdf7b304ef489ee51aa7` |
| Mode, fail-on | full, none |
| CLI exit status | 1 (a violated MUST not in the baseline, or a stale baseline entry) |

**Job status: failed.** Objects the tester did not create were changed or deleted during the run. A lost bystander fails the job whatever `fail-on` says.

### Objects the tester did not create were changed or deleted

The tester lists every object it can list outside its own before and after each targeting call. These were gone, changed, or missing from every listing afterwards. Check them, and restore what was lost from your backup; each line names the record of the call around which the loss was seen. A change is not attributed to the call: other activity on the backend can change an object.

- `MWS-TGT-2` on `ticket:tickets_delete` (violated): `"inbox"/"B1"`, `"inbox"/"B2"`

### Violated records

- [MWS-TGT-2](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-tgt-2) on `ticket:tickets_delete`, scenario `targeting v1`: **violated (MUST)**. The call removed objects the tester did not create ("inbox"/"B1", "inbox"/"B2"), outside what it named. No declared selector form (omitted) without the opt-in removed anything in the tester's container (3 of 3 left each time). _omitted: success, 3 of 3 left Only the forms the declaration names were tried; empty, match-all, container path of the spec's forms were not declared. Objects the tester did not create were changed or deleted around this test's calls: gone: "inbox"/…
- [MWS-RETRY-1](https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action#mws-retry-1) on `ticket:ticket_create`, scenario `creates v1`: **violated (SHOULD)**. Two identical calls made two objects, and the declaration names no idempotency key for ticket\_create.
````

Its outputs:

```text
mode=full
plan-hash=d5cfed120a51aff8
results-path=<out-dir>/full-bystander-none.results/4637090509
cli-exit-code=1
exit-status=1
```

## Re-run after the review

After the second-agent review's fixes (NOTES.md, "Second-agent review"), the same script ran again on 15 November 2026, 20:15:27 to 20:18:22 UTC, on macOS 26.5 (arm64), Node v26.13.1, git 2.50, against the same builds (`0295ed6`, tiny-tracker `b9265fe`, spec `e2bb9b0`), with `WITH_FETCH` set to a local clone. **Every case as expected**, and 25 of 25 unit tests passed (two new: escaping of stop and clean-up reasons, and the refusal of a `cli-ref` that is not a full SHA).

The first two re-runs showed two faults of the script itself, fixed before the third:

- The cancelled and crashed cases fired at a fixed 20 s. On this machine a full run against tiny-tracker ends in about 12 s, so the signal and the backend kill came after the run had finished, and neither case was exercised (the job was green with CLI exit 0). Both now fire once the run has written 100 ledger entries. With that, the cancelled run exited 130 after "SIGTERM: stopping; cleaning up this run's objects before exit", with its ledger in `state/`, and the crashed run failed the job on the unfinished clean-up (CLI exit 0, as before).
- Node 23 and later print the unit tests in the spec format when the output is a file; the script's filter reads TAP. It now asks for TAP.

The backend token of the run appears in no log, summary or results file of the output folder.

## Every set-up failed (Action finding A4, 15 November)

`test/local-test.sh` has two more cases, run from a copy of tiny-tracker's manifest: every resource's `create.id` names a field the create result does not have, and only `ticket-replace`'s does.

| Case | CLI `0295ed6` (pinned) | CLI `e613620` (candidate) |
|---|---|---|
| every set-up fails, `fail-on: none` | CLI exit 0, `complete`; **job fails** (new rule) | CLI exit 4, `stopped`; job fails (run did not complete) |
| one of two set-ups fails, `fail-on: none` | CLI exit 0; job passes; the failed set-up is under "Needs attention" | the same |

Runs: the selftest on the branch (pinned CLI, unit tests with `CLI_DIR` and `MWS_SPEC`, both cases ok): https://github.com/isokron-ai/mcp-writecheck-action/actions/runs/43774351584. The same script on a Mac (Node 26) against both CLIs: every case as expected, except the crashed-environment case under `e613620`, where the CLI now exits 4 (its fix of CLI problem 14) instead of the 0 the script expects at the pin. `test/setup.test.mjs` replays recorded runs of both CLIs (five manifests each) without a CLI.

The traps job on a `cli-ref` dispatch needs the plan hashes of that CLI. For `e613620` against tiny-tracker `b9265fe` they are `crash=2d043bbaf9cf8f22` (the same manifest as `clean`) and `setup=ab0e2f57711a06b4`. Both plans were read in full in the review of 15 November (made again locally; same hashes as in the dispatch run). Each differs from the plan accepted for the pinned CLI (`1cd00c43789a075f`, `df91a667f2a42138`) only by what the CLI changed: stale-write v4 (the stale test on one connection and one credential), larger schema-probe budgets (252 and 52 writes instead of 150 and 30), and one more `not tested` line (MWS-CONC-2 for `delete_ticket` on `ticket-replace`, whose delete carries no version). At most 1601 writes in all, the only host is `127.0.0.1:4610`, and the two plans differ from each other only in the manifest hash.

## What has not been tested

The list below is from the local test. Since then the action has run on GitHub-hosted runners, nightly, in modes `plan`, `catalog` and `full` (`selftest.yml`, the `dogfood-*.yml` workflows; the runs are in this repository's Actions tab), which covers the first, second and fifth items and the example's `uses:` form. No observation is recorded for the others: how the runner renders the summary, workflow commands on a runner, cancellation of a composite step, macOS and Windows runners, and a catalog near the summary's size limit.

- **`action.yml` on a GitHub runner.** Its YAML parses and a unit test checks that every input is passed to the script and that no input is interpolated into a command. Whether the runner accepts the file, and whether the three steps behave as written, is untested.
- **The artifact upload.** `actions/upload-artifact` is pinned to the commit of v7.0.2 and its inputs were read from that commit's `action.yml`. It has not been called. Untested with it: `if: always()` inside a composite action, the upload after a failed or cancelled run, and what the upload does when the folder is missing.
- **The rendered job summary.** The Markdown was read as text. How GitHub renders the tables, the `<details>` block and the `<br>` separators, and the size limit of a step summary, were not observed.
- **Workflow commands.** The `::error::` and `::warning::` lines, and the `::stop-commands::` bracket around the CLI's output, were printed in one case (`GITHUB_ACTIONS=true`) and read. A runner has not interpreted them.
- **Fetching the CLI from GitHub.** The local test ran the fetch-and-build path against a local clone. On runners it has since run over HTTPS from the public repository, with no token, in every dogfood and selftest run; a fetch on a runner's git version other than the current ubuntu-latest one has not been observed.
- **Environment variables.** The test set the server's variables in the script's own environment. That variables set on the job or on the `uses:` step reach a composite action's steps the same way is expected and unverified.
- **The example workflow** (`examples/mcp-writecheck.yml`). It parses as YAML. It was not run. Since the review it passes `actionlint` (1.7, macOS) with no finding.
- **Cancellation on a runner.** Locally the script passed SIGTERM on and the state folder was kept. Whether a runner sends SIGTERM or SIGKILL to a cancelled composite step, and whether the upload step inside the composite action still runs, are untested (`RUNNER-TEST.md`, job `cancelled`).
- **A changed canary, an unrestored fixture, and `safety.setup_unresolved`.** Covered by unit tests on made-up results only (the last in the shape of the CLI's series A). A stopped run, leftovers, an unfinished clean-up and a lost bystander were produced for real (above).
- **Servers other than tiny-tracker, locally.** The local test used tiny-tracker only. The dogfood workflows have since run the action against other servers IsoKron builds, with their backends started inside the job. Not observed: a server reached by a URL that someone else started, a hosted backend, and a catalog large enough to approach the summary's size limit.
- **The spec links.** `https://isokron.ai/mws` answered 404 on the day of the test, so no link in a summary was followed. It answered HTTP 200 on 19 November 2026; the anchors have not been followed.
- **Other platforms.** macOS and Windows runners, and Node versions other than 22.23.
- **A bystander loss from a published server.** The case above uses the CLI's own regression server; tiny-tracker has no defect that loses a bystander (NOTES.md, CLI problem 13).

## Re-run at the settled CLI head `f573a24` (15 November 2026)

`test/local-test.sh` ran on macOS 26.5 (arm64), Node v26.13.1, against `mcp-writecheck` `f573a24`, tiny-tracker `2075524` and spec `ae5d7d7`, each built from `git archive` of its commit. Every case was as expected, and the unit tests passed (36, one skipped: no skills folder). Two expectations changed with the pin:

- The crashed test environment: the CLI now stops the run with exit 4. Under `0295ed6` it was `complete` with exit 0 (NOTES.md, CLI problem 14). The job fails either way.
- Every set-up fails: exit 4 only. Under `0295ed6` it was 0 (problem 16).

`0295ed6` is no longer a supported `cli-ref` for the dogfood workflows. Their manifests use keys it refuses.

## Checking that a test fails when its guard is removed (mutation probes)

Do not clone the repository to check this by hand: run the `mutation-probe` workflow (Actions, or
`gh workflow run mutation-probe.yml -R isokron-ai/mcp-writecheck-action -f ref=<branch-or-sha> -f test='node --test test/<file>.test.mjs' -f mutations='[...]'`).
It calls isokron-ai/tool-qa's reusable workflow. Each mutation is `{"id", "file", "find", "replace"}`
(and optionally its own `test` and `pattern`): `find` must be exact text that occurs exactly once in `file`, for example
a guard in `loop/` or `src/`. Every mutation runs in a fresh checkout of `ref`: the test must pass first, then it
runs again with the edit applied. The job summary lists each mutation as `killed` (the test failed, as it must),
`survived` or `stale` (`find` is not there exactly once), and the `mutation-probe-results` artifact holds the same as
JSON. The run fails if any mutation survived or is stale. At most 20 mutations per run; read-only, no secrets.

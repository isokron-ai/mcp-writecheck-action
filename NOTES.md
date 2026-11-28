# Integrations: notes for review

> **History note (16 November 2026).** The action is now pinned to commit `3af41c6` of the public `isokron-ai/mcp-write-safety` (MWS 0.9, `mcp-writecheck` 0.1.0), which needs no token. Commit SHAs below from before that date (`17851d7`, `0295ed6`, `f573a24`, `15f71e5` and the others) refer to the private pre-publication history of the spec and the CLI and do not resolve publicly; `MWS_CLI_TOKEN` and `cli-token` are no longer needed.

Draft of 14 November 2026, re-targeted on 15 November 2026 and moved to the settled CLI head `f573a24` the same evening (section "CLI problems: status at `f573a24`").

Written against `mcp-writecheck` at commit `0295ed6` (branch `cli/resync-516`, PR #6) and the spec at commit `e2bb9b0` (`spec/mws.md` on `spec/0.9-review`, MWS 0.9, 37 requirements: 26 MUST, 11 SHOULD). Tested with tiny-tracker at `b9265fe` (branch `examples/tiny-tracker-resync`, PR #7). The 14 November draft was written against CLI `e94270a` and spec `516c4ed`.

## What is here

| Path | What |
|---|---|
| `action.yml` | Composite action: obtain the CLI (the only step that gets `cli-token`), run the script, upload the results folder, set the job status. |
| `contract.mjs` | The one file that holds everything expected to change: the CLI's source and pinned commit, its commands, flags, exit statuses, output lines, file names and the results fields the action reads, the requirement registry, the spec URL and the anchor rule. |
| `src/` | `main.mjs` (inputs, running the CLI, outputs), `install.mjs` (fetch and build), `summary.mjs` (the job-status rule, the safety facts and the summary text; pure functions). No dependencies. |
| `test/` | Unit tests (25, in `contract.test.mjs`, `summary.test.mjs`, `install.test.mjs`); `local-test.sh`, the run against tiny-tracker; `bystander-fixture.mjs`, a test environment in which a run loses objects it did not create (from the CLI's own regression suite). |
| `examples/mcp-writecheck.yml` | Example workflow: `plan` and `catalog` on pull requests, `full` on main. |
| `README.md`, `TESTING.md`, `RUNNER-TEST.md` | Use; the local test and what has no recorded observation; the historical plan for the first run on a runner (the action now runs on GitHub-hosted runners, see README, Tests). |
| `skills/mcp-write-safe-builder/SKILL.md` | The 37 requirements as build rules, and how to add the check to CI. Unchanged since 14 November apart from two fact fixes in its CI section (review, below). |
| `skills/mcp-write-safe-caller/SKILL.md` | Rules for an agent that calls write tools. The 14 November draft plus the two P-7 lines (owner-approved, 15 November), and the key-scoped `not_applied` line (owner decision, 28 November; MWS DECISIONS R16-1). |
| `LICENSE`, `NOTICE` | Apache-2.0 for `integrations/` (the licence text, and the notice: Stormhaven Enterprises LLC (IsoKron) and Joshua Bryan), and the CC BY 4.0 attribution of the spec the skills restate. |

## Decided since 14 November (owner, 15 November)

- **npm name:** `@mcp-write-safety/writecheck` (bin `mcp-writecheck`) and `@mcp-write-safety/tiny-tracker`. Not published; the npm organization is still to be created.
- **Where the action lives:** its own public repository, so that it can be listed on the Marketplace (`action.yml` at the root). The proposed name and layout are in the delivery's INDEX.md. Until it exists, this folder (committed first to an `integrations/action` branch of `mcp-write-safety`) is the source, and its README shows `uses:` for this location.
- **Licence of `integrations/`:** Apache-2.0, the action and the skills.
- **Visibility:** public.

## Design choices

### The action

Every rule of the 14 November draft is kept. Changes are marked.

1. **The default mode writes nothing.** `mode` defaults to `plan`. A workflow has to say `full` to make writes. *New:* a third mode, `catalog`, runs the CLI's new `catalog` command: verdicts from `tools/list` alone (MWS-ANN-4), no tool call, no write. It is never the default.
2. **No automatic confirmation.** The CLI has no `--yes`: a run needs the target string and the plan hash typed back. The action requires both as inputs in mode `full` and never feeds `run` a hash from a plan it has just built. A changed catalog, manifest or host therefore stops the full job until a person reads the new plan and updates the workflow. This is deliberate friction and it is the CLI's own design; an "auto" value for `plan-hash` would be a `--yes` under another name.
3. **The job status is decided by the action, from `results.json`.** The CLI exits 1 only for a violated MUST, so `fail-on: any` cannot come from the exit status. The rule is in `decide()` in `src/summary.mjs`:
   - *new:* a run that lost an object the tester did not create (any record with a non-empty `numbers.bystanders_lost`) fails the job whatever `fail-on` says, and so does setup the run left on the platform (`safety.setup_unresolved`, which the CLI's series A adds; read where present). Both hold whether or not the run completed, and both are given as reasons beside a violated record, not instead of it;
   - *new, not in the brief:* a clean-up that did not finish (`cleanup.failed` or `cleanup.unknown` non-empty, or `cleanup.stopped` set) fails the job whatever `fail-on` says. Reason: the local test killed tiny-tracker's backend 20 s into a run, and the CLI reported the run `complete` with exit status 0 (CLI problem 14); without this rule the job was green under every `fail-on`. With an open ledger the next run is refused anyway (exit 3), so the failure only comes one run earlier and says why. Objects left on purpose (`cleanup: leave`, `ephemeral`) do not fail the job;
   - a run that did not complete (CLI exit other than 0 or 1, no readable results, or `run.status` other than `complete`) fails the job whatever `fail-on` says;
   - *new (Action finding A4, 15 November):* a complete run in which the set-up of every object under test failed fails the job whatever `fail-on` says. The resources whose set-up the run attempts are those with set-up steps in the run's `plan.json` (`plan.resources[].setup`, non-empty only for a resource with an update tool and fields); a failed one has records whose reason starts `setup failed: ` (contract.mjs, `SETUP`). Reason: with `create.id` naming a missing field (dogfood trap setup-fails) the CLI at `0295ed6` reports the run `complete` with exit 0 and no violated record, so the job was green under every `fail-on`. The CLI's candidate (`e613620`, branch `cli/held-candidate`) stops such a run itself (exit 4) under the same condition; the action's rule then never fires, because the run is not complete. Without the run's `plan.json` (or with one of another hash) the rule does not fire: no false failure. Where only some set-ups failed, the summary lists them under "Needs attention" and `fail-on` decides;
   - otherwise only `violated` records count: none for `none`, those of a MUST for `must`, all for `any`;
   - under `must` and `any` the action is never more lenient than the CLI: exit status 1 fails the job even if the action found no such record.
   Leftovers alone, a changed canary and a fixture not restored are shown and annotated as warnings and do not fail the job by themselves.
4. **A requirement is a MUST if the spec or the CLI's record says so.** Kept as a guard. At `0295ed6` the CLI's registry equals Annex C (37 IDs, same levels, same order), so the rule changes nothing today; `test/contract.test.mjs` now asserts that there is no difference.
5. **The summary follows the tester rules of the spec** that apply to any report: one row per requirement and write path, no total, percentage, count of verdicts or grade (section 5.2); a verdict printed with its level (8.2, rule 12); `violated` records printed with their full reason and notes. *Changed:* a `violated` or `platform` record is now printed with its `attribution` (server, platform or unresolved), which the CLI writes as a field since the re-sync (8.2, rule 3). *New:* the safety facts come before the verdicts, in the order report.md uses: objects the tester did not create that were lost, setup not released, then "Needs attention" (leftovers, clean-up that failed or is unknown, canaries, fixtures, set-ups that failed). What the bystander inventory covered is in a fold.
6. **All 37 requirements get a row.** At `0295ed6` the CLI writes a record for every requirement (`not tested` with the reason where no check reached it), so "no record in this run" now appears only for a run that stopped.
7. **Text from the results is treated as untrusted.** Reasons, notes and bystander names can quote strings the server under test produced. They are escaped for Markdown, write paths and names are put in code spans that cannot be closed from inside, the plan is fenced with a fence longer than any run of backticks in it, and the CLI's console output is bracketed with `::stop-commands::` so that it cannot issue workflow commands.
8. **No input is interpolated into a shell command.** Inputs reach the script as environment variables. *Review:* the contract test now also scans `run: |` blocks.
9. **The state folder is inside the results folder**, so the ledger of an interrupted run is in the artifact and `mcp-writecheck cleanup` can use it. The upload step runs `always()`, also after a crash or a cancellation. (Now tested locally: a cancelled run leaves `state/<run id>/` in the results folder.) *Review:* it uploads the folder and name the script resolved (trimmed, defaulted), which the script writes as outputs before anything else, and falls back to the raw inputs when the script never ran.
10. **No sales text, no badge, no telemetry, no upsell on failure.** The action contacts the git host of the CLI, the npm registry (for the CLI's build dependencies, with audit, funding and the update check off) and the artifact service. Third-party actions are pinned by commit SHA. *Since A7(1):* a `violated` record names the helpers of the open-source MWS kits (Apache-2.0, `isokron-ai/mcp-write-safety-kits`) that address its requirement, with a link to each kit's README table, and says that using one does not settle the record. The names and links are fixed in `contract.mjs` (`KIT_HELPERS`, `KITS`), never taken from results; a requirement no helper covers gets no line. The summary makes no network call for them.
11. **Node is required, not installed.** The action checks for Node 22 and says what to add.
12. **No baseline, no signing.** The action does not pass the CLI's `--baseline`, `--sign` or `--sign-key`, and does not run `compare` or `verify-results` (the pinned CLI has the first two; the signing key and compare arrived after the pin).
13. *New:* **The results folder is the one the CLI names.** The action reads the last `results: <folder>/report.md` line that `run` and `catalog` print (the last, so that text a server printed earlier cannot win; the same for the plan-hash lines), and falls back to a new folder holding `results.json`. `catalog` reuses `catalog-<fingerprint>/` for the same catalog, so "a new folder" alone would miss it.
14. *Review:* **The token reaches one step.** `cli-token` goes only to the "Obtain mcp-writecheck" step (`main.mjs obtain`), which masks it and the header made from it, refuses a `cli-ref` that is not a full 40-character SHA, and gives it to git only for the fetch, through `GIT_CONFIG_*` variables, with global and system git configuration and hooks off. The run step, which starts the server under test, never has it in its environment. `MCP_WRITECHECK_CLI_REPOSITORY` (the local test's clone) is ignored on a GitHub runner, and a token is sent only to an https repository.
15. *Review:* **The CLI runs in its own process group** (`detached`), so a signal to the job's process group reaches it once, through the script, and not twice (a second signal makes the CLI exit without its clean-up). The run step `exec`s node so that a signal to the step's shell reaches the script. Only the first signal is passed on: a runner cancels with SIGINT and then SIGTERM, and the CLI takes a second signal as "exit now, without clean-up" (review round 2). The runner's final kill still bounds the clean-up at about 10 s; the CLI should ignore SIGTERM after SIGINT and EPIPE on its output (CLI lane).

No design rule of the draft was made wrong by the CLI changes. Rule 4 no longer has an effect and could be dropped (owner decision 1 below).

### The skills

Unchanged, apart from the two P-7 lines in the caller skill.

1. **Builder.** One rule per requirement, in the spec's order, each with its ID, level and applicability condition. The rule restates the requirement sentence. A unit test checks that the skill has exactly the 37 IDs of the registry, in order, at the right levels; it cannot check the wording.
2. **Caller.** MWS puts no requirement on callers (section 2 puts agents out of scope). The skill says so, and presents its rules as what a careful caller does given what a server must, should and may do.
3. **Both skills tell the agent not to run a write test on its own judgment** of what is a test environment, and not to put a plan hash into a workflow that the user has not seen. Both tell it not to call a server "compliant" or "passing".
4. **Attribution.** Each skill ends with the attribution line the spec's section 16 asks for.

**The skills are behind the spec and the CLI.** They name spec commit `516c4ed`. Between `516c4ed` and `e2bb9b0` the IDs and levels are unchanged, but the requirement sentences of MWS-RES-2 (R9-1, unknown outcome; R10, retry exceptions), MWS-RETRY-2 (R8-1, R8-3) and MWS-ANN-4 (R10: `destructiveHint` on every tool not declared read-only) changed, and so did the applicability of MWS-TGT-3. The builder skill's CI section also says the CLI checks 29 of the 37 IDs and names the eight it lacks (now wrong: all 37 have records), and points to the action in `integrations/github-action` of the MWS repository (now: its own repository). Neither is a CLI command or flag, so this series leaves them; the commands and flags the builder skill quotes (`init --out --env --`, `plan -m`) are still right. Re-deriving the four rules and correcting the two CI sentences is a separate change for whoever owns the skills; `test/contract.test.mjs` pins the skills' spec commit as `SKILLS_SPEC_COMMIT` until then.

## What still depends on undecided things

| Undecided | Where it shows | What to change when it is decided |
|---|---|---|
| Moving the CLI's source from git to npm | `contract.mjs` (`CLI_SOURCE`); `src/install.mjs` implements only the git source; the `cli-token` input (kept, optional, unused). `@mcp-write-safety/writecheck` is published to npm; the action still fetches the pinned commit and builds it. | Replace `CLI_SOURCE` with the npm form, add the install branch, test it, and remove `cli-token`. `cli-ref` then becomes a version, which is a change of the input's meaning. |
| Visibility of `mcp-write-safety` | Decided: the repository is public (16 November 2026); the fetch needs no token and `cli-token` is optional and unused. | Remove `cli-token` in a later version. |
| The public spec page | `spec-url` default `https://isokron.ai/mws?utm_source=writecheck-action&utm_medium=action`; `requirementUrl()` in `contract.mjs` assumes the anchor is the ID in lower case. The page answered HTTP 200 on 19 November 2026; the anchors were not re-checked. | Check one link per area on the live page. |
| The standalone repository | `isokron-ai/mcp-writecheck-action` exists and is public; `action.yml` has `branding`. Releases are tagged `v0.x`; the examples pin a full commit SHA. | Keep the example's SHA in step with the release. |
| The CLI after series A and the R9-1/R10 set | `safety.setup_unresolved` is read where present; the R10 changes (ANN-4 on every non-read-only tool, the TGT-2 operator declaration, the RES-2 retry exceptions) are in the spec but not in `0295ed6`. | Move `CLI_DEFAULT_REF`; re-run the tests with `CLI_DIR` and `MWS_SPEC`; check `results.json` for new fields. |

## CLI problems: status at `f573a24`

Later on 16 November 2026 it moved to `3a68072` (the candidate after the fixes of SH-6 to SH-8 and BL-5, R15-3 `applied_all`; spec `163858d`; tiny-tracker `9e7c1ba`, branch `examples/tiny-tracker-r15`): problem 18 below is fixed there, and the Payload posts are deleted through the MCP tool again. Before that, on 16 November 2026, the pin moved to `59e3124` (branch `cli/held-candidate`, the launch candidate: `f573a24` plus the result-shape support, write-result/0.1 and rule 11 point 13 for the shape readers, and the fixes of the Action CI items SH-1 to SH-5; spec `415318f`; tiny-tracker `77c2b17`, whose manifest adopts write-result/0.1). The pin moved on 15 November 2026 to `f573a24`, the CLI's settled head for MWS 0.9 (branches `cli/held-candidate` and `cli/resync-516`, PR #6; spec `ae5d7d7`; tiny-tracker `2075524`, PR #7). Changes to the list below:

- **14** (a test environment that fails during the run): *fixed*. The run is `stopped` with exit 4. The dogfood trap backend-crash and `test/local-test.sh` now require it. The clean-up rule of design choice 3 stays as a guard.
- **15** (unredacted server text in the ledger): *fixed* (the CLI redacts the ledger's free-text fields).
- **16** (every set-up failed, `complete` with exit 0): *fixed*. The run is `stopped` with exit 4; the dogfood trap setup-fails and `test/local-test.sh` require it. The action's rule (design choice 3, A4) no longer fires at the pin and stays as a guard.
- The usage text of exit 4 now names its two causes and says that 4 outranks 1; `CLI.exit[4]` quotes it and the contract test checks it.
- Manifests: the migration in the CLI's CHANGELOG applies to every manifest written for `0295ed6` (declared patterns where a verdict turns on wording, under strict rule 11; `key.class` for a create tool that does not call itself a create, or calls itself an upsert). `0295ed6` refuses those keys, so the dogfood manifests here load only with the new CLI; a `cli-ref` dispatch with `0295ed6` is no longer supported.
- 17. *New:* **The loader refuses every multi-item call whose arguments bind the tester's objects other than as a bare `{{ids}}`** (read: the CLI's manifest loader and its multi-item gate accept only a bare `{{ids}}` or `{{?ids}}`). `{{ids[0]}}`, `{{ids[1]}}`, … (one item per object) and `{{json:ids}}` inside a string (a `where` filter) bind exactly the tester's objects and render correctly, but the manifest does not load ("must bind the objects the call acts on"). Four dogfood manifests used these forms (kronicle-lite `apply`, Kubernetes multi-document apply, Payload `updateTasks`, writesafe `ws_batch`). *Fixed in `59e3124`* (the binding is read from the template's parsed roots), and the multi blocks are back.

- 18. *Fixed in `3a68072` (SH-6 to SH-8); seen at `59e3124`:* **MWS-IN-4's counterpart control (R14-6) is sent as a real write on the object under test, and a boolean counterpart can change that object's state for the rest of the run** (ran: Payload and Grafana dogfood). The counterpart of a `"true"` probe is `true`: Payload `updatePosts` with `draft: true` leaves a draft newer than the published post, and `updateTasks` with `archived: true` archives the task, which a collection hook then keeps from every update; Grafana `alerting_rules_write` with `disable_provenance` changes the rule's provenance, after which every update answers 409. Every later base control then fails, so MWS-IN-1, IN-3, IN-4 and IN-6 on those tools become `not tested` (their reason still quotes the R10-3 sentence, "neither names the argument", although the quoted error names it), later checks fail ("the first call did not succeed"), and MWS-RES-4 leaves no record. Real findings are lost: Payload's MWS-ANN-3 on `post-items:updatePosts` (PR-1) and Grafana's MWS-IN-3 on `alerting_rules_write` (GR-2). The Payload posts could not be deleted at clean-up (the research build's guarded delete compares the session's read, of the published post, with the newest draft), so the dogfood manifest cleaned posts up through the control arm until `3a68072`. At `3a68072` a counterpart that would change the object is not sent, and the probe is not judged: IN-1, IN-4 and IN-6 on most update tools are `not tested` rather than `held` (a coverage follow-up with the CLI).

- 19. *R15-4, the `restorable` key (`cli/coverage-fields`, pinned at `17851d7`):* an MWS-IN-4 counterpart that writes the object is sent only for an argument the resource lists under `restorable`, and the object is put back and read back after it. tiny-tracker's IN-1, IN-4 and IN-6 records on its two update tools are `held` again. **Payload's and Grafana's dashboard records recover nothing, for two reasons:**
  - Their update tools also take request options whose counterparts cannot be put back through the tool, and so must not be listed: Payload `all`, `draft`, `_status`, `locale`, `fallbackLocale`, `overrideLock` and `archived`; Grafana `message`, a version-history note. A record is `held` only where every probe is judged, so one probe that is not judged keeps it `not tested`, however many of the others a `restorable` list lets through.
  - The loader refuses `restorable` where the update tool is also a delete or multi-item tool (from `17851d7`, of any resource of the manifest): Payload `task` (`updateTasks`), Grafana `alert-rule` and `alert-rule-alt` (`alerting_rules_write`), and every Kubernetes ConfigMap resource (`resources_create_or_update` is the multi-item tool of `configmap` and `configmap-norv`). At `2443620` the rule was per resource, and Kubernetes `configmap-rv` got its three records back; at `17851d7` it cannot list anything.
  - Payload `post-items` lists nothing on purpose. Its whole-object `updatePosts` gives the array rows new ids on every call (finding PR-1), so no put-back reads as before; with arguments listed, the object was retired at the first counterpart and PR-1's check did not run.

## CLI problems: status at `0295ed6`

"Ran" means observed in the local test; "read" means found in the source.

1. **Registry behind the spec.** *Fixed* (ran: `requirements`; `test/contract.test.mjs`). 37 IDs, the spec's levels, Annex C's order; `PLATFORM_LISTED` equals Annex C's `platform available` column; the README has a coverage table. Five short forms are worded differently from Annex C (MWS-IN-2, IN-7, CFG-2, CFG-4, ANN-2); the action prints Annex C's. The CLI is pinned to spec `098621b`, whose Annex C equals `e2bb9b0`'s.
2. **No attribution field.** *Fixed* (read, and seen in results): `results[].attribution`. The summary prints it.
3. **No catalog-only verdict path.** *Fixed* (ran): `mcp-writecheck catalog`, which this action exposes as mode `catalog`.
4. **The plan hash depends on the environment.** *Unchanged* (ran): the plan names every host given to the server (`Hosts reached or given to the server: 127.0.0.1:4610`). The README and the example still set the same URL in both jobs and a fixed port. `plan` still has no machine-readable output.
5. **A refused run leaves a folder behind.** *Unchanged* (read: `run` creates `<out>/<run id>/` before the confirmation). The action uses the `results:` line, then a new folder holding `results.json`.
6. **Exit status 1 does not mean the run completed.** *Unchanged* (read: `exit: interrupted ? 130 : … === 1 ? 1 : stopped ? 4 : 0`). The action checks `run.status`. In the series-A CLI, unreleased setup exits 4 and outranks 1.
7. **Exit status 1 is the only verdict signal.** *Unchanged*; the action reads `results.json`.
8. **The baseline outcome is not in the results.** *Unchanged* (read).
9. **`plan` and `catalog` without a saved catalog need a server that starts.** *Unchanged* (ran: tiny-tracker without `TRACKER_BACKEND_URL` exits 2, and the CLI exits 4).
10. **The CLI branch does not contain tiny-tracker.** *Unchanged*: tiny-tracker is on `examples/tiny-tracker-resync`; the CLI branch has only its manifest. The local test takes the server from `TINY_TRACKER_DIR`.
11. **Small things.** The schema's `$id` is still a placeholder (`https://mws.invalid/…`); redaction still skips credential values shorter than six characters; `tenant guard matched: …` is still printed without the redactor (read).
12. *New:* **`catalog` reuses its folder.** `catalog` writes `<out>/catalog-<fingerprint>/` and overwrites it for the same catalog (read). Harmless in CI; it is why design rule 13 exists.
13. *New:* **A bystander loss cannot be produced with tiny-tracker.** Its selector tool stays in the project it is given, and the CLI's loader refuses a selector not bound to the tester's own container (ran: `selector.args: must bind the container with {{scope}}`). The local test uses the server of the CLI's regression case S1 instead (`test/bystander-fixture.mjs`), which needs the CLI's compiled tests. A tiny-tracker defect that loses a bystander would make this case reproducible from the published packages.
14. *New:* **A test environment that fails during the run gives a `complete` run and exit status 0** (ran: tiny-tracker's backend killed 20 s into a run). Every later check is `not tested` (166 records, mostly "setup failed: could not create the object under test … 502"), the clean-up stops after three failures (`cleanup.stopped`: "3 cleanup calls failed in a row; the rest is left in the ledger") with 61 failed deletes and 9 unknown creates, and `run.status` is `complete`. A run whose backend is unreachable should be `stopped` with exit 4. The action fails the job on the unfinished clean-up instead (design choice 3).
15. *Review:* **The ledger holds unredacted server error text** (read: `objects.ts` writes `short(r.text, 200)` of a failed create or delete into the ledger; `run.ts` copies the ledger to `<run>/ledger.jsonl`). The action uploads both `state/` and the run folder, so a server that echoes a credential in an error puts it into an artifact that every reader of the repository can download. Fix in the CLI: pass ledger reasons through the redactor. The README's artifact section says so until then.
16. *New (Action finding A4):* **A run in which every set-up failed is `complete` with exit 0** (ran, locally and in the dogfood trap setup-fails): every resource's `create.id` names a field the create result does not have. The candidate `e613620` stops such a run (`stopped`, exit 4, "the set-up of every resource with an object under test failed (…)"); a run where only some set-ups failed stays `complete` with exit 0 there too. The action fails the job itself (design choice 3).

## Second-agent review, 15 November (landing on `integrations/action`)

A read-only review of the series on safety and correctness. No finding on: a green job for a run the CLI reported incomplete, stopped or with a lost bystander (every path traced); `confirm-target` and the plan-hash gate; shell injection from inputs. Findings and what was done:

| Finding | Done |
|---|---|
| S1. `run.stopped_reason`, `cleanup.stopped` and a JSON parse error reached the job status line unescaped (a server could add an image, a link or a fake status line) | Escaped in `decide()` and `readResults()`; annotations get the plain text. Unit test added. |
| S2. A signal to the job's process group reached the CLI twice, and a second signal skips its clean-up | `detached` child; `exec node` in action.yml. Design rule 15. |
| S3. `cli-ref` accepted a branch or tag with a warning | Refused unless 40 lower-case hex characters; the fetched commit is always checked. Unit test added. |
| S4. `MCP_WRITECHECK_CLI_REPOSITORY` could redirect the fetch, and the token, in production | Ignored when `GITHUB_ACTIONS` is `true`; a token goes only to an https repository. |
| S5. The token was in the run step's environment (readable from `/proc` by the server under test), unmasked, and given to every git command with the job's global configuration | Own obtain step; masked (token, header, base64); fetch-only, with global and system configuration and hooks off. README input table states the least scope. RUNNER-TEST's `cancelled` job no longer puts the token in git's argv. Design rule 14. |
| S6. The ledger in the artifact can hold unredacted server error text | CLI problem 15; README artifact section. Not fixable in the action without dropping the ledger. |
| S7. The upload used the raw `results-dir`, the script the trimmed one | Upload uses the resolved outputs. |
| S8. README warned against `pull_request_target` for mode `full` only; fork pull requests fail red while the CLI is private | Warning covers every mode; the example's plan job skips fork pull requests until the CLI is published. |
| S9. The skills' restatements of MWS-RES-2, MWS-RETRY-2, MWS-ANN-4 and the applicability of MWS-TGT-3 are wrong at `e2bb9b0`, not only stale, so moving the cited commit would not be a pure fact fix | Not changed: the skills still cite `516c4ed`, which their text matches. The builder skill's CI section got the two pure fact fixes (all 37 IDs have a check and a record at `0295ed6`, verified; the action's repository). Re-deriving the four rules stays with the skills' owner, before launch. |
| Nits | The levels comment in `summary.mjs`; the last match of the CLI's output lines; RUNNER-TEST's `steps.run.outcome` moved to `env`. |

The local test was re-run after the fixes (TESTING.md, "Re-run after the review"). It showed two faults of `test/local-test.sh`, not of the action: the cancelled and crashed cases fired a fixed 20 s into a run, and on a fast machine a run ends in about 12 s, so neither case was exercised (both now fire once the run has written 100 ledger entries); and Node 23 and later print the unit tests in the spec format, which the script's TAP filter did not read (it now asks for TAP). `actionlint` 1.7.12 finds nothing in the example workflow.

Round 2 (the same reviewer, on the fixes and on the public repository's two workflows): no blocker; every finding above fixed with no new problem. One remaining issue: SIGINT followed by SIGTERM still cut the CLI's clean-up short, because both were passed on; the script now passes on only the first. A detached CLI does not outlive a killed script for long (it dies on EPIPE at its next write). For the public repository's `selftest.yml`: tiny-tracker `b9265fe` and spec `e2bb9b0` are reachable only on `examples/tiny-tracker-resync` and `spec/0.9-review`; move the pinned refs when those branches are merged and deleted.

Also from the review, for the runner test: the runner's cancel sequence (SIGINT, then SIGTERM, then a kill) can be shorter than the CLI's clean-up grace. RUNNER-TEST's `cancelled` row now asks for that to be recorded.

## Decisions for the owner

1. **The MUST rule (design choice 4).** It has no effect at `0295ed6`. Keep it as a guard, or drop it and take the record's level alone.
2. **Whether to expose a baseline.** Teams with known violations cannot adopt `fail-on: must` without one. It needs the CLI to write the baseline outcome to a file (problem 8).
3. **The clean-up rule (design choice 3).** This series fails the job when the clean-up did not finish, whatever `fail-on` says; the brief asked only for a lost bystander. Keep it, or fix the CLI so that a run whose test environment failed is `stopped` (problem 14) and drop the rule. Keeping both does no harm.
4. **Whether the caller skill is published under the MWS name**, given that the spec scopes callers out. The skill is explicit that its rules are not MWS requirements.
5. **Artifact retention.** The capture can hold data from the test environment. The draft uses the repository's default retention.
6. **Marketplace metadata:** `branding` (icon and colour) and the listing name; `name: mcp-writecheck` may collide with another listing.

## Before any release

- [ ] Run the action on a GitHub runner: `RUNNER-TEST.md`.
- [ ] Re-derive the four changed rules of the builder skill (and the caller skill's MWS-RETRY-2 line) against the published spec; move `SKILLS_SPEC_COMMIT`. The two CI sentences were fixed in review.
- [ ] Run `node --test test/*.test.mjs` with `CLI_DIR` and `MWS_SPEC` pointing at the release candidates of both.
- [ ] Have a second reader check every rule of both skills against the requirement sentence of the published spec. The tests check IDs and levels only.
- [ ] Try both skills with an agent on a real task.
- [ ] Publish the spec page and follow one requirement link per area from a real summary.
- [ ] Publish the CLI to npm; switch `CLI_SOURCE`; retest the install path; remove `cli-token`.
- [ ] Replace the placeholder commit SHA in `examples/mcp-writecheck.yml` and in the README snippets with the release commit.
- [ ] Re-check the pinned commits of `actions/upload-artifact` (v7.0.2), `actions/checkout` (v7.0.1) and `actions/setup-node` (v7.1.0); they were read from the tag lists on 14 November 2026.
- [ ] Look at a real artifact from a server other than tiny-tracker for data that should not be there.

## Not done

- An install path for an npm package (there is no package to test it against).
- `--baseline`, `--sign`, `--review`, `rerun`, `cleanup` and `recheck` as action features.
- Annotations on pull-request lines, a pull-request comment, SARIF. `junit.xml` is in the artifact for teams that want a test reporter.

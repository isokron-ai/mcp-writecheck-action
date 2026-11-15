/**
 * The one place for everything in this action that is expected to change before release:
 *
 *   1. where the mcp-writecheck CLI comes from and which commit is pinned;
 *   2. the CLI's commands, flags, exit statuses, output files, the lines of its output that the
 *      action reads, and the fields of results.json that carry the safety facts;
 *   3. the MWS requirement registry (IDs, levels, short forms) and the commit of the spec it
 *      was copied from;
 *   4. the public spec page and how a requirement ID becomes an anchor on it.
 *
 * The other files import from here and hold no CLI flag, no file name of the CLI's, no
 * requirement ID and no URL of their own. `test/contract.test.mjs` checks this file against a
 * built CLI and, when given the spec, against Annex C.
 */

// ---------------------------------------------------------------------------------------------
// 1. Where the CLI comes from
// ---------------------------------------------------------------------------------------------

/**
 * Commit 0295ed6 of branch cli/resync-516 (PR #6), the CLI settled on 15 Nov 2026: 37 requirements,
 * pinned to spec 098621b. A full SHA is needed: `git fetch` does not take a short one.
 */
export const CLI_DEFAULT_REF = '0295ed6494d99ce5467f0d6e94e91a5c436a18c2';

/**
 * How the CLI is obtained when the caller gives no `cli-path`.
 *
 * Today: a git fetch of one commit, then a build, because the package is not published
 * (`"private": true`). The npm name is decided (owner, 15 Nov 2026): `@mcp-write-safety/writecheck`,
 * bin `mcp-writecheck`; the npm organization does not exist yet. The repository is private, so the
 * fetch needs the `cli-token` input until the repository is public.
 *
 * After publication, replace this object with the npm form, for example
 *   { kind: 'npm', spec: (version) => `@mcp-write-safety/writecheck@${version}` }
 * and add the matching branch in src/install.mjs. That branch is not written yet, on purpose:
 * it could not be tested against a package that does not exist.
 */
export const CLI_SOURCE = {
  kind: 'git',
  // MCP_WRITECHECK_CLI_REPOSITORY is for the local test only (it points at a local clone). It is
  // ignored on a GitHub runner, so that no variable of the job can send the fetch, and the
  // cli-token with it, anywhere else.
  repository: (process.env.GITHUB_ACTIONS !== 'true' && process.env.MCP_WRITECHECK_CLI_REPOSITORY) || 'https://github.com/isokron-ai/mcp-write-safety.git',
  packageDir: 'packages/writecheck',
  build: [
    ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npm', 'run', 'build'],
  ],
};

/** The CLI's entry point, relative to the package folder (also what `cli-path` must contain). */
export const CLI_ENTRY = 'dist/src/cli/main.js';

/** package.json `engines.node` of the CLI at the pinned commit is ">=22". */
export const CLI_MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------------------------
// 2. The CLI's interface, as the action uses it
// ---------------------------------------------------------------------------------------------

export const CLI = {
  name: 'mcp-writecheck',

  /** `version` prints one line, for example "mcp-writecheck 0.1.0-dev.0 (MWS 0.9)". */
  versionArgs: () => ['version'],

  /** `plan`: tools/list only, or no call at all with a saved catalog. Makes no tool call, writes no file. */
  planArgs: ({ manifest, catalog }) => ['plan', '-m', manifest, ...(catalog ? ['--catalog', catalog] : [])],

  /**
   * `catalog`: catalog-only mode. The verdicts that need only tools/list (MWS-ANN-4 for each tool), every
   * other requirement `not tested`. Calls no tool. Writes the usual results folder, <out>/catalog-<fingerprint>/.
   * With a saved catalog no server is started; otherwise the manifest's server is started for tools/list.
   */
  catalogArgs: ({ manifest, catalog, out }) => ['catalog', ...(catalog ? ['--catalog', catalog] : ['-m', manifest]), '--out', out],
  /** The requirements `catalog` judges; it records every other one as `not tested`. */
  catalogRequirements: ['MWS-ANN-4'],

  /** `run`: the only command that writes. There is no --yes; both confirmations are required. */
  runArgs: ({ manifest, confirmTarget, planHash, out, state }) => [
    'run', '-m', manifest,
    '--confirm-target', confirmTarget,
    '--plan-hash', planHash,
    '--out', out,
    '--state', state,
  ],

  /** The line `plan` prints with the hash. */
  planHashLine: /^plan hash: ([0-9a-f]{16})$/m,
  /** The first line `run` prints before it asks for confirmation. */
  runPlanLine: /^Plan ([0-9a-f]{16}) for target /m,
  /** The line `run` and `catalog` print with the folder they wrote: "results: <folder>/report.md …". */
  resultsLine: /^results: (.+)\/report\.md(?: |$)/m,
  /** The shape of a plan hash, used to validate the `plan-hash` input. */
  planHashShape: /^[0-9a-f]{16}$/,

  /**
   * Exit statuses, from the CLI's own usage text. 130 is not in the usage text; the CLI exits with it
   * after SIGINT or SIGTERM, once it has cleaned up. `catalog` exits 1 only for a violated MUST, which
   * MWS-ANN-4 (a SHOULD) never is.
   */
  exit: {
    0: 'done',
    1: 'a violated MUST not in the baseline, or a stale baseline entry',
    2: 'usage or manifest error',
    3: 'refused (target, confirmation, guard or open ledger)',
    4: 'stopped or failed',
    130: 'interrupted',
  },
  /** The statuses after which a complete results folder is expected. */
  exitRanToCompletion: [0, 1],

  /** `run` writes <out>/<run id>/ with these files. */
  resultsFile: 'results.json',
  reportFile: 'report.md',
  resultsFormat: 'mws-results/1',
};

/**
 * The fields of results.json (mws-results/1 at CLI_DEFAULT_REF) that carry what the tester's own seat
 * belts saw. None of them is a verdict; the action surfaces each, and some fail the job whatever
 * `fail-on` says (src/summary.mjs, decide()).
 *
 *   numbers.bystanders_lost     on a targeting record: objects the tester did not create that were gone,
 *                               changed or missing afterwards ("<resource> "<id>" …" strings). Any entry
 *                               fails the job. report.md puts them before everything else.
 *   numbers.bystander_inventory what the inventory around a targeting call covered: { scopes, objects,
 *                               lists, read_back_by_id, partial } or { unavailable }.
 *   safety.setup_unresolved     setup made through the platform's API that could not be released or
 *                               confirmed released. Not in the schema at CLI_DEFAULT_REF; it comes with
 *                               the CLI's series A (cli/gate2-gaps), where such a run exits 4. Read where
 *                               present. Any entry fails the job.
 *   leftovers                   objects of the run left in the test environment ({ resource, id, name, how,
 *                               reason }).
 *   cleanup.failed, .unknown    deletes that failed, and creates whose outcome is unknown (still open in
 *                               the ledger): `mcp-writecheck cleanup` with the state folder handles them.
 *   safety.canaries, safety.fixtures_restored
 *                               untouched-state canaries and fixtures put back.
 *   results[].attribution       server, platform or unresolved on a violated or platform record of a
 *                               requirement that lists platform; null otherwise (spec 8.2, rule 3).
 */
/**
 * Leftovers the manifest asked for: the `reason` the CLI writes for an object it left behind because
 * the resource's `cleanup` policy says so (core/cleanup.ts at CLI_DEFAULT_REF): `ephemeral` (the backend
 * is disposable), `leave`, and `archive` (archived, so the object remains). The summary lists these
 * apart from objects left behind by accident, and they raise no warning.
 */
export const LEFT_BY_DECLARATION = [
  /^the backend is declared disposable \(cleanup: ephemeral\)$/,
  /^cleanup: leave$/,
  /^archived \(the object remains, closed\)$/,
];

export const RESULTS_FIELDS = {
  bystandersLost: 'bystanders_lost',
  bystanderInventory: 'bystander_inventory',
  setupUnresolved: 'setup_unresolved',
};

/** The seven verdicts of MWS section 8, in the order the summary lists them. */
export const VERDICTS = ['violated', 'platform', 'held', 'not observed', 'not tested', 'not applicable', 'self-attested'];

// ---------------------------------------------------------------------------------------------
// 3. The requirement registry
// ---------------------------------------------------------------------------------------------

/**
 * MWS 0.9, Annex C, copied from spec/mws.md at the commit below (branch spec/0.9-review): ID, level,
 * short form. The short forms are an index only; the requirement is the sentence in section 9.
 *
 * The CLI at CLI_DEFAULT_REF knows the same 37 IDs at the same levels (it is pinned to spec 098621b,
 * whose Annex C is identical to this one). Five of its short forms are worded differently
 * (MWS-IN-2, IN-7, CFG-2, CFG-4, ANN-2); the action prints only these. src/summary.mjs still shows any
 * level difference, should one return.
 */
export const SPEC = {
  version: '0.9',
  commit: 'e2bb9b0',
  requirements: [
    ['MWS-UPD-1', 'MUST', 'A field patch changes only the named fields'],
    ['MWS-UPD-2', 'MUST', 'A list edit, move or removal lands on the element the caller read at that address, or is refused'],
    ['MWS-CONC-1', 'MUST', 'Do not bypass the backend\'s concurrency control by default'],
    ['MWS-CONC-2', 'MUST', 'Refuse a stale write where the backend can detect it'],
    ['MWS-CONC-3', 'MUST', 'Concurrent writes to different parts do not both succeed with one lost'],
    ['MWS-CONC-4', 'MUST', 'A conflict is an error, is not applied and says so'],
    ['MWS-CONC-5', 'SHOULD', 'The description discloses stale writes the backend cannot detect'],
    ['MWS-CONC-6', 'SHOULD', 'A conflict tells the caller to read again before retrying, or carries the current state'],
    ['MWS-TGT-1', 'MUST', 'Honor or reject a scope argument'],
    ['MWS-TGT-2', 'MUST', 'An empty or match-all selector does not mean everything'],
    ['MWS-TGT-3', 'MUST', 'A create does not overwrite'],
    ['MWS-RES-1', 'MUST', 'Success only when the state asked for is in effect'],
    ['MWS-RES-2', 'MUST', 'A failed write is not a success, says what remains applied, and is a tool execution error where the backend or a rule refused it'],
    ['MWS-RES-3', 'MUST', 'A create returns its identifier, even on later failure'],
    ['MWS-RES-4', 'SHOULD', 'A write returns a receipt'],
    ['MWS-ATOM-1', 'MUST', 'A partial outcome is not success, and names what was applied'],
    ['MWS-ATOM-2', 'SHOULD', 'Multi-object writes are all-or-nothing'],
    ['MWS-RETRY-1', 'SHOULD', 'A non-idempotent create accepts an idempotency key'],
    ['MWS-RETRY-2', 'MUST', 'An idempotency key is honored: applied at most once and answered with the first outcome where the server can establish it, new key new write, changed arguments refused'],
    ['MWS-RETRY-3', 'MUST', 'The write asked for is not in effect before an `input_required` result'],
    ['MWS-IN-1', 'MUST', 'No coercion that changes the meaning of a value'],
    ['MWS-IN-2', 'MUST', 'Unknown arguments are never dropped silently'],
    ['MWS-IN-3', 'MUST', 'A call that breaks a declared constraint is rejected'],
    ['MWS-IN-4', 'MUST', 'A validation failure is an error naming the argument and reason'],
    ['MWS-IN-5', 'SHOULD', 'The schema declares the fixed single-argument constraints that are enforced'],
    ['MWS-IN-6', 'SHOULD', 'Wrong types are rejected, not converted or dropped'],
    ['MWS-IN-7', 'SHOULD', 'Unknown arguments are rejected'],
    ['MWS-CFG-1', 'MUST', 'An unrecognized safety setting never leaves writes enabled'],
    ['MWS-CFG-2', 'MUST', 'An unknown tool name in a deny-list stops the server or the request, or disables writes'],
    ['MWS-CFG-3', 'MUST', 'Read-only mode refuses every write tool'],
    ['MWS-CFG-4', 'SHOULD', 'An unknown tool name in an allow-list stops the server or the request'],
    ['MWS-ANN-1', 'MUST', '`readOnlyHint: true` means no state change'],
    ['MWS-ANN-2', 'MUST', '`destructiveHint: false` means no deletion, and no removal or replacement of data the caller did not name'],
    ['MWS-ANN-3', 'MUST', '`idempotentHint: true` means no further effect on repeat'],
    ['MWS-ANN-4', 'SHOULD', '`readOnlyHint` and `destructiveHint` are declared explicitly'],
    ['MWS-ANN-5', 'SHOULD', '`destructiveHint: false` means additive only (at risk)'],
    ['MWS-SEC-1', 'MUST', 'No credentials in tool results, other than one the tool exists to issue'],
  ].map(([id, level, short]) => ({ id, level, short })),
};

/** The shape of a requirement ID (section 6 of the spec: `MWS-<AREA>-<n>`). */
export const REQUIREMENT_ID = /^MWS-[A-Z]+-[0-9]+$/;

// ---------------------------------------------------------------------------------------------
// 4. The public spec page
// ---------------------------------------------------------------------------------------------

/** Default of the `spec-url` input. The page does not exist yet (HTTP 404 on 14 Nov 2026; not re-checked). */
export const SPEC_DEFAULT_URL = 'https://isokron.ai/mws';

/**
 * The link for one requirement: the base URL, then the anchor of its heading. The headings in
 * spec/mws.md are "#### MWS-UPD-1", whose slug in the usual Markdown renderers is "mws-upd-1".
 * If the published page builds anchors another way, this function is the only thing to change.
 */
export function requirementUrl(baseUrl, id) {
  return `${String(baseUrl).replace(/#.*$/, '')}#${id.toLowerCase()}`;
}

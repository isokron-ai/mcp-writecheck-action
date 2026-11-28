/**
 * The writecheck loop worker's workflows, checked on the files: corpus.yml (what the pump dispatches) and
 * loop-fixture.yml (its pull-request proof, which must run the same steps).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, '.github', 'workflows', f), 'utf8');
const worker = read('corpus.yml');
const fixture = read('loop-fixture.yml');
const body = (t) => t.replace(/^\s*#.*$/gm, '');

/** The text of every `run:` (one line or a block). */
function runBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] !== '|' && m[2] !== '>') { out.push(m[2]); continue; }
    const ind = m[1].length;
    const block = [];
    for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > ind); i++) block.push(lines[i]);
    i--;
    out.push(block.join('\n'));
  }
  return out;
}

/** The shared part of the job: from the checkout to the teardown. */
const shared = (t) => t.slice(t.indexOf('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          ref: '), t.indexOf('        run: loop/teardown.sh\n'));

for (const [name, text] of [['corpus.yml', worker], ['loop-fixture.yml', fixture]]) {
  test(`${name}: permissions {} on top, timeouts, pinned actions, no secrets, no expressions in run`, () => {
    const b = body(text);
    assert.match(b, /^permissions: \{\}$/m);
    assert.doesNotMatch(b, /pull_request_target|workflow_run|secrets\./);
    const jobs = b.slice(b.indexOf('\njobs:\n'));
    const jobNames = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
    assert.ok(jobNames.length >= 1);
    // A job that calls a reusable workflow cannot set a timeout (the called jobs have theirs); every other job does.
    const called = (jobs.match(/^ {4}uses: /gm) ?? []).length;
    assert.equal((jobs.match(/^ {4}timeout-minutes: \d+$/gm) ?? []).length, jobNames.length - called, 'a timeout on every job');
    for (const m of b.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^[^@]+@[0-9a-f]{40}$/, m[1]);
    for (const r of runBlocks(b)) assert.doesNotMatch(r, /\$\{\{/, r.slice(0, 80));
    const kit = b.match(/isokron-ai\/tool-qa\/worker-kit@([0-9a-f]{40})/g);
    const pin = /WORKER_KIT_REF: '([0-9a-f]{40})'/.exec(b)[1];
    for (const k of kit) assert.ok(k.endsWith(pin), 'every worker-kit step names WORKER_KIT_REF');
    // R-WC-06, R-WC-09: the sandbox at 78a7834 (4504c0b, then the reader option of #16; crates, .NET tools and MCP bundles; tunnel shutdown; capped volumes, data-root and logs; native builds from source; the guard tests the install network), the
    // conformance workflow and the guard both at it.
    const sbx = /SANDBOX_REF: '([0-9a-f]{40})'/.exec(b)[1];
    assert.equal(sbx, '78a7834cf028507b03e90e266b87bebeacfccd51');
    assert.match(b, new RegExp(`\\n {4}uses: isokron-ai/mcp-surface-corpus/\\.github/workflows/sandbox-conformance\\.yml@${sbx} `));
    assert.match(b, new RegExp(`uses: isokron-ai/mcp-surface-corpus/sandbox-guard@${sbx} `));
    assert.match(b, /needs\.conformance\.outputs\.verdict == 'pass'/);
    assert.doesNotMatch(b, /prepare\.sh (sandbox|selftest)/);
    const at = b.indexOf('loop/run-items.mjs');
    const heads = [...b.slice(0, at).matchAll(/^ {2}[a-z][a-z0-9-]*:$/gm)]; // job headers before the item runner
    const job = b.slice(heads[heads.length - 1].index); // the job that runs the items
    assert.ok(job.includes('sandbox-guard@'), 'the item job itself runs the guard');
    assert.ok(job.indexOf('sandbox-guard@') < job.indexOf('loop/run-items.mjs'), 'the guard runs on this runner before any target');
    assert.match(b, /SEED_REF: '[0-9a-f]{40}'/);
  });
}

test('corpus.yml: the pump\'s worker contract (dispatch only, four inputs, run name, guard first)', () => {
  const b = body(worker);
  assert.match(b, /^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}shard_id:\n[\s\S]*? {6}attempt_id:\n[\s\S]*? {6}items:\n/m);
  // Four inputs (tool_sha, R-WC-28), and the seven mode inputs of tool-qa's write-backend contract (R-WCF-07).
  assert.equal((b.match(/^ {6}[a-z_-]+:\n {8}description:/gm) ?? []).length, 11, 'exactly eleven inputs');
  assert.doesNotMatch(b, /^ {2}(push|pull_request|schedule):/m);
  assert.match(b, /^run-name: shard \$\{\{ inputs\.shard_id \}\}$/m);
  const guard = b.slice(b.indexOf('\n  guard:'), b.indexOf('\n  writecheck:'));
  assert.match(guard, /if: github\.repository == 'isokron-ai\/mcp-writecheck-action' && github\.ref == 'refs\/heads\/main'/);
  assert.ok(guard.indexOf('LOOP_ENABLED') < guard.indexOf('actions/checkout'), 'LOOP_ENABLED is checked before any checkout');
  assert.match(guard, /LANE_WRITECHECK_ENABLED: \$\{\{ vars\.LANE_WRITECHECK_ENABLED \}\}/);
  assert.match(guard, /LOOP_PAUSE_UNTIL: \$\{\{ vars\.LOOP_PAUSE_UNTIL \}\}/);
  assert.match(b, /\n {2}writecheck:\n {4}needs: \[guard, conformance\]\n {4}if: needs\.guard\.outputs\.proceed == 'true' && needs\.conformance\.outputs\.verdict == 'pass'/);
  // The inputs are checked whole before anything else in the job.
  const job = b.slice(b.indexOf('\n  writecheck:'));
  assert.ok(job.indexOf('name: Check the inputs') < job.indexOf('uses: actions/checkout'));
  assert.match(job, /\[\[ ! "\$SHARD_ID" =~ \$id_re \]\]/);
  // One upload step per item of the shard, each only after the controls passed and the sandbox is gone.
  for (let i = 0; i < 10; i++) {
    assert.match(job, new RegExp(`- name: Seal and upload item ${i}\\n {8}if: \\$\\{\\{ !cancelled\\(\\) && steps\\.teardown\\.outcome == 'success' && steps\\.run\\.outputs\\.controls_ok == 'true' && steps\\.run\\.outputs\\.has_${i} == 'true' \\}\\}\\n`));
    assert.match(job, new RegExp(`item-index: '${i}'\\n {10}fence: \\$\\{\\{ steps\\.run\\.outputs\\.fence_${i} \\}\\}\\n {10}run-key: \\$\\{\\{ steps\\.run\\.outputs\\.run_key_${i} \\}\\}`));
  }
  assert.ok(job.indexOf('name: Sandbox guard') < job.indexOf('name: Run the items in the sandbox'));
  assert.ok(job.indexOf('loop/prepare.sh fetch') < job.indexOf('sandbox-guard@'), 'the CLI is built before gVisor and before any target');
  assert.ok(job.indexOf('loop/teardown.sh') < job.indexOf('Seal and upload item 0'));
  assert.doesNotMatch(job, /dry-run/);
});

test('loop-fixture.yml runs the worker\'s steps unchanged, on pull requests from this repository only', () => {
  const norm = (t) => shared(t).replace(/steps\.inputs\.outputs\.(items|shard_id|attempt_id|tool_sha|mode|backend_kind|backend|stand_in|spec_url|spec_format|env_names)\b/g, 'inputs.$1');
  assert.ok(shared(worker).length > 500);
  assert.equal(norm(fixture), shared(worker));
  const b = body(fixture);
  assert.match(b, /^on:\n {2}pull_request:\n {4}paths:\n/m);
  assert.match(b, /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.equal((b.match(/dry-run: 'true'/g) ?? []).length, (b.match(/worker-kit@/g) ?? []).length, 'every bundle is a dry run');
  assert.match(b, /node loop\/check-bundles\.mjs --toolqa toolqa-ingest/);
});

test('corpus-batch.yml is the older hand-dispatched batch path, kept as it was', () => {
  const b = body(read('corpus-batch.yml'));
  assert.match(b, /^name: corpus-batch$/m);
  assert.match(b, /^on:\n(?:\s*\n)*  workflow_dispatch:\n    inputs:\n      only:/m);
  assert.match(b, /corpus\/run-ci-shard\.sh/);
});

test('R-WC-13: the last item cannot outlast the writecheck job or the pump lease', async () => {
  const { ITEM_GRACE_MS, SHARD_BUDGET_MS } = await import('../loop/run-items.mjs');
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  // The running item's unit deadline is the shard deadline plus the grace constant, nothing longer.
  assert.match(src, /runUnit\(u, Math\.min\(deadline \+ ITEM_GRACE_MS,/);
  assert.doesNotMatch(src, /deadline \+ \d+ \* 60_000/);
  const wf = readFileSync(join(root, '.github', 'workflows', 'corpus.yml'), 'utf8');
  const job = wf.slice(wf.indexOf('\n  writecheck:'));
  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(job)[1]);
  const beforeT0 = 15; // checkout, guard (gVisor install and self test), CLI build, image pulls: measured worst case
  const afterDeadline = 3 + 5; // host-side overhang of the last item (sweep, collect, start), then teardown and sealing
  const worst = beforeT0 + SHARD_BUDGET_MS / 60_000 + ITEM_GRACE_MS / 60_000 + afterDeadline;
  assert.ok(worst <= timeout, `worst case ${worst} min must fit in timeout-minutes ${timeout}`);
  const lease = 1.5 * (12 + 10 * 2) + 10; // tool-qa pump/slots.mjs with writecheck setup_minutes 12 (tool-qa#66)
  assert.ok(timeout < lease, `job timeout ${timeout} must be below the pump lease ${lease}`);
});

test('R-WC-28: the worker runs the commit the pump pins (tool_sha), checked whole, and stops unless the checkout is that commit', () => {
  const b = body(worker);
  // An optional input, empty by default, so a dispatch without it runs the dispatched ref as before.
  assert.match(b, /\n {6}tool_sha:\n {8}description: [^\n]+\n {8}required: false\n {8}type: string\n {8}default: ''\n/);
  const job = b.slice(b.indexOf('\n  writecheck:'));
  const check = job.slice(job.indexOf('name: Check the inputs'), job.indexOf('uses: actions/checkout'));
  assert.match(check, /TOOL_SHA: \$\{\{ inputs\.tool_sha \}\}/);
  assert.match(check, /if \[ -n "\$TOOL_SHA" \] && \[\[ ! "\$TOOL_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]; then [^\n]*exit 1; fi/);
  // The job that runs the items checks out that commit (else its own) and proves it before anything of it runs.
  for (const [name, text, expr] of [['corpus.yml', worker, 'inputs.tool_sha'], ['loop-fixture.yml', fixture, 'steps.inputs.outputs.tool_sha']]) {
    const t = body(text);
    const at = t.indexOf('uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          ref: ');
    assert.ok(at > 0, name);
    const seg = t.slice(at, t.indexOf('loop/run-items.mjs', at));
    assert.match(seg, new RegExp(`ref: \\$\\{\\{ ${expr.replace(/\./g, '\\.')} \\|\\| github\\.sha \\}\\}\\n`), name);
    assert.match(seg, new RegExp(`TOOL_SHA: \\$\\{\\{ ${expr.replace(/\./g, '\\.')} \\}\\}`), name);
    assert.match(seg, /head=\$\(git rev-parse HEAD\)\n\s*want="\$\{TOOL_SHA:-\$GITHUB_SHA\}"\n\s*if \[ "\$head" != "\$want" \]; then [^\n]*exit 1; fi\n\s*echo "ACTION_SHA=\$head" >> "\$GITHUB_ENV"/, name);
    // The check comes right after the checkout, before Node is set up and before any of the checkout's code runs.
    assert.ok(seg.indexOf('git rev-parse HEAD') < seg.indexOf('actions/setup-node'), name);
    assert.ok(seg.indexOf('git rev-parse HEAD') < seg.indexOf('loop/items.mjs'), name);
  }
});

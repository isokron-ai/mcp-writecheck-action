/**
 * R-TSW-*: the result bundle of the T0 workers (selftest.yml and dogfood-*.yml), which tool-qa's t0-self lane
 * dispatches. Each worker ends with a sealed tool-qa bundle built by loop/t0-bundle.mjs.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, infraOnly, observe, stemFromRef, workResults } from '../loop/t0-bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');
const workers = readdirSync(dir).filter((f) => /^(dogfood-.+|selftest)\.yml$/.test(f)).sort();
const needs = (...r) => JSON.stringify({ 't0-start': { result: 'success', outputs: {} }, ...Object.fromEntries(r.map((x, i) => [`job${i}`, { result: x }])) });
const ENV = { GITHUB_REPOSITORY: 'isokron-ai/mcp-writecheck-action', GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-writecheck-action/.github/workflows/dogfood-writesafe.yml@refs/heads/main', GITHUB_SHA: 'c'.repeat(40) };

test('R-TSW-01: a run whose work jobs succeeded (or were skipped) observes green', () => {
  const b = build({ ...ENV, NEEDS: needs('success', 'skipped') });
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'green_or_infra', observed: 'green_or_infra' }]);
  assert.equal(b.run.observed, 'green');
  assert.equal(b.meta.subject.id, 'isokron-ai/mcp-writecheck-action.dogfood-writesafe');
  assert.equal(b.meta.subject.sha, 'c'.repeat(40));
  assert.equal(b.run.workflow, 'dogfood-writesafe.yml');
});

test('R-TSW-02: a failed or cancelled job makes the control fail, so ingest rejects the run as control_failed (a lead against our own tool)', () => {
  assert.equal(build({ ...ENV, NEEDS: needs('success', 'failure') }).meta.controls[0].observed, 'failed');
  assert.equal(build({ ...ENV, NEEDS: needs('success', 'cancelled') }).meta.controls[0].observed, 'cancelled');
  assert.equal(build({ ...ENV, NEEDS: needs('cancelled', 'failure') }).meta.controls[0].observed, 'failed', 'a failure is named before a cancellation');
  for (const bad of ['failure', 'cancelled']) assert.notEqual(build({ ...ENV, NEEDS: needs(bad) }).meta.controls[0].observed, 'green');
});

test('R-TSW-03: no work job result, a result GitHub does not define, or every work job skipped is never green', () => {
  assert.equal(observe([]), 'incomplete');
  assert.equal(observe(undefined), 'incomplete');
  assert.equal(observe(['success', 'weird']), 'incomplete');
  assert.equal(observe(['skipped', 'skipped']), 'skipped', 'nothing ran: not green');
  assert.equal(observe(['success', 'skipped']), 'green');
  assert.deepEqual(workResults(needs('success', 'skipped')), ['success', 'skipped'], 't0-start is not a work job');
  assert.deepEqual(workResults(needs()), [], 'only t0-start: no work job result');
  assert.deepEqual(workResults('not json'), []);
  const all = build({ ...ENV, NEEDS: needs('skipped', 'skipped') });
  assert.notEqual(all.meta.controls[0].observed, all.meta.controls[0].expected, 'ingest rejects an all-skipped run');
  assert.notEqual(build({ ...ENV, NEEDS: needs() }).meta.controls[0].observed, 'green_or_infra');
});

test('R-TSW-04: the subject is the repository and the workflow file stem; a ref that names no workflow file is refused', () => {
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/.github/workflows/selftest.yml@refs/heads/main'), 'selftest');
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/.github/workflows/dogfood-tiny-tracker.yml@refs/heads/x'), 'dogfood-tiny-tracker');
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/other/selftest.yml@refs/heads/main'), null);
  assert.throws(() => build({ ...ENV, GITHUB_WORKFLOW_REF: 'nope', NEEDS: needs('success') }), /does not name a workflow file/);
  assert.equal(build({ ...ENV, GITHUB_SHA: 'zz', NEEDS: needs('success') }).meta.subject.sha, null, 'an unusable sha is dropped');
});

test('R-TSW-05: every T0 worker ends with a t0-manifest job that waits for every other job and runs none of the workflow\'s code', () => {
  assert.equal(workers.length, 8, 'selftest and seven dogfood workers');
  for (const f of workers) {
    const text = readFileSync(join(dir, f), 'utf8');
    const jobs = [...text.slice(text.indexOf('\njobs:')).matchAll(/^  ([a-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
    assert.ok(jobs.includes('t0-manifest'), `${f}: t0-manifest`);
    const job = text.slice(text.indexOf('\n  t0-manifest:\n'));
    const needs = /^    needs: \[([^\]]*)\]/m.exec(job)?.[1].split(',').map((x) => x.trim());
    assert.ok(needs, `${f}: needs`);
    for (const j of jobs) if (j !== 't0-manifest') assert.ok(needs.includes(j), `${f}: t0-manifest waits for ${j} (a job it does not wait for could fail unseen)`);
    assert.match(job, /\n    if: \$\{\{ always\(\) && needs\.t0-start\.outputs\.go == 'true' \}\}/, `${f}: runs even when a job failed, and not when the kill switch is off`);
    assert.match(job, /\n    permissions:\n      contents: read\n/, `${f}: contents: read only`);
    assert.match(job, /NEEDS: \$\{\{ toJSON\(needs\) \}\}/, `${f}: reads every job's result`);
    assert.match(job, /uses: isokron-ai\/tool-qa\/worker-kit@[0-9a-f]{40} /, `${f}: the worker-kit action is pinned to a full commit`);
    assert.match(job, /item-index: 0\n\s+fence: \$\{\{ needs\.t0-start\.outputs\.fence \}\}\n\s+run-key: \$\{\{ needs\.t0-start\.outputs\.run_key \}\}/, `${f}: item 0 with the dispatched fence and run_key`);
    assert.match(job, /\n      actions: read /, `${f}: actions: read to read the failed steps`);
    assert.doesNotMatch(job, /t0-manifest\.json|name: t0-\$\{\{/, `${f}: the old unsealed stub is gone`);
  }
});

test('R-TSW-06: the workers\' subjects match the names the pump dispatches (pump/workflows.json t0-self in tool-qa)', () => {
  const expected = ['dogfood-grafana', 'dogfood-kronicle-lite', 'dogfood-kubernetes', 'dogfood-payload', 'dogfood-sea-lite', 'dogfood-tiny-tracker', 'dogfood-writesafe', 'selftest'];
  assert.deepEqual(workers.map((f) => f.replace(/\.yml$/, '')), expected);
  for (const stem of expected) assert.equal(build({ ...ENV, GITHUB_WORKFLOW_REF: `isokron-ai/mcp-writecheck-action/.github/workflows/${stem}.yml@refs/heads/main`, NEEDS: needs('success') }).meta.subject.id, `isokron-ai/mcp-writecheck-action.${stem}`);
});

const job = (name, conclusion, ...steps) => ({ name, conclusion, steps: steps.map(([n, c]) => ({ name: n, conclusion: c })) });

test('R-TSW-07: a run that failed only at steps that fetch from the network is infrastructure: a retryable infra skip and a control that holds, so no lead is raised against our tool', () => {
  const infra = [job('kind', 'failure', ['Set up job', 'success'], ['Install kind', 'failure'], ['Create the cluster', 'skipped'])];
  assert.equal(infraOnly(infra), true);
  const b = build({ ...ENV, NEEDS: needs('failure') }, new Date(), { jobs: infra });
  assert.equal(b.run.observed, 'infra');
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'green_or_infra', observed: 'green_or_infra' }]);
  assert.deepEqual(b.meta.skips, [{ stage: 'worker', reason: 'upstream_unavailable', fault: 'infra', retryable: true }]);
  assert.equal(infraOnly([job('x', 'failure', ['Run actions/setup-go@abc', 'failure'])]), true);
  assert.equal(infraOnly([job('x', 'failure', ['Take the upstream binary from its image', 'failure'])]), true);
  for (const n of ['Build the test app', 'Build the research app', 'Build the research build', 'Build the research server', 'Build kronicle-lite', 'Build sea-lite', 'Start Grafana']) assert.equal(infraOnly([job('x', 'failure', [n, 'failure'])]), true, n);
});

test('R-TSW-08: a failure at any other step, a mix, a failed job with no failed step, or no step information is a lead against our tool, never infrastructure', () => {
  for (const jobs of [
    [job('x', 'failure', ['Full run', 'failure'])],
    [job('x', 'failure', ['Build tiny-tracker', 'failure'])],
    [job('x', 'failure', ['Build mcp-writecheck', 'failure'])],
    [job('x', 'failure', ['Install kind', 'failure'], ['Full run', 'failure'])],
    [job('x', 'failure', ['Install kind', 'failure']), job('y', 'failure', ['Catalog', 'failure'])],
    [job('x', 'failure')],
    [],
    null,
  ]) {
    assert.equal(infraOnly(jobs), false, JSON.stringify(jobs));
    const b = build({ ...ENV, NEEDS: needs('failure') }, new Date(), { jobs });
    assert.equal(b.meta.controls[0].observed, 'failed');
    assert.deepEqual(b.meta.skips, []);
  }
  assert.equal(build({ ...ENV, NEEDS: needs('success') }, new Date(), { jobs: [job('x', 'failure', ['Install kind', 'failure'])] }).run.observed, 'green', 'infra is only read for a failed run');
});

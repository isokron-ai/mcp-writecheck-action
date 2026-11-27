/**
 * R-TSW-*: the result bundle of the T0 workers (selftest.yml and dogfood-*.yml), which tool-qa's t0-self lane
 * dispatches. Each worker ends with a sealed tool-qa bundle built by loop/t0-bundle.mjs.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, observe, stemFromRef } from '../loop/t0-bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');
const workers = readdirSync(dir).filter((f) => /^(dogfood-.+|selftest)\.yml$/.test(f)).sort();
const ENV = { GITHUB_REPOSITORY: 'isokron-ai/mcp-writecheck-action', GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-writecheck-action/.github/workflows/dogfood-writesafe.yml@refs/heads/main', GITHUB_SHA: 'c'.repeat(40) };

test('R-TSW-01: a run whose jobs all succeeded (or were skipped) observes green', () => {
  const b = build({ ...ENV, RESULTS: 'success success skipped' });
  assert.deepEqual(b.meta.controls, [{ kind: 'known_good', expected: 'green', observed: 'green' }]);
  assert.equal(b.meta.subject.id, 'isokron-ai/mcp-writecheck-action.dogfood-writesafe');
  assert.equal(b.meta.subject.sha, 'c'.repeat(40));
  assert.equal(b.run.workflow, 'dogfood-writesafe.yml');
});

test('R-TSW-02: a failed or cancelled job makes the control fail, so ingest rejects the run as control_failed (a lead against our own tool)', () => {
  assert.equal(build({ ...ENV, RESULTS: 'success failure' }).meta.controls[0].observed, 'failed');
  assert.equal(build({ ...ENV, RESULTS: 'success cancelled' }).meta.controls[0].observed, 'cancelled');
  assert.equal(build({ ...ENV, RESULTS: 'cancelled failure' }).meta.controls[0].observed, 'failed', 'a failure is named before a cancellation');
  for (const bad of ['failure', 'cancelled']) assert.notEqual(build({ ...ENV, RESULTS: bad }).meta.controls[0].observed, 'green');
});

test('R-TSW-03: no result, or a result GitHub does not define, is incomplete, never green', () => {
  assert.equal(observe(''), 'incomplete');
  assert.equal(observe(undefined), 'incomplete');
  assert.equal(observe('success weird'), 'incomplete');
  assert.equal(observe('success\nsuccess'), 'green', 'whitespace of any kind separates results');
});

test('R-TSW-04: the subject is the repository and the workflow file stem; a ref that names no workflow file is refused', () => {
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/.github/workflows/selftest.yml@refs/heads/main'), 'selftest');
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/.github/workflows/dogfood-tiny-tracker.yml@refs/heads/x'), 'dogfood-tiny-tracker');
  assert.equal(stemFromRef('isokron-ai/mcp-writecheck-action/other/selftest.yml@refs/heads/main'), null);
  assert.throws(() => build({ ...ENV, GITHUB_WORKFLOW_REF: 'nope', RESULTS: 'success' }), /does not name a workflow file/);
  assert.equal(build({ ...ENV, GITHUB_SHA: 'zz', RESULTS: 'success' }).meta.subject.sha, null, 'an unusable sha is dropped');
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
    assert.match(job, /RESULTS: \$\{\{ join\(needs\.\*\.result, ' '\) \}\}/, `${f}: reads every job's result`);
    assert.match(job, /uses: isokron-ai\/tool-qa\/worker-kit@[0-9a-f]{40} /, `${f}: the worker-kit action is pinned to a full commit`);
    assert.match(job, /item-index: 0\n\s+fence: \$\{\{ needs\.t0-start\.outputs\.fence \}\}\n\s+run-key: \$\{\{ needs\.t0-start\.outputs\.run_key \}\}/, `${f}: item 0 with the dispatched fence and run_key`);
    assert.doesNotMatch(job, /t0-manifest\.json|name: t0-\$\{\{/, `${f}: the old unsealed stub is gone`);
  }
});

test('R-TSW-06: the workers\' subjects match the names the pump dispatches (pump/workflows.json t0-self in tool-qa)', () => {
  const expected = ['dogfood-grafana', 'dogfood-kronicle-lite', 'dogfood-kubernetes', 'dogfood-payload', 'dogfood-sea-lite', 'dogfood-tiny-tracker', 'dogfood-writesafe', 'selftest'];
  assert.deepEqual(workers.map((f) => f.replace(/\.yml$/, '')), expected);
  for (const stem of expected) assert.equal(build({ ...ENV, GITHUB_WORKFLOW_REF: `isokron-ai/mcp-writecheck-action/.github/workflows/${stem}.yml@refs/heads/main`, RESULTS: 'success' }).meta.subject.id, `isokron-ai/mcp-writecheck-action.${stem}`);
});

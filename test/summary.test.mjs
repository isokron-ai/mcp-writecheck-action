/**
 * The job-status rule and the summary text, on small made-up results documents. The run against
 * tiny-tracker (test/local-test.sh) covers real ones.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SPEC } from '../contract.mjs';
import { code, decide, fence, levelOf, md, renderNoResults, renderPlan, renderRun, safetyFacts } from '../src/summary.mjs';

const rec = (requirement, level, verdict, o = {}) => ({
  requirement,
  level,
  verdict,
  write_path: { resource: o.resource ?? 'ticket', tool: o.tool ?? 'update_ticket', arm: 'mcp' },
  scenario: { id: o.scenario ?? 's', version: '1' },
  reason: o.reason ?? 'because',
  numbers: o.numbers ?? {},
  steps: [],
  notes: o.notes ?? [],
  attribution: o.attribution ?? null,
});

const doc = (results, o = {}) => ({
  format: 'mws-results/1',
  scope: 'Scope: server x, resources ticket through update_ticket.',
  suite: { name: 'mcp-writecheck', version: '0.1.0-dev.0' },
  spec: { version: '0.9' },
  run: { id: 'abc', prefix: 'mwsc-abc-', started: 't0', ended: 't1', status: o.status ?? 'complete', stopped_reason: o.stopped ?? null },
  target: { confirm: 'staging-tracker' },
  manifest: { sha256: 'f'.repeat(64) },
  plan: { hash: '0123456789abcdef' },
  results,
  not_built: [],
  leftovers: o.leftovers ?? [],
  cleanup: o.cleanup ?? null,
  safety: { canaries: o.canaries ?? [], fixtures_restored: [], gate: null, protocol: null, rerun_of: null, ...(o.setupUnresolved ? { setup_unresolved: o.setupUnresolved } : {}) },
});

const held = rec('MWS-UPD-1', 'MUST', 'held');
const violatedMust = rec('MWS-CONC-1', 'MUST', 'violated', { tool: 'replace_ticket' });
const violatedShould = rec('MWS-RETRY-1', 'SHOULD', 'violated', { tool: 'add_comment' });
// A level difference between a record and the registry (none at the pinned CLI; the rule stays as a guard).
const violatedDrift = rec('MWS-UPD-2', 'SHOULD', 'violated', { tool: 'remove_label' });

test('fail-on decides from violated records only', () => {
  const cases = [
    // [fail-on, cli exit, results, fails?]
    ['none', 0, [held], false],
    ['must', 0, [held], false],
    ['any', 0, [held], false],
    ['none', 1, [held, violatedMust], false],
    ['must', 1, [held, violatedMust], true],
    ['any', 1, [held, violatedMust], true],
    ['must', 0, [held, violatedShould], false],
    ['any', 0, [held, violatedShould], true],
    ['must', 0, [rec('MWS-CONC-3', 'MUST', 'platform'), rec('MWS-CONC-3', 'MUST', 'not observed'), rec('MWS-CONC-2', 'MUST', 'not tested'), rec('MWS-CONC-4', 'MUST', 'self-attested', { numbers: { answer: false } })], false],
    ['any', 0, [rec('MWS-CONC-3', 'MUST', 'platform'), rec('MWS-CONC-4', 'MUST', 'self-attested', { numbers: { answer: false } })], false],
  ];
  for (const [failOn, cliExit, results, want] of cases) {
    assert.equal(decide({ failOn, cliExit, doc: doc(results) }).fail, want, `${failOn}, exit ${cliExit}, ${results.map((r) => `${r.requirement} ${r.verdict}`).join('; ')}`);
  }
});

test('a MUST in the spec counts as a MUST when the CLI recorded it as SHOULD', () => {
  assert.deepEqual(levelOf(violatedDrift), { recorded: 'SHOULD', registry: 'MUST', must: true, differs: true });
  const d = decide({ failOn: 'must', cliExit: 0, doc: doc([violatedDrift]) });
  assert.equal(d.fail, true);
  assert.deepEqual(d.failing, [violatedDrift]);
  assert.equal(decide({ failOn: 'none', cliExit: 0, doc: doc([violatedDrift]) }).fail, false);
});

test('a run that did not complete fails the job whatever fail-on says', () => {
  for (const failOn of ['none', 'must', 'any']) {
    for (const cliExit of [2, 3, 4, 130, null, 7]) assert.equal(decide({ failOn, cliExit, doc: null }).fail, true, `${failOn}, exit ${cliExit}, no results`);
    // Results exist, but the run stopped (the CLI exits 4, or 1 when a MUST was violated before the stop).
    assert.equal(decide({ failOn, cliExit: 4, doc: doc([held], { status: 'stopped', stopped: 'HTTP 429' }) }).fail, true);
    assert.equal(decide({ failOn, cliExit: 1, doc: doc([violatedMust], { status: 'stopped', stopped: 'HTTP 429' }) }).fail, true);
    // Exit 0 without results is not a pass.
    assert.equal(decide({ failOn, cliExit: 0, doc: null }).fail, true);
  }
});

test('the action is not more lenient than the CLI under must and any', () => {
  assert.equal(decide({ failOn: 'must', cliExit: 1, doc: doc([held]) }).fail, true);
  assert.equal(decide({ failOn: 'any', cliExit: 1, doc: doc([held]) }).fail, true);
  assert.equal(decide({ failOn: 'none', cliExit: 1, doc: doc([held]) }).fail, false);
});

test('untrusted text cannot add markup, close a code span or close a fence', () => {
  assert.equal(md('a | b <img src=x> [l](u) *x* `c`\nnext'), 'a \\| b &lt;img src=x&gt; \\[l\\](u) \\*x\\* \\`c\\` next');
  assert.equal(code('a`b|c\nd'), "`a'b\\|c d`");
  const f = fence('text with ``` and ```` inside');
  assert.ok(f.startsWith('`````text\n') && f.endsWith('\n`````'));
});

test('the run summary: one row per requirement of the spec, each ID linked, no aggregate', () => {
  const results = [
    held,
    violatedMust,
    violatedDrift,
    rec('MWS-CONC-4', 'MUST', 'self-attested', { numbers: { answer: false }, tool: 'set_labels' }),
    rec('MWS-IN-4', 'MUST', 'self-attested', { numbers: { answer: true } }),
    rec('MWS-CONC-3', 'MUST', 'not observed', { reason: 'No lost update was seen in 30 pairs.' }),
    rec('MWS-XYZ-9', 'MUST', 'held'),
  ];
  const d = doc(results, { leftovers: [{ resource: 'ticket', id: 'T-1' }], canaries: [{ name: 'projects', tool: 'list_projects', unchanged: false }] });
  const decision = decide({ failOn: 'must', cliExit: 1, doc: d });
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 1, decision, cliVersion: 'mcp-writecheck 0.1.0-dev.0 (MWS 0.9)', artifactName: 'a' });

  for (const r of SPEC.requirements) assert.ok(text.includes(`| [${r.id}](https://example.test/mws#${r.id.toLowerCase()}) | ${r.level} |`), `no row for ${r.id}`);
  assert.ok(text.includes('**Job status: failed.**'));
  assert.ok(text.includes('**violated (MUST)**'));
  assert.ok(text.includes('**violated (MUST in MWS 0.9; recorded as SHOULD)**'));
  assert.ok(text.includes('self-attested: no: `ticket:set_labels`'));
  assert.ok(text.includes('self-attested: yes: `ticket:update_ticket`'));
  assert.ok(text.includes('| [MWS-CONC-5](https://example.test/mws#mws-conc-5) | SHOULD | no record in this run |'));
  assert.ok(text.includes('`MWS-XYZ-9`: recorded by mcp-writecheck but not in the requirement registry'));
  assert.ok(text.includes('Objects of this run were left behind in the test environment: ticket `"T-1"`'));
  assert.ok(text.includes('canary `projects` changed'));
  // MWS section 5.2: no total, percentage, count of verdicts or grade. The words below are how one would be written.
  assert.doesNotMatch(text, /%|\bscore:|\bpassed\b|\bpass\b|\bcompliant\b|\bconformant\b|\bcertified\b|\bgrade\b/i);
  assert.doesNotMatch(text, /\b\d+ (of \d+ )?(requirements?|records?|verdicts?|violations?|held|violated)\b/i);
});

test('the run summary of a clean run does not claim conformance', () => {
  const d = doc([held]);
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: d }), cliVersion: 'v', artifactName: 'a' });
  assert.ok(text.includes('**Job status: not failed.**'));
  assert.ok(text.includes('This is not a statement that the server meets MWS.'));
  assert.ok(!text.includes('### Violated records'));
});

test('a summary too large for a job summary drops the full table and says so', () => {
  const d = doc([held]);
  const o = { doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: d }), cliVersion: 'v', artifactName: 'a' };
  assert.ok(renderRun(o).includes('<details>'));
  const small = renderRun({ ...o, maxBytes: 100 });
  assert.ok(!small.includes('<details>'));
  assert.ok(small.includes('left out because it is too large'));
});

test('the plan summary says there are no verdicts; a refusal shows both hashes', () => {
  const plan = renderPlan({ manifest: 'm.yaml', catalog: null, cliExit: 0, planHash: '0123456789abcdef', planText: 'Plan 0123456789abcdef for target t', cliVersion: 'v', decision: { fail: false, reasons: [] } });
  assert.ok(plan.includes('A plan has no verdicts.'));
  assert.ok(plan.includes('`0123456789abcdef`'));
  const refused = renderNoResults({ cliExit: 3, decision: decide({ failOn: 'none', cliExit: 3, doc: null }), lastLines: 'error: the plan hash given …', planHashGiven: '0000000000000000', planHashSeen: '0123456789abcdef', cliVersion: 'v' });
  assert.ok(refused.includes('**Job status: failed.**'));
  assert.ok(refused.includes('`0000000000000000`') && refused.includes('`0123456789abcdef`'));
  assert.ok(refused.includes('refused (target, confirmation, guard or open ledger)'));
});

// ---------------------------------------------------------------------------------------------
// The safety facts (CLI 0295ed6: the bystander inventory; series A: safety.setup_unresolved)
// ---------------------------------------------------------------------------------------------

// The shape the CLI writes on a targeting record (src/checks/targeting.ts at 0295ed6).
const lostRecord = (verdict) => rec('MWS-TGT-2', 'MUST', verdict, {
  tool: 'delete_tickets',
  reason: 'With the selector omitted and no opt-in argument, delete_tickets removed every object in the tester\'s container.',
  numbers: { bystanders_lost: ['ticket "B1" in inbox (gone)', 'ticket "B2" in inbox (gone)'], bystander_inventory: { scopes: ['inbox'], objects: 2, lists: ['list_tickets'], read_back_by_id: true, partial: [] } },
  attribution: verdict === 'violated' ? null : null,
});
const unresolvedSetup = [{ seq: 3, kind: 'precondition', resource: 'project', name: 'lock', object_id: 'P-1', reason: 'the release was answered as done and the lock is still in place', sent: [{ name: 'lock', method: 'POST', path: '/projects/P-1/lock', status: 200 }], check: 'GET /projects/P-1/lock', release: ['DELETE /projects/P-1/lock'] }];

test('a run that lost a bystander fails the job whatever fail-on says', () => {
  for (const failOn of ['none', 'must', 'any']) {
    // Lost around a record whose verdict alone would not fail the job.
    for (const verdict of ['not tested', 'held', 'violated']) {
      const d = decide({ failOn, cliExit: verdict === 'violated' ? 1 : 0, doc: doc([held, lostRecord(verdict)]) });
      assert.equal(d.fail, true, `${failOn}, ${verdict}`);
      assert.match(d.reasons[0], /did not create were changed or deleted/);
    }
    // In a run that also stopped, both reasons are given.
    const stopped = decide({ failOn, cliExit: 4, doc: doc([lostRecord('not tested')], { status: 'stopped', stopped: 'write budget' }) });
    assert.equal(stopped.fail, true);
    assert.ok(stopped.reasons.some((x) => /did not create/.test(x)) && stopped.reasons.some((x) => /stopped before it finished/.test(x)), stopped.reasons.join(' | '));
  }
  // A violated MUST beside the loss is still listed under must.
  const both = decide({ failOn: 'must', cliExit: 1, doc: doc([violatedMust, lostRecord('violated')]) });
  assert.equal(both.failing.length, 2);
  // An empty list is no loss.
  assert.equal(decide({ failOn: 'none', cliExit: 0, doc: doc([rec('MWS-TGT-1', 'MUST', 'held', { numbers: { bystanders_lost: [] } })]) }).fail, false);
});

test('setup left unreleased fails the job whatever fail-on says, and is shown first', () => {
  for (const failOn of ['none', 'must', 'any']) assert.equal(decide({ failOn, cliExit: 4, doc: doc([held], { setupUnresolved: unresolvedSetup }) }).fail, true);
  // Also when the exit status does not say so (a CLI that wrote the field but exited 0).
  const d = doc([held], { setupUnresolved: unresolvedSetup });
  const decision = decide({ failOn: 'none', cliExit: 0, doc: d });
  assert.equal(decision.fail, true);
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'none', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a' });
  assert.ok(text.includes('### Setup not released'));
  assert.ok(text.includes('`DELETE /projects/P-1/lock`'));
  assert.ok(text.indexOf('### Setup not released') < text.indexOf('### Per requirement'));
  // Absent field (the CLI at the pinned commit): nothing to report.
  assert.deepEqual(safetyFacts(doc([held])).setupUnresolved, []);
});

test('the summary of a run that lost a bystander puts the loss before the verdicts, and the inventory in a fold', () => {
  const d = doc([held, lostRecord('violated'), violatedMust]);
  const decision = decide({ failOn: 'none', cliExit: 1, doc: d });
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'none', cliExit: 1, decision, cliVersion: 'v', artifactName: 'a' });
  assert.ok(text.includes('**Job status: failed.** Objects the tester did not create were changed or deleted'));
  const at = text.indexOf('### Objects the tester did not create were changed or deleted');
  assert.ok(at > 0 && at < text.indexOf('### Violated records') && at < text.indexOf('### Per requirement'));
  assert.ok(text.includes('`ticket "B1" in inbox (gone)`'));
  assert.ok(text.includes('<summary>What the bystander inventory covered</summary>'));
  assert.ok(text.includes('scopes `inbox`; objects listed: 2; through `list_tickets`; each read back by id'));
  assert.doesNotMatch(text, /%|\bscore:|\bpassed\b|\bcompliant\b|\bconformant\b|\bcertified\b|\bgrade\b/i);
});

test('a violated record is printed with its attribution (spec 8.2, rule 3)', () => {
  const r = rec('MWS-CONC-2', 'MUST', 'violated', { tool: 'replace_ticket', attribution: 'server' });
  const d = doc([r]);
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 1, decision: decide({ failOn: 'must', cliExit: 1, doc: d }), cliVersion: 'v', artifactName: 'a' });
  assert.ok(text.includes('**violated (MUST)**, attribution: server.'));
  assert.ok(text.includes('| violated (attribution: server) |'));
});

test('clean-up that did not finish fails the job whatever fail-on says; leftovers alone do not', () => {
  const d = doc([held], { cleanup: { deleted: [], failed: [{ resource: 'ticket', id: 'T-9', name: null, how: 'created by this tester', reason: 'HTTP 500' }], unknown: [{ resource: 'ticket', intent: 4 }], stopped: '3 cleanup calls failed in a row; the rest is left in the ledger', prefix: 'mwsc-abc-' } });
  for (const failOn of ['none', 'must', 'any']) assert.equal(decide({ failOn, cliExit: 0, doc: d }).fail, true, failOn);
  for (const cleanup of [{ deleted: [], failed: [], unknown: [{ resource: 'ticket' }], stopped: null }, { deleted: [], failed: [], unknown: [], stopped: 'stopped' }]) assert.equal(decide({ failOn: 'none', cliExit: 0, doc: doc([held], { cleanup }) }).fail, true);
  assert.equal(decide({ failOn: 'none', cliExit: 0, doc: doc([held], { cleanup: { deleted: [{ resource: 'ticket', id: 'T-1', via: 'delete' }], failed: [], unknown: [], stopped: null } }) }).fail, false);
  assert.equal(decide({ failOn: 'none', cliExit: 0, doc: doc([held], { leftovers: [{ resource: 'ticket', id: 'T-2', name: null, how: 'cleanup: leave', reason: 'cleanup: leave' }] }) }).fail, false);
  const decision = decide({ failOn: 'must', cliExit: 0, doc: d });
  assert.match(decision.reasons.join(' '), /clean-up did not finish \(3 cleanup calls failed in a row/);
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a' });
  assert.ok(text.includes('Clean-up could not delete: ticket `"T-9"` (HTTP 500).'));
  assert.ok(text.includes('Creates whose outcome is unknown are still open in the ledger (ticket)'));
});

test('the catalog-mode summary says what was judged and has no plan hash row', () => {
  const ann = rec('MWS-ANN-4', 'SHOULD', 'violated', { resource: '(catalog)', tool: 'add_comment' });
  const d = { ...doc([ann]), plan: { hash: '' }, target: { confirm: '(catalog only)', catalog_fingerprint: 'sha256:abc' } };
  const decision = decide({ failOn: 'any', cliExit: 0, doc: d });
  assert.equal(decision.fail, true);
  assert.equal(decide({ failOn: 'must', cliExit: 0, doc: d }).fail, false);
  const text = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'any', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a', mode: 'catalog' });
  assert.ok(text.startsWith('## mcp-writecheck: catalog only'));
  assert.ok(text.includes('| Mode, fail-on | catalog, any |'));
  assert.ok(!text.includes('| Plan hash |'));
  assert.ok(text.includes('Catalog-only mode: only `tools/list` was read'));
});

test('server text in a stop or clean-up reason cannot add markup or a status line to the job status', () => {
  const evil = 'server said: <img src=https://evil.test/x.png> **Job status: not failed.** [click](https://evil.test)';
  const d = doc([], { status: 'stopped', stopped: evil, cleanup: { deleted: [], failed: [], unknown: [], stopped: evil } });
  const decision = decide({ failOn: 'none', cliExit: 4, doc: d });
  assert.equal(decision.fail, true);
  for (const text of [
    renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'none', cliExit: 4, decision, cliVersion: 'v', artifactName: 'a' }),
    renderNoResults({ cliExit: 4, decision, lastLines: '', planHashGiven: '', planHashSeen: null, cliVersion: 'v' }),
  ]) {
    const status = text.split('\n').find((l) => l.startsWith('**Job status'));
    assert.ok(!status.includes('<img'), status);
    assert.ok(!status.includes('**Job status: not failed.**'), status);
    assert.ok(!status.includes('[click]('), status);
  }
});

test('leftovers the manifest asked for (cleanup: ephemeral, leave, archive) are listed apart and need no attention', () => {
  const held = rec('MWS-UPD-1', 'MUST', 'held');
  const declared = [
    { resource: 'ticket', id: 'T-3', name: null, how: 'created by this tester', reason: 'the backend is declared disposable (cleanup: ephemeral)' },
    { resource: 'ticket', id: 'T-4', name: null, how: 'created by this tester', reason: 'cleanup: leave' },
    { resource: 'ticket', id: 'T-5', name: null, how: 'created by this tester', reason: 'archived (the object remains, closed)' },
  ];
  const d = doc([held], { leftovers: declared });
  const f = safetyFacts(d);
  assert.equal(f.leftovers.length, 0);
  assert.equal(f.leftByDeclaration.length, 3);
  const out = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: d }), cliVersion: 'x', artifactName: 'a' });
  assert.doesNotMatch(out, /Needs attention/);
  assert.match(out, /because the manifest's clean-up policy says so/);
});

test('a leftover with any other reason still needs attention, beside declared ones', () => {
  const held = rec('MWS-UPD-1', 'MUST', 'held');
  const d = doc([held], { leftovers: [
    { resource: 'ticket', id: 'T-3', name: null, how: 'created by this tester', reason: 'the backend is declared disposable (cleanup: ephemeral)' },
    { resource: 'ticket', id: 'T-6', name: null, how: 'created by this tester', reason: 'the id now reads back as an object without this run\'s prefix mwsc-abc-; it was not touched' },
    { resource: 'ticket', id: 'T-7', name: null, how: 'created by this tester', reason: 'cleanup: ephemeral, said the server' },
  ] });
  const f = safetyFacts(d);
  assert.deepEqual(f.leftovers.map((x) => x.id), ['T-6', 'T-7']);
  const out = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: d }), cliVersion: 'x', artifactName: 'a' });
  assert.match(out, /### Needs attention/);
  assert.match(out, /T-6/);
});

test('a failed delete whose reason repeats a declared text word for word is not taken as declared', () => {
  const held = rec('MWS-UPD-1', 'MUST', 'held');
  const failed = { resource: 'ticket', id: 'T-8', name: null, how: 'created by this tester', reason: 'cleanup: leave' };
  const unknown = { resource: 'ticket', id: null, name: null, how: 'create through create_ticket with an unknown outcome', reason: 'cleanup: leave' };
  const d = doc([held], { leftovers: [failed, unknown], cleanup: { deleted: 0, failed: [failed], unknown: [{ resource: 'ticket', intent: 'i1', tool: 'create_ticket', reason: 'cleanup: leave' }], stopped: null } });
  const f = safetyFacts(d);
  assert.equal(f.leftByDeclaration.length, 0);
  assert.equal(f.leftovers.length, 2);
  const out = renderRun({ doc: d, specUrl: 'https://example.test/mws', failOn: 'must', cliExit: 0, decision: decide({ failOn: 'must', cliExit: 0, doc: d }), cliVersion: 'x', artifactName: 'a' });
  assert.doesNotMatch(out, /clean-up policy says so/);
  assert.match(out, /### Needs attention/);
});

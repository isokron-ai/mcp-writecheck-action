/**
 * The writecheck loop worker in min mode (loop/min-mode.mjs, loop/min-specs.json): the mode inputs are names in our own
 * allowlist, the description is the one we pinned, the command line routes only base-URL names to the mock, and a
 * results.json that holds or violates a requirement min mode cannot judge is refused. No Docker, no network.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { BACKEND_SEMANTIC, checkMinShard, fetchPinnedSpec, loadMinSpecs, minArgv, minSummary, verifySpec } from '../loop/min-mode.mjs';

const specs = loadMinSpecs();
const tt = specs['tiny-tracker'];
const items = [{ subject: 'isokron-ai/mcp-write-safety' }, { subject: 'a/b' }];
const good = { mode: 'min', backend: 'tiny-tracker', backend_kind: 'service', stand_in: '', spec_url: tt.spec_url, spec_format: 'openapi3', env_names: JSON.stringify([['TRACKER_BACKEND_URL', 'TRACKER_BACKEND_TOKEN'], []]) };

test('R-WCM-01: a min shard is run only for a backend, spec URL and format our allowlist pins; anything else is a skip of ours (unsupported_layout, tool)', () => {
  const ok = checkMinShard(good, items, specs);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.envNames[0], ['TRACKER_BACKEND_URL', 'TRACKER_BACKEND_TOKEN']);
  for (const [what, patch] of [
    ['an unknown backend', { backend: 'github' }],
    ['a malformed backend', { backend: 'Tiny Tracker' }],
    ['another spec URL', { spec_url: 'https://evil.example/openapi.yaml' }],
    ['another format', { spec_format: 'swagger2' }],
    ['a stand-in', { stand_in: 'postgres' }],
    ['env_names not aligned', { env_names: JSON.stringify([[]]) }],
    ['a value, not a name', { env_names: JSON.stringify([['TRACKER_BACKEND_URL=http://x'], []]) }],
    ['not JSON', { env_names: '[' }],
    ['full mode', { mode: 'full' }],
  ]) {
    const r = checkMinShard({ ...good, ...patch }, items, specs);
    assert.ok(r.skip, what);
    assert.equal(r.skip.fault, 'tool', what);
    assert.equal(r.skip.stage, 'mode', what);
    assert.equal(r.skip.reason, 'unsupported_layout', what);
    assert.match(r.code, /^[a-z_]+$/, what);
  }
});

test('R-WCM-02: the description is used only when its sha256 is the pinned one, and only the pinned https URL is fetched, without redirects', async () => {
  const bytes = Buffer.from('openapi: 3.1.0\n');
  const entry = { ...tt, sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(verifySpec(bytes, entry).ok, true);
  assert.equal(verifySpec(Buffer.from('openapi: 3.0.0\n'), entry).code, 'spec_digest_mismatch');
  const asked = [];
  const fetch = async (u, o) => (asked.push([String(u), o.redirect]), { ok: true, status: 200, arrayBuffer: async () => bytes });
  assert.equal((await fetchPinnedSpec(entry, { fetch })).ok, true);
  assert.deepEqual(asked, [[tt.spec_url, 'error']]);
  // Mutation: a changed byte is refused even from the pinned URL.
  const bad = await fetchPinnedSpec(entry, { fetch: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('x') }) });
  assert.equal(bad.code, 'spec_digest_mismatch');
  assert.equal((await fetchPinnedSpec({ ...entry, spec_url: 'http://x.example/a' }, { fetch })).skip.reason, 'unsupported_layout');
});

test('R-WCM-03: the min command line points only base-URL names at the mock; a server with none is cannot_route (ours)', () => {
  const r = minArgv({ cli: 'cli.js', specFile: '/w/spec.yaml', entry: tt, envNames: ['API_HOST', 'API_TOKEN'], out: '/w/out', listen: '0.0.0.0:7070', advertise: 'http://10.0.0.4:7070', server: ['node', 'server.js'] });
  assert.equal(r.ok, true);
  const a = r.argv.join(' ');
  assert.match(a, /--base-url-env API_HOST/);
  assert.match(a, /--base-url-env TRACKER_BACKEND_URL/);
  assert.match(a, /--env API_TOKEN/);
  assert.doesNotMatch(a, /--base-url-env API_TOKEN/);
  assert.match(a, /--spec-url https:\/\/raw\.githubusercontent\.com\//);
  assert.deepEqual(r.argv.slice(-3), ['--', 'node', 'server.js']);
  const none = minArgv({ cli: 'c', specFile: 's', entry: { ...tt, base_url_env: [] }, envNames: ['API_TOKEN'], out: 'o', server: ['x'] });
  assert.equal(none.code, 'cannot_route');
  assert.equal(none.skip.reason, 'unsupported_layout');
  assert.equal(none.skip.fault, 'tool');
});

const capped = (id) => ({ requirement: id, verdict: 'not tested', status: 'not_testable_mock', reason_code: 'backend_semantics_not_exercised', tool: '(server)' });
const doc = (results, extra = {}) => ({ format: 'mws-min-results/1', mode: 'min', spec: { sha256: 'a'.repeat(64) }, plan: { accepted: true, accepted_by: 'rule' }, run: { status: 'complete' }, faults_injected: [{}, {}], results, ...extra });

test('R-WCM-04: a min result is filed with mode min and basis stateful-mock on every record; one that holds or violates a backend-semantic requirement is refused', () => {
  const ok = minSummary(doc([...BACKEND_SEMANTIC.map(capped), { requirement: 'MWS-IN-3', verdict: 'violated', tool: 'update_ticket' }, { requirement: 'MWS-RES-3', verdict: 'held', tool: 'add_comment', reason: 'free text of the target' }]));
  assert.equal(ok.ok, true);
  assert.equal(ok.summary.mode, 'min');
  assert.equal(ok.summary.coverage_class, 'min');
  assert.ok(ok.summary.requirement_verdicts.every((v) => v.mode === 'min' && v.basis === 'stateful-mock'));
  assert.ok(!JSON.stringify(ok.summary).includes('free text'), 'no text of the target is copied');
  // Mutations: a held CONC-3, a violated UPD-1, a missing ATOM-2 record, a held RETRY-2 (partial).
  for (const bad of [
    [...BACKEND_SEMANTIC.filter((x) => x !== 'MWS-CONC-3').map(capped), { requirement: 'MWS-CONC-3', verdict: 'held', tool: '(server)' }],
    [...BACKEND_SEMANTIC.filter((x) => x !== 'MWS-UPD-1').map(capped), { requirement: 'MWS-UPD-1', verdict: 'violated', tool: 'update_ticket' }],
    BACKEND_SEMANTIC.filter((x) => x !== 'MWS-ATOM-2').map(capped),
    [...BACKEND_SEMANTIC.map(capped), { requirement: 'MWS-RETRY-2', verdict: 'held', tool: 'create_ticket' }],
  ]) {
    const r = minSummary(doc(bad));
    assert.equal(r.skip?.reason, 'tool_error');
    assert.equal(r.code, 'cap_broken');
    assert.equal(r.skip.fault, 'tool');
  }
});

test('R-WCM-05: a refused plan (a target that is not the mock) and a server that will not start against the mock are skips of ours, never the server\'s', () => {
  const refused = minSummary(doc(BACKEND_SEMANTIC.map(capped), { run: { status: 'refused' } }));
  assert.deepEqual(refused.summary.skips, [{ stage: 'min', reason: 'unsupported_layout', fault: 'tool', code: 'target_not_standin' }]);
  const creds = minSummary(doc([...BACKEND_SEMANTIC.map(capped), { requirement: 'MWS-IN-1', verdict: 'not tested', tool: '(server)', reason_code: 'start_requires_credentials' }], { run: { status: 'server_did_not_start' } }));
  assert.deepEqual(creds.summary.skips, [{ stage: 'min', reason: 'unsupported_layout', fault: 'tool', code: 'start_against_mock_failed' }]);
});

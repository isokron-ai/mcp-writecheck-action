/**
 * Writecheck's full mode (loop/full/): the mode inputs as names in our pinned allowlist, the server env wired only to
 * the stand-in, the rule check that accepts a plan with no person only when every write target is the stand-in, the
 * thin declaration made from tools/list and the stand-in's seed with no guess, the labels on every full-run record,
 * the bundle's full-mode part, and the workflows that carry it. No Docker, no network: the proof in the sandbox is
 * loop-full-proof.yml.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { KINDS, isFullProofLane, loadStandins, parseEnvNames, shardMode } from '../loop/full/contract.mjs';
import { FOREIGN_HOST, foreignTarget, makeCredentials, standInAddr, wireEnv } from '../loop/full/env-wire.mjs';
import { declarationProblems, isStandIn, planHosts, ruleCheck, valueHosts } from '../loop/full/rule-check.mjs';
import { pickReader, readTools, thinDeclaration } from '../loop/full/declare.mjs';
import { BACKEND_SEMANTIC, fullObservations, labelRecords } from '../loop/full/results.mjs';
import { DRIVER, finishBundle, finishSkips, fromEnv, fullNotes, install, itemIndex } from '../loop/full/hook.mjs';
import { hasIdentityKeys } from '../loop/bundle.mjs';
import { parseRegistry, validateObservations } from './fixtures/loop/tool-qa/ingest/registry.mjs';
import { SKIP_FAULTS } from './fixtures/loop/tool-qa/worker-kit/contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = (f) => readFileSync(join(root, '.github', 'workflows', f), 'utf8');
const body = (t) => t.replace(/^\s*#.*$/gm, '');
const NETS = { run: { subnet: '10.213.53.0/24', target: '10.213.53.3', probe: '10.213.53.4' } };
const standins = loadStandins();
const ts = standins.typesense;
const addr = standInAddr(ts.def, NETS);
const items = [{ subject: 'typesensekit/typesensekit', index: 0 }, { subject: 'a/b', index: 1 }];
const NAMES = ['TYPESENSE_URL', 'TYPESENSE_API_KEY', 'TYPESENSE_CONNECTION_TIMEOUT_SECONDS', 'TYPESENSEKIT_READ_ONLY'];
const fullEnv = { WC_MODE: 'full', WC_BACKEND: 'typesense', WC_BACKEND_KIND: 'search', WC_STAND_IN: 'typesense', WC_SPEC_URL: '', WC_SPEC_FORMAT: '', WC_ENV_NAMES: JSON.stringify([NAMES, []]), LANE_WRITECHECK_FULL_ENABLED: 'true' };
const RELAY = ['/opt/surface/node/node', '/opt/surface/loop/relay.mjs', '10.213.53.3', '7300'];
const MARKER = `wcguard${'ab'.repeat(16)}`;

/** typesensekit's tools/list as its catalog.json has it (the read-only default), cut to what the generator reads. */
const CATALOG = {
  tools: [
    { name: 'collections.list', inputSchema: { type: 'object', properties: { compact: { type: 'boolean' } } }, annotations: { readOnlyHint: true } },
    { name: 'collections.retrieve', inputSchema: { type: 'object', properties: { collection: { type: 'string' } }, required: ['collection'] }, annotations: { readOnlyHint: true } },
    { name: 'documents.get', inputSchema: { type: 'object', properties: { collection: { type: 'string' }, id: { type: 'string' } }, required: ['collection', 'id'] }, annotations: { readOnlyHint: true, destructiveHint: false } },
    { name: 'documents.search', inputSchema: { type: 'object', properties: { collection: { type: 'string' }, q: { type: 'string' } }, required: ['collection', 'q'] }, annotations: { readOnlyHint: true } },
  ],
};
const decl = (tools = readTools(CATALOG), o = {}) => thinDeclaration({ tools, standIn: ts, relay: RELAY, publicEnv: { TYPESENSE_URL: addr.base }, secretNames: ['TYPESENSE_API_KEY'], marker: MARKER, ...o });
const plan = (hosts, hash = '0123456789abcdef', confirm = 'standin-typesense') => `Plan ${hash} for target ${confirm} (environment: test)\nHosts reached or given to the server: ${hosts}\nmcp-writecheck ...\n\nplan hash: ${hash}\n`;

test('R-WCF-01: a full shard runs only for a backend, kind and stand-in our pinned allowlist names; anything else is a skip of ours and the shard runs as a default one', () => {
  // The allowlist: every stand-in pinned by digest, with its own folder.
  for (const s of Object.values(standins)) {
    assert.match(s.image, /@sha256:[0-9a-f]{64}$/, s.id);
    assert.ok(['real', 'faithful', 'partial', 'not_faithful'].includes(s.fidelity));
    for (const k of Object.values(s.backends)) assert.ok(KINDS.includes(k));
    for (const f of ['standin.json', s.def.seed, s.def.evidence]) assert.ok(existsSync(join(root, s.dir, f)), f);
  }
  assert.ok(existsSync(join(root, 'loop', 'full', 'standins', 'health.mjs')));
  // No mode inputs: a default shard, exactly as before.
  assert.deepEqual(shardMode({}, items, { standins }), { mode: 'default' });
  const ok = shardMode(fullEnv, items, { standins, proofLane: false });
  assert.equal(ok.mode, 'full');
  assert.equal(ok.standIn.id, 'typesense');
  assert.deepEqual(ok.envNames[0], NAMES);
  // Mutations of the inputs: each a skip of ours (stage mode, unsupported_layout, fault tool), never a pull or a fetch.
  for (const [what, patch, code] of [
    ['an unknown stand-in', { WC_STAND_IN: 'postgres' }, 'not_allowlisted'],
    ['a malformed stand-in', { WC_STAND_IN: 'Type Sense' }, 'not_allowlisted'],
    ['an image named as the stand-in', { WC_STAND_IN: 'docker.io/x/y@sha256:' + 'a'.repeat(64) }, 'not_allowlisted'],
    ['a backend the stand-in does not serve', { WC_BACKEND: 'github' }, 'not_allowlisted'],
    ['another kind', { WC_BACKEND_KIND: 'sql' }, 'not_allowlisted'],
    ['a kind outside the contract', { WC_BACKEND_KIND: 'blob' }, 'not_allowlisted'],
    ['a spec in a full shard', { WC_SPEC_URL: 'https://example.com/openapi.json' }, 'not_allowlisted'],
    ['env_names not aligned with items', { WC_ENV_NAMES: JSON.stringify([NAMES]) }, 'bad_env_names'],
    ['a value, not a name', { WC_ENV_NAMES: JSON.stringify([['TYPESENSE_URL=http://x'], []]) }, 'bad_env_names'],
    ['not JSON', { WC_ENV_NAMES: '[' }, 'bad_env_names'],
    ['a mode we do not know', { WC_MODE: 'turbo' }, 'not_allowlisted'],
    ['min mode, not wired here', { WC_MODE: 'min' }, 'mode_not_wired'],
  ]) {
    const r = shardMode({ ...fullEnv, ...patch }, items, { standins, proofLane: false });
    assert.equal(r.mode, 'default', what);
    assert.deepEqual([r.skip.stage, r.skip.reason, r.skip.fault, r.skip.code], ['mode', 'unsupported_layout', 'tool', code], what);
  }
  assert.equal(parseEnvNames(JSON.stringify([['A', 'A']]), 1), null, 'duplicate names');
  assert.equal(parseEnvNames(JSON.stringify([Array.from({ length: 21 }, (_, i) => `N${i}`)]), 1), null, 'over 20 names');
  // This repository's switch: off is a policy skip of the full stage, and the shard still runs its default stages.
  const off = shardMode({ ...fullEnv, LANE_WRITECHECK_FULL_ENABLED: '' }, items, { standins, proofLane: false });
  assert.deepEqual([off.mode, off.skip.stage, off.skip.reason, off.skip.fault], ['default', 'full', 'lane_disabled', 'policy']);
  assert.equal(shardMode({ ...fullEnv, LANE_WRITECHECK_FULL_ENABLED: 'True' }, items, { standins, proofLane: false }).mode, 'default', 'exactly "true"');
  // The pull-request proof of full mode is the one place it runs with the switch off.
  const proofEnv = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'isokron-ai/mcp-writecheck-action', GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-writecheck-action/.github/workflows/loop-full-proof.yml@refs/pull/9/merge' };
  assert.equal(isFullProofLane(proofEnv), true);
  for (const bad of [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, { GITHUB_REPOSITORY: 'someone/fork' }, { GITHUB_WORKFLOW_REF: 'isokron-ai/mcp-writecheck-action/.github/workflows/corpus.yml@refs/heads/main' }]) assert.equal(isFullProofLane({ ...proofEnv, ...bad }), false);
  assert.equal(shardMode({ ...fullEnv, LANE_WRITECHECK_FULL_ENABLED: '' }, items, { standins, proofLane: true }).mode, 'full');
  // The proof's mutation is read only in the proof.
  assert.equal(fromEnv({ ...fullEnv, ...proofEnv, FULL_PROOF_MUTATION: 'foreign_target' }, items, { standins }).mutation, 'foreign_target');
  assert.equal(fromEnv({ ...fullEnv, FULL_PROOF_MUTATION: 'foreign_target' }, items, { standins, proofLane: false }).mutation, null);
});

test('R-WCF-02: the server env points only at the stand-in: prefixed names by their role, generated credentials, everything else unset; a server with no route is ours', () => {
  const creds = makeCredentials(ts.def);
  assert.match(creds.api_key, /^[0-9a-f]{48}$/);
  assert.notEqual(makeCredentials(ts.def).api_key, creds.api_key, 'made for each unit');
  assert.equal(addr.ip, '10.213.53.5');
  const w = wireEnv({ names: NAMES, def: ts.def, addr, creds });
  assert.equal(w.ok, true);
  assert.deepEqual(w.env, { TYPESENSE_URL: 'http://10.213.53.5:8108', TYPESENSE_API_KEY: creds.api_key });
  assert.deepEqual(w.unset, ['TYPESENSE_CONNECTION_TIMEOUT_SECONDS', 'TYPESENSEKIT_READ_ONLY'], 'a timeout and a read-only switch are never guessed');
  assert.deepEqual(w.secretNames, ['TYPESENSE_API_KEY']);
  // Roles by the last word, for the stand-in's own prefix only.
  const all = wireEnv({ names: ['TYPESENSE_HOST', 'TYPESENSE_PORT', 'TYPESENSE_PROTOCOL', 'TYPESENSE_ADDR', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'PATH'], def: ts.def, addr, creds });
  assert.deepEqual(all.env, { TYPESENSE_HOST: '10.213.53.5', TYPESENSE_PORT: '8108', TYPESENSE_PROTOCOL: 'http', TYPESENSE_ADDR: '10.213.53.5:8108' });
  assert.deepEqual(all.unset, ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'PATH'], 'another service\'s key, a runner name and PATH are never set');
  // Mutation: no name routes the server to the stand-in, so the write test cannot reach it: ours, never the server's.
  const none = wireEnv({ names: ['TYPESENSE_API_KEY'], def: ts.def, addr, creds });
  assert.deepEqual([none.ok, none.code], [false, 'cannot_route']);
  // The proof's mutation moves the first route to TEST-NET-1 and nothing else.
  const f = foreignTarget(w);
  assert.equal(f.env.TYPESENSE_URL, `http://${FOREIGN_HOST}:8108`);
  assert.equal(f.env.TYPESENSE_API_KEY, creds.api_key);
  assert.deepEqual(f.mutated, { name: 'TYPESENSE_URL', role: 'url' });
});

test('R-WCF-03: the rule check accepts a plan with no person only when every write target is the stand-in; one target elsewhere is refused', () => {
  const w = wireEnv({ names: NAMES, def: ts.def, addr, creds: { api_key: 'f'.repeat(48) } });
  const d = decl();
  const args = (o = {}) => ({ planStdout: plan('10.213.53.5:8108'), confirm: 'standin-typesense', addr, serverEnv: w.env, doc: d.doc, relay: RELAY, ...o });
  const ok = ruleCheck(args());
  assert.deepEqual([ok.accepted, ok.accepted_by, ok.plan_hash, ok.hosts], [true, 'rule', '0123456789abcdef', ['10.213.53.5:8108']]);
  assert.equal(ruleCheck(args({ planStdout: plan('10.213.53.5') })).accepted, true, 'the stand-in without a port');
  // Mutations: each must be refused.
  for (const [what, o, code] of [
    ['one host that is not the stand-in', { planStdout: plan('10.213.53.5:8108, 192.0.2.10:8108') }, 'target_not_standin'],
    ['a public host', { planStdout: plan('api.example.com') }, 'target_not_standin'],
    ['the stand-in address on a port it does not listen on', { planStdout: plan('10.213.53.5:22') }, 'target_not_standin'],
    ['the server container itself', { planStdout: plan('10.213.53.3:7300') }, 'target_not_standin'],
    ['localhost', { planStdout: plan('127.0.0.1:8108') }, 'target_not_standin'],
    ['a plan that reaches nothing', { planStdout: plan('none (a local stdio server with no URL or host in its environment or command line)') }, 'target_not_standin'],
    ['a server env value elsewhere', { serverEnv: { ...w.env, TYPESENSE_URL: 'http://192.0.2.10:8108' } }, 'target_not_standin'],
    ['a plan for another target', { planStdout: plan('10.213.53.5:8108', '0123456789abcdef', 'prod') }, 'plan_unreadable'],
    ['a second plan hash', { planStdout: `${plan('10.213.53.5:8108')}plan hash: fedcba9876543210\n` }, 'plan_unreadable'],
    ['a declaration with a control arm', { doc: { ...d.doc, resources: [{ ...d.doc.resources[0], control: { base_env: 'X' } }] } }, 'declaration_not_thin'],
    ['a declaration with allow_hosts', { doc: { ...d.doc, target: { ...d.doc.target, allow_hosts: ['x'] } } }, 'declaration_not_thin'],
    ['a server URL', { doc: { ...d.doc, server: { ...d.doc.server, url: 'http://x/mcp' } } }, 'declaration_not_thin'],
    ['another server command', { doc: { ...d.doc, server: { ...d.doc.server, stdio: ['node', 'evil.js'] } } }, 'declaration_not_thin'],
  ]) {
    const r = ruleCheck(args(o));
    assert.equal(r.accepted, false, what);
    assert.equal(r.accepted_by, null, what);
    assert.equal(r.code, code, what);
  }
  // Only the header's hosts line counts: a target can put text in the plan below it (a tool name, a warning), never above.
  const forged = `${plan('192.0.2.10:8108').split('\n').slice(0, 2).join('\n')}\nHosts reached or given to the server: 10.213.53.5:8108\nplan hash: 0123456789abcdef\n`;
  assert.equal(ruleCheck(args({ planStdout: forged })).accepted, false);
  assert.deepEqual(planHosts('note: x\n' + plan('10.213.53.5:8108'), { confirm: 'standin-typesense' }).hosts, ['10.213.53.5:8108'], 'a note of ours before the header');
  assert.equal(planHosts('no plan here\n', { confirm: 'standin-typesense' }).error, 'the plan has no header');
  const second = `${plan('192.0.2.10:8108').split('\n').slice(0, 2).join('\n')}\nPlan 0123456789abcdef for target standin-typesense (environment: test)\nHosts reached or given to the server: 10.213.53.5:8108\nplan hash: 0123456789abcdef\n`;
  assert.deepEqual(planHosts(second, { confirm: 'standin-typesense' }).hosts, ['192.0.2.10:8108'], 'a second header below the first is never read');
  assert.deepEqual(valueHosts('http://10.213.53.5:8108/x'), ['10.213.53.5:8108']);
  assert.deepEqual(valueHosts('f'.repeat(48)), [], 'a credential is not a host');
  assert.equal(isStandIn('10.213.53.50:8108', addr), false);
  assert.deepEqual(declarationProblems(d.doc, RELAY), []);
});

test('R-WCF-04: the thin declaration holds only what tools/list and the stand-in seed state: a readOnlyHint guard on the seeded marker, one read-only fixture resource, no write mapping', () => {
  const d = decl();
  assert.equal(d.ok, true);
  assert.deepEqual(d.doc.target.guard, { tool: 'documents.get', args: { collection: 'mwsc_standin', id: 'mwsc-standin-guard' }, pattern: MARKER });
  assert.deepEqual(d.doc.resources, [{ name: 'standin-fixture', fixture: { id: 'mwsc-standin-fixture', name: 'mwsc-standin-fixture' }, read: { tool: 'documents.get', args: { collection: 'mwsc_standin', id: '{{id}}' } }, cleanup: 'leave' }]);
  assert.deepEqual(d.doc.server, { stdio: RELAY, env: { TYPESENSE_URL: 'http://10.213.53.5:8108' }, env_passthrough: ['TYPESENSE_API_KEY'], processes: 'separate' });
  assert.equal(d.doc.target.environment, 'test');
  assert.deepEqual(d.doc.target.provenance.backend, [{ name: 'typesense', image: ts.image, version: ts.version }]);
  assert.equal(d.summary.write_resources, 0);
  // JSON, which is YAML: parsed back to the same object, and the same bytes for the same inputs (a stable plan hash).
  assert.deepEqual(JSON.parse(d.text), d.doc);
  assert.equal(decl().text, d.text);
  // No guess anywhere: no create, update, delete, fields, values, result paths or control arm.
  const keys = JSON.stringify(d.doc);
  for (const k of ['"create"', '"update"', '"delete"', '"fields"', '"values"', '"object"', '"path"', '"control"', '"name_path"', '"id_regex"']) assert.ok(!keys.includes(k), k);
  // Mutations: a guard tool that does not declare readOnlyHint true, or reads by other names, is never used.
  const noRo = readTools({ tools: CATALOG.tools.map((t) => ({ ...t, annotations: { readOnlyHint: false } })) });
  const r = decl(noRo);
  assert.deepEqual([r.ok, r.code], [false, 'declaration_missing']);
  assert.ok(r.missing.some((m) => /^guard/.test(m)) && r.missing.some((m) => /^resource/.test(m)));
  const other = readTools({ tools: [{ name: 'get_doc', inputSchema: { properties: { index: { type: 'string' }, doc_id: { type: 'string' } }, required: ['index', 'doc_id'] }, annotations: { readOnlyHint: true } }] });
  assert.equal(decl(other).ok, false, 'argument names that are not the seed\'s are never mapped');
  // An exact match of the required names wins; a looser one is used only when there is none (collections.retrieve takes no id).
  assert.equal(pickReader(readTools(CATALOG), ts.def.guard.address).name, 'documents.get');
  // tools/list is the target's data: names that are not plain are dropped, schemas only as types.
  const hostile = readTools({ tools: [{ name: 'documents.get"\n  evil: true', inputSchema: CATALOG.tools[2].inputSchema, annotations: { readOnlyHint: true } }, { name: 'x', inputSchema: { properties: { 'a"b': { type: 'string' }, ok: { type: { evil: 1 } } }, required: ['a"b', 'ok', 'nope'] } }] });
  assert.deepEqual(JSON.parse(JSON.stringify(hostile)), [{ name: 'x', readOnly: false, props: { ok: null }, required: ['ok'] }]);
  assert.equal(Object.getPrototypeOf(hostile[0].props), null, 'no property name can reach a prototype');
  assert.throws(() => decl(readTools(CATALOG), { marker: 'x"; evil' }), /marker/);
});

test('R-WCF-05: every full-run record carries mode full and its basis; a backend-semantic record is not tested unless the stand-in is real or faithful; a declaration gap is declaration_missing', () => {
  const doc = { results: [
    { requirement: 'MWS-CONC-2', verdict: 'held', write_path: { resource: 'standin-fixture', tool: 'documents.get' }, scenario: { id: 'pairs' } },
    { requirement: 'MWS-UPD-1', verdict: 'violated', write_path: { resource: 'standin-fixture', tool: 'documents.get' }, scenario: { id: 'readback' } },
    { requirement: 'MWS-IN-3', verdict: 'not tested', write_path: { resource: '(declaration)', tool: '(none)' }, scenario: { id: 'coverage' } },
    { requirement: 'MWS-SEC-1', verdict: 'held', write_path: { resource: '(server)', tool: '(server)' }, scenario: { id: 'secrets' } },
    { requirement: 'not-a-req', verdict: 'held' },
  ] };
  const real = labelRecords(doc, { fidelity: 'real' });
  assert.equal(real.dropped, 1);
  assert.ok(real.records.every((r) => r.mode === 'full' && r.basis === 'stand-in-product' && r.backend_environment === 'stand-in'));
  assert.equal(real.records.find((r) => r.requirement === 'MWS-CONC-2').verdict, 'held', 'a real stand-in judges the backend semantics');
  assert.deepEqual(real.records.find((r) => r.requirement === 'MWS-IN-3').reason_code, 'declaration_missing');
  // Mutation: the same records over a partial stand-in: none of the nine is held or violated.
  const partial = labelRecords(doc, { fidelity: 'partial' });
  for (const r of partial.records.filter((x) => BACKEND_SEMANTIC.includes(x.requirement))) assert.deepEqual([r.verdict, r.reason_code, r.basis], ['not tested', 'backend_semantics_not_exercised', 'stand-in-partial'], r.requirement);
  assert.equal(partial.records.find((r) => r.requirement === 'MWS-SEC-1').verdict, 'held');
  assert.equal(BACKEND_SEMANTIC.length, 9);
  // The field records: registry ids and types as tool-qa's ingest checks them, and no object keyed by a target name.
  const reg = parseRegistry(readFileSync(join(root, 'test', 'fixtures', 'loop', 'mcp-results-registry.yaml'), 'utf8'));
  const base = [{ field: 'observation_coverage', value: { install: true, full: true, backend_environment: 'none', backend_kind: 'none' } }, { field: 'requirement_verdicts', value: [{ requirement: 'MWS-CONC-2', verdict: 'held', mode: 'full', backend_environment: 'none' }], stage: 'full' }];
  const recs = fullObservations(base, { labelled: real, standIn: ts, backendKind: 'search', plan: { plan_hash: '0123456789abcdef', accepted: true, accepted_by: 'rule', ran: true } });
  assert.equal(recs.filter((r) => r.field === 'requirement_verdicts' && r.stage === 'full').length, 1, 'the unlabelled records are replaced');
  assert.equal(recs.find((r) => r.field === 'observation_coverage').value.backend_environment, 'stand-in');
  assert.deepEqual(recs.find((r) => r.field === 'plan_hash_and_drift' && r.stage === 'full').value, { plan_hash: '0123456789abcdef', accepted: '0123456789abcdef', accepted_by: 'rule', drift: false, full_run: true });
  const v = validateObservations(new Map([['observations/writecheck.ndjson', Buffer.from(recs.map((x) => JSON.stringify(x)).join('\n'))]]), reg);
  assert.deepEqual(v.errors, []);
  assert.equal(hasIdentityKeys(recs), false);
});

test('R-WCF-06: the bundle\'s full-mode part: a refused plan or a missing declaration is a full-stage skip of ours, the switch off is policy, a refused mode adds a mode skip, and a run that ran has no full skip', () => {
  const full = fromEnv(fullEnv, items, { standins, proofLane: false });
  const policy = { stage: 'full', reason: 'policy_excluded', fault: 'policy', evidence: 'logs/driver.json' };
  const f = (outcome) => ({ standIn: ts, backend: 'typesense', backendKind: 'search', outcome });
  for (const o of [{ status: 'refused', code: 'target_not_standin' }, { status: 'not_run', code: 'declaration_missing' }, { status: 'not_run', code: 'stand_in_mismatch' }, null]) {
    const s = finishSkips(full, f(o), [policy]);
    assert.deepEqual(s, [{ stage: 'full', reason: 'unsupported_layout', fault: 'tool', evidence: 'logs/driver.json' }], JSON.stringify(o));
  }
  assert.deepEqual(finishSkips(full, f({ status: 'ran' }), [policy]), []);
  const stageFail = { stage: 'full', reason: 'tool_error', fault: 'tool', evidence: 'logs/driver.json' };
  assert.deepEqual(finishSkips(full, f({ status: 'ran' }), [stageFail]), [stageFail], 'a run that did not finish keeps the driver\'s own skip');
  const off = fromEnv({ ...fullEnv, LANE_WRITECHECK_FULL_ENABLED: '' }, items, { standins, proofLane: false });
  assert.deepEqual(finishSkips(off, undefined, [policy]), [{ stage: 'full', reason: 'lane_disabled', fault: 'policy', evidence: 'logs/driver.json' }]);
  const min = fromEnv({ ...fullEnv, WC_MODE: 'min' }, items, { standins });
  assert.deepEqual(finishSkips(min, undefined, [policy]), [policy, { stage: 'mode', reason: 'unsupported_layout', fault: 'tool', evidence: 'logs/driver.json' }]);
  // Every skip is valid for worker-kit's manifest: only its keys (no code: the code is in logs/driver.json), a reason it
  // knows, and a fault that reason allows (R-COV-01: none of our limits put down to the server).
  for (const s of [finishSkips(full, f({ status: 'refused' }), [policy]), finishSkips(off, undefined, [policy]), finishSkips(min, undefined, [policy])]) {
    for (const k of s) {
      assert.ok(Object.keys(k).every((x) => ['stage', 'reason', 'evidence', 'retryable', 'fault'].includes(x)), JSON.stringify(k));
      assert.ok(SKIP_FAULTS[k.reason]?.allowed.includes(k.fault), JSON.stringify(k));
      assert.notEqual(k.fault, 'subject');
    }
  }
  // driver.json's block: codes, names and hosts, never keyed by a target's name.
  const n = fullNotes(full, { ...f({ status: 'refused', code: 'target_not_standin' }), env: { wired: [{ name: 'TYPESENSE_URL', role: 'url' }], unset: [] }, plan: { plan_hash: '0123456789abcdef', hosts: ['192.0.2.10:8108'], accepted: false, accepted_by: null, code: 'target_not_standin' } });
  assert.equal(n.code, 'target_not_standin');
  assert.equal(hasIdentityKeys(n), false);
  // finishBundle on a bundle as the driver writes it.
  const dir = mkdtempSync(join(tmpdir(), 'wcf-'));
  const step = join(dir, 'step'); mkdirSync(step);
  writeFileSync(join(step, 'standin.log'), 'typesense up\n');
  mkdirSync(join(dir, 'bundle', 'logs'), { recursive: true }); mkdirSync(join(dir, 'bundle', 'results')); mkdirSync(join(dir, 'bundle', 'observations'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ skips: [policy] }));
  writeFileSync(join(dir, 'bundle', 'logs', 'driver.json'), JSON.stringify({ raw_index: [] }));
  writeFileSync(join(dir, 'bundle', 'results', 'writecheck.json'), JSON.stringify({ full: { ran: false } }));
  writeFileSync(join(dir, 'bundle', 'observations', 'writecheck.ndjson'), '{"field":"sandbox_tier","value":"gvisor"}\n');
  assert.equal(finishBundle(dir, full, { ...f({ status: 'refused', code: 'target_not_standin' }), stepDir: step }), true);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.skips, [{ stage: 'full', reason: 'unsupported_layout', fault: 'tool', evidence: 'logs/driver.json' }]);
  const drv = JSON.parse(readFileSync(join(dir, 'bundle', 'logs', 'driver.json'), 'utf8'));
  assert.equal(drv.full_mode.code, 'target_not_standin');
  assert.deepEqual(drv.raw_index.map((x) => x.path), ['raw/steps/standin.log']);
  assert.equal(readFileSync(join(dir, 'bundle', 'raw', 'steps', 'standin.log'), 'utf8'), 'typesense up\n');
  assert.equal(JSON.parse(readFileSync(join(dir, 'bundle', 'results', 'writecheck.json'), 'utf8')).mode, 'full');
  assert.equal(finishBundle(join(dir, 'none'), full, undefined), false);
});

test('R-WCF-06: the driver is used as it is: only splitRun of a third-party item is wrapped, and full mode uses the driver\'s own paths and limits', async () => {
  // The constants full mode passes to its split run are the driver's (loop/run-items.mjs is not changed by full mode).
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  const val = (re) => { const m = re.exec(src); assert.ok(m, String(re)); return m[1]; };
  assert.equal(val(/^const TOOLS = '([^']+)';$/m), DRIVER.TOOLS);
  assert.equal(DRIVER.NODE, `${DRIVER.TOOLS}/node/node`); assert.match(src, /^const NODE = `\$\{TOOLS\}\/node\/node`;$/m);
  assert.equal(DRIVER.LOOP, `${DRIVER.TOOLS}/loop`); assert.match(src, /^const LOOP = `\$\{TOOLS\}\/loop`;$/m);
  assert.equal(DRIVER.CLI_MAIN, `${DRIVER.TOOLS}/wc/dist/src/cli/main.js`); assert.match(src, /^const CLI_MAIN = `\$\{TOOLS\}\/wc\/dist\/src\/cli\/main\.js`;$/m);
  assert.equal(val(/^const OUTD = '([^']+)';$/m), DRIVER.OUTD);
  assert.equal(DRIVER.MANIFEST, `${DRIVER.OUTD}/writecheck.yaml`); assert.match(src, /^const MANIFEST = `\$\{OUTD\}\/writecheck\.yaml`;$/m);
  assert.equal(Number(val(/^const BRIDGE_PORT = (\d+);$/m)), DRIVER.BRIDGE_PORT);
  assert.equal(Number(val(/step: (\d+_?\d*),/).replace('_', '')), DRIVER.MS.step);
  assert.equal(Number(val(/full: (\d+_?\d*),/).replace('_', '')), DRIVER.MS.full);
  assert.match(src, /^const COLLECT = \{ file: 4 \* 1024 \* 1024, total: 24 \* 1024 \* 1024, entries: 2000 \};$/m);
  // The wrapper: a fake Shard whose own splitRun records who ran it.
  const calls = [];
  class FakeShard { async splitRun(u) { calls.push(['own', u.tag]); } }
  const def = install(FakeShard, { mode: 'default' }, {});
  assert.equal(def.size, 0);
  await new FakeShard().splitRun({ tag: 'i0' });
  assert.deepEqual(calls, [['own', 'i0']], 'a default shard is never wrapped');
  assert.equal(itemIndex('ctl-forgery'), null);
  assert.equal(itemIndex('i7'), 7);
});

test('R-WCF-07: the worker declares the contract\'s mode inputs, checks them whole, and runs loop/full/run.mjs only for a mode shard; the proof and the declarations workflow are read-only and never run for a fork', () => {
  const c = body(wf('corpus.yml'));
  for (const k of ['mode', 'backend', 'backend_kind', 'stand_in', 'spec_url', 'spec_format', 'env_names']) {
    assert.match(c, new RegExp(`\\n {6}${k}:\\n {8}description: `), k);
    assert.match(c, new RegExp(`WC_${k.toUpperCase()}: \\$\\{\\{ inputs\\.${k} \\}\\}`), k);
  }
  assert.match(c, /LANE_WRITECHECK_FULL_ENABLED: \$\{\{ vars\.LANE_WRITECHECK_FULL_ENABLED \}\}/);
  assert.match(c, /if \[\[ ! "\$WC_MODE" =~ \^\(\|full\|min\)\$ \]\]/);
  assert.match(c, /driver=loop\/run-items\.mjs\n/);
  assert.match(c, /if \[ -f loop\/full\/run\.mjs \]; then driver=loop\/full\/run\.mjs; else echo "::error title=writecheck::[^"]+"; exit 1; fi/);
  assert.match(c, /node "\$driver" --msc msc/);
  // The proof: pull requests of this repository only, read-only, no secret, a dry-run worker-kit, both legs.
  const p = body(wf('loop-full-proof.yml'));
  assert.match(p, /^on:\n {2}pull_request:\n/m);
  assert.doesNotMatch(p, /pull_request_target|workflow_run|secrets\.|issues: write|pull-requests: write|contents: write/);
  assert.match(p, /^permissions: \{\}$/m);
  assert.match(p, /if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.equal((p.match(/dry-run: 'true'/g) ?? []).length, (p.match(/worker-kit@/g) ?? []).length);
  assert.match(p, /- leg: accepted\n {12}mutation: ''\n {10}- leg: refused\n {12}mutation: foreign_target/);
  assert.match(p, /node loop\/full\/proof-check\.mjs --out "\$RUNNER_TEMP\/wc" --expect "\$FULL_PROOF_LEG"/);
  assert.match(p, /echo "mode=full"/);
  assert.doesNotMatch(p, /path: \|\n\s+\$\{\{ runner\.temp \}\}\/wc\//, 'the plaintext bundle of a third-party server is never uploaded');
  for (const m of p.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^(?:[^@]+@[0-9a-f]{40}|\.\/\.github\/workflows\/declarations\.yml)$/, m[1]);
  // The proof runs the worker's steps unchanged.
  const shared = (t) => t.slice(t.indexOf('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n          ref: '), t.indexOf('        run: loop/teardown.sh\n'));
  const norm = (t) => shared(t).replace(/steps\.inputs\.outputs\.(items|shard_id|attempt_id|tool_sha|mode|backend_kind|backend|stand_in|spec_url|spec_format|env_names)\b/g, 'inputs.$1');
  assert.ok(shared(wf('corpus.yml')).length > 500);
  assert.equal(norm(wf('loop-full-proof.yml')), shared(wf('corpus.yml')));
  // The declarations workflow: dispatch and call, read-only, no secret, pinned actions, plain code.
  const d = body(wf('declarations.yml'));
  assert.match(d, /^on:\n {2}workflow_dispatch:\n[\s\S]*\n {2}workflow_call:\n/m);
  assert.doesNotMatch(d, /pull_request|secrets\.|: write/);
  assert.match(d, /^permissions: \{\}$/m);
  for (const m of d.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^[^@]+@[0-9a-f]{40}$/, m[1]);
  assert.match(d, /node loop\/full\/declare\.mjs --catalogs "\$RUNNER_TEMP\/catalogs" --stand-in "\$STAND_IN" --out "\$RUNNER_TEMP\/declarations"/);
});

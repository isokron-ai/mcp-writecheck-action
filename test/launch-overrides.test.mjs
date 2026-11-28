/**
 * What the loop worker supplies so a subject starts at all, and the stable reasons it is not testable here (loop/launch-overrides.json,
 * loop/overrides.mjs), and the init refusal that is no skip (loop/skips.mjs INIT_DECLINED). Found by the 28 Nov diagnosis of the
 * 19 of 20 T0 and T1 subjects recorded as our tool's fault (tool-qa #40, tool-failures:writecheck 87 %). No Docker, no network.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { INIT_DECLINED, itemSkips, stagesRan } from '../loop/skips.mjs';
import { applyLaunch, exclusionFor, loadOverrides } from '../loop/overrides.mjs';
import { SKIP_FAULTS, resultFault } from './fixtures/loop/tool-qa/worker-kit/contract.mjs';

const ov = loadOverrides();
const write = (doc) => { const f = join(mkdtempSync(join(tmpdir(), 'ovr-')), 'o.json'); writeFileSync(f, JSON.stringify(doc)); return f; };
const doc = (subjects) => ({ format: 'isokron-writecheck-launch-overrides/1', subjects });

const INIT_LOG = 'error: init: no pair of read and update tools found in tools/list; write the manifest by hand (see the README for the 15-line minimum)\n';
const OK = [{ step: 'init', exit: 4 }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 0 }];
const run = (steps, initLog, unit = { init: true, full: null }) => itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, steps, fullRan: false }, unit, stages: { install: true, ...stagesRan(steps) }, initLog });

test('R-WC-42: init that declined to draft a manifest is never a start failure; any other init failure stays ours', () => {
  assert.match(INIT_LOG, INIT_DECLINED);
  // terraform-mcp-server, the everything server, kronicle-lite (28 Nov): plan and catalog ran, init declined.
  const declined = run(OK, INIT_LOG);
  assert.deepEqual(declined.skips.map((x) => `${x.stage}:${x.fault}`), ['full:policy']);
  assert.match(declined.notes.init_detail, /^init_declined/);
  assert.equal(resultFault(declined.skips).coverage, 'excluded');
  // A fixture that ran its full test too: nothing is skipped.
  const fixtureSteps = [...OK, { step: 'full', exit: 1 }];
  const fixture = itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, steps: fixtureSteps, fullRan: true }, unit: { init: true, full: { confirm: 'x' } }, stages: { install: true, ...stagesRan(fixtureSteps) }, initLog: INIT_LOG });
  assert.deepEqual(fixture.skips, []);
  assert.equal(resultFault(fixture.skips).coverage, 'assessed');
  // Mutation: any other init output (the server never started) is still a skip of ours.
  assert.equal(run(OK, 'error: server INIT did not initialize: timed out\n').skips[0].fault, 'tool');
  assert.equal(run(OK, '').skips[0].stage, 'init');
  // The refusal is never a start failure (tool-qa#131, the lead mcp-writecheck-action#83: a server that started and listed its tools in 0.3 s was recorded timeout_start):
  // not as init's own skip, with or without plan and catalog, and its code is kept in the driver notes.
  assert.equal(declined.notes.init_code, 'no_read_update_pair');
  for (const steps of [OK, [{ step: 'init', exit: 4 }, { step: 'plan', exit: 4 }, { step: 'catalog', exit: 4 }]]) {
    const r = run(steps, INIT_LOG);
    assert.ok(!r.skips.some((x) => x.stage === 'init'), 'init has no skip');
    assert.ok(!r.skips.some((x) => x.stage === 'init' && x.reason === 'timeout_start'));
  }
  // Mutation: the refusal does not excuse a plan or catalog that did not run: those keep their own skips.
  const noCatalog = run([{ step: 'init', exit: 4 }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 4 }], INIT_LOG);
  assert.deepEqual(noCatalog.skips.map((x) => x.stage), ['catalog', 'full']);
  // Mutation: the sentence must start the line (a server cannot print it inside its own text to hide a failed start).
  assert.equal(run(OK, `the server said: ${INIT_LOG}`).skips[0].stage, 'init');
});

test('R-WC-43: a subject this lane cannot test has a stable code and a fault that is never the server\'s; the file refuses anything else', () => {
  const codes = Object.fromEntries([...ov].filter(([, o]) => o.exclude).map(([s, o]) => [s, `${o.exclude.reason}/${o.exclude.fault}/${o.exclude.code}`]));
  assert.deepEqual(codes, {
    'isokron-ai/mcp-catalog-snap': 'policy_excluded/policy/not_an_mcp_server',
    'isokron-ai/strapi-plugin-writesafe': 'policy_excluded/policy/not_an_mcp_server',
    'googleapis/mcp-toolbox': 'heavy_backend/policy/awaiting_standin_database',
    'zerodha/kite-mcp-server': 'policy_excluded/policy/not_testable_hosted_backend',
    'tuananh/hyper-mcp': 'policy_excluded/policy/not_testable_needs_remote_plugins',
    'apollographql/apollo-mcp-server': 'heavy_backend/policy/awaiting_standin_graphql',
    'nguyenvanduocit/all-in-one-model-context-protocol': 'policy_excluded/policy/not_testable_hosted_backend',
    'roblox/studio-rust-mcp-server': 'policy_excluded/policy/not_testable_desktop_backend',
    'elastic/mcp-server-elasticsearch': 'heavy_backend/policy/awaiting_standin_elasticsearch',
    'strowk/mcp-k8s-go': 'heavy_backend/policy/awaiting_standin_kubernetes',
    'mark3labs/mcp-filesystem-server': 'no_runnable_artifact/tool/go_install_not_supported',
    'isaacphi/mcp-language-server': 'no_runnable_artifact/tool/go_install_not_supported',
  });
  for (const [s, o] of ov) if (o.exclude) assert.ok(SKIP_FAULTS[o.exclude.reason].allowed.includes(o.exclude.fault), `${s}: the contract allows ${o.exclude.reason}/${o.exclude.fault}`);
  // The skip is the shape resolveSubject answers, case-insensitive on the subject, and carries the code into the driver notes.
  const ex = exclusionFor('Roblox/studio-rust-mcp-server', ov);
  assert.equal(ex.skip.reason, 'policy_excluded');
  assert.equal(ex.skip.fault, 'policy');
  const s = itemSkips({ resolved: ex });
  assert.equal(s.notes.not_testable, 'not_testable_desktop_backend');
  assert.deepEqual([...new Set(s.skips.map((x) => `${x.reason}/${x.fault}`))], ['policy_excluded/policy']);
  assert.equal(resultFault(s.skips).coverage, 'excluded');
  assert.equal(exclusionFor('someone/else', ov), null);
  // Mutations: a fault that blames the server, an unknown reason, a missing why, a code that is not a stable word, a host in an env value.
  const ok = { exclude: { reason: 'policy_excluded', fault: 'policy', code: 'not_testable_hosted_backend' }, why: 'a long enough reason' };
  assert.ok(loadOverrides(write(doc({ 'a/b': ok }))));
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { ...ok, exclude: { ...ok.exclude, fault: 'subject' } } }))), /fault subject/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { ...ok, exclude: { ...ok.exclude, reason: 'start_requires_credentials', fault: 'subject' } } }))), /not one an exclusion may use/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { ...ok, why: '' } }))), /say why/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { ...ok, exclude: { ...ok.exclude, code: 'Hosted Backend' } } }))), /stable snake_case/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { launch: { env: { API_URL: 'https://example.com' } }, why: 'a long enough reason' } }))), /names a host/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { launch: { args: ['--x'] }, exclude: ok.exclude, why: 'a long enough reason' } }))), /exactly one/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { launch: { install_scripts: false }, why: 'a long enough reason' } }))), /install_scripts/);
  assert.throws(() => loadOverrides(write(doc({ 'a/b': { launch: { args: ['/opt/surface/loop/launch-files/missing.json'] }, why: 'a long enough reason' } }))), /not a file of this repository/);
});

test('R-WC-44: the arguments, bin and files that make the T0 and T1 servers start are supplied by name, never a credential or a host', () => {
  const base = { kind: 'npm', package: 'x', version: 'latest' };
  assert.deepEqual(applyLaunch('isokron-ai/sea-lite', base, ov), { ...base, args: ['serve'], install_scripts: true });
  assert.deepEqual(applyLaunch('isokron-ai/mcp-check', base, ov), { ...base, bin: 'mcp-check-server' });
  assert.deepEqual(applyLaunch('grafana/mcp-grafana', { kind: 'docker', args: ['--address', ':8000'] }, ov).args, ['-t', 'stdio']);
  assert.deepEqual(applyLaunch('containers/kubernetes-mcp-server', base, ov).env, { KUBECONFIG: '/opt/surface/loop/launch-files/kubeconfig.yaml' });
  // The registry's own environment is kept and ours is added; an unlisted subject is unchanged.
  assert.deepEqual(applyLaunch('containers/kubernetes-mcp-server', { ...base, env: { A: null } }, ov).env, { A: null, KUBECONFIG: '/opt/surface/loop/launch-files/kubeconfig.yaml' });
  assert.equal(applyLaunch('someone/else', base, ov), base);
  // No value in the file is a secret or a host: the only environment value is a path of ours.
  for (const [s, o] of ov) for (const v of Object.values(o.launch?.env ?? {})) assert.match(v, /^\/opt\/surface\/loop\/launch-files\//, s);
  // Every T0 and T1 subject is covered here or by the init rule: each exclusion or launch entry exists for a subject of the 20.
  const twenty = ['isokron-ai/kronicle-lite', 'isokron-ai/mcp-catalog-snap', 'isokron-ai/mcp-check', 'isokron-ai/sea-lite', 'isokron-ai/strapi-plugin-writesafe', 'apollographql/apollo-mcp-server', 'containers/kubernetes-mcp-server', 'elastic/mcp-server-elasticsearch', 'github/github-mcp-server', 'googleapis/mcp-toolbox', 'grafana/mcp-grafana', 'hashicorp/terraform-mcp-server', 'isaacphi/mcp-language-server', 'mark3labs/mcp-filesystem-server', 'modelcontextprotocol/servers', 'nguyenvanduocit/all-in-one-model-context-protocol', 'roblox/studio-rust-mcp-server', 'strowk/mcp-k8s-go', 'tuananh/hyper-mcp', 'zerodha/kite-mcp-server'];
  for (const s of ov.keys()) assert.ok(twenty.includes(s), `${s} is a T0 or T1 subject`);
});

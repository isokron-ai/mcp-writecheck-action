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

import { INIT_DECLINED, INIT_DECLINED_EXIT, itemSkips, stagesRan } from '../loop/skips.mjs';
import { applyLaunch, exclusionFor, loadOverrides, providedLaunch, valueProblem } from '../loop/overrides.mjs';
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
  // Mutation: only the CLI's own exit status 4 is the refusal; the same words after another status (a timeout, 2, 3, 0) are not.
  assert.equal(INIT_DECLINED_EXIT, 4);
  for (const exit of [2, 3, 124]) assert.equal(run([{ step: 'init', exit }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 0 }], INIT_LOG).skips[0].stage, 'init', `exit ${exit}`);
  assert.equal(run([{ step: 'init', exit: 4, timed_out: true }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 0 }], INIT_LOG).skips[0].stage, 'init');
  // Mutation: the sentence must start the line (a server cannot print it inside its own text to hide a failed start).
  assert.equal(run(OK, `the server said: ${INIT_LOG}`).skips[0].stage, 'init');
});

test('R-WC-43: a subject this lane cannot test has a stable code and a fault that is never the server\'s; the file refuses anything else', () => {
  const codes = Object.fromEntries([...ov].filter(([, o]) => o.exclude).map(([s, o]) => [s, `${o.exclude.reason}/${o.exclude.fault}/${o.exclude.code}`]));
  assert.deepEqual(codes, {
    'isokron-ai/mcp-catalog-snap': 'policy_excluded/policy/not_an_mcp_server',
    'isokron-ai/strapi-plugin-writesafe': 'policy_excluded/policy/not_an_mcp_server',
    'googleapis/mcp-toolbox': 'no_runnable_artifact/tool/oci_host_not_allowed',
    'zerodha/kite-mcp-server': 'no_runnable_artifact/tool/go_install_not_supported',
    'nguyenvanduocit/all-in-one-model-context-protocol': 'no_runnable_artifact/tool/go_install_not_supported',
    'tuananh/hyper-mcp': 'no_runnable_artifact/tool/needs_local_plugin_fixture',
    'roblox/studio-rust-mcp-server': 'no_runnable_artifact/tool/source_only_launch_unsupported',
    'elastic/mcp-server-elasticsearch': 'no_runnable_artifact/tool/source_only_launch_unsupported',
    'mark3labs/mcp-filesystem-server': 'no_runnable_artifact/tool/go_install_not_supported',
    'isaacphi/mcp-language-server': 'no_runnable_artifact/tool/go_install_not_supported',
  });
  // Policy is only for what we chose not to run: a command line tool and a library, never a limit of ours (review of #84).
  for (const [subject, o] of ov) if (o.exclude?.fault === 'policy') assert.match(o.exclude.code, /^not_an_mcp_server$/, subject);
  for (const [s, o] of ov) if (o.exclude) assert.ok(SKIP_FAULTS[o.exclude.reason].allowed.includes(o.exclude.fault), `${s}: the contract allows ${o.exclude.reason}/${o.exclude.fault}`);
  // The skip is the shape resolveSubject answers, case-insensitive on the subject, and carries the code into the driver notes.
  const ex = exclusionFor('Isokron-ai/mcp-catalog-snap', ov);
  assert.equal(ex.skip.reason, 'policy_excluded');
  assert.equal(ex.skip.fault, 'policy');
  const s = itemSkips({ resolved: ex });
  assert.equal(s.notes.not_testable, 'not_an_mcp_server');
  assert.deepEqual([...new Set(s.skips.map((x) => `${x.reason}/${x.fault}`))], ['policy_excluded/policy']);
  assert.equal(resultFault(s.skips).coverage, 'excluded');
  // Our own gap stays ours: a Go server is unassessed by our tool, with its code.
  const go = itemSkips({ resolved: exclusionFor('zerodha/kite-mcp-server', ov) });
  assert.equal(go.notes.not_testable, 'go_install_not_supported');
  assert.equal(resultFault(go.skips).coverage, 'unassessed_tool');
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
  // apollo's image sets its transport in its own environment, which wins over the config file: ours says stdio.
  assert.deepEqual(applyLaunch('apollographql/apollo-mcp-server', { kind: 'docker' }, ov).env, { APOLLO_MCP_TRANSPORT__TYPE: 'stdio' });
  // A package the seed does not list is supplied as an npm launch, with the dummy kubeconfig.
  assert.deepEqual(providedLaunch('strowk/mcp-k8s-go', ov), { fixture: null, launch: { kind: 'npm', package: '@strowk/mcp-k8s', version: 'latest' }, source: 'registry', package: 'npm:@strowk/mcp-k8s' });
  assert.equal(providedLaunch('isokron-ai/sea-lite', ov), null);
  // No value in the file is a secret, a host or a path outside the mount: every one passes the guard.
  for (const [s, o] of ov) for (const v of [...(o.launch?.args ?? []), ...Object.values(o.launch?.env ?? {})]) assert.equal(valueProblem(v), null, `${s}: ${v}`);
  // The guard: .. segments, other paths, flag=path, hostnames, host:port, addresses, URLs.
  const M = '/opt/surface/loop/launch-files';
  for (const bad of [`${M}/../x`, `${M}/./../kubeconfig.yaml`, '/etc/passwd', `--config=/etc/passwd`, `--config=${M}/../a`, `${M}/nope.yaml`, 'dir/file', 'example.com', 'api.example.com:443', 'localhost:8080', '127.0.0.1', '10.0.0.1:9000', 'http://x', '--url=https://x.test/mcp', '--addr=db.internal:5432', '[::1]:80']) assert.ok(valueProblem(bad), `refused: ${bad}`);
  for (const good of ['serve', '-t', 'stdio', '--stdio', 'sqlite', `${M}/kubeconfig.yaml`, `--config=${M}/apollo.yaml`]) assert.equal(valueProblem(good), null, `allowed: ${good}`);
  // Mutation: a launch of ours with a path outside the mount, a flag=path with .., or a host:port in an env value does not load.
  const bad = (launch) => () => loadOverrides(write(doc({ 'a/b': { launch, why: 'a long enough reason' } })));
  assert.throws(bad({ args: ['--config=/etc/passwd'] }), /outside/);
  assert.throws(bad({ args: [`--config=${M}/../a`] }), /\.\. segment/);
  assert.throws(bad({ env: { DB: 'db.internal:5432' } }), /names a host/);
  assert.throws(bad({ kind: 'npm' }), /come together/);
  assert.throws(bad({ kind: 'pypi', package: 'x' }), /npm package/);
  // Every T0 and T1 subject is covered here or by the init rule: each exclusion or launch entry exists for a subject of the 20.
  const twenty = ['isokron-ai/kronicle-lite', 'isokron-ai/mcp-catalog-snap', 'isokron-ai/mcp-check', 'isokron-ai/sea-lite', 'isokron-ai/strapi-plugin-writesafe', 'apollographql/apollo-mcp-server', 'containers/kubernetes-mcp-server', 'elastic/mcp-server-elasticsearch', 'github/github-mcp-server', 'googleapis/mcp-toolbox', 'grafana/mcp-grafana', 'hashicorp/terraform-mcp-server', 'isaacphi/mcp-language-server', 'mark3labs/mcp-filesystem-server', 'modelcontextprotocol/servers', 'nguyenvanduocit/all-in-one-model-context-protocol', 'roblox/studio-rust-mcp-server', 'strowk/mcp-k8s-go', 'tuananh/hyper-mcp', 'zerodha/kite-mcp-server'];
  for (const s of ov.keys()) assert.ok(twenty.includes(s), `${s} is a T0 or T1 subject`);
});

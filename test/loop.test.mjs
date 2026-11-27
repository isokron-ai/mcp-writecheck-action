/**
 * The writecheck loop worker (loop/): inputs, subject mapping, the checked summary and field records, bundle
 * layout and caps, the control verdicts, the in-sandbox helpers, the kill switch, and a bundle built from our
 * functions judged by tool-qa's own contract, forgery and registry checks (copies at the pinned commit in
 * test/fixtures/loop/, hashes in VENDORED.json). No Docker, no network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURE_MANIFEST, InputError, catalogManifest, loadFixtures, lockProblems, parseItems, resolveSubject, seedPackages, validateFixtures } from '../loop/items.mjs';
import { findRunFolder, observations, planHash, publicSummary, readCatalog, readResults, summarize, ndjson } from '../loop/summary.mjs';
import { BundleFiles, buildMeta, forgeryVerdict, hasIdentityKeys, knownBadVerdict, knownGoodVerdict, parseCollected, safeRawPath } from '../loop/bundle.mjs';
import { evaluateGuard, laneVariable, main as guardMain, refProblem } from '../loop/guard.mjs';
import { SKIP_FAULTS, buildManifest, resultFault, validateManifest } from './fixtures/loop/tool-qa/worker-kit/contract.mjs';
import { REASON_FAULT, STAGE_RAN_EXITS, entryErrorCode, installFault, itemSkips, stageFailure, stagesRan } from '../loop/skips.mjs';
import { CLI } from '../contract.mjs';
import { lastStderr } from '../loop/run-items.mjs';
import { checkBundle } from './fixtures/loop/tool-qa/ingest/forgery.mjs';
import { parseRegistry, validateObservations } from './fixtures/loop/tool-qa/ingest/registry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = join(root, 'test', 'fixtures', 'loop');
const KEY = 'a'.repeat(64);
const item = (subject, extra = {}) => ({ subject, run_key: KEY, fence: 3, ...extra });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const SEED = {
  map: new Map([
    ['acme/npm-server', { id: 'acme/npm-server', transport: 'stdio', packages: [{ registry: 'pypi', identifier: 'acme-py' }, { registry: 'npm', identifier: '@acme/server' }] }],
    ['acme/py-server', { id: 'acme/py-server', transport: 'both', packages: [{ registry: 'pypi', identifier: 'acme-mcp' }] }],
    ['acme/oci-only', { id: 'acme/oci-only', transport: 'stdio', packages: [{ registry: 'oci', identifier: 'ghcr.io/acme/x:1' }, { registry: 'cargo', identifier: 'x' }] }],
    ['acme/http-only', { id: 'acme/http-only', transport: 'http', packages: [{ registry: 'npm', identifier: 'acme-http' }] }],
    ['acme/bad-name', { id: 'acme/bad-name', transport: 'stdio', packages: [{ registry: 'npm', identifier: 'Bad Name; rm -rf' }] }],
  ]),
};

test('vendored tool-qa and registry copies match VENDORED.json', () => {
  const v = JSON.parse(readFileSync(join(fx, 'VENDORED.json'), 'utf8'));
  for (const [p, h] of Object.entries(v.files)) assert.equal(sha(readFileSync(join(fx, 'tool-qa', p))), h, p);
  assert.equal(sha(readFileSync(join(fx, 'mcp-results-registry.yaml'))), v.registry.sha256);
  // The workflows pin the same tool-qa commit as the copies.
  for (const wf of ['corpus.yml', 'loop-fixture.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', wf), 'utf8');
    assert.match(text, new RegExp(`WORKER_KIT_REF: '${v.commit}'`), wf);
  }
});

test('items: the pump\'s list, checked whole', () => {
  assert.deepEqual(parseItems(JSON.stringify([item('acme/npm-server')])), [{ index: 0, subject: 'acme/npm-server', run_key: KEY, fence: 3 }]);
  const bad = [
    '', 'not json', '{}', '[]', JSON.stringify(Array.from({ length: 11 }, (_, i) => item(`acme/s${i}`))),
    `[${JSON.stringify(item('acme/x'))}\n]`, JSON.stringify([item('acme/x', { run_key: 'A'.repeat(64) })]), JSON.stringify([item('acme/x', { fence: 0 })]),
    JSON.stringify([item('acme/x', { fence: 1.5 })]), JSON.stringify([item('../x')]), JSON.stringify([item('acme/x\nb')]), JSON.stringify([item('acme/x', { extra: 1 })]),
    JSON.stringify([item('acme/x'), item('ACME/X')]),
  ];
  for (const b of bad) assert.throws(() => parseItems(b), InputError, b.slice(0, 40));
});

test('subjects: fixtures first, then the seed (npm before PyPI), else a skip with a contract code', () => {
  const fixtures = loadFixtures(join(root, 'loop', 'fixtures.json'));
  const tt = resolveSubject('isokron-ai/mcp-write-safety', { seed: SEED, fixtures });
  assert.equal(tt.fixture, 'tiny-tracker');
  assert.deepEqual(tt.launch, { kind: 'npm', package: '@mcp-write-safety/tiny-tracker', version: '0.1.0', bin: 'tiny-tracker' });
  assert.deepEqual(resolveSubject('acme/npm-server', { seed: SEED, fixtures }).launch, { kind: 'npm', package: '@acme/server', version: 'latest' });
  assert.deepEqual(resolveSubject('ACME/py-server', { seed: SEED, fixtures }).launch, { kind: 'pypi', package: 'acme-mcp', version: 'latest' });
  assert.equal(resolveSubject('acme/oci-only', { seed: SEED, fixtures }).skip.reason, 'no_runnable_artifact');
  assert.match(resolveSubject('acme/oci-only', { seed: SEED, fixtures }).skip.detail, /cargo, oci/);
  assert.equal(resolveSubject('acme/http-only', { seed: SEED, fixtures }).skip.reason, 'unsupported_transport');
  assert.equal(resolveSubject('acme/bad-name', { seed: SEED, fixtures }).skip.reason, 'no_runnable_artifact');
  assert.equal(resolveSubject('acme/unknown', { seed: SEED, fixtures }).skip.reason, 'policy_excluded');
  assert.deepEqual(seedPackages({ packages: [{ registry: 'npm', identifier: 'ok' }, { registry: 'npm', identifier: 'NO' }] }), [{ kind: 'npm', package: 'ok' }]);
  // Every skip code is one of tool-qa's.
  const { SKIP_REASONS } = JSON.parse(JSON.stringify({ SKIP_REASONS: readFileSync(join(fx, 'tool-qa', 'worker-kit', 'contract.mjs'), 'utf8').match(/'[a-z_]+'/g).map((s) => s.slice(1, -1)) }));
  for (const c of ['no_runnable_artifact', 'unsupported_transport', 'policy_excluded', 'install_failed_registry', 'timeout_start', 'trace_unavailable', 'tool_error']) assert.ok(SKIP_REASONS.includes(c), c);
});

test('R-WC-03: fixtures: valid; each runs its dogfood manifest byte for byte, under the plan hash accepted there', () => {
  const f = loadFixtures(join(root, 'loop', 'fixtures.json'));
  assert.throws(() => validateFixtures({ format: 'x' }));
  assert.throws(() => validateFixtures({ format: 'isokron-writecheck-fixtures/1', fixtures: { a: { subject: 'a/b', launch: { kind: 'npm', package: 'x', version: 'latest' } } } }));
  const base = { subject: 'a/b', launch: { kind: 'npm', package: 'x', version: '1.0.0' }, manifest: 'dogfood/x/writecheck.yaml' };
  for (const link of ['/work/out/x', '/work/pkg', '/work/m/x', '/etc/x', '/work/../x', 'work/x']) {
    assert.throws(() => validateFixtures({ format: 'isokron-writecheck-fixtures/1', fixtures: { a: { ...base, link } } }), undefined, link);
  }
  for (const [name, dog] of [['tiny-tracker', 'dogfood/tiny-tracker/writecheck.yaml'], ['kronicle-lite', 'dogfood/kronicle-lite/writecheck.yaml']]) {
    const fx1 = f.fixtures[name];
    assert.equal(fx1.manifest, dog);
    // The manifest's relative cwd, taken from where the driver writes it, is the link to the installed package.
    const cwd = /^ {2}cwd: (\S+)/m.exec(readFileSync(join(root, dog), 'utf8'))[1];
    assert.equal(join(dirname(FIXTURE_MANIFEST), cwd), fx1.link, name);
    const wf = readFileSync(join(root, '.github', 'workflows', `dogfood-${name}.yml`), 'utf8');
    assert.ok(wf.includes(`PLAN_HASH: ${fx1.full.plan_hash}`), `${name}: the plan hash the dogfood workflow accepts`);
  }
});

test('the generic catalog manifest quotes every word and passes only the names it is given', () => {
  const m = catalogManifest(['node', '/work/pkg/a b/"x".js'], ['FORGERY_MARKER'], 'loop-i0');
  assert.match(m, /^ {2}stdio: \["node", "\/work\/pkg\/a b\/\\"x\\"\.js"\]$/m);
  assert.match(m, /^ {2}env_passthrough: \["FORGERY_MARKER"\]$/m);
  assert.match(m, /^ {2}confirm: "loop-i0"$/m);
});

const catalogDoc = {
  tools: [
    { name: 'create_item', description: 'secret text', inputSchema: { properties: { idempotency_key: {}, title: {}, expected_version: {}, dry_run: {}, 'bad name': {} } }, annotations: { destructiveHint: false, title: 'x', readOnlyHint: 'yes' } },
    { name: 'list_items', annotations: { readOnlyHint: true } },
    { name: 'bad name!', annotations: {} },
  ],
};
const resultsDoc = {
  run: { status: 'complete', writes: 12 },
  results: [
    { requirement: 'MWS-ANN-4', verdict: 'violated', write_path: { resource: '(catalog)', tool: 'list_items' }, reason: 'long text' },
    { requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'create_item' } },
    { requirement: 'attempt_id=1', verdict: 'held' },
    { requirement: 'MWS-UPD-1', verdict: 'maybe' },
  ],
};
const filesOf = (o) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v))]));

test('summary: one results folder, whitelisted values only', () => {
  const files = filesOf({ 'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc });
  assert.equal(findRunFolder(files, 'results', { catalog: true }).dir, 'results/catalog-0123456789');
  files.set('results/catalog-abcdefabcd/results.json', Buffer.from('{}'));
  assert.equal(findRunFolder(files, 'results', { catalog: true }).dir, null, 'two folders: none is trusted');
  assert.equal(findRunFolder(new Map(), 'results', { catalog: true }).why, 'no results folder');
  const r = readResults(resultsDoc);
  assert.equal(r.records.length, 2);
  assert.equal(r.dropped, 2);
  assert.equal(r.status, 'complete');
  const c = readCatalog(catalogDoc);
  assert.deepEqual(c.tools.map((t) => t.name), ['create_item', 'list_items']);
  assert.deepEqual(c.tools[0].annotations, { destructiveHint: false });
  assert.deepEqual(c.tools[0].params, ['idempotency_key', 'title', 'expected_version', 'dry_run']);
  assert.equal(planHash('x\nplan hash: 0123456789abcdef\n'), '0123456789abcdef');
  assert.equal(planHash('plan hash: 0123456789abcdef\nplan hash: fedcba9876543210\n'), null);
});

test('field records: registry ids with the declared types, and no object keyed by a target name', () => {
  const reg = parseRegistry(readFileSync(join(fx, 'mcp-results-registry.yaml'), 'utf8'));
  const files = filesOf({
    'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc,
    'full/run-1/results.json': { run: { status: 'complete', writes: 40 }, results: [{ requirement: 'MWS-RETRY-2', verdict: 'held', write_path: { resource: 'ticket', tool: 'create_item' } }, { requirement: 'MWS-CONC-1', verdict: 'violated', write_path: { resource: 'ticket', tool: 'create_item' } }] },
  });
  const s = summarize({ files, steps: [{ step: 'plan', exit: 0, ms: 5 }], planStdout: 'plan hash: 0123456789abcdef\n', fullRan: true, acceptedPlanHash: '0123456789abcdef' });
  assert.equal(s.plan.drift, false);
  assert.equal(s.full.status, 'complete');
  const recs = observations(s, { versions: { mcp_writecheck: 'x' }, stagesRan: { install: true } });
  const fields = recs.map((x) => x.field);
  for (const f of ['tool_annotations_declared', 'annotation_completeness', 'idempotency_evidence_params', 'concurrency_guard_params', 'safety_params', 'requirement_verdicts', 'plan_hash_and_drift', 'annotation_honesty_behaviour_confirmed', 'idempotency_evidence_behaviour', 'conflict_behaviour', 'our_tool_versions', 'sandbox_tier', 'observation_coverage', 'step_telemetry']) assert.ok(fields.includes(f), f);
  const v = validateObservations(new Map([['observations/writecheck.ndjson', Buffer.from(ndjson(recs))]]), reg);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(recs.find((x) => x.field === 'idempotency_evidence_params').value, [{ tool: 'create_item', param: 'idempotency_key' }]);
  assert.deepEqual(recs.find((x) => x.field === 'concurrency_guard_params').value, [{ tool: 'create_item', param: 'expected_version' }]);
  assert.deepEqual(recs.find((x) => x.field === 'safety_params').value, [{ tool: 'create_item', param: 'dry_run' }]);
  // Incomplete sandbox evidence: only our own records.
  const few = observations(s, { versions: {}, stagesRan: {}, evidenceComplete: false }).map((x) => x.field);
  assert.deepEqual(few, ['our_tool_versions', 'sandbox_tier', 'observation_coverage', 'step_telemetry']);
  assert.ok(!('_records' in publicSummary(s)));
});

test('collected output: checked line by line; unsafe paths are renamed', () => {
  const lines = [
    JSON.stringify({ path: 'results/x/results.json', kind: 'file', bytes: 2, sha256: 'a'.repeat(64), b64: Buffer.from('{}').toString('base64'), truncated: false }),
    JSON.stringify({ path: '../etc/passwd', kind: 'file', bytes: 1, b64: 'YQ==' }),
    JSON.stringify({ path: 'big', kind: 'file', bytes: 10, sha256: 'b'.repeat(64), omitted: true }),
    JSON.stringify({ path: 'l', kind: 'link' }),
    'not json',
    JSON.stringify({ done: true, entries: 4, capped: true }),
  ].join('\n');
  const p = parseCollected(lines);
  assert.deepEqual([...p.files.keys()], ['results/x/results.json']);
  assert.equal(p.bad, 2);
  assert.equal(p.done.capped, true);
  assert.equal(safeRawPath('raw/out', 'results/x/results.json'), 'raw/out/results/x/results.json');
  assert.match(safeRawPath('raw/out', 'a b/c'), /^raw\/out\/_renamed\/[0-9a-f]{32}$/);
  assert.match(safeRawPath('raw/out', `${'a'.repeat(100)}/${'b'.repeat(100)}`), /_renamed/);
});

test('raw caps: a file and the bundle are cut, and the index keeps the original size and hash', () => {
  const b = new BundleFiles({ fileCap: 10, totalCap: 15 });
  b.raw('raw/a', Buffer.alloc(12, 1));
  b.raw('raw/b', Buffer.alloc(12, 2));
  b.raw('raw/c', Buffer.alloc(3, 3));
  assert.equal(b.files.get('raw/a').length, 10);
  assert.equal(b.files.get('raw/b').length, 5);
  assert.ok(!b.files.has('raw/c'));
  assert.deepEqual(b.rawIndex.map((x) => [x.path, x.bytes, x.kept, x.truncated]), [['raw/a', 12, 10, true], ['raw/b', 12, 5, true], ['raw/c', 3, 0, true]]);
});

test('the in-sandbox collector lists files, never follows links, and caps', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wc-collect-')));
  mkdirSync(join(d, 'a'));
  writeFileSync(join(d, 'a', 'x.txt'), 'hello');
  writeFileSync(join(d, 'big'), Buffer.alloc(100, 7));
  symlinkSync('/etc/hosts', join(d, 'link'));
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'collect.mjs'), d, '50', '60', '100'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const p = parseCollected(r.stdout);
  assert.equal(p.files.get('a/x.txt').toString(), 'hello');
  assert.equal(p.files.get('big').length, 50);
  assert.ok(p.entries.find((e) => e.path === 'big').truncated);
  assert.equal(p.entries.find((e) => e.path === 'link').kind, 'link');
});

test('the backend starter runs the main command after the background one is ready, with its exit status', () => {
  const d = mkdtempSync(join(tmpdir(), 'wc-bg-'));
  const spec = JSON.stringify({ argv: [process.execPath, '-e', 'console.log("backend ready"); setInterval(() => {}, 1000)'], log: join(d, 'bg.log'), ready: 'backend', wait_ms: 5000 });
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'bg.mjs'), spec, '--', process.execPath, '-e', 'process.exit(3)'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(r.status, 3);
  assert.match(readFileSync(join(d, 'bg.log'), 'utf8'), /backend ready/);
});

/** What the forgery server answers to tools/list, as catalog.json would hold it, and what it prints on stderr. */
function forgeryCatalog(marker) {
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'forgery-server.mjs')], {
    input: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`, env: { ...process.env, FORGERY_MARKER: marker }, encoding: 'utf8', timeout: 10_000,
  });
  return { tools: JSON.parse(r.stdout.trim().split('\n')[0]).result.tools, stderr: r.stderr };
}

test('forgery control: contained through our summary; a leak and an unread list are caught', () => {
  const marker = `wcforgery${'1'.repeat(32)}`;
  const { tools, stderr } = forgeryCatalog(marker);
  assert.ok(stderr.includes(marker));
  const files = filesOf({
    'results/catalog-0123456789/catalog.json': { tools }, 'results/catalog-0123456789/results.json': { run: { status: 'complete' }, results: [{ requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'fence' }, reason: marker }] },
    'results/forged/results.json': { attempt_id: 'forged', run_key: '0f'.repeat(32), marker },
  });
  const s = summarize({ files, steps: [], planStdout: '' });
  const output = { summary: publicSummary(s), observations: observations(s, { versions: {}, stagesRan: {} }) };
  const rawTexts = [...files.values()].map((b) => b.toString());
  assert.equal(forgeryVerdict({ marker, output, rawTexts, toolCount: s.catalog.tool_count }), 'contained');
  assert.equal(forgeryVerdict({ marker, output: { ...output, x: marker }, rawTexts, toolCount: 2 }), 'leaked');
  assert.equal(forgeryVerdict({ marker, output: { ...output, n: { run_key: 'x' } }, rawTexts, toolCount: 2 }), 'leaked');
  assert.equal(forgeryVerdict({ marker, output, rawTexts: [], toolCount: 2 }), 'not_read');
  assert.equal(forgeryVerdict({ marker, output, rawTexts, toolCount: 1 }), 'not_read');
  assert.ok(hasIdentityKeys({ a: [{ 'Run-Key': 1 }] }));
  assert.ok(hasIdentityKeys({ schema_version: 1, files: [] }));
  assert.ok(!hasIdentityKeys({ tools: [{ tool: 'attempt_id' }] }));
});

test('known-answer controls: detected and held, and their failures', () => {
  const s = (recs, found = true) => ({ catalog: { found }, _records: { catalog: recs } });
  const v = (verdict) => ({ requirement: 'MWS-ANN-4', verdict });
  assert.equal(knownBadVerdict(s([v('violated'), v('held')]), 'MWS-ANN-4'), 'detected');
  assert.equal(knownBadVerdict(s([v('held')]), 'MWS-ANN-4'), 'missed');
  assert.equal(knownBadVerdict(s([], false), 'MWS-ANN-4'), 'not_run');
  assert.equal(knownGoodVerdict(s([v('held')]), 'MWS-ANN-4'), 'held');
  assert.equal(knownGoodVerdict(s([v('held'), v('violated')]), 'MWS-ANN-4'), 'violated');
  assert.equal(knownGoodVerdict(s([]), 'MWS-ANN-4'), 'not_observed');
});

test('a bundle built from our functions passes tool-qa\'s manifest, forgery and registry checks', () => {
  const marker = `wcforgery${'2'.repeat(32)}`;
  const { tools } = forgeryCatalog(marker);
  const ctlFiles = filesOf({ 'results/catalog-0123456789/catalog.json': { tools }, 'results/catalog-0123456789/results.json': { run: { status: 'complete' }, results: [] } });
  const cs = summarize({ files: ctlFiles, steps: [], planStdout: '' });
  const ctlOut = { summary: publicSummary(cs), observations: observations(cs, { versions: {}, stagesRan: {} }) };
  const b = new BundleFiles();
  const subj = summarize({ files: filesOf({ 'results/catalog-0123456789/results.json': resultsDoc, 'results/catalog-0123456789/catalog.json': catalogDoc }), steps: [{ step: 'catalog', exit: 0, ms: 1 }], planStdout: '' });
  b.put('results/writecheck.json', JSON.stringify(publicSummary(subj)));
  b.put('observations/writecheck.ndjson', ndjson(observations(subj, { versions: { mcp_writecheck: 'c' }, stagesRan: { catalog: true } })));
  b.put('controls/forgery.json', JSON.stringify(ctlOut));
  b.put('controls/known-bad.json', '{"observed":"detected"}');
  b.put('logs/driver.json', '{"index":0}');
  b.raw('raw/control-forgery/out/results/catalog-0123456789/catalog.json', ctlFiles.get('results/catalog-0123456789/catalog.json'));
  b.raw('raw/control-forgery/out/forged-envelope.json', JSON.stringify({ attempt_id: 'forged', run_key: '0f'.repeat(32), fence: 9, marker }));
  const files = [...b.files.entries()].map(([path, data]) => ({ path, data }));
  const meta = buildMeta({
    subject: 'acme/npm-server', tools: [{ name: 'mcp-writecheck', version: 'c'.repeat(40) }], settingsDigest: 'd'.repeat(64), startedAt: '2026-11-23T00:00:00Z', finishedAt: '2026-11-23T00:01:00Z',
    skips: [{ stage: 'full', reason: 'policy_excluded', evidence: 'logs/driver.json' }],
    controls: [{ kind: 'forgery', expected: 'contained', observed: 'contained', output: 'controls/forgery.json', marker }, { kind: 'known_bad', expected: 'detected', observed: 'detected', output: 'controls/known-bad.json' }],
  });
  const workflow = { repo: 'isokron-ai/mcp-writecheck-action', file: '.github/workflows/corpus.yml', sha: 'e'.repeat(40), run_id: 5, run_attempt: 1 };
  const manifest = buildManifest({ identity: { attempt_id: 'att-1', fence: 3, run_key: KEY }, workflow, meta, files });
  assert.ok(validateManifest(manifest).ok);
  const exp = { attempt_id: 'att-1', fence: 3, run_key: KEY, repo: workflow.repo, workflow_file: workflow.file, workflow_sha: workflow.sha, run_id: 5, run_attempt: 1 };
  assert.deepEqual(checkBundle(manifest, b.files, exp), []);
  const reg = parseRegistry(readFileSync(join(fx, 'mcp-results-registry.yaml'), 'utf8'));
  assert.deepEqual(validateObservations(b.files, reg).errors, []);
  // A leak of the marker outside raw/ is what ingest rejects.
  const leaked = new Map(b.files);
  leaked.set('logs/driver.json', Buffer.from(`{"m":"${marker}"}`));
  const m2 = buildManifest({ identity: { attempt_id: 'att-1', fence: 3, run_key: KEY }, workflow, meta, files: [...leaked.entries()].map(([path, data]) => ({ path, data })) });
  assert.ok(checkBundle(m2, leaked, exp).some((p) => p.reason === 'forgery_marker_leaked'));
});

test('kill switch: LOOP_ENABLED exactly true, pause, lane switch, pins', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.deepEqual(evaluateGuard({}, { now }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'TRUE' }, { now }), { proceed: false, reason: 'loop_disabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-24' }, { now }), { proceed: false, reason: 'paused' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: 'soon' }, { now }), { proceed: false, reason: 'pause_unreadable' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LOOP_PAUSE_UNTIL: '2026-11-22' }, { now }), { proceed: true, reason: 'enabled' });
  assert.deepEqual(evaluateGuard({ LOOP_ENABLED: 'true', LANE_WRITECHECK_ENABLED: 'false' }, { now }), { proceed: false, reason: 'lane_disabled' });
  assert.equal(laneVariable('writecheck'), 'LANE_WRITECHECK_ENABLED');
  assert.match(refProblem('SANDBOX_REF', '0'.repeat(40), 'x'), /placeholder/);
  const out = { text: '', write(s) { this.text += s; } };
  assert.equal(guardMain([], { LOOP_ENABLED: 'true', WORKER_KIT_REF: 'b'.repeat(40), SANDBOX_REF: 'short' }, { out, now }), 1);
  assert.equal(guardMain([], { LOOP_ENABLED: 'true', WORKER_KIT_REF: 'b'.repeat(40), SANDBOX_REF: 'c'.repeat(40) }, { out, now }), 0);
  assert.equal(guardMain([], { LOOP_ENABLED: 'no' }, { out, now }), 0);
});

test('R-WC-01: the tools volume carries what its code imports (the network logger needs src/)', async () => {
  const { MSC_TOOL_DIRS, missingImports } = await import('../loop/run-items.mjs');
  assert.deepEqual(MSC_TOOL_DIRS, ['sandbox', 'src']);
  const d = mkdtempSync(join(tmpdir(), 'wc-tools-'));
  mkdirSync(join(d, 'sandbox'));
  writeFileSync(join(d, 'sandbox', 'netlog.mjs'), "import { a } from '../src/dns.mjs';\nexport { b } from './x.mjs';\nconst c = await import('./y.mjs');\nimport fs from 'node:fs';\n");
  writeFileSync(join(d, 'sandbox', 'x.mjs'), 'export const b = 1;\n');
  assert.deepEqual(missingImports(d), ['sandbox/netlog.mjs -> ../src/dns.mjs', 'sandbox/netlog.mjs -> ./y.mjs']);
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'dns.mjs'), 'export const a = 1;\n');
  writeFileSync(join(d, 'sandbox', 'y.mjs'), 'export {};\n');
  assert.deepEqual(missingImports(d), []);
  // Our own in-sandbox code imports nothing outside loop/sandbox.
  assert.deepEqual(missingImports(join(root, 'loop', 'sandbox')), []);
});

test('R-WC-02: every name the driver takes from mcp-surface-corpus is in the list it checks at load', async () => {
  const { MSC_MODULES, MSC_NEEDS } = await import('../loop/run-items.mjs');
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  const used = [...new Set([...src.matchAll(/\b(?:this\.M|M)\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].filter((n) => !['dir', 'images'].includes(n)).sort();
  assert.deepEqual(used, [...MSC_NEEDS].sort());
  assert.ok(MSC_MODULES.includes('src/sandbox-env.mjs'), 'settingsManifest and settingsDigest live in sandbox-env.mjs');
  // With a checkout of mcp-surface-corpus at hand (MSC_DIR), check the names against its exports too.
  if (process.env.MSC_DIR) {
    const { pathToFileURL } = await import('node:url');
    const M = Object.assign({}, ...(await Promise.all(MSC_MODULES.map((p) => import(pathToFileURL(join(process.env.MSC_DIR, p)).href)))));
    assert.deepEqual(MSC_NEEDS.filter((n) => M[n] === undefined), []);
  }
});

test('R-WC-04: the collector brings the files the summary reads first, ahead of thousands of capture files', () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'wc-collect-order-')));
  mkdirSync(join(d, 'full', 'r1', 'capture'), { recursive: true });
  mkdirSync(join(d, 'results', 'catalog-0123456789'), { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(d, 'full', 'r1', 'capture', `f${i}`), 'x');
  writeFileSync(join(d, 'full', 'r1', 'results.json'), '{}');
  writeFileSync(join(d, 'results', 'catalog-0123456789', 'results.json'), '{}');
  writeFileSync(join(d, 'results', 'catalog-0123456789', 'catalog.json'), '{}');
  const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'collect.mjs'), d, '100', '1000', '10'], { encoding: 'utf8' });
  const p = parseCollected(r.stdout);
  for (const f of ['full/r1/results.json', 'results/catalog-0123456789/results.json', 'results/catalog-0123456789/catalog.json']) assert.ok(p.files.has(f), f);
  assert.equal(p.entries.length, 10);
  assert.equal(p.done.capped, true);
});

test('R-WC-05: the forgery control fails when the verdict was tampered with, not only when text leaked', async () => {
  const { FORGED_PLAN_HASH } = await import('../loop/bundle.mjs');
  assert.ok(readFileSync(join(root, 'loop', 'sandbox', 'forgery-server.mjs'), 'utf8').includes(`FORGED_PLAN_HASH = '${FORGED_PLAN_HASH}'`));
  const marker = `wcforgery${'3'.repeat(32)}`;
  const { tools } = forgeryCatalog(marker);
  const real = { run: { status: 'complete' }, results: [
    { requirement: 'MWS-ANN-4', verdict: 'violated', write_path: { resource: '(catalog)', tool: 'attempt_id' } },
    { requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'fence' } },
  ] };
  const verdictOf = (files, planStdout) => {
    const s = summarize({ files: filesOf(files), steps: [], planStdout });
    const output = { summary: publicSummary(s), observations: observations(s, { versions: {}, stagesRan: {} }) };
    return forgeryVerdict({ marker, output, rawTexts: [marker], toolCount: s.catalog.tool_count, summary: s });
  };
  const cat = 'results/catalog-0123456789';
  // Split from the CLI: the real verdict.
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: real }, 'plan hash: 1111222233334444\n'), 'contained');
  // What the server could do sharing the CLI's container: rewrite results.json, write a plan hash into the CLI's stdout, plant a folder.
  const allHeld = { run: { status: 'complete' }, results: real.results.map((r) => ({ ...r, verdict: 'held' })) };
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: allHeld }, 'plan hash: 1111222233334444\n'), 'tampered');
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: real }, `plan hash: ${FORGED_PLAN_HASH}\n`), 'tampered');
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: real }, `plan hash: 1111222233334444\nplan hash: ${FORGED_PLAN_HASH}\n`), 'tampered');
  const forgedRec = { run: { status: 'complete' }, results: [...real.results, { requirement: 'MWS-ANN-4', verdict: 'held', write_path: { resource: '(catalog)', tool: 'forged' } }] };
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: forgedRec }, 'plan hash: 1111222233334444\n'), 'tampered');
  assert.equal(verdictOf({ [`${cat}/catalog.json`]: { tools }, [`${cat}/results.json`]: real, 'results/catalog-ffffffffff/results.json': allHeld }, 'plan hash: 1111222233334444\n'), 'not_read');
  // The tampering runs only where the driver asks for it: a test that starts the server must not write into its runner's processes.
  assert.match(readFileSync(join(root, 'loop', 'sandbox', 'forgery-server.mjs'), 'utf8'), /if \(process\.env\.FORGERY_TAMPER === '1'\)/);
});

test('R-WC-05: bridge and relay carry a stdio server over TCP, both ways, and the server answers after stdin ends', async () => {
  const port = 47000 + Math.floor(Math.random() * 900);
  const { spawn } = await import('node:child_process');
  const bridge = spawn(process.execPath, [join(root, 'loop', 'sandbox', 'bridge.mjs'), String(port), '--', process.execPath, join(root, 'loop', 'sandbox', 'forgery-server.mjs')], { env: { ...process.env, FORGERY_MARKER: 'm'.repeat(20) }, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    await new Promise((ok, no) => { bridge.stdout.on('data', (d) => { if (String(d).includes('"listening"')) ok(); }); bridge.on('exit', no); setTimeout(no, 10_000); });
    const r = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'relay.mjs'), '127.0.0.1', String(port)], { input: `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' })}\n`, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0);
    const msg = JSON.parse(r.stdout.trim().split('\n')[0]);
    assert.equal(msg.id, 7);
    assert.deepEqual(msg.result.tools.map((t) => t.name), ['attempt_id', 'fence']);
    const bad = spawnSync(process.execPath, [join(root, 'loop', 'sandbox', 'relay.mjs'), 'localhost', String(port)], { encoding: 'utf8' });
    assert.equal(bad.status, 2, 'an address that is not IPv4 is refused');
  } finally { bridge.kill('SIGKILL'); }
});

test('R-WC-05: every subject and the forgery control run split; only our locked fixtures share the CLI\'s container', async () => {
  const { serverContainer } = await import('../loop/run-items.mjs');
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /if \(!u\.manifestFile\) \{\n\s*\/\/ Every subject and the forgery control[^\n]*\n\s*await this\.splitRun\(/);
  const split = src.slice(src.indexOf('async splitRun('), src.indexOf('One unit (an item or a control) end to end'));
  // The server's container: the install volume read-only and the tools, never the output volume (serverContainer); an
  // OCI subject's (WC14) gets the tools only, read-only, and its bridge through the portable runtime.
  assert.match(split, /\.\.\.serverContainer\(u, \{ work, toolsVol: this\.toolsVol, serverCmd, loader: this\.loader \}\), env: u\.oci \? \{ \.\.\.runEnv\(\), \.\.\.BRIDGE_ENV_EMPTY \} : runEnv\(/);
  assert.doesNotMatch(split.slice(split.indexOf('sandboxRunArgs('), split.indexOf('this.writeSettings(argv')), /\bout\b/);
  const ours = serverContainer({}, { work: 'w', toolsVol: 't', serverCmd: ['srv'], loader: null });
  assert.deepEqual(ours.mounts, [{ src: 'w', dst: '/work', ro: true }, { src: 't', dst: '/opt/surface', ro: true }]);
  const oci = serverContainer({ oci: { workdir: '/app' } }, { work: 'w', toolsVol: 't', serverCmd: ['srv', '--stdio'], loader: 'ld-linux-x86-64.so.2' });
  assert.deepEqual(oci.mounts, [{ src: 't', dst: '/opt/surface', ro: true }]);
  assert.equal(oci.workdir, '/app');
  // The CLI's container: our helper at the probe address, with the output volume.
  assert.match(split, /helperRunArgs\(\{ name: cname, image: this\.images\.node24, network, ip: M\.NETS\.run\.probe/);
  const f = loadFixtures(join(root, 'loop', 'fixtures.json'));
  for (const x of Object.values(f.fixtures)) assert.ok(x.subject.startsWith('isokron-ai/') && x.manifest && x.lock, x.subject);
});

test('R-WC-07: fixtures install from committed lockfiles pinned by integrity', () => {
  const f = loadFixtures(join(root, 'loop', 'fixtures.json'));
  for (const [name, x] of Object.entries(f.fixtures)) {
    const lock = JSON.parse(readFileSync(join(root, x.lock, 'package-lock.json'), 'utf8'));
    assert.deepEqual(lockProblems(x, lock, name), [], name);
    if (x.source) continue; // WC12: a source fixture is the committed folder; test/pg-fixture.test.mjs pins it
    assert.equal(lock.packages[`node_modules/${x.launch.package}`].integrity, x.integrity);
    assert.deepEqual(JSON.parse(readFileSync(join(root, x.lock, 'package.json'), 'utf8')).dependencies, { [x.launch.package]: x.launch.version });
  }
  const x = f.fixtures['kronicle-lite'];
  const lock = JSON.parse(readFileSync(join(root, x.lock, 'package-lock.json'), 'utf8'));
  assert.ok(lockProblems({ ...x, integrity: `sha512-${'A'.repeat(86)}==` }, lock, 'kronicle-lite').length > 0, 'another integrity is refused');
  const loose = structuredClone(lock);
  loose.packages['node_modules/zod'].resolved = 'https://example.com/zod.tgz';
  assert.ok(lockProblems(x, loose, 'kronicle-lite').some((p) => p.includes('node_modules/zod')));
});

test('R-WC-08: teardown fails while a process of the sandbox user is left on the host', () => {
  const t = readFileSync(join(root, 'loop', 'teardown.sh'), 'utf8');
  assert.match(t, /pgrep -u 65534/);
  assert.match(t, /left\(\) \{ pgrep -f 'runsc-sandbox\|runsc-gofer\|containerd-shim-runsc' \|\| pgrep -u 65534; \}/);
  assert.match(t, /exit 1\n?$/);
});

test('R-WC-09: a native fixture builds from source in the build image; no fixture widens the install allowlist', async () => {
  const f = loadFixtures(join(root, 'loop', 'fixtures.json'));
  for (const x of Object.values(f.fixtures)) assert.equal(x.install_hosts, undefined);
  assert.equal(f.fixtures['kronicle-lite'].launch.install_scripts, true);
  const base = JSON.parse(readFileSync(join(root, 'loop', 'fixtures.json'), 'utf8'));
  base.fixtures['kronicle-lite'].install_hosts = ['github.com'];
  assert.throws(() => validateFixtures(base), /unknown field install_hosts/);
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  // The locked install keeps launchPlan's build image and carries the sandbox's native build env.
  assert.match(src, /\.\.\.\(native \? \{ env: \{ \.\.\.M\.NATIVE_BUILD_ENV \} \} : \{\}\)/);
  assert.match(src, /if \(native && \(!\/-build\$\/\.test\(plan\.image\) \|\| !plan\.runImage\)\) throw/);
  assert.match(src, /const registries = \[\.\.\.plan\.registries\];/);
  assert.doesNotMatch(src, /npm_config_proxy|installHosts/);
  const { egressHosts, MSC_NEEDS } = await import('../loop/run-items.mjs');
  assert.ok(MSC_NEEDS.includes('NATIVE_BUILD_ENV'));
  assert.deepEqual(egressHosts([{ host: 'registry.npmjs.org', allowed: true }, { host: 'registry.npmjs.org', allowed: true }, { host: 'github.com', allowed: false }, { host: 'Attempt_ID=x', allowed: false }]), ['(other)', 'github.com (refused)', 'registry.npmjs.org']);
  if (process.env.MSC_DIR) {
    const { pathToFileURL } = await import('node:url');
    const T = await import(pathToFileURL(join(process.env.MSC_DIR, 'src', 'targets.mjs')).href);
    const plan = T.launchPlan({ kind: 'npm', package: 'kronicle-lite', version: '0.11.2', install_scripts: true });
    assert.equal(plan.image, 'node24-build');
    assert.equal(plan.runImage, 'node24');
    assert.deepEqual(plan.registries, ['registry.npmjs.org']);
    assert.deepEqual({ ...T.NATIVE_BUILD_ENV }, { npm_config_nodedir: '/usr/local', npm_config_build_from_source: 'true' });
  }
});

test('R-WC-12: the collector reads its root only when it resolves to itself; a link at the root or above it is refused, not followed', () => {
  const run = (root) => spawnSync(process.execPath, [join(root_, 'loop', 'sandbox', 'collect.mjs'), root, '100', '1000', '100'], { encoding: 'utf8' });
  const root_ = join(dirname(fileURLToPath(import.meta.url)), '..');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'wc-collect-root-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'wc-collect-outside-')));
  writeFileSync(join(outside, 'leak.txt'), 'from the helper\'s own filesystem');
  mkdirSync(join(outside, 'out'));
  writeFileSync(join(outside, 'out', 'leak2.txt'), 'x');
  // A real folder is listed as before; a missing one is an empty listing.
  mkdirSync(join(work, 'out'));
  writeFileSync(join(work, 'out', 'results.json'), '{}');
  const ok = run(join(work, 'out'));
  assert.equal(ok.status, 0);
  assert.deepEqual(parseCollected(ok.stdout).entries.map((e) => e.path), ['results.json']);
  assert.equal(run(join(work, 'missing')).status, 0);
  // The root itself is a link (a target replaced /work/out): refused with one error line and no listing.
  symlinkSync(outside, join(work, 'out-link'));
  const l1 = run(join(work, 'out-link'));
  assert.equal(l1.status, 3);
  assert.deepEqual(JSON.parse(l1.stdout.trim()), { error: 'root_is_a_link' });
  assert.ok(!l1.stdout.includes('leak.txt'));
  // A folder above the root is a link: refused too.
  symlinkSync(outside, join(work, 'dir-link'));
  const l2 = run(join(work, 'dir-link', 'out'));
  assert.equal(l2.status, 3);
  assert.ok(!l2.stdout.includes('leak2.txt'));
  // The driver treats a refused read as no output: no done line, nothing collected.
  assert.ok(!parseCollected(l1.stdout).done);
  assert.equal(parseCollected(l1.stdout).files.size, 0);
});

// Every path of itemSkips, with the inputs the driver gives it (loop/run-items.mjs runItem).
function everySkipPath(fixtures) {
  const inst = (o = {}) => ({ ok: false, timed_out: false, steps: [{ name: 'install', exit: 1, timed_out: false }], egress: [], ...o });
  const ran = { init: true, plan: true, catalog: true };
  return {
    not_in_seed: itemSkips({ resolved: resolveSubject('acme/unknown', { seed: SEED, fixtures }) }),
    no_package: itemSkips({ resolved: resolveSubject('acme/oci-only', { seed: SEED, fixtures }) }),
    http_only: itemSkips({ resolved: resolveSubject('acme/http-only', { seed: SEED, fixtures }) }),
    wrong_fixture: itemSkips({ resolved: resolveSubject('acme/npm-server', { seed: SEED, fixtures }, 'tiny-tracker') }),
    not_started: itemSkips({ resolved: resolveSubject('acme/npm-server', { seed: SEED, fixtures }), notStarted: true }),
    harness: itemSkips({ resolved: {}, res: { error: 'harness', install: null, fullRan: false }, stages: {} }),
    install_failed: itemSkips({ resolved: {}, res: { error: null, install: inst(), fullRan: false } }),
    install_404: itemSkips({ resolved: {}, res: { error: null, install: inst({ kind: 'npm', scripts: false }), fullRan: false }, installLog: 'npm error code E404\nnpm error 404 Not Found' }),
    install_timeout: itemSkips({ resolved: {}, res: { error: null, install: inst({ timed_out: true }), fullRan: false } }),
    third_party_ran: itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, fullRan: false }, unit: { init: true, full: null }, stages: ran }),
    fixture_http_init: itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, fullRan: true }, unit: { init: false, full: {} }, stages: { plan: true, catalog: true } }),
    evidence_missing: itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, fullRan: false }, unit: { init: true }, stages: ran, evidenceComplete: false }),
  };
}

test('R-WC-24: every skip says its fault side, one the reason allows; our own limits are the tool\'s, never the subject\'s', () => {
  const fixtures = loadFixtures(join(root, 'loop', 'fixtures.json'));
  const paths = everySkipPath(fixtures);
  for (const [name, { skips }] of Object.entries(paths)) {
    assert.ok(skips.length > 0, name);
    for (const sk of skips) {
      assert.ok(Object.hasOwn(SKIP_FAULTS, sk.reason), `${name}: ${sk.reason} is a contract reason`);
      assert.equal(typeof sk.fault, 'string', `${name}: ${sk.stage}:${sk.reason} declares a fault`);
      assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault), `${name}: ${sk.reason} may be ${sk.fault}`);
    }
  }
  // A subject with no npm or PyPI package (OCI images, crates) is a gap of ours: tool, and the result is unassessed by our limit.
  assert.deepEqual([...new Set(paths.no_package.skips.map((s) => `${s.reason}:${s.fault}`))], ['no_runnable_artifact:tool']);
  assert.equal(resultFault(paths.no_package.skips).coverage, 'unassessed_tool');
  assert.deepEqual([...new Set(paths.http_only.skips.map((s) => s.fault))], ['tool']);
  assert.deepEqual([...new Set(paths.not_in_seed.skips.map((s) => s.fault))], ['policy']);
  assert.deepEqual([...new Set(paths.not_started.skips.map((s) => `${s.reason}:${s.fault}:${s.retryable}`))], ['timeout_start:tool:true']);
  assert.equal(paths.third_party_ran.skips.find((s) => s.stage === 'full').fault, 'policy');
  assert.equal(paths.fixture_http_init.skips.find((s) => s.stage === 'init').fault, 'tool');
  assert.equal(paths.evidence_missing.skips.find((s) => s.reason === 'trace_unavailable').fault, 'tool');
  assert.equal(REASON_FAULT.no_runnable_artifact, 'tool');
  // The kit at the pinned commit accepts the manifests, and refuses a fault the reason does not allow.
  const workflow = { repo: 'isokron-ai/mcp-writecheck-action', file: '.github/workflows/corpus.yml', sha: 'e'.repeat(40), run_id: 5, run_attempt: 1 };
  const files = [{ path: 'logs/driver.json', data: Buffer.from('{}') }];
  const manifestOf = (skips) => buildManifest({ identity: { attempt_id: 'att-1', fence: 3, run_key: KEY }, workflow, files, meta: buildMeta({ subject: 'acme/x', tools: [{ name: 'mcp-writecheck', version: 'c'.repeat(40) }], settingsDigest: 'd'.repeat(64), startedAt: '2026-11-25T00:00:00Z', finishedAt: '2026-11-25T00:01:00Z', skips, controls: [] }) });
  for (const [name, { skips }] of Object.entries(paths)) assert.deepEqual(validateManifest(manifestOf(skips)).errors, [], name);
  assert.throws(() => manifestOf([{ stage: 'install', reason: 'no_runnable_artifact', fault: 'infra', evidence: 'logs/driver.json' }]), /not a fault no_runnable_artifact may have/);
  // The driver builds its skips only through itemSkips: no skip object is written in run-items.mjs itself.
  const driver = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.doesNotMatch(driver, /skips\.push\(\{/);
  assert.match(driver, /itemSkips\(\{ resolved, res, unit: u, stages, evidenceComplete, installLog, serverLog \}\)/);
});

test('R-WC-25: a harness error is our own tool_error (retryable), not somebody else\'s outage', () => {
  const { skips } = everySkipPath(loadFixtures(join(root, 'loop', 'fixtures.json'))).harness;
  assert.deepEqual(skips.map((s) => s.stage), ['install', 'init', 'plan', 'catalog']);
  for (const s of skips) assert.deepEqual([s.reason, s.fault, s.retryable], ['tool_error', 'tool', true]);
  // Stages that ran before the harness failed are not skips.
  assert.deepEqual(itemSkips({ resolved: {}, res: { error: 'harness', install: { ok: true } }, stages: { install: true, init: true } }).skips.map((s) => s.stage), ['plan', 'catalog']);
});

test('R-WC-26: an install failure is the subject\'s only with a package-level error in its own output; our limits are the tool\'s', () => {
  const npm = (o = {}) => ({ kind: 'npm', scripts: false, ok: false, timed_out: false, steps: [{ name: 'install', exit: 1, timed_out: false }], egress: [], ...o });
  const pypi = (o = {}) => ({ kind: 'pypi', package: 'acme-mcp', ok: false, timed_out: false, steps: [{ name: 'venv', exit: 0 }, { name: 'install', exit: 1, timed_out: false }], egress: [], ...o });
  const NOT_FOUND = 'ERROR: Could not find a version that satisfies the requirement acme-mcp (from versions: none)\nERROR: No matching distribution found for acme-mcp\n';
  assert.equal(installFault(npm(), 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/acme\n'), 'subject');
  assert.equal(installFault(npm(), 'npm ERR! code ETARGET\nnpm ERR! notarget No matching version\n'), 'subject');
  assert.equal(installFault(pypi(), NOT_FOUND), 'subject');
  // The package declares nothing to run at all.
  assert.equal(installFault(npm({ steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], entry_error: 'declares_no_bin' })), 'subject');
  // Ours: no evidence, a native build, our proxy refusing a host, our time limit, our memory limit (137) or timeout (124).
  assert.equal(installFault(npm(), 'gyp ERR! build error\n'), 'tool');
  assert.equal(installFault(npm(), ''), 'tool');
  assert.equal(installFault(npm({ egress: [{ host: 'github.com', allowed: false }] }), 'npm error code E404\n'), 'tool');
  assert.equal(installFault(npm({ timed_out: true }), 'npm error code E404\n'), 'tool');
  assert.equal(installFault(npm({ steps: [{ name: 'install', exit: 137 }] })), 'tool');
  assert.equal(installFault(npm({ steps: [{ name: 'install', exit: 124 }] })), 'tool');
  assert.equal(installFault(npm({ steps: [{ name: 'install', exit: 1, timed_out: true }] }), 'npm error code E404\n'), 'tool');
  assert.equal(installFault(null), 'tool');
  // Through itemSkips: the same evidence decides the skips' fault.
  const paths = everySkipPath(loadFixtures(join(root, 'loop', 'fixtures.json')));
  assert.deepEqual([...new Set(paths.install_404.skips.map((s) => `${s.reason}:${s.fault}`))], ['install_failed_registry:subject']);
  assert.deepEqual([...new Set(paths.install_failed.skips.map((s) => `${s.reason}:${s.fault}`))], ['install_failed_registry:tool']);
  assert.deepEqual([...new Set(paths.install_timeout.skips.map((s) => `${s.reason}:${s.fault}`))], ['timeout_start:tool']);
});

test('R-WC-30: an entry step failure is the subject\'s only when the package declares nothing to run; every other entry answer is ours', () => {
  // The helper's answers (msc sandbox/npm-entry.mjs at 11974fb), as codes.
  assert.equal(entryErrorCode({ error: 'the package declares no bin' }, 1), 'declares_no_bin');
  assert.equal(entryErrorCode({ error: 'the package has no bin of that name' }, 1), 'no_bin_of_that_name');
  assert.equal(entryErrorCode({ error: 'the installed package has no readable package.json: ENOENT' }, 1), 'entry_failed');
  assert.equal(entryErrorCode({ error: 'the bin script is not in the package' }, 1), 'entry_failed');
  assert.equal(entryErrorCode({ error: 'the bin script points outside the package' }, 1), 'entry_failed');
  assert.equal(entryErrorCode(null, 1), 'entry_failed');
  // Docker, the image or a crash, not the helper's answer; and an exit 0 whose answer did not parse.
  for (const code of [125, 126, 127, 139, 2, null]) assert.equal(entryErrorCode({ error: 'the package declares no bin' }, code), 'entry_crashed', String(code));
  assert.equal(entryErrorCode({ script: 'elsewhere' }, 0), 'entry_unreadable');
  const at = (entry_error, exit = 1) => installFault({ kind: 'npm', scripts: false, ok: false, steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit }], egress: [], entry_error });
  assert.equal(at('declares_no_bin'), 'subject');
  // The bin name comes from our mapping (the seed, the registry, a fixture), not from the package: ours.
  for (const e of ['no_bin_of_that_name', 'entry_failed', 'entry_crashed', 'entry_unreadable']) assert.equal(at(e), 'tool', e);
  assert.equal(at('entry_crashed', 139), 'tool');
  // An entry step that failed without a code, or a failure with every step at 0, is no evidence.
  assert.equal(installFault({ kind: 'npm', scripts: false, ok: false, steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], egress: [] }), 'tool');
  assert.equal(installFault({ kind: 'npm', scripts: false, ok: false, steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 0 }], egress: [] }), 'tool');
  // The driver passes the helper's answer on as a code (its stdout is not in the install log).
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /if \(!entry\) inst\.entry_error = entryErrorCode\(j, r\.exit\);/);
});

test('R-WC-31: install output counts as evidence only where no code of the package could have written it, and only about the package', () => {
  const npm = (o = {}) => ({ kind: 'npm', scripts: false, ok: false, steps: [{ name: 'install', exit: 1 }], egress: [], ...o });
  const pypi = (o = {}) => ({ kind: 'pypi', package: 'acme-mcp', ok: false, steps: [{ name: 'venv', exit: 0 }, { name: 'install', exit: 1 }], egress: [], ...o });
  const E404 = 'npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/acme\nnpm error A complete log of this run can be found in: /work/home/.npm/_logs/x.log\n';
  // npm with lifecycle scripts on: a script could print anything, so nothing it printed counts.
  assert.equal(installFault(npm({ scripts: true }), E404), 'tool');
  assert.equal(installFault(npm({ scripts: undefined }), E404), 'tool', 'unknown whether scripts ran: no evidence');
  // Scripts off: only npm's final error block counts; an E404 line earlier (a deprecation notice with a newline in it,
  // a dependency's warning) followed by another failure does not.
  assert.equal(installFault(npm(), E404), 'subject');
  assert.equal(installFault(npm(), `npm warn deprecated acme@1.0.0: x\nnpm error code E404\nnpm warn something\nnpm error code EBADENGINE\nnpm error engine Unsupported engine\n`), 'tool');
  assert.equal(installFault(npm(), 'npm warn deprecated acme@1: see\nnpm error code E404 (forged in a message)\nnpm error code 1\n'), 'tool');
  assert.equal(installFault(npm(), `${E404}npm warn later output\n`), 'tool');
  // Our own lines after npm's (a network name, a container id) do not matter.
  assert.equal(installFault(npm(), `${E404}surface-abc-i0-in\n`), 'subject');
  // pip: "(from versions: none)" and "no matching distribution" for the package itself, nothing else in the way.
  const NOT_FOUND = 'ERROR: Could not find a version that satisfies the requirement acme-mcp (from versions: none)\nERROR: No matching distribution found for acme-mcp\n';
  assert.equal(installFault(pypi(), NOT_FOUND), 'subject');
  assert.equal(installFault(pypi({ package: 'Acme_MCP' }), NOT_FOUND), 'subject', 'names compared as pip normalises them');
  // pip's own connection retries before the same lines (a proxy outage, DNS, a timeout: no refusal record).
  assert.equal(installFault(pypi(), `WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'ProxyError('Cannot connect to proxy.')': /simple/acme-mcp/\n${NOT_FOUND}`), 'tool');
  assert.equal(installFault(pypi(), `WARNING: Max retries exceeded with url: /simple/acme-mcp/\n${NOT_FOUND}`), 'tool');
  assert.equal(installFault(pypi(), `Temporary failure in name resolution\n${NOT_FOUND}`), 'tool');
  // A Python-version mismatch: the package exists, our image's Python is not one it supports.
  assert.equal(installFault(pypi(), 'ERROR: Ignored the following versions that require a different python version: 1.0 Requires-Python >=3.14\nERROR: Could not find a version that satisfies the requirement acme-mcp (from versions: none)\nERROR: No matching distribution found for acme-mcp\n'), 'tool');
  // Versions exist but none fits: not proven to be the package's.
  assert.equal(installFault(pypi(), 'ERROR: Could not find a version that satisfies the requirement acme-mcp (from versions: 0.1, 0.2)\nERROR: No matching distribution found for acme-mcp\n'), 'tool');
  // About a dependency, or after a build of anything ran (a setup.py could print the same lines).
  assert.equal(installFault(pypi(), 'ERROR: Could not find a version that satisfies the requirement other-dep (from versions: none)\nERROR: No matching distribution found for other-dep\n'), 'tool');
  assert.equal(installFault(pypi(), `  Preparing metadata (pyproject.toml): started\n${NOT_FOUND}`), 'tool');
  assert.equal(installFault(pypi(), `Building wheel for acme-mcp (pyproject.toml)\n${NOT_FOUND}`), 'tool');
  // The old loose patterns alone are no longer evidence.
  assert.equal(installFault(pypi(), 'ERROR: No matching distribution found for acme-mcp\n'), 'tool');
  assert.equal(installFault({ kind: 'cargo', ok: false, steps: [{ name: 'install', exit: 101 }], egress: [] }, 'npm error code E404\n'), 'tool');
  // The driver records whether npm ran scripts, and the package asked for.
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /const scripts = u\.launch\.kind === 'npm' \? !plan\.install\.some\(\(st\) => st\.name === 'install' && st\.cmd\.includes\('--ignore-scripts'\)\) : null;/);
});

test('R-WC-12: a root that is not a folder (a file, a FIFO where the output folder was) is refused with its own documented error', () => {
  const root_ = join(dirname(fileURLToPath(import.meta.url)), '..');
  const collect = join(root_, 'loop', 'sandbox', 'collect.mjs');
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'wc-collect-file-')));
  writeFileSync(join(work, 'out'), 'a file where /work/out was');
  const r = spawnSync(process.execPath, [collect, join(work, 'out'), '100', '1000', '100'], { encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { error: 'root_is_not_a_folder' });
  assert.equal(parseCollected(r.stdout).files.size, 0);
  assert.ok(!parseCollected(r.stdout).done);
  // Every error the collector can print is documented in its header.
  const text = readFileSync(collect, 'utf8');
  const header = text.slice(0, text.indexOf('*/'));
  for (const code of new Set([...text.matchAll(/'(root_[a-z_]+)'/g)].map((m) => m[1]))) assert.ok(header.includes(`"${code}"`), `${code} is documented`);
});

test('R-WC-27: loop/README.md names the sandbox commit the workflows pin', () => {
  const readme = readFileSync(join(root, 'loop', 'README.md'), 'utf8');
  for (const wf of ['corpus.yml', 'loop-fixture.yml']) {
    const ref = /SANDBOX_REF: '([0-9a-f]{40})'/.exec(readFileSync(join(root, '.github', 'workflows', wf), 'utf8'))[1];
    assert.match(readme, new RegExp(`\\(\`SANDBOX_REF\`, ${ref.slice(0, 7)}\\)`), wf);
  }
  // No other seven-hex sandbox pin is named beside SANDBOX_REF.
  assert.equal([...readme.matchAll(/`SANDBOX_REF`, ([0-9a-f]{7})/g)].length, 1);
});

test('R-WC-29: the manifest names each tool by its tool-qa pin key, mcp-writecheck-action at the commit that ran', async () => {
  const { actionSha, gitHead, toolsFor } = await import('../loop/run-items.mjs');
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  // The workflow's checked ACTION_SHA, which must be the checkout's HEAD; never GITHUB_SHA (the YAML's branch head).
  assert.equal(actionSha({ ACTION_SHA: A, GITHUB_SHA: B }, A), A);
  assert.equal(actionSha({ GITHUB_SHA: B }, A), A, 'without ACTION_SHA, the HEAD, not GITHUB_SHA');
  assert.throws(() => actionSha({ ACTION_SHA: A }, B), /not the commit checked out/);
  assert.throws(() => actionSha({ ACTION_SHA: 'abc123' }, 'abc123'), /full commit SHA/);
  assert.equal(actionSha({}, null), 'local');
  assert.match(gitHead(root) ?? '', /^[0-9a-f]{40}$/);
  // The names are the keys of tool-qa pump/workflows.json writecheck versions (tool: mcp-writecheck-action, mcp-writecheck;
  // probe: mcp-surface-corpus), so ingest can prove every pin.
  const tools = toolsFor({ cliRef: 'c'.repeat(40), actionRef: A, sandboxRef: 'd'.repeat(40), gvisor: 'release-20261101.0' });
  assert.deepEqual(tools.map((t) => t.name), ['mcp-writecheck', 'mcp-writecheck-action', 'mcp-surface-corpus', 'gvisor']);
  assert.deepEqual(Object.fromEntries(tools.map((t) => [t.name, t.version])), { 'mcp-writecheck': 'c'.repeat(40), 'mcp-writecheck-action': A, 'mcp-surface-corpus': 'd'.repeat(40), gvisor: 'release-20261101.0' });
  // The driver reports through these two only.
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('export async function main')), /GITHUB_SHA|mcp-surface-corpus-sandbox/);
  assert.match(src, /const actionRef = actionSha\(env, gitHead\(\)\);/);
  assert.match(src, /ctx\.tools = toolsFor\(\{ cliRef: env\.CLI_REF, actionRef, sandboxRef: env\.SANDBOX_REF, gvisor: shard\.cfg\.release(?:, mckRef: ctx\.mckRef)? \}\);/);
  assert.deepEqual(toolsFor({ cliRef: 'c', actionRef: A, sandboxRef: 'd', gvisor: 'g', mckRef: 'e'.repeat(40) }).at(-1), { name: 'mcp-check', version: 'e'.repeat(40) });
});

// R-WC-40. The shapes are the 25-27 Nov loop bundles: init, plan and catalog each exited 4 after about 30.5 s with
// "server INIT did not initialize: timed out", no tool read. apollographql/apollo-mcp-server@efeeae43e2cd (OCI) logged
// "failed to read config file '/config.yaml'"; isokron-ai/mcp-check@99da78b026bf (npm) resolves to its command line
// tool, which prints its usage. Both were recorded fault policy, coverage excluded.
const FAILED_STEPS = ['init', 'plan', 'catalog'].map((step) => ({ step, exit: 4, timed_out: false, ms: 30_512 }));
const APOLLO_LOG = '{"listening":7100}\nError: failed to read config file \'/config.yaml\': No such file or directory (os error 2)\n';
const MCK_LOG = '{"listening":7100}\nmcp-check: no input: give a tools.json file, -, --stdin, --url, -- <command>, --config, --repo, --repo-dir or --registry\n\nmcp-check 1.3.1: grade an MCP server\'s tools/list (rubric 2.2.0)\n\nUsage:\n  mcp-check <tools.json | - | --stdin> [options]\n';

test('R-WC-40: a stage counts as run only when its step ended with a status that means it ran; a server whose init, plan and catalog failed is ours, never excluded by policy', () => {
  // The statuses are the CLI's own (contract.mjs): 0 done, 1 a verdict.
  assert.deepEqual([...STAGE_RAN_EXITS], CLI.exitRanToCompletion);
  assert.deepEqual(stagesRan(FAILED_STEPS), { init: false, plan: false, catalog: false });
  assert.deepEqual(stagesRan([{ step: 'init', exit: 0 }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 1 }, { step: 'full', exit: 0, timed_out: true }]), { init: true, plan: true, catalog: true, full: false });
  const third = { init: true, full: null };
  const run = (log, steps = FAILED_STEPS) => itemSkips({ resolved: {}, res: { error: null, install: { ok: true }, steps, fullRan: false }, unit: third, stages: { install: true, ...stagesRan(steps) }, serverLog: log });
  const apollo = run(APOLLO_LOG);
  assert.deepEqual(apollo.skips.map((x) => `${x.stage}:${x.reason}:${x.fault}`), ['init:timeout_start:tool', 'plan:timeout_start:tool', 'catalog:timeout_start:tool', 'full:policy_excluded:policy']);
  assert.deepEqual(apollo.notes.stage_detail, { init: 'start_needs_config', plan: 'start_needs_config', catalog: 'start_needs_config' });
  // Our limit comes first: the result is unassessed by our tool, not excluded and not the server's.
  assert.deepEqual(resultFault(apollo.skips).coverage, 'unassessed_tool');
  const mck = run(MCK_LOG);
  assert.deepEqual([...new Set(mck.skips.filter((x) => x.stage !== 'full').map((x) => `${x.reason}:${x.fault}`))], ['no_runnable_artifact:tool']);
  assert.equal(mck.notes.stage_detail.catalog, 'not_a_server');
  assert.equal(resultFault(mck.skips).fault, 'tool');
  // Nothing telling on stderr: still ours (an ambiguous failure is never the server's).
  assert.deepEqual(stageFailure({ exit: 4, timed_out: false }, '{"listening":7100}\n'), { reason: 'timeout_start', fault: 'tool', detail: 'start_failed' });
  assert.deepEqual(stageFailure({ exit: 4, timed_out: true }, APOLLO_LOG).detail, 'step_timeout');
  assert.deepEqual(stageFailure({ exit: 2 }, '').reason, 'tool_error');
  assert.deepEqual(stageFailure(null, '').detail, 'not_attempted');
  // One stage failed after the others ran: only that one is a skip.
  const partial = run('', [{ step: 'init', exit: 0 }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 4 }]);
  assert.deepEqual(partial.skips.map((x) => x.stage), ['catalog', 'full']);
  // A catalog that ran (github/github-mcp-server, 46 tools) keeps only the full stage's policy skip.
  assert.deepEqual(run('', [{ step: 'init', exit: 0 }, { step: 'plan', exit: 0 }, { step: 'catalog', exit: 1 }]).skips.map((x) => `${x.stage}:${x.fault}`), ['full:policy']);
  // A fixture's setup that failed leaves init, plan and catalog never started: ours too.
  assert.deepEqual(run('', [{ step: 'setup-0', exit: 1 }]).skips.filter((x) => x.stage !== 'full').map((x) => `${x.reason}:${x.fault}`), ['tool_error:tool', 'tool_error:tool', 'tool_error:tool']);
  // Every skip is one the kit accepts.
  for (const sk of [...apollo.skips, ...mck.skips]) assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault), `${sk.reason}/${sk.fault}`);
  // The driver marks stages through stagesRan, and gives itemSkips the server's stderr.
  const driver = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(driver, /Object\.assign\(stages, stagesRan\(res\.steps\)\)/);
  assert.doesNotMatch(driver, /stages\[s\.step\] = true/);
  // The stderr comes from a split run's server.log, else the failed steps' own logs.
  const d = mkdtempSync(join(tmpdir(), 'wc40-'));
  writeFileSync(join(d, 'init.log'), 'error: server INIT did not initialize: timed out\nUsage: x\n');
  assert.match(lastStderr(d, FAILED_STEPS), /Usage: x/);
  writeFileSync(join(d, 'server.log'), APOLLO_LOG);
  assert.equal(lastStderr(d, FAILED_STEPS), APOLLO_LOG);
});

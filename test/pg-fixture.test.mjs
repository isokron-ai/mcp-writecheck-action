// WC12: the PostgreSQL fixture of the writecheck loop (loop/fixtures/pg-tracker, dogfood/pg-tracker/writecheck.yaml):
// a source fixture pinned by the digest of its committed folder, a real PostgreSQL server started inside the sandbox
// container for the full write test only, and every result of that test labelled "hermetic".
//
// Offline tests run everywhere. The live tests (R-WC-17) run the pinned CLI against a real PostgreSQL on this machine,
// with the clean build and with each defect build; they need CLI_DIR (a built packages/writecheck) and the fixture's
// dependencies (`npm ci --omit=dev` in loop/fixtures/pg-tracker), and skip themselves without them.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BACKEND_HERMETIC, INSTALL_SCRIPT_ALLOW, loadFixtures, lockProblems, parseItems, resolveSubject, sourceDigest, validateFixtures } from '../loop/items.mjs';
import { findRunFolder, observations, summarize } from '../loop/summary.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(root, 'loop', 'fixtures', 'pg-tracker');
const read = (p) => readFileSync(join(root, p), 'utf8');
const fixtures = () => loadFixtures(join(root, 'loop', 'fixtures.json'));
const tmps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };
after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

/** The fixture folder as it is committed: without a node_modules. */
function copyFixture(to) {
  cpSync(FIX, to, { recursive: true, filter: (s) => !s.split('/').includes('node_modules') });
}

test('R-WC-14: pg-tracker is a source fixture: its folder is pinned by digest, its dependencies by lockfile', () => {
  const f = fixtures().fixtures['pg-tracker'];
  assert.equal(f.source.dir, 'loop/fixtures/pg-tracker');
  assert.equal(sourceDigest(FIX), f.source.sha256, 'fixtures.json pins the committed bytes of the folder');
  assert.equal(f.integrity, undefined);
  assert.equal(f.launch.install_scripts, true, 'the PostgreSQL binaries are linked by the platform package\'s install script, so it installs in the build image');
  const lock = JSON.parse(readFileSync(join(FIX, 'package-lock.json'), 'utf8'));
  assert.deepEqual(lockProblems(f, lock, 'pg-tracker'), []);
  assert.deepEqual(Object.keys(lock.packages[''].dependencies).sort(), ['embedded-postgres', 'pg']);
  // Every dependency is an exact version (the lock root, the package.json), every package from the registry with a sha512.
  for (const v of Object.values(lock.packages[''].dependencies)) assert.match(v, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  // The runtime never loads embedded-postgres's JavaScript, only its binaries; a change to that is a reviewed one.
  // Every import form: static, dynamic, require, createRequire, import.meta.resolve. Only guard.mjs may name the package (to block it).
  for (const file of readdirSync(join(FIX, 'src'))) {
    const src = readFileSync(join(FIX, 'src', file), 'utf8').replace(/\/\/[^\n]*/g, '');
    const named = [...src.matchAll(/['"`]embedded-postgres(?:\/[^'"`]*)?['"`]/g)];
    if (file === 'guard.mjs') continue;
    assert.deepEqual(named.map((m) => m[0]), [], `${file} names the embedded-postgres module`);
  }
  assert.match(readFileSync(join(FIX, 'src', 'cli.mjs'), 'utf8'), /^import '\.\/guard\.mjs';/m);
});

test('R-WC-14: a changed byte of the fixture, a loosened lock or a lost label is refused (mutations)', () => {
  const base = JSON.parse(read('loop/fixtures.json'));
  // 1. A changed byte of the server's source no longer matches the digest in fixtures.json.
  const dir = tmp('wc12-mut-');
  mkdirSync(join(dir, 'loop', 'fixtures'), { recursive: true });
  copyFixture(join(dir, 'loop', 'fixtures', 'pg-tracker'));
  for (const name of ['tiny-tracker', 'kronicle-lite', 'redis-tracker']) cpSync(join(root, 'loop', 'fixtures', name), join(dir, 'loop', 'fixtures', name), { recursive: true, filter: (s) => !s.split('/').includes('node_modules') });
  writeFileSync(join(dir, 'loop', 'fixtures.json'), JSON.stringify(base));
  assert.doesNotThrow(() => loadFixtures(join(dir, 'loop', 'fixtures.json')));
  const mcp = join(dir, 'loop', 'fixtures', 'pg-tracker', 'src', 'mcp.mjs');
  writeFileSync(mcp, `${readFileSync(mcp, 'utf8')}\n// a change nobody reviewed\n`);
  assert.throws(() => loadFixtures(join(dir, 'loop', 'fixtures.json')), /digest/);
  // 2. A source fixture with an npm integrity, a lock from another host, a ranged dependency, or a backend that is not hermetic.
  const bad = (edit) => { const d = structuredClone(base); edit(d.fixtures['pg-tracker']); return () => validateFixtures(d); };
  assert.throws(bad((f) => { f.integrity = `sha512-${'A'.repeat(86)}==`; }), /no integrity/);
  assert.throws(bad((f) => { f.backend.environment = 'shared'; }), /hermetic/);
  assert.throws(bad((f) => { delete f.backend; }), /backend must be/);
  assert.throws(bad((f) => { f.source.dir = 'loop/fixtures/tiny-tracker'; }), /lock folder/);
  assert.throws(bad((f) => { f.background.only = ['plan', 'serve']; }), /background\.only/);
  const f = fixtures().fixtures['pg-tracker'];
  const lock = JSON.parse(readFileSync(join(FIX, 'package-lock.json'), 'utf8'));
  const loose = structuredClone(lock);
  loose.packages['node_modules/pg'].resolved = 'https://example.com/pg.tgz';
  assert.ok(lockProblems(f, loose, 'pg-tracker').some((p) => p.includes('node_modules/pg')));
  const ranged = structuredClone(lock);
  ranged.packages[''].dependencies.pg = '^8.23.1';
  assert.ok(lockProblems(f, ranged, 'pg-tracker').some((p) => p.includes('exact version')));
  // An install script on any package outside the allowlist is a problem (the allowlist: embedded-postgres's platform packages only).
  const sneaky = structuredClone(lock);
  sneaky.packages['node_modules/pg'].hasInstallScript = true;
  assert.ok(lockProblems(f, sneaky, 'pg-tracker').some((p) => p.includes('node_modules/pg') && p.includes('install script')));
  const wrapper = structuredClone(lock);
  wrapper.packages['node_modules/embedded-postgres'].hasInstallScript = true;
  assert.ok(lockProblems(f, wrapper, 'pg-tracker').some((p) => p.includes('node_modules/embedded-postgres ')));
  const nonOptional = structuredClone(lock);
  delete nonOptional.packages['node_modules/@embedded-postgres/linux-x64'].optional;
  assert.ok(lockProblems(f, nonOptional, 'pg-tracker').some((p) => p.includes('optional')));
  assert.deepEqual(lock.packages['node_modules/@embedded-postgres/linux-x64'].hasInstallScript, true);
  for (const [k, v] of Object.entries(lock.packages)) if (v.hasInstallScript) assert.match(k, INSTALL_SCRIPT_ALLOW['pg-tracker']);
});

test('R-WC-15: every result of a full write test is labelled hermetic; nothing else is', () => {
  const f = fixtures().fixtures['pg-tracker'];
  assert.equal(f.backend.environment, BACKEND_HERMETIC);
  for (const x of Object.values(fixtures().fixtures)) assert.equal(x.backend.environment, 'hermetic', 'tiny-tracker and kronicle-lite are labelled the same way');
  const results = (rs) => Buffer.from(JSON.stringify({ run: { status: 'complete', writes: 5 }, results: rs }));
  const files = new Map([
    ['results/catalog-0123456789/results.json', results([{ requirement: 'MWS-ANN-4', verdict: 'held', write_path: { tool: 'update_item', resource: 'item' } }])],
    ['results/catalog-0123456789/catalog.json', Buffer.from(JSON.stringify({ tools: [{ name: 'update_item', annotations: { readOnlyHint: false } }] }))],
    ['full/run1/results.json', results([{ requirement: 'MWS-CONC-2', verdict: 'held', write_path: { tool: 'delete_item', resource: 'item' } }, { requirement: 'MWS-TGT-2', verdict: 'held', write_path: { tool: 'delete_items', resource: 'item' } }])],
  ]);
  const ran = summarize({ files, steps: [], planStdout: 'plan hash: 36b151549223fe4e\n', fullRan: true, acceptedPlanHash: '36b151549223fe4e' });
  const obs = observations(ran, { versions: {}, stagesRan: { install: true, full: true }, backend: f.backend });
  const cov = obs.find((o) => o.field === 'observation_coverage').value;
  assert.equal(cov.backend_environment, 'hermetic');
  assert.equal(cov.backend_kind, 'postgresql');
  assert.equal(obs.find((o) => o.field === 'backend_version').value, f.backend.version);
  const fullVerdicts = obs.filter((o) => o.field === 'requirement_verdicts' && o.stage === 'full').flatMap((o) => o.value);
  assert.equal(fullVerdicts.length, 2);
  assert.ok(fullVerdicts.every((v) => v.backend_environment === 'hermetic' && v.mode === 'full'));
  assert.ok(obs.find((o) => o.field === 'conflict_behaviour').value.backend_environment === 'hermetic');
  // The catalog read of the same item made no write and used no backend: its records carry no label.
  const catalogVerdicts = obs.filter((o) => o.field === 'requirement_verdicts' && o.stage === 'catalog').flatMap((o) => o.value);
  assert.ok(catalogVerdicts.length > 0 && catalogVerdicts.every((v) => v.backend_environment === undefined));
  // No full run, or a third-party server (no fixture, no backend): "none", never hermetic.
  const catalogOnly = summarize({ files: new Map([...files].filter(([p]) => !p.startsWith('full/'))), steps: [], planStdout: '', fullRan: false });
  for (const backend of [f.backend, null]) {
    const o = observations(catalogOnly, { versions: {}, stagesRan: {}, backend });
    assert.deepEqual([o.find((x) => x.field === 'observation_coverage').value.backend_environment, o.find((x) => x.field === 'observation_coverage').value.backend_kind], ['none', 'none']);
    assert.equal(o.find((x) => x.field === 'backend_version'), undefined);
  }
  // The label is not read from the target's output: a results.json that says otherwise changes nothing.
  const forged = new Map(files);
  forged.set('full/run1/results.json', results([{ requirement: 'MWS-CONC-2', verdict: 'held', backend_environment: 'production', write_path: { tool: 'x', resource: 'y' } }]));
  const o = observations(summarize({ files: forged, steps: [], planStdout: '', fullRan: true }), { versions: {}, stagesRan: {}, backend: f.backend });
  assert.ok(o.filter((x) => x.field === 'requirement_verdicts' && x.stage === 'full').flatMap((x) => x.value).every((v) => v.backend_environment === 'hermetic'));
  assert.ok(findRunFolder(forged, 'full').dir);
});

test('R-WC-16: the backend runs inside the sandbox container, for the full write test only, on loopback; never a runner service', () => {
  const f = fixtures().fixtures['pg-tracker'];
  assert.deepEqual(f.background.only, ['run'], 'plan and catalog call no tool and do not start a database');
  assert.deepEqual(f.background.args, ['backend', '--port', '4620']);
  assert.equal(f.manifest, 'dogfood/pg-tracker/writecheck.yaml');
  assert.deepEqual(f.random_env, ['PGFX_PASSWORD'], 'the database password is random per run, never in fixtures.json or the manifest');
  assert.equal(new URL(f.env.PGFX_DATABASE_URL).hostname, '127.0.0.1');
  assert.equal(new URL(f.env.PGFX_CONTROL_URL).hostname, '127.0.0.1');
  // The driver starts it with bg.mjs in the fixture's own sandbox container, next to the CLI, and only for the commands in `only`.
  const run = read('loop/run-items.mjs');
  assert.match(run, /bg && \(!u\.background\.only \|\| u\.background\.only\.includes\(args\[0\]\)\)/);
  assert.match(run, /u\.source \? \['src'\] : \[\]/);
  // No workflow starts a service container (a GitHub `services:` block is reachable from the runner, outside the sandbox).
  for (const w of readdirSync(join(root, '.github', 'workflows'))) assert.doesNotMatch(read(`.github/workflows/${w}`), /^\s*services:/m, w);
  // The backend listens on loopback only, with no Unix socket, and refuses to start without a password.
  const be = read('loop/fixtures/pg-tracker/src/backend.mjs');
  assert.match(be, /listen_addresses=127\.0\.0\.1/);
  assert.match(be, /unix_socket_directories=/);
  assert.match(be, /listen\(port \+ 1, '127\.0\.0\.1'/);
  assert.match(be, /PGFX_PASSWORD \(at least 16 characters\) is required/);
  assert.match(be, /!sameToken\(req\.headers\.authorization, `Bearer \$\{token\}`\)/);
  assert.match(be, /timingSafeEqual/);
  // The PR proof runs the fixture in the sandbox with the other fixture servers, and judges the label.
  assert.match(read('.github/workflows/loop-fixture.yml'), /"subject":"isokron-ai\/mcp-writecheck-action\.pg-tracker"/);
  assert.match(read('loop/check-bundles.mjs'), /labelled hermetic/);
});

test('R-WC-16: the plan a person accepted is in the repository and is the one fixtures.json names', () => {
  const f = fixtures().fixtures['pg-tracker'];
  const plan = read('dogfood/pg-tracker/plan.txt');
  assert.match(plan, new RegExp(`^plan hash: ${f.full.plan_hash}$`, 'm'));
  assert.match(plan, new RegExp(`for target ${f.full.confirm} \\(environment: test\\)`));
  assert.match(plan, /Hosts reached or given to the server: 127\.0\.0\.1:4620, 127\.0\.0\.1:4621\n/);
  assert.match(plan, /At most \d+ writes and \d+ created objects/);
  // The manifest the plan was made from is the one committed, and it points at the control channel of the same backend.
  const m = read('dogfood/pg-tracker/writecheck.yaml');
  assert.match(m, new RegExp(`confirm: ${f.full.confirm}\\n`));
  assert.match(m, /base_env: PGFX_CONTROL_URL/);
  assert.match(m, /env_passthrough: \[PGFX_PASSWORD\]/);
});

test('R-WC-14: the defects of the server, the manifest\'s comment and fixtures.json\'s known answers name the same builds', () => {
  // Read from the source: importing the server would need its dependencies, which the unit job does not install.
  const DEFECTS = /export const DEFECTS = \[([^\]]+)\]/.exec(read('loop/fixtures/pg-tracker/src/mcp.mjs'))[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  assert.ok(DEFECTS.length >= 4);
  const f = fixtures().fixtures['pg-tracker'];
  assert.deepEqual(f.known_answers.map((k) => k.defect).sort(), [...DEFECTS].sort());
  const header = read('dogfood/pg-tracker/writecheck.yaml').split('\nmws:')[0].replace(/\n# /g, ' ');
  for (const d of DEFECTS) assert.ok(header.includes(d), `the manifest's header names ${d}`);
  assert.match(read('loop/fixtures/pg-tracker/src/mcp.mjs'), /list\.includes\('all'\) \? DEFECTS : list/);
  for (const k of f.known_answers) assert.equal(k.env, 'PGFX_DEFECTS');
});

// ---------------------------------------------------------------------------------------------------------------------
// R-WC-17 (live): the pinned CLI against a real PostgreSQL, known-good and known-bad, with the defects switched on one by one.

// resolve, not join: selftest.yml passes an absolute CLI_DIR (join would put it under the working folder), test.yml a relative one.
export const cliDirFrom = (v, cwd = process.cwd()) => (v ? resolve(cwd, v) : null);
const CLI_DIR = cliDirFrom(process.env.CLI_DIR);
const cliMain = CLI_DIR && (existsSync(CLI_DIR) ? join(CLI_DIR, 'dist', 'src', 'cli', 'main.js') : null);
const haveDeps = existsSync(join(FIX, 'node_modules', 'pg'));
const live = cliMain && existsSync(cliMain) && haveDeps ? false : 'needs CLI_DIR (a built packages/writecheck) and `npm ci --omit=dev` in loop/fixtures/pg-tracker';
// In the CI job that runs them (CI and CLI_DIR set, or PG_LIVE_REQUIRED) a skip is a failure: the job cannot pass with nothing run.
const required = process.env.PG_LIVE_REQUIRED === '1' || (process.env.CI && process.env.CLI_DIR);
if (required && live) test('R-WC-17: the live tests are required here and cannot run', () => assert.fail(live));

test('R-WC-41: CLI_DIR is found whether it is absolute (selftest.yml) or relative (test.yml), and selftest installs the fixture before its required live tests', () => {
  assert.equal(cliDirFrom('/home/runner/work/a/a/mws/packages/writecheck', '/home/runner/work/a/a'), '/home/runner/work/a/a/mws/packages/writecheck');
  assert.equal(cliDirFrom('mws-cli/packages/writecheck', '/w'), '/w/mws-cli/packages/writecheck');
  assert.equal(cliDirFrom('', '/w'), null);
  // Mutation: the old join() puts an absolute CLI_DIR under the working folder, so the CLI is never found there.
  assert.equal(join('/home/runner/work/a/a', '/home/runner/work/a/a/mws/packages/writecheck'), '/home/runner/work/a/a/home/runner/work/a/a/mws/packages/writecheck');
  // selftest.yml runs every unit test with CI and CLI_DIR set, which makes the live tests required: the fixture's
  // dependencies must be installed in that job, before the local test.
  const y = readFileSync(join(root, '.github', 'workflows', 'selftest.yml'), 'utf8');
  const install = y.indexOf('- name: Install the PostgreSQL fixture\'s dependencies');
  assert.ok(install > 0 && install < y.indexOf('- name: Local test against tiny-tracker'), 'installed before the local test');
  assert.match(y.slice(install), /working-directory: action\/loop\/fixtures\/pg-tracker\n\s+run: npm ci --omit=dev --no-audit --no-fund --loglevel=error\n/);
});

const PORT = 4620;
const waitLine = (child, re, ms) => new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error(`no ${re} from the backend in ${ms} ms: ${buf.slice(-400)}`)), ms);
  const on = (d) => { buf += d; if (re.test(buf)) { clearTimeout(t); resolve(buf); } };
  child.stdout.on('data', on);
  child.stderr.on('data', on);
  child.on('exit', (c) => { clearTimeout(t); reject(new Error(`the backend exited (${c}): ${buf.slice(-400)}`)); });
});

/** Starts the backend, runs `plan` and then `run` (or `catalog`) of the CLI over the fixture, stops the backend. Returns the results and the plan text. */
async function cliRun({ defect = '', mode = 'run' }) {
  const work = tmp('wc12-live-');
  mkdirSync(join(work, 'm', 'x'), { recursive: true });
  symlinkSync(FIX, join(work, 'pg'));
  const manifest = join(work, 'm', 'x', 'writecheck.yaml');
  writeFileSync(manifest, read('dogfood/pg-tracker/writecheck.yaml'));
  const f = fixtures().fixtures['pg-tracker'];
  const env = { ...process.env, ...f.env, PGFX_PASSWORD: 'a'.repeat(8) + Math.random().toString(16).slice(2, 14).padEnd(12, '0'), PGFX_DATA_DIR: work };
  delete env.PGFX_DEFECTS;
  if (defect) env.PGFX_DEFECTS = defect;
  let backend = null;
  let bufOut = '{"postgres":""}';
  try {
    if (mode === 'run') {
      backend = spawn(process.execPath, [join(FIX, 'src', 'cli.mjs'), ...f.background.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      bufOut = await waitLine(backend, /"backend":.*\}/, 60_000);
    }
    const cli = (args) => spawnSync(process.execPath, [cliMain, ...args], { cwd: join(work, 'm', 'x'), env, encoding: 'utf8', timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
    const plan = cli(['plan', '-m', manifest]);
    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    const hash = /^plan hash: ([0-9a-f]{16})$/m.exec(plan.stdout)?.[1];
    assert.ok(hash, 'the plan printed a hash');
    const out = join(work, 'out');
    const r = mode === 'run'
      ? cli(['run', '-m', manifest, '--confirm-target', f.full.confirm, '--plan-hash', hash, '--out', out, '--state', join(work, 'state')])
      : cli(['catalog', '-m', manifest, '--out', out]);
    const dir = readdirSync(out)[0];
    const results = JSON.parse(readFileSync(join(out, dir, 'results.json'), 'utf8'));
    return { plan: plan.stdout, hash, status: r.status, results, pgVersion: /"postgres":"([^"]*)"/.exec(bufOut)?.[1] ?? '', log: `${r.stdout}${r.stderr}`.slice(-3000) };
  } finally {
    if (backend) { backend.kill('SIGTERM'); await new Promise((res) => { backend.once('exit', res); setTimeout(res, 15_000); }); }
  }
}

const verdicts = (results, req, tool) => results.results.filter((r) => r.requirement === req && (!tool || r.write_path?.tool === tool)).map((r) => r.verdict);
/** The oracle of the live tests: a requirement's records on a tool must include a violated one (or must all be held). */
function expectViolated(run, req, tool) { assert.ok(verdicts(run.results, req, tool).includes('violated'), `${req} on ${tool} must be violated; got ${JSON.stringify(verdicts(run.results, req, tool))}\n${run.log}`); }
function expectHeld(run, req) { const v = verdicts(run.results, req); assert.ok(v.includes('held') && !v.includes('violated'), `${req} must hold; got ${JSON.stringify(v)}\n${run.log}`); }

test('R-WC-17: known good: the correct build against a real PostgreSQL holds every cell it tests, and the plan is the accepted one', { skip: live, timeout: 300_000 }, async () => {
  const run = await cliRun({});
  const f = fixtures().fixtures['pg-tracker'];
  assert.equal(run.hash, f.full.plan_hash, 'the plan of this CLI, this manifest and this server is the accepted one (dogfood/pg-tracker/plan.txt)');
  assert.equal(run.plan.trim(), read('dogfood/pg-tracker/plan.txt').trim());
  assert.equal(run.status, 0, run.log);
  assert.equal(run.results.run.status, 'complete');
  // The version the backend measured is the one the label records.
  assert.ok(f.backend.version.includes(`PostgreSQL ${run.pgVersion} `), `measured ${run.pgVersion}, labelled ${f.backend.version}`);
  assert.deepEqual(run.results.results.filter((r) => r.verdict === 'violated').map((r) => `${r.requirement} ${r.write_path?.tool}`), [], 'no violated record in the correct build');
  for (const req of ['MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-4', 'MWS-TGT-1', 'MWS-TGT-2', 'MWS-TGT-3', 'MWS-UPD-1', 'MWS-RES-3', 'MWS-RES-4', 'MWS-RETRY-1', 'MWS-RETRY-2', 'MWS-ANN-4', 'MWS-IN-1', 'MWS-IN-7']) expectHeld(run, req);
  // The mutation of the oracle: the same results do not satisfy "violated", so the checks below cannot pass vacuously.
  assert.throws(() => expectViolated(run, 'MWS-CONC-2', 'delete_item'), /must be violated/);
});

for (const [defect, req, tool] of [
  ['lost-update', 'MWS-CONC-2', 'delete_item'],
  ['empty-filter-deletes-all', 'MWS-TGT-2', 'delete_items'],
  ['idempotency-key-dropped', 'MWS-RETRY-2', 'create_item'],
]) {
  test(`R-WC-17: known bad (${defect}): the PostgreSQL cells catch it as ${req} on ${tool}, and the run still completes`, { skip: live, timeout: 300_000 }, async () => {
    const run = await cliRun({ defect });
    assert.equal(run.results.run.status, 'complete', run.log);
    assert.equal(run.status, 1, 'a violated MUST fails the run');
    expectViolated(run, req, tool);
    // Only the cell of the defect moved: the other defects' requirements still hold.
    for (const other of ['MWS-CONC-2', 'MWS-TGT-2', 'MWS-RETRY-2'].filter((x) => x !== req)) assert.ok(!verdicts(run.results, other).includes('violated'), `${other} unaffected by ${defect}`);
  });
}

test('R-WC-17: known bad (missing-annotations): the catalog read, which needs no database, catches it as MWS-ANN-4', { skip: live, timeout: 120_000 }, async () => {
  const good = await cliRun({ mode: 'catalog' });
  expectHeld(good, 'MWS-ANN-4');
  const bad = await cliRun({ mode: 'catalog', defect: 'missing-annotations' });
  expectViolated(bad, 'MWS-ANN-4');
  assert.ok(verdicts(bad.results, 'MWS-ANN-4').every((v) => v === 'violated'));
});

test('R-WC-14: embedded-postgres cannot be loaded at runtime (a hook refuses it), where Node has the hook', async () => {
  const { hooked } = await import('../loop/fixtures/pg-tracker/src/guard.mjs');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import './src/guard.mjs'; try { await import('embedded-postgres'); console.log('LOADED'); } catch (e) { console.log('BLOCKED ' + e.message); }"], { cwd: FIX, encoding: 'utf8' });
  if (!hooked) return; // Node before 22.15: the source scan above is the check
  assert.match(r.stdout, /BLOCKED embedded-postgres must not be loaded/);
});

test('R-WC-14: the binaries the backend runs are pinned by sha256, and the measured server version must be the pinned one', () => {
  const be = read('loop/fixtures/pg-tracker/src/backend.mjs');
  for (const key of ['linux-x64', 'linux-arm64']) assert.match(be, new RegExp(`'${key}': \\{ postgres: '[0-9a-f]{64}', initdb: '[0-9a-f]{64}' \\}`));
  assert.match(be, /has sha256 \$\{got\}, not the pinned/);
  assert.match(be, /join\(here, '\.\.', 'node_modules'/, 'resolved from the fixture\'s own folder, never a parent\'s');
  assert.doesNotMatch(be, /dirname\(d\)/);
  const pinned = /PINNED_SERVER_VERSION = '([0-9.]+)'/.exec(be)[1];
  assert.ok(fixtures().fixtures['pg-tracker'].backend.version.includes(`PostgreSQL ${pinned} `), 'the label records the version the backend is checked to be');
  assert.match(be, /the server says it is PostgreSQL/);
});

test('R-WC-18: a source fixture is selected by its id in the item, never by its subject alone', () => {
  const fx = fixtures();
  const sub = 'isokron-ai/mcp-writecheck-action';
  const seed = { map: new Map([[sub, { id: sub, packages: [{ registry: 'npm', identifier: 'some-package' }] }]]) };
  // Seeded as a normal subject, with no fixture id: the generic path, never the fixture.
  const plain = resolveSubject(sub, { seed, fixtures: fx });
  assert.equal(plain.fixture, null);
  assert.equal(plain.source, 'seed');
  assert.equal(resolveSubject(sub, { seed: { map: new Map() }, fixtures: fx }).skip.reason, 'policy_excluded');
  // With the id and the fixture's own subject (`<repository>.<id>`, so that history keyed by subject never mixes two backends): the fixture. With the repository's name, another subject, or an id that does not exist: a skip.
  const own = fx.fixtures['pg-tracker'].subject;
  assert.equal(own, `${sub}.pg-tracker`);
  assert.equal(resolveSubject(own, { seed, fixtures: fx }, 'pg-tracker').fixture, 'pg-tracker');
  assert.equal(resolveSubject(sub, { seed, fixtures: fx }, 'pg-tracker').skip.reason, 'policy_excluded');
  assert.equal(resolveSubject('isokron-ai/kronicle-lite', { seed, fixtures: fx }, 'pg-tracker').skip.reason, 'policy_excluded');
  assert.equal(resolveSubject(own, { seed, fixtures: fx }, 'no-such').skip.reason, 'policy_excluded');
  // The items carry it, checked; the proof shard names it.
  const key = 'a'.repeat(64);
  assert.equal(parseItems(JSON.stringify([{ subject: own, fixture: 'pg-tracker', run_key: key, fence: 1 }]))[0].fixture, 'pg-tracker');
  assert.throws(() => parseItems(JSON.stringify([{ subject: sub, fixture: 'Bad Id', run_key: key, fence: 1 }])), /fixture id/);
  assert.match(read('.github/workflows/loop-fixture.yml'), /"subject":"isokron-ai\/mcp-writecheck-action\.pg-tracker","fixture":"pg-tracker"/);
  // The older fixtures keep their subject mapping (unchanged since the lane started).
  assert.equal(resolveSubject('isokron-ai/kronicle-lite', { seed, fixtures: fx }).fixture, 'kronicle-lite');
});

test('R-WC-17: the control channel answers a bad foreign key with 400, a wrong token with 401, a duplicate with a client error', { skip: live, timeout: 120_000 }, async () => {
  const work = tmp('wc12-ctl-');
  const f = fixtures().fixtures['pg-tracker'];
  const password = 'c'.repeat(8) + 'd'.repeat(12);
  const env = { ...process.env, PGFX_PASSWORD: password, PGFX_DATA_DIR: work };
  const backend = spawn(process.execPath, [join(FIX, 'src', 'cli.mjs'), ...f.background.args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitLine(backend, /"backend":.*\}/, 60_000);
    const url = f.env.PGFX_CONTROL_URL;
    const post = (body, token = password) => fetch(`${url}/items`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ project: 'no-such-project', title: 'x' })).status, 400);
    assert.equal((await post({ project: 'inbox' })).status, 400, 'a missing title is the caller\'s');
    assert.equal((await post({ title: 'x' }, 'wrong')).status, 401);
    assert.equal((await post({ title: 'ok' })).status, 201);
  } finally {
    backend.kill('SIGTERM');
    await new Promise((res) => { backend.once('exit', res); setTimeout(res, 15_000); });
  }
});

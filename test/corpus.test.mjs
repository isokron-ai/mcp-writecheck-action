/**
 * The corpus driver (corpus/run-shard.mjs): its public output is the label and one
 * "run finished, exit N" line per target, a verdict never shows or fails the shard, the metadata
 * keeps the real exit statuses, and every piece of target code runs in a locked-down container
 * (C1): user 10001, no capabilities, no-new-privileges, read-only root, named volumes only, install
 * on an egress network and everything else on an internal one. These tests use a stand-in `docker`
 * (test/fixtures/corpus/fake-docker.mjs) and a local artifact; no daemon, no network.
 * test/corpus-container.test.mjs runs the same driver against a real Docker daemon.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  backendRunArgs, catalogManifest, checkPinned, classifyCli, dockerEnvFrom, fill, installPlan, keepRegular, LABEL,
  platformKey, publicExit, sandboxEnv, sandboxRunArgs, volumeMount,
} from '../corpus/run-shard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'zz-secret-target-name';
const IMG = `docker.io/library/node:22-bookworm-slim@sha256:${'a'.repeat(64)}`;

test('public exit: verdict statuses fold to 0, tool and harness problems keep their code', () => {
  assert.equal(publicExit({ status: 'completed', cli_exit: 1 }), 0);
  assert.equal(publicExit({ status: 'completed', cli_exit: 0 }), 0);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 4 }), 4);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 99 }), 70);
  assert.equal(publicExit({ status: 'cli_crash', cli_exit: null }), 70);
  assert.equal(publicExit({ status: 'timeout' }), 124);
  assert.equal(publicExit({ status: 'harness_error' }), 125);
});

test('CLI step classes; a container that did not start is a harness error', () => {
  assert.equal(classifyCli({ exit: 1 }), 'completed');
  assert.equal(classifyCli({ exit: 3 }), 'cli_error');
  assert.equal(classifyCli({ exit: null, signal: 'SIGSEGV' }), 'cli_crash');
  assert.equal(classifyCli({ exit: 7 }), 'cli_crash');
  assert.equal(classifyCli({ exit: 137, container: true }), 'cli_crash');
  assert.equal(classifyCli({ exit: 125, container: true }), 'harness_error');
  assert.equal(classifyCli({ exit: 0, timed_out: true }), 'timeout');
});

test('an expected CLI problem reports 0', () => {
  assert.equal(publicExit({ status: 'expected_cli_error', cli_exit: 4 }), 0);
});

test('templates: unknown names are a harness error', () => {
  assert.deepEqual(fill(['{{a}}/x', { k: '{{a}}' }], { a: 'v' }), ['v/x', { k: 'v' }]);
  assert.throws(() => fill('{{nope}}', {}));
  assert.match(catalogManifest(['srv', 'a b'], ['E'], 'c'), /stdio: \["srv", "a b"\]/);
});

// ------------------------------------------------------------------------------------------------
// C1: the container flags
// ------------------------------------------------------------------------------------------------

const mounts = [{ src: 'corpus-r1-t01', dst: '/work' }, { src: 'corpus-r1-cli', dst: '/opt/mwsc', ro: true }];

test('C1: sandbox containers run as 10001, no capabilities, no-new-privileges, read-only root, tmpfs /tmp', () => {
  const a = sandboxRunArgs({ name: 'n', image: IMG, network: 'corpus-r1-t01-run', mounts, env: { A: 'b' }, cmd: ['node', 'x'] });
  const pair = (k) => a[a.indexOf(k) + 1];
  assert.equal(pair('--user'), '10001:10001');
  assert.equal(pair('--cap-drop'), 'ALL');
  assert.equal(pair('--security-opt'), 'no-new-privileges');
  assert.ok(a.includes('--read-only'));
  assert.match(pair('--tmpfs'), /^\/tmp:rw,nosuid,nodev/);
  assert.ok(a.includes('--pids-limit') && a.includes('--memory') && a.includes('--init'));
  assert.equal(pair('--network'), 'corpus-r1-t01-run');
  assert.ok(!a.includes('--cap-add') && !a.includes('--privileged') && !a.includes('-v') && !a.includes('--volume'));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--mount'), ['type=volume,src=corpus-r1-t01,dst=/work', 'type=volume,src=corpus-r1-cli,dst=/opt/mwsc,readonly']);
  assert.deepEqual(a.slice(-3), [IMG, 'node', 'x']);
});

test('C1: only corpus volumes are mounted: no host path, no Docker socket, no workspace or RUNNER_TEMP', () => {
  for (const src of ['/var/run/docker.sock', '/home/runner/work/x/x', '/home/runner/work/_temp', '/home/runner/work/_actions', '/', 'data', 'corpus-x/../../etc']) {
    assert.throws(() => volumeMount({ src, dst: '/work' }), /only corpus volumes/, src);
  }
  assert.throws(() => volumeMount({ src: 'corpus-x', dst: '/var/run/docker.sock' }), /mount point/);
  assert.throws(() => sandboxRunArgs({ name: 'n', image: IMG, network: 'none', mounts: [{ src: '/var/run/docker.sock', dst: '/work' }], cmd: ['x'] }));
});

test('C1: images must be pinned by digest (sandbox and backends)', () => {
  assert.equal(checkPinned(IMG, 'x'), IMG);
  for (const bad of ['node:22', 'node@sha256:abc', `node:22@sha256:${'A'.repeat(64)}`, '', null]) assert.throws(() => checkPinned(bad, 'x'), /pinned by digest/);
  assert.throws(() => sandboxRunArgs({ name: 'n', image: 'node:22', network: 'none', mounts, cmd: ['x'] }), /pinned/);
  assert.throws(() => backendRunArgs({ name: 'b', image: 'postgres:16', network: 'n', alias: 'b0' }), /pinned/);
});

test('C1: backends drop every capability but an allowlisted few, and publish no host port', () => {
  const a = backendRunArgs({ name: 'b', image: IMG, network: 'corpus-r1-t01-run', alias: 'b0', capAdd: ['CHOWN', 'SETUID'], env: { P: '1' }, args: ['-c', 'x'] });
  assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--cap-add'), ['CHOWN', 'SETUID']);
  assert.equal(a[a.indexOf('--security-opt') + 1], 'no-new-privileges');
  assert.ok(!a.includes('-p') && !a.includes('--publish') && !a.includes('--privileged'));
  assert.equal(a[a.indexOf('--network-alias') + 1], 'b0');
  for (const cap of ['SYS_ADMIN', 'NET_ADMIN', 'ALL', 'SYS_PTRACE']) {
    assert.throws(() => backendRunArgs({ name: 'b', image: IMG, network: 'n', alias: 'b0', capAdd: [cap] }), /not allowed/);
  }
});

test('C1 / H3: the docker client and the containers get no GitHub file command, no token, a HOME of their own', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/runner', DOCKER_HOST: 'unix:///x', GITHUB_ENV: 'f', GITHUB_STEP_SUMMARY: 'f', GITHUB_OUTPUT: 'f', GITHUB_PATH: 'f', ACTIONS_RUNTIME_TOKEN: 't', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', MWS_CLI_TOKEN: 't', CORPUS_TARGETS_KEY: 'k', RUNNER_TEMP: '/t' };
  assert.deepEqual(Object.keys(dockerEnvFrom(env)).sort(), ['DOCKER_HOST', 'HOME', 'PATH']);
  const s = sandboxEnv('/work/venv/bin', { SRV: '1' });
  assert.equal(s.HOME, '/work/home');
  assert.ok(!Object.keys(s).some((k) => /^(GITHUB|ACTIONS|RUNNER)_|TOKEN|KEY/.test(k)));
  // L4: every cache lives in the target's own volume, so one target cannot poison the next.
  for (const k of ['npm_config_cache', 'UV_CACHE_DIR', 'PIP_CACHE_DIR', 'XDG_CACHE_HOME']) assert.match(s[k], /^\/work\/home\//, k);
  assert.match(s.PATH, /^\/work\/venv\/bin:/);
});

test('C1: platform comes from the Docker server and must be Linux', () => {
  assert.equal(platformKey('linux/amd64\n'), 'linux-x64');
  assert.equal(platformKey('linux/arm64'), 'linux-arm64');
  assert.throws(() => platformKey('darwin/arm64'), /Linux/);
  assert.throws(() => platformKey('linux/s390x'), /unsupported/);
});

// ------------------------------------------------------------------------------------------------
// M4: hash-locked installs
// ------------------------------------------------------------------------------------------------

test('M4: npm targets install with npm ci from the pinned lockfile; install scripts off unless asked', () => {
  assert.throws(() => installPlan({ ecosystem: 'npm', package: 'p' }, 'linux-x64'), /not hash-locked/);
  const t = { ecosystem: 'npm', package: 'p', lock: { package_json: '{}', package_lock: '{}' } };
  const p = installPlan(t, 'linux-x64');
  const ci = p.steps.find((s) => s.cmd[0] === 'npm' && s.cmd[1] === 'ci');
  assert.ok(ci.cmd.includes('--ignore-scripts'));
  assert.equal(ci.net, 'egress');
  assert.ok(!p.steps.some((s) => s.cmd.includes('install') && s.cmd[0] === 'npm'), 'never npm install');
  assert.ok(!installPlan({ ...t, install_scripts: true }, 'linux-x64').steps[0].cmd.includes('--ignore-scripts'));
  assert.deepEqual(p.files.map((f) => f.path), ['/work/pkg/artifact.tgz', '/work/pkg/package.json', '/work/pkg/package-lock.json']);
});

test('M4: PyPI targets install with --require-hashes from the lock for this platform; the target itself offline', () => {
  const t = { ecosystem: 'pypi', package: 'p', artifact: { file: 'p-1.0-py3-none-any.whl' }, lock: { pypi: { 'linux-x64': 'a==1 --hash=sha256:00\n' } } };
  assert.throws(() => installPlan(t, 'linux-arm64'), /not hash-locked for linux-arm64/);
  const p = installPlan(t, 'linux-x64');
  const deps = p.steps.find((s) => s.cmd.includes('-r'));
  for (const f of ['--require-hashes', '--no-deps', '--only-binary']) assert.ok(deps.cmd.includes(f), f);
  assert.equal(deps.net, 'egress');
  const self = p.steps.find((s) => s.cmd.includes('/work/dl/p-1.0-py3-none-any.whl'));
  assert.equal(self.net, 'none');
  assert.ok(self.cmd.includes('--offline') && self.cmd.includes('--no-deps'));
  assert.ok(p.needsUv);
  assert.ok(!installPlan({ ...t, allow_build: true }, 'linux-x64').steps.find((s) => s.cmd.includes('-r')).cmd.includes('--only-binary'));
  assert.throws(() => installPlan({ ...t, artifact: { file: '../x.whl' } }, 'linux-x64'), /file name/);
});

test('M4: binary targets unpack with no network', () => {
  const p = installPlan({ ecosystem: 'binary', artifact: { 'linux-x64': { file: 's.tgz' } } }, 'linux-x64');
  assert.ok(p.steps.every((s) => s.net === 'none'));
  assert.throws(() => installPlan({ ecosystem: 'binary', artifact: {} }, 'linux-x64'), /no artifact/);
});

test('copy-out keeps regular files and folders only', () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-keep-'));
  mkdirSync(join(d, 'a'));
  writeFileSync(join(d, 'a', 'f'), 'x');
  symlinkSync('/etc/passwd', join(d, 'a', 'l'));
  spawnSync('mkfifo', [join(d, 'p')]);
  assert.ok(keepRegular(d) >= 1);
  assert.ok(existsSync(join(d, 'a', 'f')));
  assert.throws(() => lstatSync(join(d, 'a', 'l')));
  assert.throws(() => lstatSync(join(d, 'p')));
});

// ------------------------------------------------------------------------------------------------
// The driver end to end, with the stand-in docker
// ------------------------------------------------------------------------------------------------

function stand({ format = 'isokron-corpus-targets/2', extra = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  const cli = join(d, 'cli');
  mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
  // The host only asks the CLI for its version and requirement list; target steps go to docker.
  writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), `
    const [cmd] = process.argv.slice(2);
    if (cmd === 'version') { console.log('mcp-writecheck 0.0.0-test (MWS 0.9)'); process.exit(0); }
    if (cmd === 'requirements') { console.log('MWS-ANN-4\\tSHOULD\\tx'); process.exit(0); }
    process.exit(9);
  `.replace(/^\s+/gm, ''));
  writeFileSync(join(cli, 'package.json'), '{"type":"commonjs"}');
  const bin = join(d, 'bin');
  mkdirSync(bin);
  // The shim records the names of the variables docker was given, then sets the fake's own.
  writeFileSync(join(bin, 'docker'), `#!/bin/sh\nFAKE_DOCKER_SEEN_ENV=$("${process.execPath}" -e 'console.log(JSON.stringify(Object.keys(process.env).sort()))')\nexport FAKE_DOCKER_SEEN_ENV\nFAKE_DOCKER_ROOT="${join(d, 'fake')}" exec "${process.execPath}" "${join(root, 'test', 'fixtures', 'corpus', 'fake-docker.mjs')}" "$@"\n`);
  chmodSync(join(bin, 'docker'), 0o755);
  mkdirSync(join(d, 'fake'));
  writeFileSync(join(d, 'images.json'), JSON.stringify({ runtime: IMG, uv: `ghcr.io/astral-sh/uv:0@sha256:${'b'.repeat(64)}` }));
  const art = join(d, 'srv.tgz');
  mkdirSync(join(d, 'srvsrc'));
  writeFileSync(join(d, 'srvsrc', 'srv'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', art, '-C', join(d, 'srvsrc'), 'srv']);
  const sha = createHash('sha256').update(readFileSync(art)).digest('hex');
  const bt = (id, s) => ({ id, lane: 'ci', name: NAME, ecosystem: 'binary', package: NAME, version: '1',
    artifact: { 'linux-x64': { url: pathToFileURL(art).href, file: 'srv.tgz', sha256: s } }, server: { command: ['{{bin}}/srv'] }, init: false });
  const targets = { format, targets: [
    bt('t01', sha),
    bt('t02', '0'.repeat(64)),
    { id: 't03', lane: 'mac', name: NAME, ecosystem: 'binary', package: NAME, version: '1', artifact: {}, server: { command: ['x'] } },
    { ...bt('t04', sha), ecosystem: 'npm', artifact: { url: pathToFileURL(art).href, sha256: sha }, lock: { package_json: '{}', package_lock: '{}' }, setup: ['touch {{tdir}}/seed'] },
    { ...bt('t05', sha), backends: [{ image: 'postgres:16', port: 5432 }] },
    { ...bt('t06', sha), backends: [{ image: IMG, port: 5432, cap_add: ['SYS_ADMIN'] }] },
    { ...bt('t07', sha), ecosystem: 'npm', artifact: { url: pathToFileURL(art).href, sha256: sha } },
    ...extra,
  ] };
  writeFileSync(join(d, 'targets.json'), JSON.stringify(targets));
  return d;
}

function drive(d, { only, cliExit = 0, env = {}, extraArgs = [] } = {}) {
  const log = join(d, 'fake', 'calls.jsonl');
  writeFileSync(join(d, 'fake', 'cli-exit'), String(cliExit));
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'),
    '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--images', join(d, 'images.json'), ...(only ? ['--only', only] : []), ...extraArgs], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(d, 'bin')}:${process.env.PATH}`, ...env },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  const meta = (id) => JSON.parse(readFileSync(join(d, 'out', id, 'meta.json'), 'utf8'));
  return { r, calls, meta };
}

for (const cliExit of [0, 1]) {
  test(`a shard prints only the label and run lines (CLI exit ${cliExit}); a bad checksum is a harness error`, () => {
    const d = stand();
    const { r, meta } = drive(d, { only: 't01,t02', cliExit });
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines[0], LABEL);
    assert.deepEqual(lines.slice(1).sort(), ['run finished, exit 0', 'run finished, exit 125']);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 1, 'the harness error turns the shard red, the verdict does not');
    const m1 = meta('t01');
    assert.equal(m1.status, 'completed');
    assert.equal(m1.cli_exit, cliExit);
    assert.equal(m1.results.length, 1);
    assert.equal(m1.results[0].folder, 'sandbox/results/catalog-x');
    assert.match(readFileSync(join(d, 'out', 't01', 'logs', 'catalog.log'), 'utf8'), new RegExp(NAME));
    const m2 = meta('t02');
    assert.equal(m2.status, 'harness_error');
    assert.match(m2.harness_error, /checksum/);
  });
}

test('a shard with only a verdict is green', () => {
  const d = stand();
  const { r } = drive(d, { only: 't01', cliExit: 1 });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  assert.equal(r.status, 0);
});

test('C1: every target step runs in a hardened container; install has egress, set-up and the CLI only the internal network', () => {
  const d = stand();
  const { r, calls, meta } = drive(d, { only: 't01,t04' });
  assert.equal(r.status, 0, r.stdout);
  const runs = calls.filter((c) => c.argv[0] === 'run').map((c) => c.argv);
  assert.ok(runs.length >= 8);
  const net = (a) => a[a.indexOf('--network') + 1];
  const internal = JSON.parse(readFileSync(join(d, 'fake', 'networks.json'), 'utf8'));
  for (const a of runs) {
    // Every container, ours or the target's: no host path, no socket, no privileged mode, no bind.
    assert.ok(!a.some((x) => x.includes(d) || x.includes('docker.sock') || x.startsWith('type=bind')), a.join(' '));
    assert.ok(!a.includes('--privileged') && !a.includes('-v') && !a.includes('--volume') && !a.includes('-p'), a.join(' '));
    assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
    assert.equal(a[a.indexOf('--security-opt') + 1], 'no-new-privileges');
    const user = a[a.indexOf('--user') + 1];
    const targetCode = a.includes('isokron.corpus.target=t01') || a.includes('isokron.corpus.target=t04');
    if (targetCode) {
      assert.equal(user, '10001:10001');
      assert.ok(a.includes('--read-only'));
      const cmd = a.slice(a.findIndex((x) => x === IMG) + 1);
      const isInstall = cmd[0] === 'npm' && cmd[1] === 'ci';
      if (isInstall) assert.equal(internal[net(a)], false, 'install: egress network');
      else if (net(a) !== 'none') assert.equal(internal[net(a)], true, `${cmd.join(' ')}: internal network`);
      if (cmd.includes('/opt/mwsc/dist/src/cli/main.js') || /^touch /.test(cmd[2] ?? '')) assert.equal(internal[net(a)], true, 'CLI and set-up: internal network');
    } else {
      // Our helpers (volume set-up, file writes, copy-out, the CLI volume): no network at all.
      assert.equal(net(a), 'none', a.join(' '));
    }
  }
  assert.ok(runs.some((a) => a.includes('npm') && a.includes('ci')), 'npm ci ran');
  assert.ok(runs.some((a) => a.includes('touch /work/seed')), 'set-up ran in a container');
  assert.deepEqual(meta('t04').networks, { install: { internal: false }, run: { internal: true } });
  // Volumes and networks are removed again, by label.
  assert.ok(calls.some((c) => c.argv[0] === 'volume' && c.argv[1] === 'rm'));
  assert.ok(calls.some((c) => c.argv[0] === 'network' && c.argv[1] === 'rm'));
});

test('C1 / H3: the docker client never sees GitHub file commands or secrets; the public summary is untouched', () => {
  const d = stand();
  writeFileSync(join(d, 'summary.md'), '');
  const { r, calls } = drive(d, { only: 't01', env: { GITHUB_STEP_SUMMARY: join(d, 'summary.md'), GITHUB_ENV: join(d, 'genv'), GITHUB_OUTPUT: join(d, 'gout'), GITHUB_ACTIONS: 'true', MWS_CLI_TOKEN: 'x', ACTIONS_RUNTIME_TOKEN: 'y', CORPUS_TARGETS_KEY: 'k' } });
  assert.equal(r.status, 0);
  for (const c of calls) {
    for (const k of ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_ACTIONS', 'MWS_CLI_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'CORPUS_TARGETS_KEY']) assert.ok(!c.env.includes(k), k);
    assert.ok(!c.argv.some((x) => /GITHUB_|TOKEN|CORPUS_TARGETS_KEY/.test(x)), c.argv.join(' '));
  }
  assert.equal(readFileSync(join(d, 'summary.md'), 'utf8'), '');
});

test('C1: an unpinned backend image, a capability outside the allowlist, a list without locks: harness errors', () => {
  const d = stand();
  const { r, meta } = drive(d, { only: 't05,t06,t07' });
  assert.equal(r.status, 1);
  assert.match(meta('t05').harness_error, /pinned by digest/);
  assert.match(meta('t06').harness_error, /SYS_ADMIN is not allowed/);
  assert.match(meta('t07').harness_error, /not hash-locked/);
  assert.equal(r.stdout.split('\n').filter((l) => l === 'run finished, exit 125').length, 3);
});

test('a target list in the v1 format is refused (it carries no locks)', () => {
  const d = stand({ format: 'isokron-corpus-targets/1' });
  const { r } = drive(d, { only: 't01' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 125\n`);
  assert.match(readFileSync(join(d, 'out', '_shard', 'harness-error.txt'), 'utf8'), /another format/);
});

test('--consume-targets removes the clear-text list before any target runs', () => {
  const d = stand();
  const { r } = drive(d, { only: 't01', extraArgs: ['--consume-targets'] });
  assert.equal(r.status, 0);
  assert.throws(() => readFileSync(join(d, 'targets.json')));
  assert.match(JSON.parse(readFileSync(join(d, 'out', '_shard', 'shard.json'), 'utf8')).targets_list_sha256, /^[0-9a-f]{64}$/);
});

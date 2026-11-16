/**
 * The corpus sandbox against a real Docker daemon (C1). Skipped unless CORPUS_DOCKER_TESTS=1, so the
 * public unit-test workflow does not pull images; run it locally with Docker:
 *
 *   CORPUS_DOCKER_TESTS=1 [CORPUS_SMOKE_CLI=<built packages/writecheck>] node --test test/corpus-container.test.mjs
 *
 * A hostile stand-in target (test/fixtures/corpus/hostile: an npm package whose postinstall and
 * set-up record what they can see and do, and whose MCP server leaves an orphan process and junk
 * behind) is installed and run by corpus/run-shard.mjs with a backend. The test then reads the
 * probe reports out of the bundle and checks the sandbox held: uid 10001, no capabilities,
 * no-new-privileges, read-only root and CLI, no Docker socket, no host path, no egress at run time
 * while the backend is reachable, no secret or GitHub variable in the environment, nothing left
 * running or mounted afterwards, and only the label and run lines on stdout.
 * Without CORPUS_SMOKE_CLI a stand-in CLI (plain Node, runs inside the container) is used.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LABEL } from '../corpus/run-shard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.CORPUS_DOCKER_TESTS === '1' ? false : 'set CORPUS_DOCKER_TESTS=1 (needs a Docker daemon)';
const images = JSON.parse(readFileSync(join(root, 'corpus', 'images.json'), 'utf8'));

function standInCli(d) {
  const cli = join(d, 'cli');
  mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
  // Speaks just enough MCP to start the server, list its tools and write a results folder.
  writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), `
const { spawn } = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');
const [cmd, ...a] = process.argv.slice(2);
if (cmd === 'version') { console.log('mcp-writecheck 0.0.0-smoke (MWS 0.9)'); process.exit(0); }
if (cmd === 'requirements') { console.log('MWS-ANN-4\\tSHOULD\\tx'); process.exit(0); }
if (cmd === 'init') process.exit(4);
const m = fs.readFileSync(a[a.indexOf('-m') + 1], 'utf8');
const argv = JSON.parse(/stdio: (\\[.*\\])/.exec(m)[1]);
const srv = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
srv.stdout.on('data', (c) => { buf += c; if (buf.split('\\n').some((l) => { try { return JSON.parse(l).id === 2; } catch { return false; } })) {
  if (cmd === 'plan') console.log('plan hash: 0123456789abcdef');
  if (cmd === 'catalog') { const r = path.join(a[a.indexOf('--out') + 1], 'catalog-smoke'); fs.mkdirSync(r, { recursive: true });
    fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ run: { status: 'complete' }, tools: buf })); }
  srv.kill(); process.exit(0); } });
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } }) + '\\n');
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\\n');
`);
  writeFileSync(join(cli, 'package.json'), '{"type":"commonjs"}');
  return cli;
}

test('C1 smoke: a hostile target stays inside its container', { skip, timeout: 600_000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-smoke-'));
  // The fixture as a registry would serve it, and its lockfile (no registry dependencies: offline).
  const pk = spawnSync('npm', ['pack', '--silent', '--pack-destination', d, join(root, 'test', 'fixtures', 'corpus', 'hostile')], { encoding: 'utf8' });
  assert.equal(pk.status, 0, pk.stderr);
  const art = join(d, 'artifact.tgz');
  writeFileSync(art, readFileSync(join(d, pk.stdout.trim())));
  const lk = join(d, 'lock');
  mkdirSync(lk);
  writeFileSync(join(lk, 'artifact.tgz'), readFileSync(art));
  writeFileSync(join(lk, 'package.json'), '{"private":true}');
  const li = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', './artifact.tgz'], { cwd: lk, encoding: 'utf8' });
  assert.equal(li.status, 0, li.stderr);

  // Host places a target would love to read: the clear-text list, a fake secret, the workspace.
  const runnerTemp = join(d, 'runner-temp-7c1e');
  mkdirSync(join(runnerTemp, 'corpus'), { recursive: true });
  writeFileSync(join(runnerTemp, 'corpus', 'secret.key'), 'AGE-SECRET-KEY-1FAKE');
  const summary = join(d, 'summary.md');
  writeFileSync(summary, '');
  const t = {
    id: 't01', lane: 'ci', name: 'zz-secret-target-name', ecosystem: 'npm', package: 'corpus-hostile', version: '1.0.0',
    artifact: { url: pathToFileURL(art).href, sha256: createHash('sha256').update(readFileSync(art)).digest('hex') },
    lock: { package_json: readFileSync(join(lk, 'package.json'), 'utf8'), package_lock: readFileSync(join(lk, 'package-lock.json'), 'utf8') },
    install_scripts: true,
    backends: [{ image: images.runtime, port: 7000, args: ['node', '-e', "require('net').createServer((s) => { s.on('error', () => {}); s.end('pong'); }).listen(7000)"],
      wait: ['node', '-e', "require('net').connect(7000, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"] }],
    setup: ['node {{pkgdir}}/probe.js run'],
    server: { command: ['{{bin}}/hostile-server'], env: { PROBE_HOST_PATHS: [runnerTemp, join(runnerTemp, 'corpus', 'secret.key'), root, d].join(':') } },
  };
  const targets = join(runnerTemp, 'corpus', 'targets.json');
  writeFileSync(targets, JSON.stringify({ format: 'isokron-corpus-targets/2', targets: [t] }));
  const cli = process.env.CORPUS_SMOKE_CLI || standInCli(d);
  const out = join(runnerTemp, 'corpus', 'out');
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', targets, '--consume-targets', '--cli', cli, '--cli-commit', 'f'.repeat(40), '--out', out, '--lane', 'ci'], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_STEP_SUMMARY: summary, GITHUB_ENV: join(d, 'genv'), GITHUB_ACTIONS: 'true', MWS_CLI_TOKEN: 'tok-should-not-leak', CORPUS_TARGETS_KEY: 'AGE-SECRET-KEY-1FAKE' },
  });
  const meta = JSON.parse(readFileSync(join(out, 't01', 'meta.json'), 'utf8'));
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`, JSON.stringify(meta.harness_error));
  assert.equal(r.status, 0);
  assert.equal(meta.status, 'completed');
  assert.deepEqual(meta.networks, { install: { internal: false }, run: { internal: true } });
  assert.equal(readFileSync(summary, 'utf8'), '', 'GITHUB_STEP_SUMMARY untouched');
  assert.ok(!existsSync(join(d, 'genv')), 'GITHUB_ENV untouched');

  const sb = join(out, 't01', 'sandbox');
  for (const phase of ['install', 'run']) {
    const p = JSON.parse(readFileSync(join(sb, `probe-${phase}.json`), 'utf8'));
    assert.equal(p.uid, 10001, phase);
    assert.equal(p.gid, 10001, phase);
    assert.equal(p.cap_eff, '0000000000000000', phase);
    assert.equal(p.cap_prm, '0000000000000000', phase);
    assert.equal(p.cap_bnd, '0000000000000000', phase);
    assert.equal(p.no_new_privs, '1', phase);
    assert.equal(p.write_root, 'EROFS', phase);
    assert.equal(p.write_etc, 'EROFS', phase);
    assert.equal(p.write_cli, 'EROFS', phase);
    assert.equal(p.write_work, true, phase);
    assert.deepEqual(p.docker_sock, [], phase);
    assert.deepEqual(p.host_paths_seen, [], phase);
    assert.equal(p.sudo, '', phase);
    for (const k of p.env_keys) assert.ok(!/^(GITHUB|ACTIONS|RUNNER)_|TOKEN|CORPUS_TARGETS_KEY|MWS_CLI/.test(k), `${phase}: ${k}`);
    // Mounts: the volumes and Docker's own files only; no host folder of the runner.
    for (const line of p.mountinfo.split('\n').filter(Boolean)) {
      const f = line.split(' ');
      assert.ok(!f[3].includes(d) && !f[3].includes(root) && !f[4].includes('docker.sock'), line);
    }
  }
  const install = JSON.parse(readFileSync(join(sb, 'probe-install.json'), 'utf8'));
  if (process.env.CORPUS_NET_GUARD === '1') {
    // corpus/net-guard.sh is in place: even the install network cannot reach the host or metadata.
    assert.equal(install.gateway.ok, false, 'install: no host service');
    assert.equal(install.metadata.ok, false, 'install: no metadata address');
  }
  const run = JSON.parse(readFileSync(join(sb, 'probe-run.json'), 'utf8'));
  assert.equal(run.gateway.ok, false, 'run: no host service');
  assert.equal(run.metadata.ok, false, 'run: no metadata address');
  assert.equal(run.egress_ip.ok, false, 'no egress at run time');
  assert.equal(run.egress_dns.ok, false, 'no outside DNS at run time');
  assert.deepEqual(run.backend, { ok: true, data: 'pong' }, 'the backend is reachable on the internal network');

  // The junk the target left: no symlink or fifo came back; the target's files are under sandbox/.
  const walk = (p) => readdirSync(p).flatMap((e) => (lstatSync(join(p, e)).isDirectory() ? walk(join(p, e)) : [join(p, e)]));
  for (const f of walk(join(out, 't01'))) assert.ok(lstatSync(f).isFile(), f);
  assert.ok(existsSync(join(sb, 'CLAUDE.md')), 'target files stay data in sandbox/ (the Mac strips agent files)');
  assert.equal(meta.results.length, 1);

  // Nothing left: no container, volume or network of the run, and no orphan process on the host.
  for (const kind of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
    const l = spawnSync('docker', [...kind, '--filter', 'label=isokron.corpus.run'], { encoding: 'utf8' });
    assert.equal(l.stdout.trim(), '', kind.join(' '));
  }
  assert.equal(spawnSync('sh', ['-c', 'ps -eo args | grep -c "[c]orpus-hostile-orphan"'], { encoding: 'utf8' }).stdout.trim(), '0');
  assert.ok(!existsSync(targets), '--consume-targets');
});

// The PyPI path: uv (copied read-only from its pinned image) installs Python and the hash-locked
// dependencies on the install network, the target's own wheel offline, and the CLI runs it on the
// internal network. A lock whose hash does not match the registry's file stops the install.
// Needs registry egress from containers, so also CORPUS_DOCKER_NET=1 (and, behind a TLS-inspecting
// proxy, CORPUS_INSTALL_CA_FILE).
const skipNet = skip || (process.env.CORPUS_DOCKER_NET === '1' ? false : 'set CORPUS_DOCKER_NET=1 (containers need registry egress)');
test('M4 smoke: a PyPI target installs from its hash lock in containers; a wrong hash is a harness error', { skip: skipNet, timeout: 600_000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-smoke-py-'));
  const fx = join(root, 'test', 'fixtures', 'corpus', 'pyhostile');
  assert.equal(spawnSync('python3', ['-I', join(fx, 'mkwheel.py'), d]).status, 0);
  const file = 'corpus_pyhostile-1.0.0-py3-none-any.whl';
  const lock = readFileSync(join(fx, 'six.lock'), 'utf8');
  const target = (id, lk) => ({
    id, lane: 'ci', ecosystem: 'pypi', package: 'corpus-pyhostile', version: '1.0.0', timeout_s: 240,
    artifact: { url: pathToFileURL(join(d, file)).href, file, sha256: createHash('sha256').update(readFileSync(join(d, file))).digest('hex') },
    lock: { pypi: { 'linux-x64': lk, 'linux-arm64': lk } },
    setup: ['{{bin}}/python -c "import six, corpus_pyhostile; print(six.__version__)" > {{tdir}}/out/py-ok.txt'],
    server: { command: ['{{bin}}/pyhostile-server'] },
  });
  writeFileSync(join(d, 'targets.json'), JSON.stringify({ format: 'isokron-corpus-targets/2', targets: [target('p01', lock), target('p02', lock.replace(/sha256:4721/, 'sha256:0000').replace(/sha256:ff70/, 'sha256:0000'))] }));
  const out = join(d, 'out');
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', process.env.CORPUS_SMOKE_CLI || standInCli(d), '--cli-commit', 'f'.repeat(40), '--out', out], { encoding: 'utf8', env: { ...process.env, CORPUS_ORDER_SEED: '00' } });
  assert.equal(r.stdout.split('\n')[0], LABEL);
  assert.deepEqual(r.stdout.split('\n').slice(1).filter(Boolean).sort(), ['run finished, exit 0', 'run finished, exit 125']);
  const m1 = JSON.parse(readFileSync(join(out, 'p01', 'meta.json'), 'utf8'));
  assert.equal(m1.status, 'completed', m1.harness_error);
  assert.equal(readFileSync(join(out, 'p01', 'sandbox', 'py-ok.txt'), 'utf8').trim(), '1.17.0');
  assert.match(readFileSync(join(out, 'p01', 'deps.txt'), 'utf8'), /^six==1\.17\.0$/m);
  const m2 = JSON.parse(readFileSync(join(out, 'p02', 'meta.json'), 'utf8'));
  assert.equal(m2.status, 'harness_error');
  assert.match(readFileSync(join(out, 'p02', 'logs', 'install.log'), 'utf8'), /hash/i);
});

test('C1 smoke: at the time limit the container and everything in it are removed (exit 124)', { skip, timeout: 300_000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'corpus-smoke-to-'));
  const art = join(d, 's.tgz');
  mkdirSync(join(d, 's'));
  writeFileSync(join(d, 's', 'srv'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', art, '-C', join(d, 's'), 'srv']);
  const t = { id: 't09', lane: 'ci', ecosystem: 'binary', package: 'x', version: '1', timeout_s: 15, init: false,
    artifact: { 'linux-x64': { url: pathToFileURL(art).href, file: 's.tgz', sha256: createHash('sha256').update(readFileSync(art)).digest('hex') } },
    setup: ['sleep 900 & sleep 900'], server: { command: ['{{bin}}/srv'] } };
  t.artifact['linux-arm64'] = t.artifact['linux-x64'];
  writeFileSync(join(d, 'targets.json'), JSON.stringify({ format: 'isokron-corpus-targets/2', targets: [t] }));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', standInCli(d), '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out')], { encoding: 'utf8' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 124\n`);
  assert.ok(Date.now() - t0 < 120_000);
  for (const kind of [['ps', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
    assert.equal(spawnSync('docker', [...kind, '--filter', 'label=isokron.corpus.run'], { encoding: 'utf8' }).stdout.trim(), '', kind.join(' '));
  }
});

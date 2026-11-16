/**
 * The corpus driver (corpus/run-shard.mjs): its public output is the label and one
 * "run finished, exit N" line per target, a verdict never shows or fails the shard, and the
 * metadata keeps the real exit statuses. Uses a stand-in CLI and a local artifact; no network.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { catalogManifest, classifyCli, fill, LABEL, publicExit } from '../corpus/run-shard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'zz-secret-target-name';

test('public exit: verdict statuses fold to 0, tool and harness problems keep their code', () => {
  assert.equal(publicExit({ status: 'completed', cli_exit: 1 }), 0);
  assert.equal(publicExit({ status: 'completed', cli_exit: 0 }), 0);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 4 }), 4);
  assert.equal(publicExit({ status: 'cli_error', cli_exit: 99 }), 70);
  assert.equal(publicExit({ status: 'cli_crash', cli_exit: null }), 70);
  assert.equal(publicExit({ status: 'timeout' }), 124);
  assert.equal(publicExit({ status: 'harness_error' }), 125);
});

test('CLI step classes', () => {
  assert.equal(classifyCli({ exit: 1 }), 'completed');
  assert.equal(classifyCli({ exit: 3 }), 'cli_error');
  assert.equal(classifyCli({ exit: null, signal: 'SIGSEGV' }), 'cli_crash');
  assert.equal(classifyCli({ exit: 7 }), 'cli_crash');
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

function stand(cliExit) {
  const d = mkdtempSync(join(tmpdir(), 'corpus-test-'));
  const cli = join(d, 'cli');
  mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
  // A stand-in CLI: prints target-specific text and a verdict line, writes a results folder.
  writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), `
    const fs = require('node:fs'), path = require('node:path');
    const [cmd, ...a] = process.argv.slice(2);
    if (cmd === 'version') { console.log('mcp-writecheck 0.0.0-test (MWS 0.9)'); process.exit(0); }
    if (cmd === 'requirements') { console.log('MWS-ANN-4\\tSHOULD\\tx'); process.exit(0); }
    console.log('${NAME} violated MWS-ANN-1 ::error::nope');
    console.error('${NAME} on stderr');
    if (cmd === 'plan') { console.log('plan hash: 0123456789abcdef'); process.exit(0); }
    if (cmd === 'catalog') {
      const out = a[a.indexOf('--out') + 1], r = path.join(out, 'catalog-x');
      fs.mkdirSync(r, { recursive: true });
      fs.writeFileSync(path.join(r, 'results.json'), JSON.stringify({ format: 'mws-results/1', run: { status: 'complete' }, results: [{ requirement: 'MWS-ANN-4', verdict: 'violated' }] }));
      process.exit(${cliExit});
    }
    process.exit(4);
  `.replace(/^\s+/gm, ''));
  writeFileSync(join(cli, 'package.json'), '{"type":"commonjs"}');
  const art = join(d, 'srv.tgz');
  mkdirSync(join(d, 'srvsrc'));
  writeFileSync(join(d, 'srvsrc', 'srv'), '#!/bin/sh\n');
  spawnSync('tar', ['-czf', art, '-C', join(d, 'srvsrc'), 'srv']);
  const sha = createHash('sha256').update(readFileSync(art)).digest('hex');
  const targets = { format: 'isokron-corpus-targets/1', targets: [
    { id: 't01', lane: 'ci', name: NAME, ecosystem: 'binary', package: NAME, version: '1',
      artifact: { [`${platform()}-${arch()}`]: { url: pathToFileURL(art).href, file: 'srv.tgz', sha256: sha } },
      server: { command: ['{{bin}}/srv'] }, init: false },
    { id: 't02', lane: 'ci', name: NAME, ecosystem: 'binary', package: NAME, version: '1',
      artifact: { [`${platform()}-${arch()}`]: { url: pathToFileURL(art).href, file: 'srv.tgz', sha256: '0'.repeat(64) } },
      server: { command: ['{{bin}}/srv'] }, init: false },
    { id: 't03', lane: 'mac', name: NAME, ecosystem: 'binary', package: NAME, version: '1', artifact: {}, server: { command: ['x'] } },
  ] };
  writeFileSync(join(d, 'targets.json'), JSON.stringify(targets));
  return d;
}

for (const cliExit of [0, 1]) {
  test(`a shard prints only the label and run lines (CLI exit ${cliExit}); a bad checksum is a harness error`, () => {
    const d = stand(cliExit);
    const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'), '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--work', join(d, 'work')], { encoding: 'utf8' });
    assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\nrun finished, exit 125\n`);
    assert.equal(r.stderr, '');
    assert.equal(r.status, 1, 'the harness error turns the shard red, the verdict does not');
    const m1 = JSON.parse(readFileSync(join(d, 'out', 't01', 'meta.json'), 'utf8'));
    assert.equal(m1.status, 'completed');
    assert.equal(m1.cli_exit, cliExit);
    assert.equal(m1.results.length, 1);
    assert.match(readFileSync(join(d, 'out', 't01', 'logs', 'catalog.log'), 'utf8'), new RegExp(NAME));
    const m2 = JSON.parse(readFileSync(join(d, 'out', 't02', 'meta.json'), 'utf8'));
    assert.equal(m2.status, 'harness_error');
    assert.match(m2.harness_error, /checksum/);
  });
}

test('a shard with only a verdict is green', () => {
  const d = stand(1);
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'), '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--work', join(d, 'work'), '--only', 't01'], { encoding: 'utf8' });
  assert.equal(r.stdout, `${LABEL}\nrun finished, exit 0\n`);
  assert.equal(r.status, 0);
});

test('target processes get an allowlisted environment: no GitHub file commands, no tokens, own HOME', () => {
  const d = stand(0);
  const main = join(d, 'cli', 'dist', 'src', 'cli', 'main.js');
  writeFileSync(main, `if (process.argv[2] === 'catalog') require('node:fs').writeFileSync(${JSON.stringify(join(d, 'env.json'))}, JSON.stringify(process.env));\n` + readFileSync(main, 'utf8'));
  writeFileSync(join(d, 'summary.md'), '');
  const env = { ...process.env, GITHUB_STEP_SUMMARY: join(d, 'summary.md'), GITHUB_ENV: join(d, 'genv'), GITHUB_OUTPUT: join(d, 'gout'), GITHUB_ACTIONS: 'true', MWS_CLI_TOKEN: 'x', ACTIONS_RUNTIME_TOKEN: 'y' };
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--cli', join(d, 'cli'), '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--work', join(d, 'work'), '--only', 't01'], { encoding: 'utf8', env });
  assert.equal(r.status, 0);
  const seen = JSON.parse(readFileSync(join(d, 'env.json'), 'utf8'));
  for (const k of ['GITHUB_STEP_SUMMARY', 'GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_ACTIONS', 'MWS_CLI_TOKEN', 'ACTIONS_RUNTIME_TOKEN']) assert.ok(!(k in seen), k);
  assert.ok(seen.HOME.startsWith(join(d, 'work')));
  assert.equal(readFileSync(join(d, 'summary.md'), 'utf8'), '');
});

test('--consume-targets removes the clear-text list before any target runs', () => {
  const d = stand(0);
  const r = spawnSync(process.execPath, [join(root, 'corpus', 'run-shard.mjs'), '--targets', join(d, 'targets.json'), '--consume-targets', '--cli', join(d, 'cli'), '--cli-commit', 'f'.repeat(40), '--out', join(d, 'out'), '--work', join(d, 'work'), '--only', 't01'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.throws(() => readFileSync(join(d, 'targets.json')));
  assert.match(JSON.parse(readFileSync(join(d, 'out', '_shard', 'shard.json'), 'utf8')).targets_list_sha256, /^[0-9a-f]{64}$/);
});

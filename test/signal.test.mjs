/**
 * A CLI ended by a signal other than SIGINT or SIGTERM (SIGKILL from the out-of-memory killer or the
 * runner) has no exit status. The summary names the signal instead of "status null", the job fails as a
 * run that did not complete, and the `cli-exit-code` output is empty.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cliEndText, cliExitCell, decide, renderNoResults, renderPlan } from '../src/summary.mjs';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main.mjs');

test('cliEndText and cliExitCell: a status, a signal, or neither', () => {
  assert.equal(cliEndText(4), 'exited with status 4 (stopped or failed: the target stopped answering, or clean-up could not finish (4 takes precedence over 1))');
  assert.equal(cliEndText(null, 'SIGKILL'), "was ended by SIGKILL and has no exit status (most often the system's out-of-memory killer, or the runner killing the job)");
  assert.equal(cliEndText(null, 'SIGSEGV'), 'was ended by SIGSEGV and has no exit status');
  assert.equal(cliEndText(null, 'x`|y'), 'was ended by a signal and has no exit status');
  assert.equal(cliEndText(null, null), 'ended without an exit status');
  assert.equal(cliExitCell(0), '0 (done)');
  assert.equal(cliExitCell(null, 'SIGKILL'), 'none: ended by SIGKILL');
  assert.equal(cliExitCell(null), 'none');
});

test('decide and the summaries never say "status null"', () => {
  const d = decide({ failOn: 'none', cliExit: null, cliSignal: 'SIGKILL', doc: null });
  assert.equal(d.fail, true);
  assert.match(d.reasons[0], /^mcp-writecheck was ended by SIGKILL and has no exit status \(most often the system's out-of-memory killer, or the runner killing the job\)\. A run that did not complete fails the job whatever `fail-on` says\.$/);
  const none = renderNoResults({ cliExit: null, cliSignal: 'SIGKILL', decision: d, lastLines: '', planHashGiven: '', planHashSeen: null, cliVersion: 'v' });
  assert.doesNotMatch(none, /null/);
  const plan = renderPlan({ manifest: 'm.yaml', catalog: null, cliExit: null, cliSignal: 'SIGKILL', planHash: null, planText: '', cliVersion: 'v', decision: { fail: true, reasons: ['x'], failing: [] } });
  assert.match(plan, /\| CLI exit status \| none: ended by SIGKILL \|/);
  assert.doesNotMatch(plan, /null/);
});

test('the script, with a CLI that SIGKILLs itself: summary names SIGKILL, cli-exit-code empty, job status 1', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mwsc-signal-'));
  try {
    const cli = join(dir, 'cli');
    mkdirSync(join(cli, 'dist', 'src', 'cli'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), '{"name":"fake-writecheck","type":"module"}\n');
    writeFileSync(join(cli, 'dist', 'src', 'cli', 'main.js'), "if (process.argv[2] === 'version') console.log('mcp-writecheck 0.0.0-fake'); else process.kill(process.pid, 'SIGKILL');\n");
    writeFileSync(join(dir, 'writecheck.yaml'), 'mws: "0.9"\n');
    const env = { PATH: process.env.PATH, INPUT_MANIFEST: join(dir, 'writecheck.yaml'), INPUT_MODE: 'catalog', INPUT_FAIL_ON: 'none', INPUT_CLI_PATH: cli, INPUT_RESULTS_DIR: join(dir, 'results'), GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'output') };
    const r = spawnSync(process.execPath, [MAIN], { env, cwd: dir, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const out = readFileSync(join(dir, 'output'), 'utf8');
    assert.match(out, /^cli-exit-code=$/m);
    assert.match(out, /^exit-status=1$/m);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /mcp-writecheck was ended by SIGKILL and has no exit status/);
    assert.match(summary, /Peak memory: /);
    assert.doesNotMatch(summary, /status null/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

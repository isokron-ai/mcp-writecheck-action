/**
 * The memory sampling of src/memory.mjs, with fake /proc and `ps` output, and its place in the
 * summary. It must never change the job status, and any error must end as `not measured`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { memoryAttention, memoryCell, parseCeilingMb, parsePs, parseStatPpid, parseStatusKib, readLinuxTree, readPsTree, sizeText, startSampler, treeOf } from '../src/memory.mjs';
import { decide, renderNoResults, renderPlan, renderRun } from '../src/summary.mjs';

const status = (rss, hwm) => `Name:\tnode\nState:\tS (sleeping)\nVmHWM:\t  ${hwm} kB\nVmRSS:\t  ${rss} kB\nThreads:\t7\n`;
const stat = (pid, comm, ppid) => `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 100 0 0 0`;

/** A fake /proc: the action (10), the CLI (100), its supervisor (200), the server (300, own group), a grandchild (400), and an unrelated process (500). */
function fakeProc(o = {}) {
  const procs = {
    10: { ppid: 1, comm: 'node', rss: 50_000, hwm: 60_000 },
    100: { ppid: 10, comm: 'node', rss: 80_000, hwm: 120_000 },
    200: { ppid: 100, comm: 'node', rss: 30_000, hwm: 30_000 },
    300: { ppid: 200, comm: 'my server) S 1', rss: 400_000, hwm: 500_000 },
    400: { ppid: 300, comm: 'sh', rss: 2_000, hwm: 2_000 },
    500: { ppid: 1, comm: 'dockerd', rss: 900_000, hwm: 900_000 },
    ...o.procs,
  };
  const files = { '/proc/self/status': 'x', '/proc/meminfo': 'x' };
  for (const [pid, p] of Object.entries(procs)) {
    if (!p) continue;
    files[`/proc/${pid}/stat`] = stat(pid, p.comm, p.ppid);
    if (!o.noStatus?.includes(Number(pid))) files[`/proc/${pid}/status`] = status(p.rss, p.hwm);
  }
  return {
    readdir: () => ['self', 'meminfo', ...Object.keys(procs).filter((k) => procs[k])],
    read: (path) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
  };
}

test('parsers: /proc status and stat, ps', () => {
  assert.equal(parseStatusKib(status(123, 456), 'VmRSS'), 123);
  assert.equal(parseStatusKib(status(123, 456), 'VmHWM'), 456);
  assert.equal(parseStatusKib('Name:\tkthreadd\n', 'VmRSS'), null);
  assert.equal(parseStatPpid(stat(7, 'a b) c', 42)), 42);
  assert.equal(parseStatPpid('garbage'), null);
  const ps = parsePs('  100    10  80000\n200 100 30000\nPID PPID RSS\n\n  300   200 400000\n');
  assert.deepEqual([...ps.keys()], [100, 200, 300]);
  assert.deepEqual(ps.get(300), { ppid: 200, kib: 400_000 });
});

test('treeOf: root and every descendant, nothing else', () => {
  const ppids = new Map([[10, 1], [100, 10], [200, 100], [300, 200], [400, 300], [500, 1]]);
  assert.deepEqual(treeOf(100, ppids).sort((a, b) => a - b), [100, 200, 300, 400]);
  assert.deepEqual(treeOf(999, ppids), []);
});

test('Linux: the sum of VmRSS over the CLI\'s tree, and the largest VmHWM', () => {
  assert.deepEqual(readLinuxTree(100, fakeProc()), { tree: 80_000 + 30_000 + 400_000 + 2_000, maxHwm: 500_000 });
  // A process that ends between the listing and the read is skipped, not an error.
  assert.deepEqual(readLinuxTree(100, fakeProc({ noStatus: [400] })), { tree: 510_000, maxHwm: 500_000 });
  // The CLI is gone: no reading.
  assert.equal(readLinuxTree(100, fakeProc({ procs: { 100: null, 200: null, 300: null, 400: null } })), null);
});

test('macOS: the sum of RSS over the tree from one ps listing', () => {
  const ps = '   10     1  50000\n  100    10  80000\n  200   100  30000\n  300   200 400000\n  500     1 900000\n';
  assert.deepEqual(readPsTree(100, ps), { tree: 510_000 });
  assert.equal(readPsTree(100, '  10 1 5\n'), null);
});

test('sampler, Linux: peak over the readings; the peak is at least the largest single-process peak', async () => {
  const readings = [{ tree: 100_000, maxHwm: 90_000 }, { tree: 700_000, maxHwm: 300_000 }, { tree: 200_000, maxHwm: 750_000 }, null];
  let i = 0;
  const s = startSampler({ root: 100, platform: 'linux', intervalMs: 5, earlyMs: [], readLinux: () => readings[Math.min(i++, readings.length - 1)] });
  await new Promise((r) => setTimeout(r, 40));
  const m = await s.stop();
  assert.equal(m.method, 'exact');
  assert.equal(m.peakKib, 750_000);
  assert.equal(m.samples, 3);
  assert.equal(m.note, null);
});

test('sampler: readings close together at the start; a run with fewer than three says its peak can be higher', async () => {
  const at = [];
  const t0 = Date.now();
  const s = startSampler({ root: 100, platform: 'linux', intervalMs: 10_000, readLinux: () => (at.push(Date.now() - t0), { tree: 1024, maxHwm: 0 }) });
  await new Promise((r) => setTimeout(r, 450));
  const m = await s.stop();
  assert.ok(at.length >= 5, `readings at ${at.join(', ')} ms`);
  assert.equal(m.note, null);
  const short = startSampler({ root: 100, platform: 'linux', intervalMs: 10_000, readLinux: (() => { let n = 0; return () => (n++ ? null : { tree: 1024, maxHwm: 0 }); })() });
  const m2 = await short.stop();
  assert.equal(m2.samples, 1);
  assert.match(m2.note, /fewer than three readings/);
});

test('sampler, macOS: approximate, from ps', async () => {
  const s = startSampler({ root: 100, platform: 'darwin', intervalMs: 5, earlyMs: [], runPs: async () => '  100 10 2048\n  200 100 1024\n' });
  await new Promise((r) => setTimeout(r, 30));
  const m = await s.stop();
  assert.equal(m.method, 'approximate');
  assert.equal(m.peakKib, 3072);
});

test('sampler, Windows and unknown platforms: not measured, nothing is read', async () => {
  const s = startSampler({ root: 100, platform: 'win32', readLinux: () => assert.fail('read'), runPs: () => assert.fail('ps') });
  assert.deepEqual(await s.stop(), { method: 'not measured', peakKib: null, samples: 0, intervalMs: 1000, note: 'on Windows' });
  assert.equal((await startSampler({ root: undefined, platform: 'linux' }).stop()).method, 'not measured');
});

test('sampler: an error stops sampling and degrades; it never throws', async () => {
  const boom = startSampler({ root: 100, platform: 'linux', intervalMs: 5, earlyMs: [], readLinux: () => { throw new Error('EACCES: /proc | `x`'); } });
  await new Promise((r) => setTimeout(r, 20));
  const m = await boom.stop();
  assert.equal(m.method, 'not measured');
  assert.equal(m.peakKib, null);
  assert.match(m.note, /^sampling stopped: EACCES: \/proc/);
  assert.doesNotMatch(m.note, /[|`]/);
  // An error after some readings keeps the peak read so far and says sampling stopped.
  let n = 0;
  const late = startSampler({ root: 100, platform: 'darwin', intervalMs: 5, earlyMs: [], runPs: async () => { if (n++ > 0) throw new Error('ps: timed out'); return '100 1 4096\n'; } });
  await new Promise((r) => setTimeout(r, 30));
  const m2 = await late.stop();
  assert.equal(m2.method, 'approximate');
  assert.equal(m2.peakKib, 4096);
  assert.match(m2.note, /sampling stopped: ps: timed out/);
});

test('max-rss-mb: empty or a positive whole number', () => {
  assert.equal(parseCeilingMb(''), null);
  assert.equal(parseCeilingMb(' 2048 '), 2048);
  for (const bad of ['0', '-1', '1.5', '2g', '1e3', '99999999']) assert.throws(() => parseCeilingMb(bad), /max-rss-mb/);
});

test('summary text: sizes, the row, the attention line', () => {
  assert.equal(sizeText(512 * 1024), '512 MB');
  assert.equal(sizeText(1.5 * 1024 * 1024), '1.5 GB');
  const exact = { method: 'exact', peakKib: 3 * 1024 * 1024, samples: 9, intervalMs: 1000, note: null };
  assert.equal(memoryCell(exact), '3.0 GB, the CLI and every process under it (exact: /proc, read every 1 s)');
  assert.match(memoryCell({ method: 'approximate', peakKib: 1024, samples: 1, intervalMs: 2000, note: null }), /approximate: `ps`, read every 2 s/);
  assert.equal(memoryCell({ method: 'not measured', peakKib: null, samples: 0, intervalMs: 1000, note: 'on Windows' }), 'not measured (on Windows)');
  assert.equal(memoryCell(null), 'not measured');
  assert.equal(memoryAttention(exact, null), null, 'no ceiling, no line');
  assert.equal(memoryAttention(exact, 4096), null, 'under the ceiling');
  assert.match(memoryAttention(exact, 3072), /reached the `max-rss-mb` ceiling of 3072 MB\. The job status does not depend on this\./);
  assert.equal(memoryAttention({ method: 'not measured', peakKib: null }, 1), null);
});

const rec = (verdict) => ({ requirement: 'MWS-UPD-1', level: 'MUST', verdict, write_path: { resource: 'ticket', tool: 'update_ticket', arm: 'mcp' }, scenario: { id: 's', version: '1' }, reason: 'r', numbers: {}, steps: [], notes: [], attribution: null });
const doc = (results) => ({
  format: 'mws-results/1', scope: 'Scope: x', suite: { name: 'mcp-writecheck', version: '0' }, spec: { version: '0.9' },
  run: { id: 'r', prefix: 'mwsc-r-', started: 't0', ended: 't1', status: 'complete', stopped_reason: null },
  target: { confirm: 't' }, plan: { hash: '0123456789abcdef' }, results, not_built: [], leftovers: [],
  cleanup: { deleted: [], failed: [], unknown: [], stopped: null }, safety: { canaries: [], fixtures_restored: [] },
});

test('the summary shows the peak and the attention line, and the job status does not change', () => {
  const d = doc([rec('held')]);
  const decision = decide({ failOn: 'must', cliExit: 0, doc: d });
  assert.equal(decision.fail, false);
  const big = { method: 'exact', peakKib: 8 * 1024 * 1024, samples: 30, intervalMs: 1000, note: null };
  const text = renderRun({ doc: d, specUrl: 'https://isokron.ai/mws', failOn: 'must', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a', memory: big, ceilingMb: 1024 });
  assert.match(text, /\| Peak memory \| 8\.0 GB, the CLI and every process under it \(exact: \/proc, read every 1 s\) \|/);
  assert.match(text, /\*\*Job status: not failed\.\*\*/);
  assert.match(text, /### Needs attention\n\n- The peak memory of the CLI and the processes under it, 8\.0 GB \(exact\), reached the `max-rss-mb` ceiling of 1024 MB/);
  // Without a measurement (callers before this change): no row, no line, the same text as before.
  const old = renderRun({ doc: d, specUrl: 'https://isokron.ai/mws', failOn: 'must', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a' });
  assert.doesNotMatch(old, /Peak memory|Needs attention/);
  // Plan and no-results summaries carry it too; a killed CLI (exit null) still has its figure.
  const plan = renderPlan({ manifest: 'm.yaml', catalog: null, cliExit: 0, planHash: '0123456789abcdef', planText: 'x', cliVersion: 'v', decision: { fail: false, reasons: [], failing: [] }, memory: big, ceilingMb: 1024 });
  assert.match(plan, /\| Peak memory \| 8\.0 GB/);
  assert.match(plan, /\*\*Job status: not failed\.\*\*[^\n]*\n\n### Needs attention/);
  const killed = decide({ failOn: 'none', cliExit: null, doc: null });
  const none = renderNoResults({ cliExit: null, decision: killed, lastLines: '', planHashGiven: '', planHashSeen: null, cliVersion: 'v', memory: big, ceilingMb: 1024 });
  assert.match(none, /Peak memory: 8\.0 GB/);
  assert.match(none, /reached the `max-rss-mb` ceiling/);
  assert.equal(killed.fail, true);
});

test('the real /proc, where there is one: the current process tree reads a plausible figure', { skip: process.platform !== 'linux' }, () => {
  const r = readLinuxTree(process.pid);
  assert.ok(r && r.tree > 1024 && r.maxHwm >= 1024, JSON.stringify(r));
});

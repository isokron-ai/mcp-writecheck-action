/**
 * A server ended by SIGKILL the tester did not send (most often the out-of-memory killer), read from the
 * run's capture: a "Needs attention" line, never a job status. Only CLIs that write `stop_sent` on the
 * process `exit` event are read; an older capture gives nothing.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, killsAttention, renderRun, unexpectedKills } from '../src/summary.mjs';

const ev = (o) => JSON.stringify({ type: 'wire', seq: 1, t_ms: 1, label: 'SERVER', step: null, dir: 'event', channel: 'process', event: 'exit', ...o });
const capture = [
  JSON.stringify({ type: 'capture_opened', format: 'mws-capture/1', t_ms: 0 }),
  ev({ exit_code: 0, signal: null, stop_sent: false }), // closed stdin, exited by itself
  ev({ label: 'RESTART', exit_code: 137, signal: null, stop_sent: true }), // the tester's own kill (MWS-RETRY-2)
  ev({ label: 'SERVER', exit_code: 137, signal: null, stop_sent: false }), // killed by something else
  ev({ label: 'launch-http', exit_code: null, signal: 'SIGKILL', stop_sent: false }), // the supervisor itself
  ev({ label: 'old', exit_code: 137, signal: null }), // a CLI without stop_sent
  '{"type":"wire","stop_sent":false, not json',
  JSON.stringify({ type: 'wire', channel: 'stderr', dir: 'recv', label: 'SERVER', stop_sent: false, exit_code: 137 }),
  JSON.stringify({ type: 'capture_closed', lines: 9 }),
].join('\n');

test('unexpectedKills: SIGKILL exits with stop_sent false, nothing else', () => {
  assert.deepEqual(unexpectedKills(capture), [
    { label: 'SERVER', exit_code: 137, signal: null },
    { label: 'launch-http', exit_code: null, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(unexpectedKills(ev({ exit_code: 137, signal: null })), [], 'a capture without stop_sent gives nothing');
  assert.deepEqual(unexpectedKills(''), []);
  assert.deepEqual(unexpectedKills(null), []);
});

test('killsAttention: one line, labels as code, says the job status does not depend on it', () => {
  assert.equal(killsAttention([]), null);
  const one = killsAttention([{ label: 'SERVER', exit_code: 137, signal: null }]);
  assert.match(one, /^A server process \(`SERVER`\) ended by SIGKILL that the tester did not send\. Most often that is the system's out-of-memory killer\./);
  assert.match(one, /The job status does not depend on this\.$/);
  assert.match(killsAttention([{ label: 'a`|b' }, { label: 'a`|b' }]), /^2 server processes \(`a'\\\|b`\)/);
});

test('renderRun shows it under "Needs attention", and decide() does not see it', () => {
  const d = {
    format: 'mws-results/1', scope: 'Scope: x', suite: { name: 'mcp-writecheck', version: '0' }, spec: { version: '0.9' },
    run: { id: 'r', prefix: 'mwsc-r-', started: 't0', ended: 't1', status: 'complete', stopped_reason: null },
    target: { confirm: 't' }, plan: { hash: '0123456789abcdef' }, results: [], not_built: [], leftovers: [],
    cleanup: { deleted: [], failed: [], unknown: [], stopped: null }, safety: { canaries: [], fixtures_restored: [] },
  };
  const decision = decide({ failOn: 'any', cliExit: 0, doc: d });
  assert.equal(decision.fail, false);
  const text = renderRun({ doc: d, specUrl: 'https://isokron.ai/mws', failOn: 'any', cliExit: 0, decision, cliVersion: 'v', artifactName: 'a', kills: unexpectedKills(capture) });
  assert.match(text, /\*\*Job status: not failed\.\*\*/);
  assert.match(text, /### Needs attention\n\n- 2 server processes \(`SERVER`, `launch-http`\) ended by SIGKILL/);
});

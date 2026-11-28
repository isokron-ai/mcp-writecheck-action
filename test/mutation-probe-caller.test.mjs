// R-PROBE-01: the mutation-probe workflow is a thin caller of isokron-ai/tool-qa's reusable workflow,
// pinned to one commit, with nothing a pull request or a fork could use to reach it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const text = readFileSync(new URL('../.github/workflows/mutation-probe.yml', import.meta.url), 'utf8');

const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'); // the workflow without its comments

test('R-PROBE-01: mutation-probe.yml calls the reusable workflow at one full commit and passes the same commit as probe-ref; dispatch only, read-only, no secrets', () => {
  const uses = /^\s+uses: isokron-ai\/tool-qa\/\.github\/workflows\/mutation-probe\.yml@([0-9a-f]{40})\s*$/m.exec(text);
  assert.ok(uses, 'uses the reusable workflow, pinned to a full commit');
  assert.match(text, new RegExp(`^\\s+probe-ref: ${uses[1]}\\s*$`, 'm'), 'probe-ref is the same commit');
  assert.match(text, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(code, /pull_request|schedule:|push:|workflow_run/, 'no other trigger');
  assert.match(text, /^permissions: \{\}$/m);
  assert.match(text, /^    permissions:\n      contents: read\n/m);
  assert.doesNotMatch(code, /secrets:|secrets\.|\brun:/, 'no secrets, no shell of its own');
  for (const input of ['ref', 'mutations', 'probe-files', 'test', 'build']) assert.match(text, new RegExp(`^      ${input}: \\$\\{\\{ inputs\\.${input}`, 'm'), `${input} is passed through`);
});

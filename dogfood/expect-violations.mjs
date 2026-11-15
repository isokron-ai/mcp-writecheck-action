#!/usr/bin/env node
// Compares the violated MUST records of a full run with a list of known ones.
//   node dogfood/expect-violations.mjs <known-violations.txt> <results folder>
// Fails (exit 1) on a violated MUST record that is not in the list. A listed record that is no
// longer violated is reported as a notice, so that the list can be shortened and a return caught.
// The full run itself uses fail-on: none, so that this step decides; the action still fails the
// job on its own safety rules (lost bystanders, unfinished clean-up, a run that did not complete).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [listFile, resultsDir] = process.argv.slice(2);
if (!listFile || !resultsDir) {
  console.log('::error::usage: expect-violations.mjs <known-violations.txt> <results folder>');
  process.exit(1);
}
const known = new Set(readFileSync(listFile, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.split(/\s+/).join(' ')));
const doc = JSON.parse(readFileSync(join(resultsDir, 'results.json'), 'utf8'));
if (doc.run?.status !== 'complete') {
  console.log(`::error::the run did not complete (${doc.run?.status}); nothing to compare`);
  process.exit(1);
}
const key = (r) => `${r.requirement} ${r.write_path?.resource}:${r.write_path?.tool} ${r.scenario?.id ?? '-'}`;
const seen = new Set(doc.results.filter((r) => r.verdict === 'violated' && r.level === 'MUST').map(key));
let fail = false;
for (const k of [...seen].sort()) {
  if (known.has(k)) console.log(`known: ${k}`);
  else {
    console.log(`::error::new violated MUST record: ${k} (see the full run's summary)`);
    fail = true;
  }
}
for (const k of [...known].sort()) if (!seen.has(k)) console.log(`::notice::no longer violated: ${k} (remove it from ${listFile})`);
console.log(fail ? 'a violated MUST record is not in the known list' : 'every violated MUST record is a known one');
process.exit(fail ? 1 : 0);

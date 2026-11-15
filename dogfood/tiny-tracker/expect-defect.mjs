#!/usr/bin/env node
// One cell of the defect matrix: did the full run with one tiny-tracker defect switched on give a
// violated record of that defect's requirement, or, for a review-only clause, a self-attested record
// whose answer is "no" (numbers.answer === false)?
//   node dogfood/tiny-tracker/expect-defect.mjs <results folder>
// Env: DEFECT, REQUIREMENT, EXPECT (detected | missed).
// EXPECT detected: the job fails when no such record exists (a lost detection).
// EXPECT missed: a known miss of the CLI. The job passes, with a notice; when the CLI starts to detect
// it, the job fails so that the cell is flipped to detected in defects.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir] = process.argv.slice(2);
const { DEFECT, REQUIREMENT, EXPECT } = process.env;
if (!dir || !DEFECT || !REQUIREMENT || !['detected', 'missed'].includes(EXPECT)) {
  console.log('::error::usage: DEFECT=… REQUIREMENT=… EXPECT=detected|missed expect-defect.mjs <results folder>');
  process.exit(1);
}
const doc = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8'));
if (doc.run?.status !== 'complete') {
  console.log(`::error::the run with defect ${DEFECT} did not complete (${doc.run?.status})`);
  process.exit(1);
}
const hits = doc.results.filter((r) => r.requirement === REQUIREMENT && (r.verdict === 'violated' || (r.verdict === 'self-attested' && r.numbers?.answer === false)));
const detected = hits.length > 0;
for (const r of hits) console.log(`${r.verdict === 'violated' ? 'violated' : 'self-attested, answer no'}: ${r.requirement} ${r.write_path?.resource}:${r.write_path?.tool} ${r.scenario?.id ?? '-'}`);
if (!detected) {
  const other = [...new Set(doc.results.filter((r) => r.requirement === REQUIREMENT).map((r) => r.verdict))].join(', ') || 'no record';
  console.log(`${REQUIREMENT} records in this run: ${other}`);
}
if (EXPECT === 'detected' && !detected) {
  console.log(`::error::defect ${DEFECT} (${REQUIREMENT}) was not detected: no violated record of ${REQUIREMENT} (nor a self-attested one answered no)`);
  process.exit(1);
}
if (EXPECT === 'missed' && detected) {
  console.log(`::error::defect ${DEFECT} (${REQUIREMENT}) is now detected: set its cell to "expect": "detected" in dogfood/tiny-tracker/defects.json`);
  process.exit(1);
}
console.log(EXPECT === 'detected' ? `defect ${DEFECT} detected (${REQUIREMENT})` : `::notice::defect ${DEFECT} (${REQUIREMENT}) is a known miss of the CLI (expected failure)`);

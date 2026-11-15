#!/usr/bin/env node
// Compares the violated records of a full run with the known ones (expected-violations.txt): one
// line per record, "<requirement> <level> <resource>:<tool>", and a comment saying why it is known.
// Exits 1 on a violated record that is not listed (new) and on a listed one that no longer appears
// (it flipped: take it out of the list). Usage: expect.mjs <results.json> <expected-violations.txt>
import { readFileSync } from 'node:fs';
const [res, exp] = process.argv.slice(2);
const doc = JSON.parse(readFileSync(res, 'utf8'));
if (doc.run?.status !== 'complete') { console.log(`::error::the run did not complete (${doc.run?.status})`); process.exit(1); }
const seen = new Set(doc.results.filter((r) => r.verdict === 'violated').map((r) => `${r.requirement} ${r.level} ${r.write_path?.resource}:${r.write_path?.tool}`));
const known = new Set(readFileSync(exp, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
let bad = 0;
for (const k of [...seen].sort()) if (!known.has(k)) { bad++; console.log(`::error::new violated record: ${k}`); }
for (const k of [...known].sort()) if (!seen.has(k)) { bad++; console.log(`::error::a known violated record no longer appears (remove it from the list if the fix is real): ${k}`); }
for (const k of [...seen].sort()) if (known.has(k)) console.log(`known: ${k}`);
process.exit(bad ? 1 : 0);

#!/usr/bin/env node
// Checksums every document the tester did not create (no run prefix mwsc-<10 hex>-), per collection,
// through REST as editor-a (MWSV_JWT_A). `snap.mjs > before.json`, later `snap.mjs --compare before.json`:
// exits 1 when a document the tester did not create changed or went missing, or a tester object is left.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const BASE = process.env.PAYLOAD_URL ?? 'http://127.0.0.1:4960';
const H = { authorization: `JWT ${process.env.MWSV_JWT_A}` };
const out = {};
for (const c of ['tasks', 'listings', 'posts', 'users']) {
  const r = await fetch(`${BASE}/api/${c}?limit=2000&depth=0&draft=true`, { headers: H });
  const j = await r.json();
  const docs = (j.docs ?? []).sort((a, b) => a.id - b.id);
  const mine = (d) => /mwsc-[0-9a-f]{10}-/.test(JSON.stringify(d));
  // users: sessions and timestamps change with every login, not with the run's writes
  const others = docs.filter((d) => !mine(d)).map((d) => { const { sessions, updatedAt, loginAttempts, ...rest } = d; return c === 'users' ? { id: rest.id, email: rest.email, name: rest.name } : { ...rest, updatedAt }; });
  out[c] = { http: r.status, ids: others.map((d) => d.id), sha256: createHash('sha256').update(JSON.stringify(others)).digest('hex'), testers_left: docs.filter(mine).map((d) => d.id) };
}
const i = process.argv.indexOf('--compare');
if (i < 0) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
const before = JSON.parse(readFileSync(process.argv[i + 1], 'utf8'));
let bad = 0;
for (const c of Object.keys(out)) {
  const b = before[c], a = out[c];
  if (b.sha256 !== a.sha256) { bad++; console.log(`::error::${c}: documents the tester did not create changed (ids before ${b.ids.join(',')}, after ${a.ids.join(',')})`); }
  else console.log(`${c}: the ${a.ids.length} documents the tester did not create are unchanged`);
  if (a.testers_left.length) { bad++; console.log(`::error::${c}: tester objects left behind: ${a.testers_left.join(',')}`); }
}
process.exit(bad ? 1 : 0);

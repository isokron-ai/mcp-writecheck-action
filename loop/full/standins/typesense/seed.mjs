// The Typesense stand-in's seed (loop/full/unit.mjs). Ours: it runs in our helper image (node24) on the run network,
// fed on stdin (node --input-type=module -), never in the server's container.
//
//   node --input-type=module - <base url> <guard marker>      env: STANDIN_API_KEY
//
// Makes the collection the thin declaration's guard and fixture name (standin.json), the guard document, whose title
// is the unit's marker (so the guard matches only when the server read this stand-in), and the fixture document.
// Prints one JSON line, { seeded: true, documents: 2 }, or { error } and exits 1.
const [base, marker] = process.argv.slice(2);
const key = process.env.STANDIN_API_KEY ?? '';
const fail = (e) => { process.stdout.write(`${JSON.stringify({ error: String(e).slice(0, 200) })}\n`); process.exit(1); };
if (!/^http:\/\/[0-9.]{7,15}:[0-9]{2,5}$/.test(String(base)) || !/^wcguard[0-9a-f]{32}$/.test(String(marker)) || !/^[0-9a-f]{48}$/.test(key)) fail('usage: seed.mjs <base url> <marker>, STANDIN_API_KEY');
const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'X-TYPESENSE-API-KEY': key, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
  return r.json();
};
try {
  await call('POST', '/collections', {
    name: 'mwsc_standin',
    fields: [{ name: 'title', type: 'string' }, { name: 'status', type: 'string', facet: true }, { name: 'note', type: 'string', optional: true }],
  });
  await call('POST', '/collections/mwsc_standin/documents', { id: 'mwsc-standin-guard', title: marker, status: 'guard' });
  await call('POST', '/collections/mwsc_standin/documents', { id: 'mwsc-standin-fixture', title: 'mwsc-standin-fixture', status: 'open', note: 'made by the stand-in seed' });
  process.stdout.write(`${JSON.stringify({ seeded: true, documents: 2 })}\n`);
} catch (e) { fail(e.message); }

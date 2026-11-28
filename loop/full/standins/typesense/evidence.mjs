// What the Typesense stand-in holds (loop/full/unit.mjs): read after the seed and again after the full write test, so
// the bundle says whether the run's writes landed in the stand-in. Ours, in our helper image, fed on stdin.
//
//   node --input-type=module - <base url>      env: STANDIN_API_KEY
//
// Prints one JSON line of counts only, { collections, documents }, never a document: { error } and exit 1 otherwise.
const [base] = process.argv.slice(2);
const key = process.env.STANDIN_API_KEY ?? '';
const fail = (e) => { process.stdout.write(`${JSON.stringify({ error: String(e).slice(0, 200) })}\n`); process.exit(1); };
if (!/^http:\/\/[0-9.]{7,15}:[0-9]{2,5}$/.test(String(base)) || !/^[0-9a-f]{48}$/.test(key)) fail('usage: evidence.mjs <base url>, STANDIN_API_KEY');
try {
  const r = await fetch(`${base}/collections`, { headers: { 'X-TYPESENSE-API-KEY': key }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) fail(`GET /collections: ${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list)) fail('not a list');
  const documents = list.reduce((n, c) => n + (Number.isSafeInteger(c?.num_documents) ? c.num_documents : 0), 0);
  process.stdout.write(`${JSON.stringify({ collections: list.length, documents })}\n`);
} catch (e) { fail(e.message); }

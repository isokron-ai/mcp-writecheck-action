// A stand-in's health check (loop/full/unit.mjs): polls GET <base url><path> until it answers 2xx, or the time is up.
// Ours, in our helper image on the run network, fed on stdin (node --input-type=module -).
//
//   node --input-type=module - <base url> <path> <timeout ms>
//
// Prints { healthy: true, ms } or { healthy: false, last } and exits 0 or 1.
const [base, path, timeout] = process.argv.slice(2);
const until = Date.now() + Math.min(Number(timeout) || 60_000, 300_000);
const t0 = Date.now();
if (!/^http:\/\/[0-9.]{7,15}:[0-9]{2,5}$/.test(String(base)) || !/^\/[A-Za-z0-9._/-]{0,100}$/.test(String(path))) {
  process.stdout.write(`${JSON.stringify({ healthy: false, last: 'usage' })}\n`);
  process.exit(1);
}
let last = 'no answer';
while (Date.now() < until) {
  try {
    const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    if (r.ok) { process.stdout.write(`${JSON.stringify({ healthy: true, ms: Date.now() - t0 })}\n`); process.exit(0); }
    last = `status ${r.status}`;
  } catch (e) { last = String(e?.cause?.code ?? e?.name ?? 'error').slice(0, 40); }
  await new Promise((r) => setTimeout(r, 500));
}
process.stdout.write(`${JSON.stringify({ healthy: false, last })}\n`);
process.exit(1);

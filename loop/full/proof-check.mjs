#!/usr/bin/env node
/**
 * The pull-request proof of full mode (.github/workflows/loop-full-proof.yml): checks what item 0's bundle says about
 * full mode, as the driver wrote it (before the worker-kit's dry run), and writes a summary of codes, names, hosts and
 * counts only. No verdict of the server under test is printed or written: the proof's job log and artifact are public.
 *
 *   node loop/full/proof-check.mjs --out <driver out dir> --expect accepted|refused --summary <file> [--catalog-out <dir>]
 *
 * accepted: the stand-in started, took its seed and answered; the server read the seeded guard (the run started); the
 *           thin declaration was made; every host of its plan is the stand-in and the rule check accepted it with no
 *           person; the full write test ran in the sandbox (exit 0 or 1); every full-run record carries mode full and
 *           basis stand-in-product; the bundle has no full-stage skip.
 * refused:  the same up to the plan, whose target was pointed elsewhere by the proof's mutation; the rule check refused
 *           it (target_not_standin), the full write test never started, and the full stage's skip is ours
 *           (unsupported_layout, fault tool).
 * --catalog-out: copies the catalog stage's catalog.json (the server's tools/list, public) for the declarations workflow.
 * Exits 1 when a check fails.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const out = resolve(opt('--out') ?? '.');
const expect = opt('--expect');
const summaryFile = opt('--summary');
if (!['accepted', 'refused'].includes(expect) || !summaryFile) { process.stderr.write('usage: proof-check.mjs --out <dir> --expect accepted|refused --summary <file> [--catalog-out <dir>]\n'); process.exit(2); }

const dir = join(out, '0');
const read = (p) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
const lines = (p) => readFileSync(join(dir, p), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let failed = 0;
const check = (ok, what) => { process.stdout.write(`full-mode proof (${expect}): ${ok ? 'ok' : 'FAIL'} ${what}\n`); if (!ok) failed++; };

const meta = read('meta.json');
const driver = read('bundle/logs/driver.json');
const res = read('bundle/results/writecheck.json');
const obs = lines('bundle/observations/writecheck.ndjson');
const f = driver.full_mode ?? {};
const ip = '10.213.53.5';
const fullSkips = (meta.skips ?? []).filter((s) => s.stage === 'full');

check(f.mode === 'full' && f.stand_in?.id === 'typesense' && /@sha256:[0-9a-f]{64}$/.test(f.stand_in?.image ?? ''), `the shard ran in full mode against the pinned stand-in (${f.stand_in?.id ?? '-'})`);
check(f.health?.healthy === true, `the stand-in started in the sandbox and answered its health check (${f.health?.ms ?? '-'} ms)`);
check(f.evidence?.after_seed?.documents === 2, `the stand-in took its seed (documents after the seed: ${f.evidence?.after_seed?.documents ?? '-'})`);
check((f.env?.wired ?? []).some((w) => w.name === 'TYPESENSE_URL' && w.role === 'url') && (f.env?.wired ?? []).some((w) => w.name === 'TYPESENSE_API_KEY' && w.role === 'api_key'), `the server's env names were wired to the stand-in (${(f.env?.wired ?? []).map((w) => `${w.name}:${w.role}`).join(' ')}; left unset: ${(f.env?.unset ?? []).join(' ') || 'none'})`);
check(typeof f.declaration?.guard_tool === 'string' && f.declaration?.resources?.length === 1 && /^[0-9a-f]{64}$/.test(f.declaration?.sha256 ?? ''), `the thin declaration was made from tools/list and the seed (guard ${f.declaration?.guard_tool ?? '-'}, ${f.declaration?.tools_read ?? '-'} tools read, write resources ${f.declaration?.write_resources ?? '-'})`);
check(/^[0-9a-f]{16}$/.test(f.plan?.plan_hash ?? '') && f.plan?.plan_exit === 0, `the CLI planned the thin declaration (plan ${f.plan?.plan_hash ?? '-'}, hosts ${(f.plan?.hosts ?? []).join(', ') || 'none'})`);
if (expect === 'accepted') {
  check(f.plan?.accepted === true && f.plan?.accepted_by === 'rule' && (f.plan?.hosts ?? []).length > 0 && f.plan.hosts.every((h) => h === ip || h.startsWith(`${ip}:`)), 'every write target is the stand-in, and the rule check accepted the plan with no person');
  check(f.outcome?.status === 'ran' && [0, 1].includes(f.outcome?.exit), `the full write test ran in the sandbox against the stand-in (exit ${f.outcome?.exit ?? '-'})`);
  check(res.mode === 'full' && res.full?.ran === true && res.full?.found === true, `the bundle carries the full run (mode ${res.mode}, status ${res.full?.status ?? '-'}, writes ${res.full?.writes ?? '-'})`);
  const recs = obs.filter((o) => o.field === 'requirement_verdicts' && o.stage === 'full').flatMap((o) => o.value ?? []);
  check(recs.length > 0 && recs.every((r) => r.mode === 'full' && r.basis === 'stand-in-product' && r.backend_environment === 'stand-in'), `every full-run record carries mode full and basis stand-in-product (${recs.length} records; relabelled ${JSON.stringify(f.labelled?.relabelled ?? {})})`);
  check(fullSkips.length === 0, 'no full-stage skip');
  check(f.evidence?.after_run !== null && Number.isSafeInteger(f.evidence?.after_run?.documents), `the stand-in was read after the run (documents ${f.evidence?.after_run?.documents ?? '-'})`);
} else {
  check(f.mutated?.name === 'TYPESENSE_URL', `the proof pointed ${f.mutated?.name ?? '-'} at a host that is not the stand-in`);
  check(f.plan?.accepted === false && f.plan?.code === 'target_not_standin' && (f.plan?.foreign ?? []).some((h) => h.startsWith('192.0.2.10')), `the rule check refused the plan (${f.plan?.code ?? '-'}: ${(f.plan?.foreign ?? []).join(', ')})`);
  check(f.outcome?.status === 'refused' && f.code === 'target_not_standin' && res.full?.ran === false, 'the full write test never started; the bundle records not tested, target_not_standin');
  check(fullSkips.length === 1 && fullSkips[0].reason === 'unsupported_layout' && fullSkips[0].fault === 'tool', `the full stage's skip is ours (${fullSkips.map((s) => `${s.reason}:${s.fault}`).join(', ') || 'none'}), never the server's`);
}
const summary = {
  format: 'isokron-writecheck-full-proof/1', expect, failed,
  full_mode: { mode: f.mode, backend: f.backend, backend_kind: f.backend_kind, stand_in: f.stand_in, env: f.env, mutated: f.mutated, health: f.health, evidence: f.evidence, declaration: f.declaration, plan: f.plan, outcome: f.outcome, code: f.code, labelled: f.labelled },
  skips: meta.skips,
  steps: (res.steps ?? []).map((s) => ({ step: s.step, exit: s.exit })),
};
mkdirSync(dirname(resolve(summaryFile)), { recursive: true });
writeFileSync(resolve(summaryFile), `${JSON.stringify(summary, null, 2)}\n`);
const catOut = opt('--catalog-out');
if (catOut) {
  const base = join(dir, 'bundle', 'raw', 'out', 'results');
  const cat = existsSync(base) ? readdirSync(base).filter((d) => /^catalog-[0-9a-f]{10}$/.test(d)).map((d) => join(base, d, 'catalog.json')).filter(existsSync) : [];
  if (cat.length === 1) { mkdirSync(resolve(catOut), { recursive: true }); copyFileSync(cat[0], join(resolve(catOut), 'catalog.json')); }
  check(cat.length === 1, 'the catalog stage\'s catalog.json is kept for the declarations workflow');
}
process.exit(failed ? 1 : 0);

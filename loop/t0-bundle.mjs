#!/usr/bin/env node
// Build the tool-qa result bundle of one T0 worker run (t0-self lane): selftest.yml and the dogfood-*.yml.
//
//   node loop/t0-bundle.mjs --out <dir>
//   env: RESULTS (the needs.*.result values of the workflow's jobs, space separated),
//        GITHUB_WORKFLOW_REF, GITHUB_SHA, GITHUB_REPOSITORY
//
// Writes <out>/bundle/results/run.json and <out>/meta.json (the worker-kit meta file). One control,
// `known_good`: expected `green`, observed `green` only when every job of the run succeeded or was skipped.
// A job that failed or was cancelled makes it `failed` or `cancelled`, which tool-qa's ingest rejects as
// control_failed: a lead against OUR tool (this action, the mcp-writecheck CLI or the server build we run
// it against), never against a third-party subject. The subject is `<repository>.<workflow file stem>`,
// the name the pump gives the worker (pump/workflows.json t0-self control_subjects).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KNOWN = new Set(['success', 'failure', 'cancelled', 'skipped']);

/** The workflow file's stem from GITHUB_WORKFLOW_REF (`owner/repo/.github/workflows/<stem>.yml@ref`), or null. */
export function stemFromRef(ref) {
  const m = /\/\.github\/workflows\/([A-Za-z0-9._-]+)\.ya?ml@/.exec(String(ref ?? ''));
  return m ? m[1] : null;
}

/** green when every job succeeded or was skipped; failed, cancelled or incomplete otherwise. */
export function observe(results) {
  const list = String(results ?? '').split(/\s+/).filter(Boolean);
  if (list.length === 0) return 'incomplete';
  if (list.some((r) => !KNOWN.has(r))) return 'incomplete';
  if (list.includes('failure')) return 'failed';
  if (list.includes('cancelled')) return 'cancelled';
  return 'green';
}

export function build(env = process.env, now = new Date()) {
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : 'isokron-ai/mcp-writecheck-action';
  const stem = stemFromRef(env.GITHUB_WORKFLOW_REF);
  if (!stem) throw new Error('GITHUB_WORKFLOW_REF does not name a workflow file');
  const sha = /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null;
  const observed = observe(env.RESULTS);
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    run: { lane: 't0-self', workflow: `${stem}.yml`, job_results: String(env.RESULTS ?? '').split(/\s+/).filter(Boolean), observed },
    meta: {
      subject: { id: `${repo}.${stem}`, repo, sha },
      tools: [{ name: repo.split('/')[1], version: sha ?? 'unknown' }],
      oracles: [],
      settings_manifest_digest: createHash('sha256').update(`${stem}.yml`).digest('hex'),
      started_at: at,
      finished_at: at,
      skips: [],
      controls: [{ kind: 'known_good', expected: 'green', observed }],
    },
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : undefined;
  if (!out) { process.stderr.write('usage: t0-bundle.mjs --out <dir>\n'); process.exit(2); }
  const { run, meta } = build();
  mkdirSync(join(out, 'bundle', 'results'), { recursive: true });
  writeFileSync(join(out, 'bundle', 'results', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${meta.subject.id}: ${run.observed}\n`);
}

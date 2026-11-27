#!/usr/bin/env node
// Build the tool-qa result bundle of one T0 worker run (t0-self lane): selftest.yml and the dogfood-*.yml.
//
//   node loop/t0-bundle.mjs --out <dir>
//   env: NEEDS (toJSON(needs) of the t0-manifest job), GITHUB_WORKFLOW_REF, GITHUB_SHA, GITHUB_REPOSITORY, and for a failed run
//        GITHUB_TOKEN (actions: read) and GITHUB_RUN_ID, to read which steps failed
//
// Writes <out>/bundle/results/run.json and <out>/meta.json (the worker-kit meta file). One control,
// `known_good`: expected `green_or_infra`: green only when at least one work job succeeded and none failed (all skipped is not green);
// a run that failed only at steps that fetch from the network (INFRA_STEPS) is infrastructure: a retryable infra skip, no lead.
// A job that failed or was cancelled makes it `failed` or `cancelled`, which tool-qa's ingest rejects as
// control_failed: a lead against OUR tool (this action, the mcp-writecheck CLI or the server build we run
// it against), never against a third-party subject. The subject is `<repository>.<workflow file stem>`,
// the name the pump gives the worker (pump/workflows.json t0-self control_subjects).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KNOWN = new Set(['success', 'failure', 'cancelled', 'skipped']);
export const START_JOB = 't0-start';

/** The workflow file's stem from GITHUB_WORKFLOW_REF (`owner/repo/.github/workflows/<stem>.yml@ref`), or null. */
export function stemFromRef(ref) {
  const m = /\/\.github\/workflows\/([A-Za-z0-9._-]+)\.ya?ml@/.exec(String(ref ?? ''));
  return m ? m[1] : null;
}

/** The work jobs' results from `toJSON(needs)`: every job but t0-start (and this one), as an array of result strings. */
export function workResults(needsJson) {
  let needs;
  try { needs = JSON.parse(String(needsJson ?? '')); } catch { return []; }
  if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) return [];
  return Object.entries(needs).filter(([name]) => name !== START_JOB).map(([, v]) => String(v?.result ?? 'unknown'));
}

/**
 * What the run did, from the work jobs' results:
 *   green        at least one work job succeeded, none failed or was cancelled (skipped jobs are fine: the vendor jobs are off)
 *   failed       a work job failed, cancelled        (a lead against OUR tool unless every failure was infrastructure, see below)
 *   cancelled
 *   skipped      every work job was skipped: nothing ran, never green
 *   incomplete   no work job result, or one GitHub does not define
 */
export function observe(results) {
  const list = Array.isArray(results) ? results : String(results ?? '').split(/\s+/).filter(Boolean);
  if (list.length === 0 || list.some((r) => !KNOWN.has(r))) return 'incomplete';
  if (list.includes('failure')) return 'failed';
  if (list.includes('cancelled')) return 'cancelled';
  if (!list.includes('success')) return 'skipped';
  return 'green';
}

/**
 * Steps that ONLY fetch from the network (GitHub, an image registry, the Go proxy, an npm tarball): a job that failed ONLY at
 * such steps failed on infrastructure, which is not a lead against our tool: the bundle then carries a retryable infra skip and
 * tool-qa sends the worker out again. Nothing that builds, checks or starts our own code is listed: a compile error in our
 * own build, our own up.sh or RBAC, a plan hash or an integrity mismatch is ours (the pnpm tarball is downloaded in its own
 * step, and its integrity check is another, so a refusal is never read as a network failure). Anything not listed is a lead.
 */
export const INFRA_STEPS = Object.freeze([
  /^Set up job$/, /^Install kind$/, /^Download pnpm$/,
  /^Run actions\/(checkout|setup-go|setup-node|cache|download-artifact)@/, /^Run docker\//,
]);

/** @param {{name: string, conclusion: string|null, steps?: {name: string, conclusion: string|null}[]}[]} jobs from the run's jobs API */
export function infraOnly(jobs) {
  const failedSteps = [];
  let failedJobs = 0;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j?.conclusion !== 'failure') continue;
    failedJobs += 1;
    const steps = (j.steps ?? []).filter((x) => x?.conclusion === 'failure');
    if (steps.length === 0) return false; // a job that failed with no failed step: not known to be infrastructure
    failedSteps.push(...steps);
  }
  return failedJobs > 0 && failedSteps.every((x) => INFRA_STEPS.some((re) => re.test(String(x.name))));
}

export function build(env = process.env, now = new Date(), { jobs = null } = {}) {
  const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ? env.GITHUB_REPOSITORY : 'isokron-ai/mcp-writecheck-action';
  const stem = stemFromRef(env.GITHUB_WORKFLOW_REF);
  if (!stem) throw new Error('GITHUB_WORKFLOW_REF does not name a workflow file');
  const sha = /^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ? env.GITHUB_SHA : null;
  const results = workResults(env.NEEDS);
  const seen = observe(results);
  const infra = seen === 'failed' && infraOnly(jobs);
  const observed = infra ? 'green_or_infra' : seen === 'green' ? 'green_or_infra' : seen;
  const at = now.toISOString().replace(/\.\d+Z$/, 'Z');
  return {
    run: { lane: 't0-self', workflow: `${stem}.yml`, job_results: results, observed: infra ? 'infra' : seen },
    meta: {
      subject: { id: `${repo}.${stem}`, repo, sha },
      tools: [{ name: repo.split('/')[1], version: sha ?? 'unknown' }],
      oracles: [],
      settings_manifest_digest: createHash('sha256').update(`${stem}.yml`).digest('hex'),
      started_at: at,
      finished_at: at,
      // Infrastructure only: a retryable infra skip, so ingest sends the worker out again and no lead is raised against our tool.
      skips: infra ? [{ stage: 'worker', reason: 'upstream_unavailable', fault: 'infra', retryable: true }] : [],
      controls: [{ kind: 'known_good', expected: 'green_or_infra', observed }],
    },
  };
}

/** The run's jobs with their steps from the API (needs GITHUB_TOKEN with actions: read); null when it cannot be read. */
export async function readJobs(env = process.env, fetchImpl = globalThis.fetch) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_RUN_ID || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) return null;
  try {
    const res = await fetchImpl(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/jobs?per_page=100`, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    return (await res.json()).jobs ?? null;
  } catch { return null; }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : undefined;
  if (!out) { process.stderr.write('usage: t0-bundle.mjs --out <dir>\n'); process.exit(2); }
  const probe = build();
  // Only a failed run needs the steps: was it infrastructure alone?
  const jobs = probe.run.observed === 'failed' ? await readJobs() : null;
  const { run, meta } = jobs ? build(process.env, new Date(), { jobs }) : probe;
  mkdirSync(join(out, 'bundle', 'results'), { recursive: true });
  writeFileSync(join(out, 'bundle', 'results', 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  writeFileSync(join(out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  process.stdout.write(`${meta.subject.id}: ${run.observed}\n`);
}

#!/usr/bin/env node
/**
 * The action's one script. action.yml passes the inputs as INPUT_* variables. It runs twice:
 *
 *   `main.mjs obtain` (its own step, the only one that gets `cli-token`) checks the Node version,
 *   obtains the CLI (src/install.mjs) and writes the path of its entry script to the `cli-entry`
 *   output. Nothing the run starts later can then read the token from its environment.
 *
 *   `main.mjs` (the run step, given that path as MWSC_CLI_ENTRY)
 *   1. checks the inputs and the Node version;
 *   2. uses the CLI the obtain step built (without MWSC_CLI_ENTRY, as in test/local-test.sh, it
 *      obtains the CLI itself);
 *   3. runs `plan`, `catalog` or `run` with the arguments contract.mjs builds;
 *   4. writes the job summary (src/summary.mjs) and the outputs;
 *   5. records the job status in the `exit-status` output.
 *
 * It exits 0 whenever it could decide a status, so that the next step of action.yml can upload
 * the results before the last step applies the status. It exits non-zero only when it failed
 * before it could write a summary.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { CLI, CLI_DEFAULT_REF, SPEC_DEFAULT_URL } from '../contract.mjs';
import { ActionError, authHeaderValue, checkNode, obtainCli } from './install.mjs';
import { memoryAttention, parseCeilingMb, startSampler } from './memory.mjs';
import { cliEndText, decide, killsAttention, levelText, md, renderNoResults, renderPlan, renderRun, safetyFacts, unexpectedKills } from './summary.mjs';

const env = process.env;
const inActions = env.GITHUB_ACTIONS === 'true';
const log = (s) => process.stdout.write(`${s}\n`);
/** Escape a message for a workflow command, so that data cannot start a command of its own. */
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const annotate = (kind, msg) => log(inActions ? `::${kind}::${esc(msg)}` : `${kind}: ${msg}`);
/** A summary reason as plain text for an annotation: no Markdown escapes, no code spans. */
const plain = (s) => String(s).replace(/\\([\\`*_[\]|~])/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/`/g, '');
/** The last match of a line pattern in the CLI's output (text the server printed earlier cannot win). */
const lastMatch = (re, text) => [...text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].pop();

function input(name, fallback = '') {
  const v = env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function readInputs() {
  const i = {
    manifest: input('manifest'),
    mode: input('mode', 'plan'),
    failOn: input('fail-on', 'must'),
    cliRef: input('cli-ref', CLI_DEFAULT_REF),
    specUrl: input('spec-url', SPEC_DEFAULT_URL),
    confirmTarget: input('confirm-target'),
    planHash: input('plan-hash'),
    catalog: input('catalog'),
    resultsDir: input('results-dir', 'mwsc-results'),
    artifactName: input('artifact-name', 'mcp-writecheck-results'),
    cliPath: input('cli-path'),
    cliToken: input('cli-token'),
    maxRssMb: input('max-rss-mb'),
  };
  if (!i.manifest) throw new ActionError('The `manifest` input is required: the path of the mcp-writecheck manifest in this repository.');
  if (!existsSync(i.manifest)) throw new ActionError(`manifest: ${i.manifest} does not exist (the path is relative to the workspace).`);
  if (!['plan', 'catalog', 'full'].includes(i.mode)) throw new ActionError(`mode: ${JSON.stringify(i.mode)} is not one of plan, catalog, full.`);
  try {
    i.maxRssMb = parseCeilingMb(i.maxRssMb);
  } catch (e) {
    // why: memory never changes the job status (owner, 16 Nov), so a bad ceiling is a warning and the run goes on without one.
    annotate('warning', `${e.message} The run goes on without a memory ceiling.`);
    i.maxRssMb = null;
  }
  if (!['none', 'must', 'any'].includes(i.failOn)) throw new ActionError(`fail-on: ${JSON.stringify(i.failOn)} is not one of none, must, any.`);
  let url;
  try {
    url = new URL(i.specUrl);
  } catch {
    throw new ActionError(`spec-url: ${JSON.stringify(i.specUrl)} is not a URL.`);
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new ActionError('spec-url must be an http or https URL.');
  if (i.mode === 'full') {
    // why: the CLI has no --yes, and this action does not add one. Both values are written into the
    // workflow by a person who has read the plan.
    if (!i.confirmTarget) throw new ActionError('mode full needs the `confirm-target` input: the manifest\'s target.confirm, typed back.');
    if (!i.planHash) throw new ActionError('mode full needs the `plan-hash` input: the hash that mode plan (or `mcp-writecheck plan`) prints for this manifest and environment.');
    if (!CLI.planHashShape.test(i.planHash)) throw new ActionError(`plan-hash: ${JSON.stringify(i.planHash)} does not look like a plan hash.`);
    if (i.catalog) throw new ActionError('The `catalog` input applies to modes plan and catalog only: a full run reads the catalog from the server.');
  }
  if (i.catalog && !existsSync(i.catalog)) throw new ActionError(`catalog: ${i.catalog} does not exist.`);
  return i;
}

/**
 * Run the CLI. Its output goes to the job log as it comes, and is kept for the two lines the action reads.
 * With `sample`, the memory of the CLI's process tree is sampled while it runs (src/memory.mjs); the
 * result is `memory`. Sampling never changes the outcome: any error there gives `not measured`.
 */
function runCli(entry, args, { sample = false } = {}) {
  return new Promise((resolveRun) => {
    // why: the CLI's output can quote text that the server under test produced. Workflow commands are
    // switched off while it prints, so that such text cannot issue one.
    const stop = randomUUID();
    if (inActions) log(`::group::mcp-writecheck ${args[0]}\n::stop-commands::${stop}`);
    // why: detached puts the CLI in its own process group. A Ctrl-C or a signal to the job's process
    // group then reaches it once, through `forward`, not twice; a second signal makes the CLI exit at
    // once without its clean-up.
    const child = spawn(process.execPath, [entry, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let sampler = null;
    if (sample) {
      try {
        sampler = startSampler({ root: child.pid });
      } catch (e) {
        sampler = { stop: async () => ({ method: 'not measured', peakKib: null, samples: 0, intervalMs: 0, note: 'sampling could not start' }) };
      }
    }
    let out = '';
    const keep = (chunk, stream) => {
      out += chunk;
      if (out.length > 4_000_000) out = out.slice(-2_000_000);
      stream.write(chunk);
    };
    child.stdout.setEncoding('utf8').on('data', (c) => keep(c, process.stdout));
    child.stderr.setEncoding('utf8').on('data', (c) => keep(c, process.stderr));
    // The CLI cleans up after itself on SIGINT and SIGTERM; pass the first signal on and wait for it.
    // why: a runner cancels with SIGINT, then SIGTERM some seconds later. The CLI takes a second
    // signal as "exit now, without clean-up", so later signals are not passed on; the CLI's own
    // clean-up timer, and the runner's final kill, bound the wait.
    let forwarded = false;
    const forward = (sig) => {
      if (forwarded) return;
      forwarded = true;
      child.kill(sig);
    };
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    let finished = false;
    const done = (code, signal, error) => {
      if (finished) return;
      finished = true;
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      if (inActions) log(`\n::${stop}::\n::endgroup::`);
      const exit = error ? null : code ?? (signal === 'SIGINT' || signal === 'SIGTERM' ? 130 : null);
      // why: a CLI ended by any other signal (SIGKILL from the out-of-memory killer or the runner) has no exit status; the summary names the signal.
      const result = { code: exit, signal: exit === null && !error ? signal ?? null : null, out, error, memory: null };
      if (!sampler) return resolveRun(result);
      sampler
        .stop()
        .catch(() => ({ method: 'not measured', peakKib: null, samples: 0, intervalMs: 0, note: 'sampling failed' }))
        .then((memory) => resolveRun({ ...result, memory }));
    };
    child.on('error', (e) => done(null, null, e));
    child.on('close', (code, signal) => done(code, signal, null));
  });
}

/**
 * The folder a `run` or `catalog` wrote. First the folder the CLI names in its "results:" line, if it is
 * inside the results folder and holds results.json; otherwise a folder that is new since `before` and holds
 * results.json (a refused run leaves a folder without it). `catalog` reuses its folder name for the same
 * catalog, so for it the named folder is the only reliable answer.
 */
function findResultsDir(resultsRoot, before, out) {
  const named = lastMatch(CLI.resultsLine, out)?.[1];
  if (named) {
    const dir = resolve(named);
    if (dir.startsWith(resultsRoot + '/') && existsSync(join(dir, CLI.resultsFile))) return dir;
  }
  return readdirSync(resultsRoot)
    .filter((d) => !before.has(d) && existsSync(join(resultsRoot, d, CLI.resultsFile)))
    .map((d) => join(resultsRoot, d))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function readResults(runDir) {
  if (!runDir) return { doc: null, unreadable: null };
  try {
    const doc = JSON.parse(readFileSync(join(runDir, CLI.resultsFile), 'utf8'));
    if (doc.format !== CLI.resultsFormat || !Array.isArray(doc.results)) return { doc: null, unreadable: `${CLI.resultsFile} has the format ${JSON.stringify(doc.format)}; this action reads ${CLI.resultsFormat}.` };
    return { doc, unreadable: null };
  } catch (e) {
    return { doc: null, unreadable: `${CLI.resultsFile} could not be read: ${md(e.message)}` };
  }
}

/** The run's plan.json, or null. Only decide() reads it, and it tells nothing without one (setupFacts). */
function readPlan(runDir) {
  if (!runDir) return null;
  try {
    return JSON.parse(readFileSync(join(runDir, CLI.planFile), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Server processes killed by a SIGKILL the tester did not send, from the run's capture. Any problem reading
 * it (no capture, over 64 MiB, unreadable) gives none: this is a "Needs attention" line, never a job status.
 */
function readKills(runDir) {
  if (!runDir) return [];
  try {
    const file = join(runDir, CLI.captureFile);
    // why: the whole file is read into memory; on a runner already short of memory a large capture must not be what kills the action.
    if (!existsSync(file) || statSync(file).size > 64 * 1024 * 1024) return [];
    return unexpectedKills(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

/** Error and warning lines for the job's annotations, from the decision and the safety facts. */
function annotateRun(decision, doc) {
  if (decision.fail) for (const why of decision.reasons) annotate('error', plain(why));
  for (const line of new Set(decision.failing.map((f) => `${f.requirement} violated (${levelText(f)}) on ${f.write_path?.resource}:${f.write_path?.tool}`))) annotate('error', line);
  if (!doc) return;
  const facts = safetyFacts(doc);
  for (const r of facts.lost) annotate('error', `objects the tester did not create were changed or deleted around ${r.requirement} on ${r.write_path?.resource}:${r.write_path?.tool}; the job summary lists them`);
  if (facts.setupUnresolved.length) annotate('error', 'setup made through the platform API was not released; the job summary says what to do');
  if (facts.leftovers.length) annotate('warning', `mcp-writecheck left objects behind in the test environment; search it for the prefix ${doc.run?.prefix}.`);
  if (facts.cleanupUnknown.length || facts.cleanupFailed.length) annotate('warning', 'clean-up did not finish; run mcp-writecheck cleanup with the state folder from the artifact.');
}

/** A warning annotation when the sampled peak reached `max-rss-mb`. Never an error: the job status does not depend on it. */
function annotateMemory(memory, ceilingMb) {
  const line = memoryAttention(memory, ceilingMb);
  if (line) annotate('warning', plain(line));
}

function cliVersion(entry) {
  return runCli(entry, CLI.versionArgs()).then((r) => (r.code === 0 ? r.out.trim().split('\n').pop() : ''));
}

const lastLines = (text, n) => text.replace(/\s+$/, '').split('\n').slice(-n).join('\n');

function setOutputs(o) {
  const lines = Object.entries(o).map(([k, v]) => {
    const s = String(v ?? '');
    if (/[\r\n]/.test(s)) throw new ActionError(`output ${k} would contain a line break`);
    return `${k}=${s}`;
  });
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  else log(lines.map((l) => `output ${l}`).join('\n'));
}

function writeSummary(text) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  else log(text);
}

/** Mask the token and the header made from it in the job log, before anything can print them. */
function maskToken(token) {
  if (!token || !inActions) return;
  log(`::add-mask::${token}`);
  log(`::add-mask::${authHeaderValue(token)}`);
  log(`::add-mask::${authHeaderValue(token).replace(/^AUTHORIZATION: basic /, '')}`);
}

function obtain(i) {
  maskToken(i.cliToken);
  // why: the token is for the one git fetch. Nothing the action starts afterwards inherits it.
  delete env.INPUT_CLI_TOKEN;
  checkNode();
  return obtainCli({ ref: i.cliRef, cliPath: i.cliPath, token: i.cliToken, tempDir: env.RUNNER_TEMP || tmpdir(), log });
}

/** The obtain step: only the inputs that choose the CLI. */
function obtainStep() {
  const entry = obtain({ cliRef: input('cli-ref', CLI_DEFAULT_REF), cliPath: input('cli-path'), cliToken: input('cli-token') });
  setOutputs({ 'cli-entry': entry });
}

async function main() {
  // why: the upload step reads these, so the artifact holds what this script wrote even when the
  // inputs had spaces around them or the script stops early.
  setOutputs({ 'results-root': resolve(input('results-dir', 'mwsc-results')), 'artifact-name': input('artifact-name', 'mcp-writecheck-results') });
  const i = readInputs();
  const resultsRoot = resolve(i.resultsDir);
  mkdirSync(resultsRoot, { recursive: true });
  let entry;
  if (env.MWSC_CLI_ENTRY) {
    // why: the obtain step of action.yml built the CLI; this step never sees the token.
    delete env.INPUT_CLI_TOKEN;
    checkNode();
    entry = env.MWSC_CLI_ENTRY;
    if (!existsSync(entry)) throw new ActionError(`the CLI the obtain step reported, ${entry}, does not exist.`);
  } else entry = obtain(i);
  const version = await cliVersion(entry);
  if (!version) throw new ActionError(`${entry} did not answer \`${CLI.versionArgs().join(' ')}\`: it is not a usable mcp-writecheck build.`);
  log(version);

  if (i.mode === 'plan') {
    const r = await runCli(entry, CLI.planArgs({ manifest: i.manifest, catalog: i.catalog || null }), { sample: true });
    if (r.error) throw new ActionError(`could not start mcp-writecheck: ${r.error.message}`);
    const hash = lastMatch(CLI.planHashLine, r.out)?.[1] ?? null;
    const reasons = [];
    if (r.code !== 0) reasons.push(`mcp-writecheck plan ${cliEndText(r.code, r.signal)}.${i.catalog ? '' : ' Without the `catalog` input, plan starts the server for one `tools/list` request, so the server must be able to start in this job.'}`);
    else if (!hash) reasons.push('mcp-writecheck plan printed no plan hash that this action could read.');
    const decision = { fail: reasons.length > 0, reasons, failing: [] };
    const planDir = join(resultsRoot, 'plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'plan.txt'), r.out);
    writeSummary(renderPlan({ manifest: i.manifest, catalog: i.catalog || null, cliExit: r.code, cliSignal: r.signal, planHash: hash, planText: r.code === 0 ? r.out : lastLines(r.out, 40), cliVersion: version, decision, memory: r.memory, ceilingMb: i.maxRssMb }));
    annotateMemory(r.memory, i.maxRssMb);
    for (const why of reasons) annotate('error', why);
    setOutputs({ mode: 'plan', 'plan-hash': hash ?? '', 'results-path': planDir, 'cli-exit-code': r.code ?? '', 'exit-status': decision.fail ? 1 : 0 });
    return;
  }

  if (i.mode === 'catalog') {
    const before = new Set(readdirSync(resultsRoot));
    const r = await runCli(entry, CLI.catalogArgs({ manifest: i.manifest, catalog: i.catalog || null, out: resultsRoot }), { sample: true });
    if (r.error) throw new ActionError(`could not start mcp-writecheck: ${r.error.message}`);
    const runDir = findResultsDir(resultsRoot, before, r.out);
    const { doc, unreadable } = readResults(runDir);
    const decision = decide({ failOn: i.failOn, cliExit: r.code, cliSignal: r.signal, doc });
    if (unreadable) decision.reasons.push(unreadable);
    if (doc) writeSummary(renderRun({ doc, specUrl: i.specUrl, failOn: i.failOn, cliExit: r.code, cliSignal: r.signal, decision, cliVersion: version, artifactName: i.artifactName, mode: 'catalog', memory: r.memory, ceilingMb: i.maxRssMb }));
    else writeSummary(renderNoResults({ cliExit: r.code, cliSignal: r.signal, decision, lastLines: lastLines(r.out, 15), planHashGiven: '', planHashSeen: null, cliVersion: version, memory: r.memory, ceilingMb: i.maxRssMb }));
    annotateRun(decision, doc);
    annotateMemory(r.memory, i.maxRssMb);
    setOutputs({ mode: 'catalog', 'plan-hash': '', 'results-path': runDir ?? '', 'cli-exit-code': r.code ?? '', 'exit-status': decision.fail ? 1 : 0 });
    return;
  }

  // mode full
  const before = new Set(readdirSync(resultsRoot));
  // why: the ledger of an interrupted run is what `mcp-writecheck cleanup` needs; keeping the state
  // folder beside the results puts it in the artifact.
  const state = join(resultsRoot, 'state');
  const r = await runCli(entry, CLI.runArgs({ manifest: i.manifest, confirmTarget: i.confirmTarget, planHash: i.planHash, out: resultsRoot, state }), { sample: true });
  if (r.error) throw new ActionError(`could not start mcp-writecheck: ${r.error.message}`);

  const runDir = findResultsDir(resultsRoot, before, r.out);
  const { doc, unreadable } = readResults(runDir);
  const decision = decide({ failOn: i.failOn, cliExit: r.code, cliSignal: r.signal, doc, plan: readPlan(runDir) });
  if (unreadable) decision.reasons.push(unreadable);
  const planHashSeen = doc?.plan?.hash ?? lastMatch(CLI.runPlanLine, r.out)?.[1] ?? '';
  const kills = readKills(runDir);
  if (doc) writeSummary(renderRun({ doc, specUrl: i.specUrl, failOn: i.failOn, cliExit: r.code, cliSignal: r.signal, decision, cliVersion: version, artifactName: i.artifactName, mode: 'full', memory: r.memory, ceilingMb: i.maxRssMb, kills }));
  else writeSummary(renderNoResults({ cliExit: r.code, cliSignal: r.signal, decision, lastLines: lastLines(r.out, 15), planHashGiven: i.planHash, planHashSeen: planHashSeen || null, cliVersion: version, memory: r.memory, ceilingMb: i.maxRssMb }));
  annotateRun(decision, doc);
  annotateMemory(r.memory, i.maxRssMb);
  const killed = killsAttention(kills);
  if (killed) annotate('warning', plain(killed));
  setOutputs({ mode: 'full', 'plan-hash': planHashSeen, 'results-path': runDir ?? '', 'cli-exit-code': r.code ?? '', 'exit-status': decision.fail ? 1 : 0 });
}

(process.argv[2] === 'obtain' ? Promise.resolve().then(obtainStep) : main()).catch((e) => {
  const msg = e instanceof ActionError ? e.message : `unexpected error: ${e?.stack ?? e}`;
  annotate('error', msg);
  try {
    writeSummary(`## mcp-writecheck: not run\n\n**Job status: failed.** ${msg.replace(/[<>]/g, '')}\n`);
  } catch {
    /* the log line above is enough */
  }
  process.exit(1);
});

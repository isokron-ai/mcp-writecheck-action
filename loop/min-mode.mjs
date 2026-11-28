// The writecheck loop worker in min mode (tool-qa docs/INTERFACES.md, "Writecheck modes: the write-backend contract",
// tool-qa PR #119). A shard in mode `min` is homogeneous: one backend id and one spec URL. This module checks those
// inputs against our own pinned allowlist (loop/min-specs.json), fetches only a description we pinned (by URL and
// sha256, outside the sandbox), builds the `mcp-writecheck min` command line for one item, and turns the CLI's
// results.json into checked field values. It is a separate module so that the full-mode work (stand-ins) and this one
// meet only in corpus.yml's shared mode inputs.
//
// Rules from the contract:
//   - every input is a name looked up in our allowlist; a value that does not fit is a skip of ours (stage `mode`,
//     reason `unsupported_layout`, fault `tool`), never a reason to fetch a URL named only by an input;
//   - only the env names given are set, to the mock (base URLs) or to dummy canaries; never a real credential; egress
//     stays denied (the mock lives inside the sandbox network);
//   - every record says mode `min` and basis `stateful-mock`; the requirements min mode never judges (UPD-1/2, CONC-1/2/3,
//     TGT-1/3, RES-1, ATOM-2: read from the CLI's own requirements-min.json) are never held: a results.json that holds or
//     violates one is refused here as well as by the CLI;
//   - a mock that does not fit the server is ours (fault `tool`), and so is a server we cannot route to the mock or one
//     that will not start against it. worker-kit's SKIP_REASONS has no reason of its own for these yet (the contract
//     names mock_incomplete and stand_in_mismatch; contract.mjs does not list them), so the skip is `unsupported_layout`
//     (fault `tool`, the one it allows) and `code` says which: mock_incomplete, cannot_route, target_not_standin,
//     start_against_mock_failed, spec_digest_mismatch, not_allowlisted.
//
// Only Node's standard library.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_SPECS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'min-specs.json');
export const BACKEND_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The contract's base-URL names (*_URL, *_URI, *_HOST, *_ENDPOINT, *_BASE_URL, *_ADDR). */
export const BASE_URL_NAME = /_(URL|URI|HOST|ENDPOINT|BASE_URL|ADDR)$/;
export const MAX_SPEC_BYTES = 8 * 1024 * 1024;
/** Min mode reads OpenAPI 3.x only; the other formats the classifier names are a skip of ours until a reader exists. */
export const MIN_FORMATS = new Set(['openapi3']);
/** Where the CLI checkout (loop/prepare.sh fetch, mws-cli at CLI_REF) keeps min mode's requirement list. */
export const MIN_REQUIREMENTS_FILE = 'mws-cli/packages/writecheck/src/min/requirements-min.json';
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Min mode's own requirement list, read from the CLI checkout at the pinned commit (never a copy kept here): every requirement
 * id, the ones it never judges (not_testable_mock) and the ones it judges only on their violated half (partial).
 */
export function loadMinRequirements(file = MIN_REQUIREMENTS_FILE) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.format !== 'mws-min-requirements/1' || typeof doc.requirements !== 'object') throw new Error(`${file}: not a mws-min-requirements/1 file`);
  const entries = Object.entries(doc.requirements);
  const of = (st) => Object.freeze(entries.filter(([, v]) => v?.min === st).map(([k]) => k));
  const ids = new Set(entries.map(([k]) => k));
  if (ids.size !== 37 || ![...ids].every((k) => REQ_RE.test(k))) throw new Error(`${file}: expected the 37 MWS requirement ids`);
  return Object.freeze({ ids, semantic: of('not_testable_mock'), partial: of('partial') });
}

const skip = (code, detail, stage = 'mode') => ({ skip: { stage, reason: 'unsupported_layout', fault: 'tool' }, code, detail });

export function loadMinSpecs(file = MIN_SPECS_FILE) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.format !== 'writecheck-min-specs/1' || typeof doc.specs !== 'object') throw new Error(`${file}: not a writecheck-min-specs/1 file`);
  return doc.specs;
}

/**
 * The mode inputs of a min shard, checked as names in our allowlist. `inputs`: the dispatch strings (mode, backend,
 * backend_kind, stand_in, spec_url, spec_format, env_names); `items`: the checked items (for the env_names alignment).
 * @returns {{ ok: true, backend: string, entry: object, envNames: string[][] } | { skip: object }}
 */
export function checkMinShard(inputs, items, specs = loadMinSpecs()) {
  if (inputs.mode !== 'min') return skip('not_a_min_shard', 'not a min shard');
  const backend = String(inputs.backend ?? '');
  if (!BACKEND_RE.test(backend)) return skip('not_allowlisted', 'the backend id is malformed');
  if (!Object.hasOwn(specs, backend)) return skip('not_allowlisted', `backend ${backend} is not in loop/min-specs.json`);
  const entry = specs[backend];
  if (String(inputs.stand_in ?? '') !== '') return skip('not_allowlisted', 'a min shard names no stand-in');
  if (String(inputs.spec_url ?? '') !== entry.spec_url) return skip('not_allowlisted', `spec_url is not the one loop/min-specs.json pins for ${backend}`);
  if (String(inputs.spec_format ?? '') !== entry.spec_format) return skip('not_allowlisted', `spec_format is not the one pinned for ${backend}`);
  if (!MIN_FORMATS.has(entry.spec_format)) return skip('format_not_read', `min mode does not read ${entry.spec_format} yet`);
  if (inputs.backend_kind !== undefined && entry.backend_kind && String(inputs.backend_kind) !== entry.backend_kind) return skip('not_allowlisted', `backend_kind is not the one pinned for ${backend}`);
  let env;
  try {
    env = JSON.parse(String(inputs.env_names ?? '[]'));
  } catch {
    return skip('bad_env_names', 'env_names is not JSON');
  }
  if (!Array.isArray(env) || env.length !== items.length) return skip('bad_env_names', 'env_names is not a list aligned with items');
  for (const names of env) {
    if (!Array.isArray(names) || names.length > 20 || !names.every((n) => typeof n === 'string' && ENV_NAME_RE.test(n)) || new Set(names).size !== names.length) return skip('bad_env_names', 'an env_names entry is malformed');
  }
  return { ok: true, backend, entry, envNames: env };
}

/** Is a fetched description the one we pinned? (size and sha256) */
export function verifySpec(bytes, entry) {
  if (bytes.length > MAX_SPEC_BYTES) return skip('spec_digest_mismatch', 'the description is larger than we fetch');
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== entry.sha256) return skip('spec_digest_mismatch', `the description's sha256 is ${got.slice(0, 12)}, not the pinned ${entry.sha256.slice(0, 12)}`);
  return { ok: true, sha256: got };
}

/**
 * Fetches the pinned description (prepare step, outside the sandbox). Only the URL our allowlist pins, https only, no
 * redirect, capped, and checked against its pinned sha256.
 */
export async function fetchPinnedSpec(entry, o = {}) {
  const f = o.fetch ?? globalThis.fetch;
  const u = new URL(entry.spec_url);
  if (u.protocol !== 'https:' || u.username || u.password || u.search) return skip('not_allowlisted', 'the pinned URL is not a plain https URL');
  let res;
  try {
    res = await f(u, { redirect: 'error', headers: { 'user-agent': 'writecheck-min' }, signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS) });
  } catch (e) {
    return { skip: { stage: 'mode', reason: 'upstream_unavailable', fault: 'infra' }, code: 'spec_unavailable', detail: `the description could not be fetched: ${String(e?.name ?? e)}` };
  }
  if (!res.ok) return { skip: { stage: 'mode', reason: 'upstream_unavailable', fault: 'infra' }, code: 'spec_unavailable', detail: `the description answered ${res.status}` };
  // Refused before reading where the declared length is over the cap; read in chunks, and stopped as soon as it passes the cap.
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_SPEC_BYTES) return skip('spec_digest_mismatch', 'the description declares more bytes than we fetch');
  const chunks = [];
  let n = 0;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        return { skip: { stage: 'mode', reason: 'upstream_unavailable', fault: 'infra' }, code: 'spec_unavailable', detail: `the description could not be read: ${String(e?.name ?? e)}` };
      }
      if (r.done) break;
      n += r.value.length;
      if (n > MAX_SPEC_BYTES) {
        await reader.cancel().catch(() => {});
        return skip('spec_digest_mismatch', 'the description is larger than we fetch');
      }
      chunks.push(Buffer.from(r.value));
    }
  } else chunks.push(Buffer.from(await res.arrayBuffer()));
  const bytes = Buffer.concat(chunks);
  const v = verifySpec(bytes, entry);
  return v.skip ? v : { ok: true, bytes, sha256: v.sha256 };
}

/**
 * The `mcp-writecheck min` command line for one item. Its env names: the base-URL ones point at the mock, the rest get
 * dummies or canaries (the CLI decides by name). No base-URL name and none pinned for the backend: we cannot route the
 * server to the mock (`cannot_route`).
 */
export function minArgv({ cli, specFile, entry, envNames, out, listen = null, advertise = null, declaration = null, server }) {
  const base = [...new Set([...envNames.filter((n) => BASE_URL_NAME.test(n)), ...(entry.base_url_env ?? []).filter((n) => ENV_NAME_RE.test(n))])];
  if (!base.length) return skip('cannot_route', 'no base-URL variable to point the server at the mock', 'min');
  const rest = envNames.filter((n) => !base.includes(n));
  return {
    ok: true,
    argv: [cli, 'min', '--spec', specFile, '--spec-url', entry.spec_url, ...base.flatMap((n) => ['--base-url-env', n]), ...rest.flatMap((n) => ['--env', n]),
      ...(declaration ? ['--declaration', declaration] : []), ...(listen ? ['--listen', listen] : []), ...(advertise ? ['--advertise', advertise] : []), '--out', out, '--', ...server],
  };
}

const REQ_RE = /^MWS-[A-Z0-9]+-[0-9]+$/;
const TOOL_RE = /^[A-Za-z0-9._-]{1,128}$|^\(server\)$/;
const VERDICTS = new Set(['violated', 'held', 'not observed', 'not tested', 'not applicable', 'self-attested']);
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const refuse = (code, detail) => ({ refuse: { stage: 'min', reason: 'tool_error', fault: 'tool' }, code, detail });

/**
 * A min-mode results.json as checked values: mode, basis, the spec used, and one record per requirement and tool, each value
 * checked one by one (no text of the target is copied). The document is refused whole, and nothing of it filed, when it is not a
 * min-mode results.json, when any record is malformed (an id that is not one of the 37, a verdict, tool or status that is not
 * one of ours), or when it breaks a min-mode cap (a backend-semantic requirement held, violated, not marked not_testable_mock
 * or missing; a partial one held). `req`: loadMinRequirements(), the CLI's own list.
 * @returns {{ ok: true, summary: object } | { refuse: object, code: string, detail: string }}
 */
export function minSummary(doc, req = loadMinRequirements()) {
  if (doc?.format !== 'mws-min-results/1' || doc?.mode !== 'min') return refuse('not_min_results', 'not a min-mode results.json');
  if (!Array.isArray(doc.results)) return refuse('malformed_results', 'results is not a list');
  const bad = [];
  const verdicts = [];
  for (const [i, r] of doc.results.entries()) {
    if (typeof r?.requirement !== 'string' || !req.ids.has(r.requirement)) return refuse('malformed_results', `record ${i}: not one of the 37 requirement ids`);
    if (!VERDICTS.has(r.verdict)) return refuse('malformed_results', `record ${i}: not a verdict word`);
    if (typeof r.tool !== 'string' || !TOOL_RE.test(r.tool)) return refuse('malformed_results', `record ${i}: a tool name outside our character set`);
    if (r.status !== undefined && r.status !== 'not_testable_mock') return refuse('malformed_results', `record ${i}: an unknown status`);
    if (req.semantic.includes(r.requirement) && (r.verdict !== 'not tested' || r.status !== 'not_testable_mock')) bad.push(r.requirement);
    if (req.partial.includes(r.requirement) && (r.verdict === 'held' || r.verdict === 'not observed')) bad.push(r.requirement);
    verdicts.push({ requirement: r.requirement, verdict: r.verdict, tool: r.tool, mode: 'min', basis: 'stateful-mock', ...(r.status === 'not_testable_mock' ? { status: 'not_testable_mock' } : {}), ...(CODE_RE.test(r.reason_code ?? '') ? { reason_code: r.reason_code } : {}), ...(typeof r.answer === 'boolean' ? { answer: r.answer } : {}) });
  }
  for (const id of req.semantic) if (!verdicts.some((v) => v.requirement === id)) bad.push(id);
  if (bad.length) return refuse('cap_broken', `the results break a min-mode cap (${[...new Set(bad)].join(', ')}); nothing is filed`);
  const sha = /^[0-9a-f]{64}$/.test(doc.spec?.sha256 ?? '') ? doc.spec.sha256 : null;
  const status = ['complete', 'refused', 'server_did_not_start'].includes(doc.run?.status) ? doc.run.status : 'unknown';
  // Our limits, never the server's (a token checked at start against the mock, a mock that lacks what it asks for).
  const skips = status === 'refused' ? [{ stage: 'min', reason: 'unsupported_layout', fault: 'tool', code: 'target_not_standin' }] : status === 'server_did_not_start' ? [{ stage: 'min', reason: 'unsupported_layout', fault: 'tool', code: 'start_against_mock_failed' }] : [];
  return {
    ok: true,
    summary: {
      mode: 'min',
      basis: 'stateful-mock',
      coverage_class: 'min',
      spec: { sha256: sha },
      status,
      plan: { accepted_by: doc.plan?.accepted_by === 'rule' ? 'rule' : null, targets_are_mock: doc.plan?.accepted === true },
      faults_injected: Array.isArray(doc.faults_injected) ? doc.faults_injected.length : 0,
      requirement_verdicts: verdicts,
      skips,
    },
  };
}

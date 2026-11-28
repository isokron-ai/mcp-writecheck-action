// The mode inputs of one writecheck shard (tool-qa docs/INTERFACES.md, "Writecheck modes: the write-backend contract",
// tool-qa PR #119), checked against this repository's own pinned allowlist (loop/full/standins.json). Every value is a
// name to look up; nothing is pulled, fetched or started because an input names it. A value that does not fit is a
// skip of ours (stage `mode`, reason `unsupported_layout`, fault `tool`), never the server's, and the shard then runs
// as a default one (init, plan and catalog for every item, as before).
//
// The dispatch inputs reach the driver as environment variables (corpus.yml, "Run the items in the sandbox"):
//   WC_MODE, WC_BACKEND, WC_BACKEND_KIND, WC_STAND_IN, WC_SPEC_URL, WC_SPEC_FORMAT, WC_ENV_NAMES
// and the worker's own switch LANE_WRITECHECK_FULL_ENABLED (a repository variable here, as the pump's is in tool-qa):
// full mode runs only at exactly "true", or in this repository's own pull-request proof (loop-full-proof.yml).
//
// worker-kit's manifest has no field for a skip code yet (its skips allow stage, reason, evidence, retryable, fault),
// so the code (not_allowlisted, bad_env_names, mode_not_wired, ...) goes to logs/driver.json (`full_mode.code`).
//
// Only Node's standard library.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
export const STANDINS_FILE = join(here, 'standins.json');

export const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** The backend kinds of the contract's write_backend table. */
export const KINDS = Object.freeze(['sql', 'kv', 'document', 'search', 'graph', 'vector', 'queue', 'object_store', 'mail', 'filesystem', 'git', 'cluster', 'service', 'hosted_api']);
export const FIDELITY = Object.freeze(['real', 'faithful', 'partial', 'not_faithful']);
export const MAX_ENV_PER_ITEM = 20;
/** The image of a stand-in: pinned by the digest of its multi-platform index (as mcp-surface-corpus's checkPinned). */
const PINNED = /^[a-z0-9][a-z0-9./_-]{0,200}(?::[A-Za-z0-9._-]{1,120})?@sha256:[0-9a-f]{64}$/;
const MODE_INPUTS = Object.freeze(['WC_MODE', 'WC_BACKEND', 'WC_BACKEND_KIND', 'WC_STAND_IN', 'WC_SPEC_URL', 'WC_SPEC_FORMAT', 'WC_ENV_NAMES']);

/** One stand-in's own folder (standin.json), checked. */
export function loadStandinDef(dir) {
  const d = JSON.parse(readFileSync(join(repo, dir, 'standin.json'), 'utf8'));
  const bad = (w) => { throw new Error(`${dir}/standin.json: ${w}`); };
  if (d?.format !== 'isokron-writecheck-standin/1') bad('not an isokron-writecheck-standin/1 file');
  if (!Number.isInteger(d.octet) || d.octet < 5 || d.octet > 250) bad('octet is 5 to 250 (.2 to .4 are the logger, the server and the CLI)');
  if (!Number.isInteger(d.port) || d.port < 1024 || d.port > 65535) bad('port');
  if (!Array.isArray(d.ports) || !d.ports.includes(d.port) || !d.ports.every((p) => Number.isInteger(p) && p > 1023 && p < 65536)) bad('ports lists port');
  if (!['http'].includes(d.protocol)) bad('protocol is http');
  if (typeof d.entrypoint !== 'string' || !/^\/[A-Za-z0-9._/-]{1,120}$/.test(d.entrypoint)) bad('entrypoint is an absolute path');
  if (!Array.isArray(d.args) || !d.args.every((a) => typeof a === 'string' && a.length <= 200 && !/[\0\n]/.test(a))) bad('args');
  if (!d.credentials || typeof d.credentials !== 'object' || !Object.entries(d.credentials).every(([k, v]) => ['api_key', 'username', 'password'].includes(k) && /^random_hex_(16|24|32)$|^fixed:[a-z][a-z0-9_-]{0,31}$/.test(v))) bad('credentials');
  if (!Array.isArray(d.env_prefixes) || !d.env_prefixes.length || !d.env_prefixes.every((p) => /^[A-Z][A-Z0-9]{1,30}_$/.test(p))) bad('env_prefixes are NAME_ prefixes');
  if (!d.health || !/^\/[A-Za-z0-9._/-]{0,100}$/.test(d.health.path ?? '')) bad('health.path');
  for (const k of ['seed', 'evidence']) if (typeof d[k] !== 'string' || !/^[a-z0-9-]{1,40}\.mjs$/.test(d[k]) || !existsSync(join(repo, dir, d[k]))) bad(`${k} names a script of this folder`);
  const addr = (a) => a && typeof a === 'object' && !Array.isArray(a) && Object.entries(a).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v));
  if (!addr(d.guard?.address) || !Object.keys(d.guard.address).length) bad('guard.address');
  if (!addr(d.fixture?.address) || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(d.fixture.id_key ?? '') || !/^[A-Za-z0-9_.-]{1,64}$/.test(d.fixture.id ?? '') || !/^[a-z][a-z0-9]{1,7}-[a-z0-9-]{1,50}$/.test(d.fixture.name ?? '')) bad('fixture');
  return d;
}

/** The allowlist: every stand-in with its image pinned by digest and its own folder read. */
export function loadStandins(file = STANDINS_FILE) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.format !== 'isokron-writecheck-standins/1' || !doc.stand_ins || typeof doc.stand_ins !== 'object') throw new Error(`${file}: not an isokron-writecheck-standins/1 file`);
  const out = {};
  for (const [id, s] of Object.entries(doc.stand_ins)) {
    const bad = (w) => { throw new Error(`stand_ins.${id}: ${w}`); };
    if (!ID_RE.test(id)) bad('the id is malformed');
    if (!FIDELITY.includes(s.fidelity)) bad(`fidelity is one of ${FIDELITY.join(', ')}`);
    if (!PINNED.test(s.image ?? '')) bad('the image is not pinned by digest');
    if (!s.backends || typeof s.backends !== 'object' || !Object.keys(s.backends).length || !Object.entries(s.backends).every(([b, k]) => ID_RE.test(b) && KINDS.includes(k))) bad('backends maps backend ids to kinds');
    if (!/^[0-9A-Za-z._ ()-]{1,80}$/.test(s.version ?? '')) bad('version');
    if (!/^loop\/full\/standins\/[a-z0-9-]{1,40}$/.test(s.dir ?? '')) bad('dir is loop/full/standins/<id>');
    out[id] = Object.freeze({ id, ...s, def: loadStandinDef(s.dir) });
  }
  return out;
}

/** The env names of a shard: a JSON list aligned with the items, each a list of names (contract: at most 20, distinct). */
export function parseEnvNames(text, n) {
  let list;
  try { list = JSON.parse(String(text ?? '')); } catch { return null; }
  if (!Array.isArray(list) || list.length !== n) return null;
  for (const names of list) {
    if (!Array.isArray(names) || names.length > MAX_ENV_PER_ITEM || !names.every((x) => typeof x === 'string' && ENV_NAME_RE.test(x)) || new Set(names).size !== names.length) return null;
  }
  return list;
}

/**
 * This repository's pull-request proof of full mode (loop-full-proof.yml) on a pull request from this repository: the
 * only place full mode runs with the switch off, and the only place a proof mutation (FULL_PROOF_MUTATION) is read.
 */
export function isFullProofLane(env = process.env) {
  return env.GITHUB_EVENT_NAME === 'pull_request' && env.GITHUB_REPOSITORY === 'isokron-ai/mcp-writecheck-action' && /^isokron-ai\/mcp-writecheck-action\/\.github\/workflows\/loop-full-proof\.yml@/.test(env.GITHUB_WORKFLOW_REF ?? '');
}

const skip = (stage, reason, fault, code, detail) => ({ stage, reason, fault, code, detail });

/**
 * The shard's mode, from its inputs. Returns one of:
 *   { mode: 'default' }                                    no mode inputs: the shard runs as before
 *   { mode: 'default', skip }                              mode inputs we refuse or do not run: a skip of ours for every item
 *   { mode: 'full', standIn, backend, backendKind, envNames, proofLane }
 * `skip` is { stage, reason, fault, code, detail }: stage `mode` (the inputs) or `full` (the switch is off: policy).
 */
export function shardMode(env, items, { standins = loadStandins(), proofLane = isFullProofLane(env) } = {}) {
  const v = Object.fromEntries(MODE_INPUTS.map((k) => [k, String(env[k] ?? '')]));
  if (MODE_INPUTS.every((k) => v[k] === '')) return { mode: 'default' };
  const refuse = (code, detail) => ({ mode: 'default', skip: skip('mode', 'unsupported_layout', 'tool', code, detail) });
  if (v.WC_MODE === 'min') return refuse('mode_not_wired', 'min mode is not wired into this worker yet (loop/min-mode.mjs, pull request 86); the shard ran as a default one');
  if (v.WC_MODE !== 'full') return refuse('not_allowlisted', 'mode is neither full nor min');
  if (!ID_RE.test(v.WC_BACKEND) || !ID_RE.test(v.WC_STAND_IN)) return refuse('not_allowlisted', 'the backend or stand-in id is malformed');
  if (!KINDS.includes(v.WC_BACKEND_KIND)) return refuse('not_allowlisted', 'backend_kind is not a kind of the contract');
  if (v.WC_SPEC_URL !== '' || v.WC_SPEC_FORMAT !== '') return refuse('not_allowlisted', 'a full shard names no spec');
  if (!Object.hasOwn(standins, v.WC_STAND_IN)) return refuse('not_allowlisted', `stand-in ${v.WC_STAND_IN} is not in loop/full/standins.json`);
  const s = standins[v.WC_STAND_IN];
  if (s.backends[v.WC_BACKEND] !== v.WC_BACKEND_KIND) return refuse('not_allowlisted', `stand-in ${s.id} does not serve backend ${v.WC_BACKEND} of kind ${v.WC_BACKEND_KIND}`);
  const envNames = parseEnvNames(v.WC_ENV_NAMES, items.length);
  if (!envNames) return refuse('bad_env_names', 'env_names is not a JSON list of name lists aligned with items');
  if (env.LANE_WRITECHECK_FULL_ENABLED !== 'true' && !proofLane) {
    return { mode: 'default', skip: skip('full', 'lane_disabled', 'policy', 'full_mode_off', 'LANE_WRITECHECK_FULL_ENABLED is not "true" in this repository; the shard ran as a default one') };
  }
  return { mode: 'full', standIn: s, backend: v.WC_BACKEND, backendKind: v.WC_BACKEND_KIND, envNames, proofLane };
}

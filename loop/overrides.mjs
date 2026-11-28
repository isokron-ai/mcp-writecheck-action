// What this lane supplies for a subject that its registry entry or the seed does not say (loop/launch-overrides.json), so the
// server starts at all, or the stable reason it is not testable here. Only Node's standard library.
//
// An exclusion names a reason the contract knows (tool-qa worker-kit SKIP_REASONS), a fault that is never the server's
// (policy: we chose not to run it, or our own limit) and a stable `code` that coverage can count separately. A launch
// override adds arguments, names another bin, or sets environment values that point at files of this repository under
// loop/sandbox/launch-files/, the tools volume's loop/ (mounted read-only at /opt/surface/loop/launch-files/): never a credential, never a host.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OVERRIDES_FORMAT = 'isokron-writecheck-launch-overrides/1';
export const LAUNCH_FILES_MOUNT = '/opt/surface/loop/launch-files';

/** Reasons an exclusion may use, with the faults each may carry here: never the server's. */
export const EXCLUDE_REASONS = Object.freeze({ policy_excluded: ['policy'], heavy_backend: ['policy'], no_local_backend: ['tool'], no_runnable_artifact: ['tool'] });
const CODE = /^[a-z][a-z0-9_]{2,63}$/;
const ARG = (s) => typeof s === 'string' && s.length > 0 && s.length <= 500 && !/[\u0000\n\r]/.test(s);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]{0,80}\/)?[a-z0-9][a-z0-9._~-]{0,120}$/;
const SUBJECT = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]{1,100}$/;


/** The value of `--name=value`, else the value itself. */
const valueOf = (v) => { const m = /^--?[A-Za-z0-9][A-Za-z0-9_-]*=(.*)$/s.exec(v); return m ? m[1] : v; };
const HOST = [
  /^[a-z][a-z0-9+.-]*:\/\//i,                                     // a URL
  /^[^\s/]+:\d{1,5}(?:\/|$)/,                                      // host:port
  /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/,                      // an IPv4 address
  /^(?:[A-Za-z0-9-]+\.)+(?:[A-Za-z]{2,}|xn--[a-z0-9-]+)(?::\d{1,5})?(?:\/.*)?$/, // a dotted hostname (a file name with an extension is a path, below, and has a slash)
  /^\[[0-9a-fA-F:]+\](?::\d{1,5})?$/,                              // an IPv6 address
  /^localhost(?::\d{1,5})?$/i,
];

/**
 * Why an args or env value is not allowed, or null. A value that looks like a path (absolute, or `--x=/...`) is normalised, must
 * have no `..`, and must lie inside the launch-files mount and name a file of this repository; a value that names a host (a URL,
 * host:port, an address, a dotted hostname) is refused. Anything else is a plain word (`serve`, `-t`, `stdio`).
 */
export function valueProblem(v, { root = join(here, 'sandbox', 'launch-files') } = {}) {
  const x = valueOf(v);
  if (x.split(/[\\/]/).includes('..')) return 'has a .. segment';
  if (!x.startsWith('/') && HOST.some((re) => re.test(x))) return 'names a host; values point at files of ours or are plain words';
  if (x.startsWith('/') || x.includes('/') || x.includes('\\')) {
    if (!x.startsWith('/')) return 'a relative path: say where it is';
    const n = posix.normalize(x);
    if (n !== x.replace(/\/+$/, '') && n !== x) return 'is not in normal form';
    if (!n.startsWith(`${LAUNCH_FILES_MOUNT}/`)) return `is a path outside ${LAUNCH_FILES_MOUNT}/`;
    if (!existsSync(join(root, n.slice(LAUNCH_FILES_MOUNT.length + 1)))) return 'is not a file of this repository';
    return null;
  }
  if (HOST.some((re) => re.test(x))) return 'names a host; values point at files of ours or are plain words';
  return null;
}

/** Parses and checks the file; returns Map(lower-case subject -> { exclude?, launch?, why }). */
export function loadOverrides(file = join(here, 'launch-overrides.json')) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (doc?.format !== OVERRIDES_FORMAT) throw new Error('launch-overrides: unknown format');
  const out = new Map();
  for (const [subject, o] of Object.entries(doc.subjects ?? {})) {
    const bad = (m) => { throw new Error(`launch-overrides ${subject}: ${m}`); };
    if (!SUBJECT.test(subject)) bad('the subject must be lower-case owner/name');
    if (typeof o?.why !== 'string' || o.why.length < 10) bad('say why');
    const keys = Object.keys(o).filter((k) => k !== 'why');
    if (keys.length !== 1 || !['exclude', 'launch'].includes(keys[0])) bad('exactly one of exclude or launch');
    if (o.exclude) {
      const x = o.exclude;
      if (!Object.hasOwn(EXCLUDE_REASONS, x.reason)) bad(`reason ${x.reason} is not one an exclusion may use`);
      if (!EXCLUDE_REASONS[x.reason].includes(x.fault)) bad(`fault ${x.fault} is not allowed for ${x.reason}`);
      if (typeof x.code !== 'string' || !CODE.test(x.code)) bad('code must be a stable snake_case word');
      if (Object.keys(x).some((k) => !['reason', 'fault', 'code'].includes(k))) bad('unknown exclude key');
    } else {
      const l = o.launch;
      if (Object.keys(l).some((k) => !['args', 'bin', 'env', 'install_scripts', 'kind', 'package'].includes(k))) bad('unknown launch key');
      if (l.args !== undefined && !(Array.isArray(l.args) && l.args.length <= 20 && l.args.every(ARG))) bad('args must be a short list of plain strings');
      if (l.bin !== undefined && !BIN.test(l.bin)) bad('bin is not a bin name');
      if (l.install_scripts !== undefined && l.install_scripts !== true) bad('install_scripts is true or absent');
      if ((l.kind === undefined) !== (l.package === undefined)) bad('kind and package come together');
      if (l.kind !== undefined && (l.kind !== 'npm' || !NPM_NAME.test(l.package))) bad('a launch we supply is an npm package');
      for (const [k, v] of Object.entries(l.env ?? {})) if (!ENV_NAME.test(k) || typeof v !== 'string' || !ARG(v)) bad(`env ${k} is not a name and a plain value`);
      // Every value that is a path, or names a host, is checked (R-WC-44).
      for (const v of [...(l.args ?? []), ...Object.values(l.env ?? {})]) {
        const why = valueProblem(v);
        if (why) bad(`${JSON.stringify(v)}: ${why}`);
      }
    }
    out.set(subject, o);
  }
  return out;
}

/** The skip of an excluded subject, in the shape resolveSubject answers, or null. */
export function exclusionFor(subject, overrides) {
  const x = overrides?.get(String(subject).toLowerCase())?.exclude;
  if (!x) return null;
  return { skip: { stage: 'install', reason: x.reason, fault: x.fault, detail: `not testable here (${x.code}): ${overrides.get(String(subject).toLowerCase()).why}`, not_testable: x.code } };
}

/** A launch this file supplies for a subject whose seed and registry give none (an npm package), in the shape resolveSubject answers, or null. */
export function providedLaunch(subject, overrides) {
  const l = overrides?.get(String(subject).toLowerCase())?.launch;
  if (!l?.kind) return null;
  return { fixture: null, launch: { kind: l.kind, package: l.package, version: 'latest' }, source: 'registry', package: `${l.kind}:${l.package}` };
}

/** The launch with this subject's override on top: its bin, its arguments after the registry's own or replacing them, its environment. */
export function applyLaunch(subject, launch, overrides) {
  const l = overrides?.get(String(subject).toLowerCase())?.launch;
  if (!l || !launch) return launch;
  const out = { ...launch };
  if (l.bin) out.bin = l.bin;
  if (l.install_scripts) out.install_scripts = true;
  if (l.args) out.args = [...l.args];
  if (l.env) out.env = { ...(launch.env ?? {}), ...l.env };
  return out;
}


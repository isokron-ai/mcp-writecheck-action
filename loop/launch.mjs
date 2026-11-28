// How the writecheck lane starts a subject that the seed gives no npm or PyPI package (WC14): its OCI image or its crate.
//
// The OCI image is chosen exactly as the live-probe lane chooses it: isokron-ai/mcp-check's own resolver
// (corpus/live-probe.mjs resolveSubject: the official MCP Registry entry of the subject or of its seed packages, the
// provenance check for an entry that only names the repository, the image's digest and size from its registry, the
// OCI host allowlist and the 2 GB cap), used as a library from a checkout at the commit tool-qa's live-probe lane runs
// (MCP_CHECK_REF, loop/prepare.sh). Its reasons for not running a subject, with their fault side and retryability,
// are its DETAILS table, so both lanes say the same thing about the same subject.
//
// A crate is a launch path of ours: neither that resolver nor mcp-surface-corpus's launchPlan has one. `cargo install`
// in a digest-pinned Rust image (loop/images.json), through the sandbox's allowlist proxy to index.crates.io and
// static.crates.io only, with --locked (the Cargo.lock the crate published, when it published one; without one cargo
// warns and resolves the dependencies afresh), into /work/pkg; the server is the binary
// loop/sandbox/cargo-entry.mjs picks from cargo's record of what it installed. A crate is tried only when the
// resolver gives no runnable package (an image is preferred: it is what the registry lists, and needs no build).
//
// Only Node's standard library; mcp-check is passed in, never imported here.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The names the driver takes from mcp-check's live-probe module; checked at load (as R-WC-02 does for the sandbox). */
export const MCK_MODULE = 'corpus/live-probe.mjs';
export const MCK_NEEDS = ['DETAILS', 'OCI_HOSTS', 'OCI_MAX_BYTES', 'resolveSubject'];

/** mcp-check's resolver from a checkout at a pinned commit; every name the lane uses must be exported there. */
export async function loadMck(dir) {
  const mod = await import(pathToFileURL(join(dir, MCK_MODULE)).href);
  const missing = MCK_NEEDS.filter((n) => mod[n] === undefined);
  if (missing.length) throw new Error(`mcp-check at this commit does not export ${missing.join(', ')}`);
  return { ...mod, dir };
}

/** Our own images, beside mcp-surface-corpus's (loop/images.json): pinned by the digest of the multi-platform index. */
export function loadImages(file = join(here, 'images.json')) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const out = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === 'about') continue;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(k) || typeof v !== 'string' || !/^docker\.io\/library\/[a-z0-9][a-z0-9._-]{0,40}:[A-Za-z0-9._-]{1,60}@sha256:[0-9a-f]{64}$/.test(v)) throw new Error(`loop/images.json: ${k.slice(0, 40)} must be an official image by tag and index digest`);
    out[k] = v;
  }
  return out;
}

const CRATE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CRATE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]{1,60})?$/;

/** The crates of a seed entry, in the seed's order, each name checked. */
export function seedCrates(entry) {
  return (entry?.packages ?? []).filter((p) => p?.registry === 'cargo' && typeof p.identifier === 'string' && CRATE.test(p.identifier)).map((p) => p.identifier);
}

/**
 * A subject with no npm or PyPI package in the seed: the live-probe lane's resolution, else its crate. Returns what
 * loop/items.mjs resolveSubject returns: { fixture: null, launch, source, package, choice? } or { skip }.
 *   entry  the subject's seed entry;  mck  loadMck's module;  fetch  for the resolver (the tests pass a fake)
 */
export async function resolveBeyondSeed(subject, entry, { mck, fetch = globalThis.fetch } = {}) {
  const crates = seedCrates(entry);
  const pkgs = (entry?.packages ?? []).filter((p) => p && typeof p.registry === 'string' && typeof p.identifier === 'string').slice(0, 20);
  const r = await mck.resolveSubject({ repo: subject }, { seed: new Map([[subject.toLowerCase(), pkgs]]), fetch });
  if (r.status === 'runnable' && r.launch) {
    // This lane starts stdio servers and runs the CLI against them; a streamable-HTTP launch is a gap of ours.
    if ((r.launch.transport ?? 'stdio') !== 'stdio') return crateOr(crates, { stage: 'install', reason: 'unsupported_transport', fault: 'tool', detail: 'the runnable package is offered over streamable HTTP only; this lane starts stdio servers' });
    const l = r.launch;
    // A Go repository built at its commit (live-probe R-LP-91) has a package path, not a package name.
    const pkg = l.kind === 'docker' ? `oci:${/@sha256:([0-9a-f]{64})$/.exec(l.image)?.[1] ?? 'unpinned'}` : l.kind === 'go' ? `go:${l.module}` : `${l.kind}:${l.package}`;
    return { fixture: null, launch: l, source: 'registry', package: pkg, choice: { type: r.choice?.type ?? null, matched_by: r.choice?.matched_by ?? null, verified_by: r.choice?.verified_by ?? null, oci_bytes: Number.isSafeInteger(r.choice?.oci_bytes) ? r.choice.oci_bytes : null } };
  }
  const d = mck.DETAILS[r.detail] ?? mck.DETAILS.upstream_error;
  const [reason, retryable, , fault] = d;
  // A passing failure of the registry or of an image host: retried later, never replaced by a build.
  if (retryable) return { skip: { stage: 'install', reason, fault, retryable: true, detail: `the live-probe resolver could not finish (${r.detail})` } };
  return crateOr(crates, { stage: 'install', reason, fault, detail: `the live-probe resolver gave no runnable package (${r.detail})${crates.length ? '' : '; no crate in the seed either'}` });
}

function crateOr(crates, skip) {
  if (!crates.length) return { skip };
  return { fixture: null, launch: { kind: 'cargo', crate: crates[0], version: 'latest' }, source: 'seed', package: `cargo:${crates[0]}`, choice: { type: 'cargo', instead_of: skip.reason } };
}

/** In-container paths (the same as the driver's). */
const TOOLS = '/opt/surface';
const NODE = `${TOOLS}/node/node`;

/**
 * The launch plan of a crate, in the shape of mcp-surface-corpus's launchPlan: the install image (our Rust image, a
 * build image: MS.build applies), the registries the proxy lets the install reach, the install steps, and the server
 * command. The build's own folders (target, cargo home) are removed after the entry is found, so only the binary is
 * left in the volume the server's container mounts.
 */
export function cargoPlan(l) {
  if (l?.kind !== 'cargo' || !CRATE.test(l.crate ?? '') || !(l.version === 'latest' || CRATE_VERSION.test(l.version ?? ''))) throw new Error('a cargo launch is { kind: "cargo", crate, version: "latest" | x.y.z }');
  const args = Array.isArray(l.args) ? l.args : [];
  return {
    image: 'rust-build',
    runImage: 'rust-build',
    registries: ['index.crates.io', 'static.crates.io'],
    install: [
      {
        name: 'install',
        cmd: ['cargo', 'install', '--locked', '--root', '/work/pkg', ...(l.version === 'latest' ? [] : ['--version', l.version]), '--', l.crate],
        env: { CARGO_HOME: '/work/cargo-home', CARGO_TARGET_DIR: '/work/target', CARGO_TERM_COLOR: 'never', CARGO_TERM_PROGRESS_WHEN: 'never', CARGO_BUILD_JOBS: '2', CARGO_NET_RETRY: '2', CARGO_HTTP_TIMEOUT: '60', CARGO_REGISTRIES_CRATES_IO_PROTOCOL: 'sparse', CARGO_INCREMENTAL: '0' },
      },
      { name: 'entry', cmd: [NODE, `${TOOLS}/loop/cargo-entry.mjs`, '/work/pkg', l.crate], out: 'entry.json' },
      { name: 'clean', cmd: ['rm', '-rf', '/work/target', '/work/cargo-home'] },
    ],
    run: (entry) => [entry.script, ...args],
  };
}

const ARG = (s) => typeof s === 'string' && s.length > 0 && s.length <= 2000 && !/[\u0000\n\r]/.test(s);

/** At most this many VOLUME paths in an image: each is a writable anonymous volume despite the read-only root (R-WC-39). */
export const MAX_IMAGE_VOLUMES = 3;
/** Loader variables an image may set that would load code into our bridge; msc never lets us empty LD_ names (R-WC-37). */
const LOADER_ENV = /^(?:LD_PRELOAD|LD_AUDIT)$/;
/**
 * Variables of the image emptied for the bridge only (R-WC-37): they change how Node, OpenSSL or glibc start, so an
 * image setting one could stop our bridge. The server gets the image's own values back (ociServer env).
 */
export const BRIDGE_ENV_EMPTY = Object.freeze({ NODE_OPTIONS: '', NODE_PATH: '', NODE_EXTRA_CA_CERTS: '', OPENSSL_CONF: '', OPENSSL_MODULES: '', GCONV_PATH: '', GLIBC_TUNABLES: '', MALLOC_CONF: '' });

/**
 * The server command of an OCI image, as `docker run <image> [args]` would start it: the image's Entrypoint, then the
 * launch's args or else the image's Cmd (Docker drops the image's Cmd when the entrypoint is replaced). `config` is
 * `docker image inspect` .Config, the image's own data, checked here: at most 60 strings of one line each, a working
 * folder that is an absolute path, its environment (Env: NAME=value lines) and its VOLUME paths. Returns
 * { cmd, workdir, env, volumes } or { error }:
 *   image_config_unreadable  a field is not what Docker writes
 *   image_has_no_command     neither Entrypoint nor Cmd (the subject's)
 *   image_env_loader         the image sets LD_PRELOAD or LD_AUDIT, which we cannot empty for the bridge (ours)
 *   image_volumes            more than MAX_IMAGE_VOLUMES VOLUME paths (ours: we do not give it that much writable disk)
 */
export function ociServer(config, launch = {}) {
  const list = (v) => (v === null || v === undefined ? [] : Array.isArray(v) && v.length <= 60 && v.every(ARG) ? v : null);
  const ep = launch.entrypoint ? [launch.entrypoint] : list(config?.Entrypoint);
  const imgCmd = list(config?.Cmd);
  const args = list(launch.args);
  if (ep === null || imgCmd === null || args === null) return { error: 'image_config_unreadable' };
  const env = {};
  const rawEnv = config?.Env ?? [];
  if (!Array.isArray(rawEnv) || rawEnv.length > 100) return { error: 'image_config_unreadable' };
  for (const line of rawEnv) {
    const m = typeof line === 'string' && line.length <= 8192 && !/[\u0000\n\r]/.test(line) ? /^([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/s.exec(line) : null;
    if (!m) return { error: 'image_config_unreadable' };
    env[m[1]] = m[2];
  }
  if (Object.keys(env).some((k) => LOADER_ENV.test(k) && env[k] !== '')) return { error: 'image_env_loader' };
  const vols = config?.Volumes ?? {};
  if (!vols || typeof vols !== 'object' || Array.isArray(vols)) return { error: 'image_config_unreadable' };
  const volumes = Object.keys(vols).length;
  if (volumes > MAX_IMAGE_VOLUMES) return { error: 'image_volumes', volumes };
  const cmd = [...ep, ...(args.length ? args : launch.entrypoint ? [] : imgCmd)];
  if (cmd.length === 0) return { error: 'image_has_no_command' };
  if (cmd.length > 60) return { error: 'image_config_unreadable' };
  const wd = typeof config?.WorkingDir === 'string' && /^\/[A-Za-z0-9._/@+-]{0,200}$/.test(config.WorkingDir) && !/(^|\/)\.\.?(\/|$)/.test(config.WorkingDir) ? config.WorkingDir : '/';
  return { cmd, workdir: wd, env, volumes };
}

/**
 * The OCI checks live-probe makes before a pull (mcp-check R-LP-16; R-WC-38), made again here on what the resolver returned: the
 * image's host is one of mcp-check's OCI_HOSTS, its size as its registry gave it is at most OCI_MAX_BYTES, and Docker's
 * data root has room for it (four times its compressed size). Returns null or a skip.
 */
export function ociPullProblem({ image, bytes, freeBytes }, mck) {
  const host = String(image ?? '').split('/')[0];
  if (!mck.OCI_HOSTS.includes(host)) return { stage: 'install', reason: 'no_runnable_artifact', fault: 'tool', detail: 'the image is not on an OCI host this lane pulls from (oci_host_not_allowed)' };
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { stage: 'install', reason: 'no_runnable_artifact', fault: 'tool', detail: 'the resolver gave no image size (image_size_unknown)' };
  if (bytes > mck.OCI_MAX_BYTES) return { stage: 'install', reason: 'too_large', fault: 'tool', detail: 'over the 2 GB image cap (image_too_large)' };
  if (Number.isSafeInteger(freeBytes) && freeBytes < 4 * bytes) return { stage: 'install', reason: 'upstream_unavailable', fault: 'infra', retryable: true, detail: "Docker's data root has too little room for the image now (disk_low)" };
  return null;
}

/** The unpacked size cap of a pulled image (`docker image inspect` .Size): three times the compressed cap. */
export const OCI_MAX_UNPACKED = (mck) => 3 * mck.OCI_MAX_BYTES;

/**
 * The environment a registry launch declares (mcp-check packageEnv: required names, null for "make a dummy"), as the
 * server's environment: each null filled with mcp-surface-corpus's dummy value for the name, and only names and values
 * the sandbox passes to a target (targetEnvProblems), at most 60.
 */
export function launchEnv(launch, { dummyValue, targetEnvProblems }) {
  const out = {};
  for (const [k, v] of Object.entries(launch?.env ?? {}).slice(0, 60)) {
    const val = typeof v === 'string' ? v : dummyValue(k);
    if (targetEnvProblems({ [k]: val }).length === 0) out[k] = val;
  }
  return out;
}

/**
 * The command of the bridge in a server container whose image is not one of ours (an OCI subject): Node and the bridge
 * from the read-only tools volume, run through the glibc loader and libraries copied there from our Node image
 * (`rt/`), so it starts in any Linux image (Alpine's musl, distroless, scratch) and sets no LD_ variable for the server
 * it spawns. The bridge is not a trust boundary: it runs inside the subject's own filesystem and sandbox, and the only
 * thing that rests on it is that the server's stdio reaches the CLI. `serverEnv` (the image's own environment with
 * ours on top) goes to the server alone; the container's environment empties BRIDGE_ENV_EMPTY for the bridge.
 * Returns { entrypoint, cmd } for sandboxRunArgs.
 */
export function portableBridge({ loader, port, serverCmd, serverEnv = null }) {
  if (!/^ld-linux-[a-z0-9_-]{1,20}\.so\.[0-9]$/.test(loader ?? '')) throw new Error('the loader is not a glibc loader name');
  const env = serverEnv ? ['--env', Buffer.from(JSON.stringify(serverEnv)).toString('base64')] : [];
  return { entrypoint: `${TOOLS}/rt/${loader}`, cmd: ['--library-path', `${TOOLS}/rt`, NODE, `${TOOLS}/loop/bridge.mjs`, String(port), ...env, '--', ...serverCmd] };
}

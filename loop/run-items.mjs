#!/usr/bin/env node
/**
 * The writecheck loop worker's driver: one shard of items from tool-qa's pump, each run through mcp-writecheck in
 * the hardened sandbox of isokron-ai/mcp-surface-corpus, with one result bundle per item.
 *
 *   node loop/run-items.mjs --msc <mcp-surface-corpus checkout> --cli <built packages/writecheck>
 *                           --seed <tool-qa history/seed-v1.json> --out <dir> [--lane ci|local] [--mck <mcp-check checkout>]
 *   env: ITEMS, ATTEMPT_ID, SHARD_ID (the dispatch inputs), CLI_REF, SANDBOX_REF, MCP_CHECK_REF (with --mck), ACTION_SHA (the commit checked out), GITHUB_OUTPUT
 *
 * The sandbox is mcp-surface-corpus's, used as a library from a checkout at a pinned commit (src/docker.mjs,
 * src/sandbox-run.mjs, src/sandbox-net.mjs, src/runsc.mjs, src/telemetry.mjs, src/targets.mjs and its sandbox/
 * helpers): gVisor (runsc) for every container, user 65534, every capability dropped, a read-only root, limits,
 * named volumes only, an environment of the names the harness sets, an install network whose only way out is the
 * allowlist proxy to the package registry, and a run network with no way out at all (every name resolves to the
 * network logger; the host firewall logs and drops the rest). The workflow runs its self test first.
 *
 * Per item: the subject is mapped to a package (loop/items.mjs; an OCI image or a crate through loop/launch.mjs,
 * WC14: an OCI subject's own image is its server container, with our bridge started through the portable runtime in
 * the tools volume), installed in the sandbox, and the CLI runs in
 * the sandbox next to the server it starts, on the run network: init (tools/list), plan (no tool call) and
 * catalog (tools/list only, MWS-ANN-4). For IsoKron's own fixture servers (loop/fixtures.json) whose plan hash a
 * person accepted, also the full write test, against a disposable backend inside the same container. Nothing
 * reaches a real external system: the run network has no egress, and a third-party server is never given a
 * manifest that writes.
 *
 * Controls, once per shard before any item, and copied into every bundle: the forgery control
 * (loop/sandbox/forgery-server.mjs) must come out "contained"; tiny-tracker with a known defect must have its
 * defect detected (known_bad), and without it the same requirement must hold (known_good). If a control fails the
 * driver exits 1 and writes no bundle: nothing is uploaded.
 *
 * Output: <out>/<i>/bundle/ and <out>/<i>/meta.json for every item, and has_<i>, fence_<i>, run_key_<i> in
 * GITHUB_OUTPUT. The log prints positions and codes only, never a subject's output.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { arch, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lookup } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

import { FIXTURE_MANIFEST, InputError, catalogManifest, checkId, isProofLane, loadFixtures, loadSeed, parseItems, resolveSubject } from './items.mjs';
import { ndjson, observations, planHash, publicSummary, summarize } from './summary.mjs';
import { dockerPlatform, extractBinaryImage } from './binary-image.mjs';
import { entryErrorCode, itemSkips, stagesRan } from './skips.mjs';
import { BRIDGE_ENV_EMPTY, OCI_MAX_UNPACKED, cargoPlan, launchEnv, loadImages, loadMck, ociPullProblem, ociServer, portableBridge, resolveBeyondSeed } from './launch.mjs';
import { BundleFiles, buildMeta, forgeryVerdict, knownBadVerdict, knownGoodVerdict, parseCollected, safeRawPath } from './bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const say = (line) => process.stdout.write(`${line}\n`);

const TOOLS = '/opt/surface';
const NODE = `${TOOLS}/node/node`;
const CLI_MAIN = `${TOOLS}/wc/dist/src/cli/main.js`;
const LOOP = `${TOOLS}/loop`;
const OUTD = '/work/out';
const MANIFEST = `${OUTD}/writecheck.yaml`;
const PROXY_PORT = 8080;
/** The bridge's port in the server's container (split runs). */
const BRIDGE_PORT = 7300;
const MS = { build: 900_000, install: 300_000, setup: 120_000, step: 150_000, full: 900_000, helper: 120_000, pull: 600_000 };
/**
 * No item starts after this long from t0 (set before the controls run). With up to ~15 min before t0 (checkout,
 * guard, CLI build, image pulls), ITEM_GRACE_MS plus a few minutes of host-side overhang after the deadline, and
 * ~5 min of teardown and sealing, a shard ends inside the job's 50-minute timeout-minutes and the pump's lease of
 * 1.5 x (12 + 10 x 2) + 10 = 58 minutes (tool-qa pump/workflows.json writecheck setup_minutes 12). R-WC-13.
 */
export const SHARD_BUDGET_MS = Number(process.env.LOOP_SHARD_BUDGET_S || 20 * 60) * 1000;
// How far past the shard deadline the item already running may go (was 15 min, which could outlast the job).
export const ITEM_GRACE_MS = 5 * 60_000;
const COLLECT = { file: 4 * 1024 * 1024, total: 24 * 1024 * 1024, entries: 2000 };
/** Each control's captured bytes, copied into every bundle of the shard, stay small. */
const CONTROL_RAW = { fileCap: 1024 * 1024, totalCap: 3 * 1024 * 1024 };

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
/**
 * Copies Node's shared libraries and the glibc loader (as `ldd` lists them in our Node image) into the tools volume's
 * rt/, and prints the folder's file names. WC14: the bridge in an OCI subject's image starts through them.
 */
export const RT_SCRIPT = `set -e; mkdir -p ${TOOLS}/rt; for f in $(ldd /usr/local/bin/node | awk '/=>/ {print $3} !/=>/ {print $1}' | grep '^/'); do cp -L "$f" ${TOOLS}/rt/; done; chmod -R a+rX,go-w ${TOOLS}/rt; ls ${TOOLS}/rt`;
/** The loader's file name among rt/'s files (RT_SCRIPT's output), or null when there is not exactly one, or libc is missing. */
export function portableLoader(listing) {
  const names = String(listing).split('\n').map((x) => x.trim()).filter(Boolean);
  const loaders = names.filter((n) => /^ld-linux-[a-z0-9_-]{1,20}\.so\.[0-9]$/.test(n));
  return loaders.length === 1 && names.includes('libc.so.6') ? loaders[0] : null;
}

/** The folders of mcp-surface-corpus that go into the tools volume: its in-container helpers and what they import. */
export const MSC_TOOL_DIRS = ['sandbox', 'src'];

/**
 * Relative imports of the .mjs files under `dir` (the staged tools volume) that name a file not there, as
 * "<importer> -> <specifier>". R-WC-01: the network logger imports ../src/dns.mjs, and a volume without src/ made
 * every unit fail at the logger's start.
 */
export function missingImports(dir) {
  const out = [];
  const walk = (abs) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const spec = m[1] ?? m[2];
        if (!existsSync(resolve(dirname(p), spec))) out.push(`${relative(dir, p)} -> ${spec}`);
      }
    }
  };
  walk(dir);
  return out;
}
const json = (v) => `${JSON.stringify(v, null, 2)}\n`;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function parseArgs(argv) {
  const o = { lane: 'local' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!['--msc', '--cli', '--seed', '--out', '--lane', '--fixtures', '--mck'].includes(k) || v === undefined) throw new InputError(`unknown or incomplete argument ${k}`);
    o[k.slice(2)] = v; i++;
  }
  for (const k of ['msc', 'cli', 'seed', 'out']) if (!o[k]) throw new InputError(`--${k} is required`);
  if (!['ci', 'local'].includes(o.lane)) throw new InputError('--lane is ci or local');
  o.fixtures ??= join(here, 'fixtures.json');
  return o;
}

/** The modules of mcp-surface-corpus the driver uses, and every name it takes from them (R-WC-02). */
export const MSC_MODULES = ['src/docker.mjs', 'src/sandbox-run.mjs', 'src/sandbox-net.mjs', 'src/sandbox-env.mjs', 'src/runsc.mjs', 'src/telemetry.mjs', 'src/targets.mjs', 'src/env-refs.mjs'];
export const MSC_NEEDS = [
  'Docker', 'HarnessError', 'LIMITS', 'NETS', 'RUNTIME', 'Telemetry', 'checkDockerVersion', 'checkPinned', 'dummyValue', 'fromProxy', 'helperRunArgs',
  'hostDropsFor', 'isPublicIp4', 'NATIVE_BUILD_ENV', 'jsonLines', 'launchPlan', 'loadRunscConfig', 'preflight', 'readHostLog', 'rolesOn', 'sandboxRunArgs',
  'settingsDigest', 'settingsManifest', 'startNetlogOn', 'stopNetlog', 'sweepTraces', 'takeTrace', 'targetEnvProblems', 'watchTraces', 'writeDrops', 'writeNetlog',
];

/** mcp-surface-corpus's sandbox library, from a checkout at a pinned commit; every name the driver uses must be there. */
async function loadMsc(dir) {
  const mods = await Promise.all(MSC_MODULES.map((p) => import(pathToFileURL(join(dir, p)).href)));
  const M = Object.assign({}, ...mods);
  const missing = MSC_NEEDS.filter((n) => M[n] === undefined);
  if (missing.length) throw new Error(`mcp-surface-corpus at this commit does not export ${missing.join(', ')}`);
  return { ...M, dir, images: JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8')) };
}

/** A server's environment: what the unit adds, under ours (HOME, TMPDIR, SURFACE_SANDBOX and the rest are never a target's to set). */
export const runEnv = (extra = {}) => ({ ...extra, HOME: '/tmp/home', TMPDIR: '/tmp', NO_COLOR: '1', DO_NOT_TRACK: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', npm_config_update_notifier: 'false', SURFACE_SANDBOX: '1' });

export class Shard {
  constructor({ o, M, env }) {
    this.o = o; this.M = M; this.env = env;
    this.runId = randomBytes(6).toString('hex');
    this.out = resolve(o.out);
    this.shardDir = join(this.out, '_shard');
    mkdirSync(join(this.shardDir, 'cid'), { recursive: true });
    this.cidDir = join(this.shardDir, 'cid');
    this.cfg = M.loadRunscConfig(join(M.dir, 'gvisor.json'));
    this.dk = new M.Docker({ runId: this.runId, log: join(this.shardDir, 'docker.log') });
    this.tel = new M.Telemetry(join(this.shardDir, 'telemetry.jsonl'), { run: this.runId });
    this.missing = null;
    this.hostLog = false;
  }

  name(tag, what) { return this.dk.name(tag, what); }

  writeSettings(argv, meta) {
    const manifest = this.M.settingsManifest(argv, { role: meta.role });
    this.tel.write('settings', { digest: this.M.settingsDigest(manifest), manifest }, meta);
  }

  /** A target container's `container` record and its trace summary (or a trace_unavailable skip). */
  async recordContainer({ id, t0, exit = null, signal = null, timedOut = false, meta }) {
    const summary = id ? await this.M.takeTrace(this.cfg, id, { waitMs: 5000 }) : null;
    this.tel.write('container', { runtime: summary ? this.M.RUNTIME : 'unknown', exit: Number.isInteger(exit) ? exit : null, signal: signal ? String(signal).slice(0, 20) : null, timed_out: !!timedOut, oom_killed: null, ms: Date.now() - t0 }, meta);
    if (summary) {
      if (!this.tel.tryWrite('trace_summary', { summary }, { source: 'runsc', ...meta })) this.missing?.push(`a syscall trace record (${meta.role})`);
    } else {
      this.tel.write('skip', { reason: 'trace_unavailable', detail: 'runsc wrote no syscall trace for this container' }, meta);
      this.missing?.push(`a syscall trace (${meta.role})`);
    }
  }

  recordDrops(t0, subject) {
    if (!this.hostLog) return false;
    const log = this.M.readHostLog(Math.floor(t0 / 1000) - 1);
    if (!log.ok) { this.tel.write('skip', { reason: 'host_log_unavailable', detail: 'the kernel log could not be read for this unit' }, { subject }); return false; }
    this.M.writeDrops(this.tel, this.M.hostDropsFor(log.text, { since: t0 / 1000, until: Date.now() / 1000 }), { subject, roles: { ...this.M.rolesOn('install'), ...this.M.rolesOn('run') } });
    return true;
  }

  readCid(file) { try { const s = readFileSync(file, 'utf8').trim(); return /^[0-9a-f]{64}$/.test(s) ? s : null; } catch { return null; } }

  async prepare() {
    const v = await this.dk.d(['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], { keepStdout: true });
    if (v.exit !== 0) throw new this.M.HarnessError('docker is not available');
    const [ver, osArch] = v.stdout.toString().trim().split(' ');
    this.M.checkDockerVersion(ver);
    if (!String(osArch).startsWith('linux/')) throw new this.M.HarnessError('containers must be Linux');
    const ncpu = Number((await this.dk.d(['info', '--format', '{{.NCPU}}'], { keepStdout: true, logStdout: false })).stdout.toString().trim());
    this.cpus = Number.isInteger(ncpu) && ncpu >= 1 ? Math.min(this.M.LIMITS.cpus, ncpu) : 1;
    // Docker's data root, for the room an OCI subject's image needs (R-WC-38).
    const root = (await this.dk.d(['info', '--format', '{{.DockerRootDir}}'], { keepStdout: true, logStdout: false })).stdout.toString().trim();
    this.dockerRoot = /^\/[A-Za-z0-9._/-]{1,200}$/.test(root) ? root : null;
    // Our own images (loop/images.json: the Rust toolchain for crates, WC14) beside the sandbox's; a key of ours never
    // replaces one of mcp-surface-corpus's.
    const ours = loadImages();
    for (const k of Object.keys(ours)) if (Object.hasOwn(this.M.images, k)) throw new this.M.HarnessError(`loop/images.json names ${k}, an image key of mcp-surface-corpus`);
    this.images = { ...this.M.images, ...ours };
    for (const k of ['node24', 'node22', 'node24-build', 'node22-build', 'python', ...Object.keys(ours)]) this.M.checkPinned(this.images[k], k);
    await this.dk.image(this.images.node24, 'node24');
  }

  async preflight() {
    const pf = await this.M.preflight(this.dk, {
      cfg: this.cfg, arch: arch(), image: this.images.node24, cmd: ['node', '-e', 'console.log(process.getuid(), process.getgid())'], expect: '65534 65534',
      tel: this.tel, labels: this.dk.labels(), needHostLog: this.o.lane === 'ci', strict: this.o.lane === 'ci',
    });
    if (!pf.ok) throw new this.M.HarnessError(`the sandbox is not there (${pf.reason})`);
    this.hostLog = pf.hostLog;
  }

  /** Our in-container code (mcp-surface-corpus's sandbox/ helpers, loop/sandbox/, the CLI) and Node, read-only everywhere. */
  async prepareTools() {
    this.toolsVol = await this.dk.volume(`surface-${this.runId}-tools`);
    const stage = mkdtempSync(join(tmpdir(), 'wc-tools-'));
    try {
      // mcp-surface-corpus's helpers (the network logger, the egress proxy, the npm entry reader) import its src/.
      for (const d of MSC_TOOL_DIRS) cpSync(join(this.M.dir, d), join(stage, d), { recursive: true });
      cpSync(join(here, 'sandbox'), join(stage, 'loop'), { recursive: true });
      mkdirSync(join(stage, 'wc', 'node_modules'), { recursive: true });
      cpSync(join(this.o.cli, 'dist'), join(stage, 'wc', 'dist'), { recursive: true });
      cpSync(join(this.o.cli, 'package.json'), join(stage, 'wc', 'package.json'));
      cpSync(join(this.o.cli, 'node_modules', 'yaml'), join(stage, 'wc', 'node_modules', 'yaml'), { recursive: true });
      const unresolved = missingImports(stage);
      if (unresolved.length) throw new this.M.HarnessError(`the tools volume would miss what its code imports: ${unresolved.slice(0, 5).join(', ')}`);
      const tar = spawnSync('tar', ['-C', stage, '-cf', '-', '--owner=0', '--group=0', '--mode=a+rX,go-w', ...MSC_TOOL_DIRS, 'loop', 'wc'], { maxBuffer: 256 * 1024 * 1024 });
      if (tar.status !== 0) throw new this.M.HarnessError('packing the tools failed');
      this.toolsSha = sha256(tar.stdout);
      await this.dk.must(this.dk.d(this.M.helperRunArgs({ name: this.name(null, 'h'), image: this.images.node24, user: '0:0', labels: this.dk.labels(), stdin: true, mounts: [{ src: this.toolsVol, dst: TOOLS }], cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', TOOLS] }), { input: tar.stdout, deadline: Date.now() + MS.helper }), 'tools volume');
    } finally { rmSync(stage, { recursive: true, force: true }); }
    // Node for the CLI in every image (the PyPI image has none): the node24 image's own binary. Both images are
    // Debian 12 with libstdc++, which is all it links against.
    await this.dk.must(this.dk.d(this.M.helperRunArgs({ name: this.name(null, 'h'), image: this.images.node24, user: '0:0', labels: this.dk.labels(), mounts: [{ src: this.toolsVol, dst: TOOLS }], cmd: ['sh', '-c', `mkdir -p ${TOOLS}/node && cp /usr/local/bin/node ${NODE} && chmod 0555 ${NODE}`] }), { deadline: Date.now() + MS.helper }), 'node for the CLI');
    // WC14: the bridge in an OCI subject's own image runs this Node through the glibc loader and the libraries it links,
    // copied from the same image into rt/ (loop/launch.mjs portableBridge): any Linux image can start it, musl or none.
    const rt = await this.dk.d(this.M.helperRunArgs({ name: this.name(null, 'h'), image: this.images.node24, user: '0:0', labels: this.dk.labels(), mounts: [{ src: this.toolsVol, dst: TOOLS }], cmd: ['sh', '-c', RT_SCRIPT] }), { deadline: Date.now() + MS.helper, keepStdout: true, logStdout: false, cap: 64 * 1024 });
    this.loader = rt.exit === 0 ? portableLoader(rt.stdout.toString('utf8')) : null;
    this.outNet = await this.dk.network(`surface-${this.runId}-out`, false);
  }

  async resolveRegistries(names) {
    const out = [];
    for (const n of names) {
      let addrs = [];
      try { addrs = (await lookup(n, { all: true, family: 4 })).map((a) => a.address); } catch { /* reported below */ }
      const pub = [...new Set(addrs.filter(this.M.isPublicIp4))].slice(0, 8);
      if (!pub.length) throw new this.M.HarnessError(`the registry ${String(n).slice(0, 60)} has no public IPv4 address`);
      out.push(...pub.map((ip) => [n, ip]));
    }
    return out;
  }

  /** A helper container of ours (never target code): node24 image, no network unless named. */
  helper(tag, o, opts = {}) {
    return this.dk.d(this.M.helperRunArgs({ name: this.name(tag, 'h'), image: this.images.node24, labels: this.dk.labels(tag), cpus: this.cpus, ...o }), { deadline: Date.now() + MS.helper, ...opts });
  }

  /**
   * Install one launch block in the sandbox (mcp-surface-corpus's install path): the install network with the
   * network logger at .2 and the allowlist proxy at .3 as its only way out, the install container at .4.
   */
  async install(u, work, deadline) {
    const M = this.M;
    // A crate's plan is ours (loop/launch.mjs, WC14); every other kind is mcp-surface-corpus's launchPlan.
    const plan = u.launch.kind === 'cargo' ? cargoPlan(u.launch) : M.launchPlan(u.launch);
    if (u.lock) {
      // A fixture installs from its committed lockfile (loop/fixtures/<name>/), every tarball checked against the
      // lock's integrity by npm ci; the package itself must match the integrity pinned in loop/fixtures.json.
      // A source fixture (WC12) is the committed folder itself: its package.json, lockfile and src/ (never a node_modules).
      const tar = spawnSync('tar', ['-C', u.lock, '-cf', '-', '--owner=0', '--group=0', 'package.json', 'package-lock.json', ...(u.source ? ['src'] : [])], { maxBuffer: 16 * 1024 * 1024 });
      if (tar.status !== 0) throw new M.HarnessError('packing the fixture lockfile failed');
      await this.dk.must(this.helper(u.tag, { stdin: true, mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'mkdir -p /work/pkg && tar -x -f - --no-same-owner -C /work/pkg'] }, { input: tar.stdout }), 'fixture lockfile');
      // R-WC-09: with install scripts on, the same build as the sandbox's own npm install: launchPlan put it in the
      // build image (node24-build) and the step carries NATIVE_BUILD_ENV, so a native module compiles from source
      // against the image's Node headers and nothing is fetched from outside registry.npmjs.org.
      const native = u.launch.install_scripts === true;
      if (native && (!/-build$/.test(plan.image) || !plan.runImage)) throw new M.HarnessError('a fixture with install scripts must install in the build image');
      plan.install = [
        { name: 'install', cmd: ['npm', 'ci', '--prefix', '/work/pkg', '--no-audit', '--no-fund', '--loglevel=error', '--omit=dev', ...(native ? [] : ['--ignore-scripts'])], ...(native ? { env: { ...M.NATIVE_BUILD_ENV } } : {}) },
        // A source fixture's entry is the file its fixtures.json entry names, inside the folder it just installed.
        ...(u.source ? [] : [{ name: 'entry', cmd: ['node', `${TOOLS}/sandbox/npm-entry.mjs`, '/work/pkg', u.launch.package, u.launch.bin ?? ''], out: 'entry.json' }]),
      ];
    }
    const image = this.images[plan.image];
    await this.dk.image(image, plan.image);
    // R-WC-31: whether code of the package could run during the install (npm lifecycle scripts), so its output may say
    // anything; and the package asked for, so pip's "no matching distribution" can be checked to be about it.
    const scripts = u.launch.kind === 'npm' ? !plan.install.some((st) => st.name === 'install' && st.cmd.includes('--ignore-scripts')) : null;
    const inst = { kind: u.launch.kind, steps: [], ok: false, image: plan.image, resolved_version: null, egress: [], ...(scripts === null ? {} : { scripts }), ...(typeof u.launch.package === 'string' ? { package: u.launch.package } : typeof u.launch.crate === 'string' ? { package: u.launch.crate } : {}) };
    const registries = [...plan.registries];
    const inNet = await this.dk.network(`surface-${this.runId}-${u.tag}-in`, true, u.tag, { sandbox: 'install' });
    const netlog = await M.startNetlogOn(u.tdk, { net: 'install', network: inNet, image: this.images.node24, toolsVol: this.toolsVol, labels: this.dk.labels(u.tag), target: u.tag });
    const proxy = this.name(u.tag, 'proxy');
    let proxyUp = false;
    let entry = u.source ? { script: `/work/pkg/${u.source.bin}`, version: u.launch.version } : null;
    try {
      const publicHosts = await this.resolveRegistries(registries);
      const proxyArgs = M.helperRunArgs({ name: proxy, image: this.images.node24, network: this.outNet, create: true, labels: this.dk.labels(u.tag), memory: '256m', publicHosts, mounts: [{ src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${TOOLS}/sandbox/egress-proxy.mjs`, String(PROXY_PORT), ...registries] });
      this.writeSettings(proxyArgs, { subject: u.tag, role: 'proxy' });
      await this.dk.must(u.tdk.d(proxyArgs), 'egress proxy');
      proxyUp = true;
      await this.dk.must(u.tdk.d(['network', 'connect', '--ip', M.NETS.install.proxy, inNet, proxy]), 'egress proxy network');
      await this.dk.must(u.tdk.d(['start', proxy]), 'egress proxy start');
      for (let until = Date.now() + 30_000; ;) {
        const pl = await u.tdk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
        if (M.jsonLines(pl.stdout).some((x) => Number.isInteger(x.listening))) break;
        if (Date.now() >= until) throw new M.HarnessError('the egress proxy did not start');
        await sleep(250);
      }
      const proxyUrl = `http://${M.NETS.install.proxy}:${PROXY_PORT}`;
      let ok = true;
      for (const step of plan.install) {
        if (Date.now() >= deadline) { ok = false; inst.timed_out = true; break; }
        const s1 = Date.now();
        const name = this.name(u.tag, 'i');
        const cidfile = join(this.cidDir, `${name}.cid`);
        const env = {
          HOME: '/work/home', TMPDIR: '/tmp', NO_COLOR: '1', DO_NOT_TRACK: '1', SURFACE_SANDBOX: '1', CI: '1',
          npm_config_cache: '/work/home/.npm', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
          PIP_CACHE_DIR: '/work/home/.cache/pip', PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1',
          HTTPS_PROXY: proxyUrl, https_proxy: proxyUrl, HTTP_PROXY: proxyUrl, http_proxy: proxyUrl, NO_PROXY: '', no_proxy: '',
          ...(step.env ?? {}),
        };
        const argv = M.sandboxRunArgs({ name, image, network: inNet, ip: M.NETS.install.target, resolv: 'install', cidfile, labels: this.dk.labels(u.tag), cpus: this.cpus, workdir: '/work', mounts: [{ src: work, dst: '/work' }, { src: this.toolsVol, dst: TOOLS, ro: true }], env, cmd: step.cmd });
        this.writeSettings(argv, { subject: u.tag, role: 'install' });
        const r = await u.tdk.d(argv, { deadline: Math.min(deadline, Date.now() + (/-build$/.test(plan.image) && step.name === 'install' ? MS.build : MS.install)), keepStdout: !!step.out, logStdout: !step.out, cap: 1024 * 1024, onTimeout: () => this.dk.kill(name) });
        await this.recordContainer({ id: this.readCid(cidfile), t0: s1, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'install' } });
        inst.steps.push({ name: step.name, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - s1 });
        if (step.out && step.name === 'entry') {
          let j = null;
          try { j = JSON.parse(r.stdout.toString('utf8')); } catch { /* checked below */ }
          entry = j && typeof j.script === 'string' && j.script.startsWith('/work/pkg/') && !/[\u0000\n]/.test(j.script) ? j : null;
          // R-WC-30: the entry helper's answer is kept out of the install log; its code decides whose a failure is
          // (npm-entry.mjs's sentences, cargo-entry.mjs's codes: not_installed, no_binary, several_binaries).
          if (!entry) inst.entry_error = entryErrorCode(j, r.exit);
        }
        if (r.exit !== 0 || (step.name === 'entry' && !entry)) { ok = false; if (r.timed_out) inst.timed_out = true; break; }
      }
      inst.ok = ok;
    } finally {
      try { M.writeNetlog(this.tel, await M.stopNetlog(u.tdk, netlog), { subject: u.tag, roles: M.rolesOn('install') }); } finally { await this.dk.kill(netlog); }
      if (proxyUp) {
        const pl = await u.tdk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
        for (const e of M.jsonLines(pl.stdout).slice(0, 5000)) {
          const x = M.fromProxy(e);
          if (x) { this.tel.tryWrite(x[0], x[1], { source: 'proxy', subject: u.tag, role: 'proxy' }); inst.egress.push({ host: x[1].host, allowed: x[1].allowed }); }
        }
      }
      await this.dk.kill(proxy);
      await this.dk.d(['network', 'rm', inNet], { deadline: Date.now() + 60_000 });
    }
    if (entry && typeof entry.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(entry.version)) inst.resolved_version = entry.version;
    return { inst, plan, entry };
  }

  /**
   * An OCI subject's image (WC14): pulled by the runner's Docker by the digest the resolver read (data until it runs, and
   * it runs only in a sandbox container), then its config read to get the command `docker run` would start
   * (loop/launch.mjs ociServer). Nothing is installed: the image is the server's filesystem. Returns { inst, server }.
   */
  async pullOci(u, deadline) {
    const ref = this.M.checkPinned(u.launch.image, 'subject');
    const inst = { kind: 'docker', steps: [], ok: false, image: 'oci', resolved_version: null, egress: [], oci: { digest: /@sha256:([0-9a-f]{64})$/.exec(ref)[1], bytes: null } };
    const p0 = Date.now();
    u.pulled = ref;
    const pull = await u.tdk.d(['pull', '-q', ref], { deadline: Math.min(deadline, Date.now() + MS.pull) });
    inst.steps.push({ name: 'pull', exit: pull.exit, timed_out: pull.timed_out, ms: Date.now() - p0 });
    if (pull.exit !== 0) { if (pull.timed_out) inst.timed_out = true; return { inst, server: null }; }
    const c0 = Date.now();
    const ins = await u.tdk.d(['image', 'inspect', '--format', '{{json .Config}}\t{{.Os}}/{{.Architecture}}\t{{.Size}}', ref], { keepStdout: true, logStdout: false, cap: 1024 * 1024, deadline: Date.now() + MS.helper });
    const [cfgText, platform, size] = ins.stdout.toString('utf8').trim().split('\t');
    let config = null;
    try { config = JSON.parse(cfgText); } catch { /* unreadable: below */ }
    let server = ins.exit === 0 && config ? ociServer(config, u.launch) : { error: 'image_config_unreadable' };
    // The resolver read the linux/amd64 image; a runner of another platform would have pulled another one.
    if (!server.error && platform !== dockerPlatform()) server = { error: 'image_platform' };
    inst.steps.push({ name: 'config', exit: server.error ? 1 : 0, timed_out: false, ms: Date.now() - c0 });
    if (Number.isSafeInteger(Number(size))) inst.oci.bytes = Number(size);
    // R-WC-38: the unpacked image, as Docker stored it, within our cap too (the registry's size is compressed).
    if (!server.error && !(inst.oci.bytes !== null && inst.oci.bytes <= OCI_MAX_UNPACKED(this.mck))) server = { error: 'image_too_large' };
    if (Number.isSafeInteger(server.volumes)) inst.oci.volumes = server.volumes;
    if (server.error) { inst.entry_error = server.error; return { inst, server: null }; }
    inst.ok = true;
    return { inst, server };
  }

  /** Free bytes on Docker's data root, or null when they cannot be read (then the pull's own failure is the evidence). */
  freeBytes() {
    if (!this.dockerRoot) return null;
    try { const st = statfsSync(this.dockerRoot); return Number(st.bavail) * Number(st.bsize); } catch { return null; }
  }

  /** A volume of our own for one unit, /work, with home, lock and out folders owned by the sandbox user. */
  async workVolume(tag) {
    const work = await this.dk.volume(`surface-${this.runId}-${tag}-work`, tag);
    await this.dk.must(this.helper(tag, { user: '0:0', mounts: [{ src: work, dst: '/work' }], capAdd: ['CHOWN'], cmd: ['sh', '-c', 'mkdir -p /work/home /work/lock /work/out && chown -R 65534:65534 /work'] }), 'work volume');
    return work;
  }

  /** Writes a file into the unit's /work/out through a helper (stdin), as the sandbox user. */
  async put(tag, work, path, text) {
    await this.dk.must(this.helper(tag, { stdin: true, mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'cat > "$1"', 'sh', path] }, { input: Buffer.from(text) }), 'write a file into the work volume');
  }

  /** The run network (one at a time: its subnet is fixed) with the network logger at .2, for fn(network). */
  async withRunNet(u, fn) {
    const network = await this.dk.network(this.name(u.tag, 'run'), true, u.tag, { sandbox: 'run' });
    let netlog = null;
    try {
      netlog = await this.M.startNetlogOn(u.tdk, { net: 'run', network, image: this.images.node24, toolsVol: this.toolsVol, labels: this.dk.labels(u.tag), target: u.tag });
      return await fn(network);
    } finally {
      if (netlog) {
        try { this.M.writeNetlog(this.tel, await this.M.stopNetlog(u.tdk, netlog), { subject: u.tag, roles: this.M.rolesOn('run', { target: 'server' }) }); } finally { await this.dk.kill(netlog); }
      }
      await this.dk.d(['network', 'rm', network], { deadline: Date.now() + 60_000 });
    }
  }

  /**
   * A fixture's backend files (WC13), copied out of its digest-pinned image (loop/binary-image.mjs: pull, create without
   * starting, cp, sha256 against the pin) into a volume of their own, which the fixture's sandbox container mounts read-only.
   */
  async binaryVolume(u) {
    const b = u.binaryImage;
    const platform = dockerPlatform();
    await this.dk.image(b.ref, 'binary image');
    const stage = mkdtempSync(join(tmpdir(), 'wc-bin-'));
    try {
      const labels = this.dk.labels(u.tag);
      const labelArgs = Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]);
      let info;
      try {
        info = await extractBinaryImage({ dock: (argv) => u.tdk.d(argv, { deadline: Date.now() + MS.helper }), spec: b, platform, outDir: stage, containerName: this.name(u.tag, 'bin'), labelArgs });
      } catch (e) { throw new this.M.HarnessError(String(e.message).slice(0, 300)); }
      const names = Object.keys(info.files);
      const tar = spawnSync('tar', ['-C', stage, '-cf', '-', '--owner=0', '--group=0', '--mode=a+rX,go-w', ...names], { maxBuffer: 256 * 1024 * 1024 });
      if (tar.status !== 0) throw new this.M.HarnessError('packing the backend files failed');
      const vol = await this.dk.volume(`surface-${this.runId}-${u.tag}-bin`, u.tag);
      await this.dk.must(this.helper(u.tag, { user: '0:0', stdin: true, mounts: [{ src: vol, dst: '/opt/bin' }], cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', '/opt/bin'] }, { input: tar.stdout }), 'backend files volume');
      u.binaryInfo = info;
      return vol;
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }

  /**
   * One step in a sandbox container at .3 of the run network: the CLI (and the server it starts) or a fixture's
   * set-up. Its output (the CLI's and the server's) goes to raw/steps/<step>.log only.
   */
  async sandboxStep(u, { network, work, image, step, cmd, env, timeoutMs, keepStdout = false, record }) {
    const name = this.name(u.tag, 's');
    const cidfile = join(this.cidDir, `${name}.cid`);
    const argv = this.M.sandboxRunArgs({ name, image, network, ip: this.M.NETS.run.target, resolv: 'run', cidfile, labels: this.dk.labels(u.tag), cpus: this.cpus, workdir: OUTD, mounts: [{ src: work, dst: '/work' }, { src: this.toolsVol, dst: TOOLS, ro: true }, ...(u.binVol ? [{ src: u.binVol, dst: u.binaryImage.mount, ro: true }] : [])], env, cmd });
    this.writeSettings(argv, { subject: u.tag, role: 'server' });
    const log = join(u.stepDir, `${step}.log`);
    const t0 = Date.now();
    const r = await this.dk.d(argv, { log, deadline: Date.now() + timeoutMs, keepStdout, cap: 1024 * 1024, logCap: 4 * 1024 * 1024, onTimeout: () => this.dk.kill(name) });
    await this.dk.kill(name);
    await this.recordContainer({ id: this.readCid(cidfile), t0, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'server' } });
    const s = { step, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - t0 };
    record.push(s);
    return { r, s };
  }

  /**
   * A split run (R-WC-05), for every subject and for the forgery control: the server under test runs in a sandbox
   * container of its own at .3 of the run network, behind our bridge (loop/sandbox/bridge.mjs), with its install
   * volume read-only and nothing else of ours; the CLI runs in another sandbox container at .4, as our helper, with
   * the output volume that the server's container never mounts, and reaches the server over TCP through our relay
   * (loop/sandbox/relay.mjs) as if it were a stdio server. Two gVisor sandboxes: the server cannot see the CLI's
   * files or processes, write to its stdout, or signal or trace it. Its only channel to the CLI is the protocol.
   */
  async splitRun(u, { work, image, serverCmd, res, unitDeadline }) {
    const M = this.M;
    const out = await this.dk.volume(`surface-${this.runId}-${u.tag}-out`, u.tag);
    await this.dk.must(this.helper(u.tag, { user: '0:0', mounts: [{ src: out, dst: OUTD }], capAdd: ['CHOWN'], cmd: ['sh', '-c', `chown 65534:65534 ${OUTD}`] }), 'output volume');
    const relay = [NODE, `${LOOP}/relay.mjs`, M.NETS.run.target, String(BRIDGE_PORT)];
    await this.dk.must(this.helper(u.tag, { stdin: true, mounts: [{ src: out, dst: OUTD }], cmd: ['sh', '-c', 'cat > "$1"', 'sh', MANIFEST] }, { input: Buffer.from(catalogManifest(relay, [], `loop-${u.tag}`)) }), 'write the manifest');
    const left = (cap) => Math.max(1000, Math.min(cap, unitDeadline - Date.now()));
    await this.withRunNet(u, async (network) => {
      const name = this.name(u.tag, 's');
      const cidfile = join(this.cidDir, `${name}.cid`);
      const argv = M.sandboxRunArgs({ name, image, network, ip: M.NETS.run.target, resolv: 'run', cidfile, detach: true, labels: this.dk.labels(u.tag), cpus: this.cpus, ...serverContainer(u, { work, toolsVol: this.toolsVol, serverCmd, loader: this.loader }), env: u.oci ? { ...runEnv(), ...BRIDGE_ENV_EMPTY } : runEnv({ ...(u.env ?? {}) }) });
      this.writeSettings(argv, { subject: u.tag, role: 'server' });
      const t0 = Date.now();
      await this.dk.must(u.tdk.d(argv, { deadline: Date.now() + 60_000 }), 'server container');
      try {
        for (let until = Date.now() + 30_000; ;) {
          const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
          if (M.jsonLines(l.stdout).some((x) => x.listening === BRIDGE_PORT)) break;
          // R-WC-37: in an OCI subject's own image, a bridge that does not start is that image's environment against our
          // runtime, and would fail again on every retry: not retryable.
          if (Date.now() >= until) throw Object.assign(new M.HarnessError('the server bridge did not start'), u.oci ? { ociBridge: true } : {});
          await sleep(250);
        }
        const cliStep = async (step, args, { keepStdout = false } = {}) => {
          const cname = this.name(u.tag, 'c');
          const ccid = join(this.cidDir, `${cname}.cid`);
          const cargv = M.helperRunArgs({ name: cname, image: this.images.node24, network, ip: M.NETS.run.probe, resolv: 'run', cidfile: ccid, labels: this.dk.labels(u.tag), cpus: this.cpus, mounts: [{ src: out, dst: OUTD }, { src: this.toolsVol, dst: TOOLS, ro: true }], env: { HOME: '/tmp', TMPDIR: '/tmp', NO_COLOR: '1' }, cmd: ['sh', '-c', `cd ${OUTD} && exec "$@"`, 'sh', NODE, CLI_MAIN, ...args] });
          this.writeSettings(cargv, { subject: u.tag, role: 'probe' });
          const c0 = Date.now();
          const r = await this.dk.d(cargv, { log: join(u.stepDir, `${step}.log`), deadline: Date.now() + left(MS.step), keepStdout, cap: 1024 * 1024, logCap: 4 * 1024 * 1024, onTimeout: () => this.dk.kill(cname) });
          await this.dk.kill(cname);
          await this.recordContainer({ id: this.readCid(ccid), t0: c0, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'probe' } });
          res.steps.push({ step, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - c0 });
          return r;
        };
        if (u.init !== false) await cliStep('init', ['init', '--out', `${OUTD}/init-draft.yaml`, '--', ...relay]);
        res.planStdout = (await cliStep('plan', ['plan', '-m', MANIFEST], { keepStdout: true })).stdout.toString('utf8');
        await cliStep('catalog', ['catalog', '-m', MANIFEST, '--out', `${OUTD}/results`]);
      } finally {
        const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
        writeFileSync(join(u.stepDir, 'server.log'), l.stdout);
        await this.dk.kill(name);
        await this.recordContainer({ id: this.readCid(cidfile), t0, exit: null, meta: { subject: u.tag, role: 'server' } });
      }
    });
    const c = await this.helper(u.tag, { mounts: [{ src: out, dst: OUTD, ro: true }, { src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${LOOP}/collect.mjs`, OUTD, String(COLLECT.file), String(COLLECT.total), String(COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 48 * 1024 * 1024 });
    const parsed = parseCollected(c.stdout.toString('utf8'));
    res.files = parsed.files;
    res.collected = { exit: c.exit, entries: parsed.entries.length, bad: parsed.bad, done: parsed.done, truncated: c.stdout_truncated, split: true };
  }

  /**
   * One unit (an item or a control) end to end. Returns { steps, install, files, planStdout, fullRan, missing, error }.
   * `u`: { tag, launch | null, forgery?, fixture?, env, init, manifestFile?, link?, background?, setup?, full? }
   */
  async runUnit(u, unitDeadline) {
    const M = this.M;
    u.tdk = Object.create(this.dk);
    u.tdk.log = join(u.stepDir, 'docker.log');
    mkdirSync(u.stepDir, { recursive: true });
    const t0 = Date.now();
    const res = { steps: [], install: null, files: new Map(), planStdout: '', fullRan: false, missing: [], error: null, collected: null };
    this.missing = res.missing;
    const watch = M.watchTraces(this.cfg, { sinceMs: t0, onOverflow: () => this.dk.killAll(u.tag) });
    let work = null;
    try {
      work = await this.workVolume(u.tag);
      let image = this.images.node24;
      let serverCmd;
      let pkgdir = null;
      if (u.forgery) {
        serverCmd = [NODE, `${LOOP}/forgery-server.mjs`];
      } else if (u.launch.kind === 'docker') {
        // WC14: an OCI subject. Its own image is the server's container; the bridge starts there through the portable runtime.
        if (!this.loader) throw new M.HarnessError('the portable runtime for the bridge is not in the tools volume');
        const { inst, server } = await this.pullOci(u, Math.min(unitDeadline, Date.now() + MS.pull + MS.helper));
        res.install = inst;
        if (!inst.ok) return res;
        image = u.launch.image;
        serverCmd = server.cmd;
        // R-WC-37: the server gets the image's own environment back, with ours on top; the bridge gets neither.
        u.oci = { workdir: server.workdir, serverEnv: runEnv({ ...server.env, ...(u.env ?? {}) }) };
      } else {
        const { inst, plan, entry } = await this.install(u, work, Math.min(unitDeadline, Date.now() + MS.build + MS.install));
        res.install = inst;
        if (!inst.ok) return res;
        image = this.images[plan.runImage ?? plan.image];
        serverCmd = plan.run(entry);
        if (u.launch.kind === 'npm') pkgdir = u.source ? '/work/pkg' : `/work/pkg/node_modules/${u.launch.package}`;
        u.entry = entry;
        if (u.binaryImage) u.binVol = await this.binaryVolume(u);
      }
      if (!u.manifestFile) {
        // Every subject and the forgery control: the server in a sandbox container of its own, the CLI in another.
        await this.splitRun(u, { work, image, serverCmd, res, unitDeadline });
        return res;
      }
      const passEnv = Object.keys(u.env ?? {}).sort();
      // A fixture runs its dogfood manifest byte for byte (its plan hash is the one a person accepted there): written
      // two levels below /work, with its relative cwd made to land on the installed package by a link.
      const manifest = u.manifestFile ? FIXTURE_MANIFEST : MANIFEST;
      if (u.manifestFile) {
        if (!pkgdir) throw new M.HarnessError('a fixture manifest needs an npm package');
        await this.dk.must(this.helper(u.tag, { mounts: [{ src: work, dst: '/work' }], cmd: ['sh', '-c', 'mkdir -p "$(dirname "$1")" "$(dirname "$3")" && ln -s "$2" "$1"', 'sh', u.link, pkgdir, FIXTURE_MANIFEST] }), 'fixture link');
      }
      const text = u.manifestFile ? readFileSync(u.manifestFile, 'utf8') : catalogManifest(serverCmd, passEnv, `loop-${u.tag}`);
      await this.put(u.tag, work, manifest, text);
      const env = runEnv({ ...(u.env ?? {}) });
      const bg = u.background && u.entry ? { argv: ['node', u.entry.script, ...u.background.args], log: `${OUTD}/backend.log`, ready: u.background.ready, wait_ms: 15_000 } : null;
      // A fixture's backend starts only for the CLI commands its entry lists (`only`), so that plan and catalog, which
      // call no tool, do not pay for a database that starts in a second or three and is never asked anything.
      const cli = (args) => (bg && (!u.background.only || u.background.only.includes(args[0])) ? [NODE, `${LOOP}/bg.mjs`, JSON.stringify(bg), '--', NODE, CLI_MAIN, ...args] : [NODE, CLI_MAIN, ...args]);
      const left = (cap) => Math.max(1000, Math.min(cap, unitDeadline - Date.now()));
      await this.withRunNet(u, async (network) => {
        const step = (o) => this.sandboxStep(u, { network, work, image, env, record: res.steps, ...o });
        for (const [k, argv] of (u.setup ?? []).entries()) {
          const { s } = await step({ step: `setup-${k}`, cmd: argv.map((a) => a.replaceAll('{{pkgdir}}', pkgdir ?? '')), timeoutMs: left(MS.setup) });
          if (s.exit !== 0) return;
        }
        if (u.init !== false) await step({ step: 'init', cmd: [NODE, CLI_MAIN, 'init', '--out', `${OUTD}/init-draft.yaml`, ...passEnv.flatMap((k) => ['--env', k]), '--', ...serverCmd], timeoutMs: left(MS.step) });
        const p = await step({ step: 'plan', cmd: cli(['plan', '-m', manifest]), timeoutMs: left(MS.step), keepStdout: true });
        res.planStdout = p.r.stdout.toString('utf8');
        await step({ step: 'catalog', cmd: cli(['catalog', '-m', manifest, '--out', `${OUTD}/results`]), timeoutMs: left(MS.step) });
        const accepted = u.acceptedHash;
        const seen = planHash(res.planStdout);
        if (accepted && seen === accepted && Date.now() + 60_000 < unitDeadline) {
          res.fullRan = true;
          await step({ step: 'full', cmd: cli(['run', '-m', manifest, '--confirm-target', u.full.confirm, '--plan-hash', accepted, '--out', `${OUTD}/full`, '--state', `${OUTD}/state`]), timeoutMs: left(MS.full) });
        }
      });
      // Everything the steps left in /work/out, read by our helper after every target process has ended.
      const c = await this.helper(u.tag, { mounts: [{ src: work, dst: '/work', ro: true }, { src: this.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${LOOP}/collect.mjs`, OUTD, String(COLLECT.file), String(COLLECT.total), String(COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 48 * 1024 * 1024 });
      const parsed = parseCollected(c.stdout.toString('utf8'));
      res.files = parsed.files;
      res.collected = { exit: c.exit, entries: parsed.entries.length, bad: parsed.bad, done: parsed.done, truncated: c.stdout_truncated };
    } catch (e) {
      if (!(e instanceof M.HarnessError)) throw e;
      res.error = e.ociBridge ? 'oci_bridge' : 'harness';
      appendFileSync(join(u.stepDir, 'harness-error.log'), `${String(e.message).slice(0, 600)}\n`);
    } finally {
      try { await this.dk.sweep(u.tag); } catch { /* the shard's sweep follows */ }
      // An OCI subject's image goes as soon as its containers have: images of up to 2 GB share Docker's capped data root.
      if (u.pulled) { try { await this.dk.d(['image', 'rm', '--force', u.pulled], { deadline: Date.now() + MS.helper }); } catch { /* the job's teardown stops Docker */ } }
      watch.stop();
      if (watch.overflow()) { this.tel.write('skip', { reason: 'trace_overflow', detail: 'a syscall trace passed its limit; the unit\'s containers were stopped' }, { subject: u.tag }); res.missing.push('a complete syscall trace (overflow)'); }
      let drops = false;
      try { drops = this.recordDrops(t0, u.tag); } catch { /* recorded as missing */ }
      if (!drops && this.o.lane === 'ci') res.missing.push('the host firewall log');
      M.sweepTraces(this.cfg, t0);
      this.missing = null;
    }
    return res;
  }
}

/**
 * The server container of a split run, past what every sandbox container has: its mounts, command and working folder.
 * Ours and our installs' images: the bridge by Node from the tools volume, the install volume read-only at /work.
 * An OCI subject (WC14): its own image, so the bridge starts through the portable runtime (loop/launch.mjs
 * portableBridge), in the image's own working folder, with no volume of ours but the read-only tools.
 */
export function serverContainer(u, { work, toolsVol, serverCmd, loader }) {
  const tools = { src: toolsVol, dst: TOOLS, ro: true };
  if (u.oci) {
    const b = portableBridge({ loader, port: BRIDGE_PORT, serverCmd, serverEnv: u.oci.serverEnv ?? null });
    return { mounts: [tools], entrypoint: b.entrypoint, cmd: b.cmd, workdir: u.oci.workdir };
  }
  return { mounts: [{ src: work, dst: '/work', ro: true }, tools], cmd: [NODE, `${LOOP}/bridge.mjs`, String(BRIDGE_PORT), '--', ...serverCmd] };
}

/**
 * The distinct hosts the install's proxy was asked for, allowed or not (R-WC-09): names of DNS shape only, the rest
 * counted as "(other)". The proxy log is the install's own requests, so it is checked before it leaves raw/.
 */
export function egressHosts(egress) {
  return [...new Set(egress.map((e) => (typeof e.host === 'string' && /^[a-z0-9.-]{1,253}$/.test(e.host) ? `${e.host}${e.allowed ? '' : ' (refused)'}` : '(other)')))].sort().slice(0, 50);
}

/** The unit description for a subject (or a fixture), from its resolution. */
function unitFor(tag, resolved, fixtures, stepDir, extraEnv = {}, { proofPlan = false } = {}) {
  const f = resolved.fixture ? fixtures.fixtures[resolved.fixture] : null;
  const env = { ...(f?.env ?? {}), ...extraEnv };
  for (const k of f?.random_env ?? []) env[k] = randomBytes(16).toString('hex');
  const manifestFile = f?.manifest ? join(here, '..', f.manifest) : null;
  return {
    tag, stepDir, launch: resolved.launch, fixture: resolved.fixture, env,
    init: f ? f.init !== false : true,
    source: f?.source ?? null,
    backend: f?.backend ?? null,
    background: f?.background ?? null,
    setup: f?.setup ?? null,
    full: f?.full ?? null,
    // The plan hash the full write test needs: the one a person accepted; or, for a proof item that asks for it (WC13), the
    // fixture's proposed one, which nobody has accepted yet (the live lane never sends proof_plan; the bundle says so).
    acceptedHash: f?.full ? (f.full.plan_hash ?? (proofPlan ? f.full.proposed_plan_hash ?? null : null)) : null,
    proofPlan: proofPlan && !f?.full?.plan_hash,
    binaryImage: f?.binary_image ?? null,
    manifestFile, link: f?.link ?? null,
    lock: f?.lock ? join(here, '..', f.lock) : null,
  };
}

/** The raw/ copies of one unit's captured output: the files its steps left, the step logs and its telemetry. */
function addRaw(b, prefix, res, stepDir) {
  for (const [p, data] of res.files) b.raw(safeRawPath(`${prefix}/out`, p), data);
  for (const f of ['init', 'plan', 'catalog', 'full', 'server', 'docker', 'harness-error', ...Array.from({ length: 5 }, (_, k) => `setup-${k}`)]) {
    const p = join(stepDir, `${f}.log`);
    if (existsSync(p)) b.raw(`${prefix}/steps/${f}.log`, readFileSync(p));
  }
}

function settingsFor(ctx) {
  return {
    format: 'isokron-writecheck-loop-settings/1', cli_ref: ctx.cliRef, sandbox_ref: ctx.sandboxRef, action_ref: ctx.actionRef, mcp_check_ref: ctx.mckRef,
    images: ctx.shard.images, gvisor_release: ctx.shard.cfg.release, fixtures_sha256: ctx.fixtures.sha256, seed_sha256: ctx.seed.sha256,
    limits: { ...MS, shard_budget_ms: SHARD_BUDGET_MS, collect: COLLECT },
  };
}

async function runControls(ctx) {
  const { shard, fixtures } = ctx;
  const out = [];
  const ctlDir = (n) => join(shard.shardDir, 'controls', n);
  // Forgery: our hostile server, through the same steps as a subject (init, plan, catalog), with a fresh marker.
  const marker = `wcforgery${randomBytes(16).toString('hex')}`;
  const fu = { tag: 'ctl-forgery', stepDir: ctlDir('forgery'), launch: null, forgery: true, env: { FORGERY_MARKER: marker, FORGERY_TAMPER: '1' }, init: true };
  const fr = await shard.runUnit(fu, Date.now() + 10 * 60_000);
  const fs = summarize({ files: fr.files, steps: fr.steps, planStdout: fr.planStdout });
  const fOut = { format: 'isokron-writecheck-control/1', control: 'forgery', summary: publicSummary(fs), observations: observations(fs, { versions: ctx.versions, stagesRan: { install: false, init: true, plan: true, catalog: true, full: false } }) };
  const fb = new BundleFiles(CONTROL_RAW);
  addRaw(fb, 'raw/control-forgery', fr, fu.stepDir);
  const rawTexts = [...fb.files.values()].map((d) => d.toString('latin1'));
  const fObserved = forgeryVerdict({ marker, output: fOut, rawTexts, toolCount: fs.catalog.tool_count, summary: fs });
  out.push({ kind: 'forgery', expected: 'contained', observed: fObserved, output: 'controls/forgery.json', marker, file: fOut, raw: fb });

  // Known answer: tiny-tracker, installed through the sandbox like a subject, catalog with and without the defect.
  const tt = Object.entries(fixtures.fixtures).find(([, f]) => f.known_answer);
  if (!tt) throw new Error('loop/fixtures.json names no known_answer fixture');
  const [ttName, ttF] = tt;
  const ka = ttF.known_answer;
  for (const [kind, label, defect] of [['known_bad', 'known-bad', ka.defect], ['known_good', 'known-good', null]]) {
    const u = unitFor(`ctl-${label}`, { fixture: ttName, launch: { ...ttF.launch } }, fixtures, ctlDir(label), defect ? { [ka.env]: defect } : {});
    u.full = null; // catalog and plan only
    u.acceptedHash = null;
    u.init = false;
    const r = await shard.runUnit(u, Date.now() + 10 * 60_000);
    const s = summarize({ files: r.files, steps: r.steps, planStdout: r.planStdout });
    const observed = kind === 'known_bad' ? knownBadVerdict(s, ka.requirement) : knownGoodVerdict(s, ka.requirement);
    const file = { format: 'isokron-writecheck-control/1', control: label, fixture: ttName, package: `${ttF.launch.package}@${ttF.launch.version}`, defect, requirement: ka.requirement, observed, summary: publicSummary(s) };
    const rb = new BundleFiles(CONTROL_RAW);
    addRaw(rb, `raw/control-${label}`, r, u.stepDir);
    out.push({ kind, expected: kind === 'known_bad' ? 'detected' : 'held', observed, output: `controls/${label}.json`, file, raw: rb });
  }
  return out;
}

/**
 * The last 64 KB of the server's stderr (R-WC-40): a split run's server.log (the server's own container), else the
 * logs of the CLI steps that failed (a fixture's server runs in the step's container). Empty when there is none.
 */
export function lastStderr(stepDir, steps = []) {
  const tail = (f) => { try { const b = readFileSync(f); return b.subarray(Math.max(0, b.length - 64 * 1024)).toString('latin1'); } catch { return ''; } };
  const server = join(stepDir, 'server.log');
  if (existsSync(server)) return tail(server);
  return steps.filter((x) => ['init', 'plan', 'catalog'].includes(x?.step) && x.exit !== 0).map((x) => tail(join(stepDir, `${x.step}.log`))).join('\n').slice(-64 * 1024);
}

async function runItem(ctx, item, deadline) {
  const { shard, fixtures, seed } = ctx;
  const startedAt = iso();
  const b = new BundleFiles();
  const skips = [];
  let resolved = resolveSubject(item.subject, { seed, fixtures }, item.fixture ?? null);
  const notStarted = Date.now() >= deadline;
  // WC14: no npm or PyPI package, but an OCI image or a crate in the seed: the live-probe lane's resolver, else the
  // crate (loop/launch.mjs). Not when the shard's time is spent: then the item is not started, and is sent out again.
  if (resolved.skip?.beyond && ctx.mck) {
    if (notStarted) resolved = {};
    else {
      try { resolved = await resolveBeyondSeed(item.subject, resolved.entry, { mck: ctx.mck }); } catch (e) {
        appendFileSync(join(shard.shardDir, 'driver-errors.log'), `item ${item.index}: resolver: ${String(e && e.stack).slice(0, 2000)}\n`);
        resolved = { skip: { stage: 'install', reason: 'tool_error', fault: 'tool', retryable: true, detail: 'the OCI and crate resolver failed' } };
      }
      // R-WC-38: live-probe's checks before a pull (its R-LP-16), on what the resolver returned: the host, the size, and room.
      if (resolved.launch?.kind === 'docker') {
        const problem = ociPullProblem({ image: resolved.launch.image, bytes: resolved.choice?.oci_bytes, freeBytes: shard.freeBytes() }, ctx.mck);
        if (problem) resolved = { ...resolved, launch: undefined, skip: problem };
      }
    }
  }
  const driver = { format: 'isokron-writecheck-loop-driver/1', index: item.index, source: resolved.source ?? null, package: resolved.package ?? null, ...(resolved.choice ? { choice: resolved.choice } : {}), install: null, steps: [], error: null, evidence_missing: [], collected: null };
  let summary = null;
  let res = null;
  const stages = { install: false, init: false, plan: false, catalog: false, full: false };
  if (resolved.skip || notStarted) {
    // Not run: no package this lane can start (or excluded), or the shard's time budget is spent. R-WC-24: each skip says its fault.
    const s = itemSkips({ resolved, notStarted: !resolved.skip });
    skips.push(...s.skips);
    Object.assign(driver, s.notes);
  } else {
    // A registry launch may declare the environment its server needs: dummy values only (WC14, as the live-probe lane).
    const u = unitFor(`i${item.index}`, resolved, fixtures, join(shard.shardDir, 'items', String(item.index)), resolved.launch?.env ? launchEnv(resolved.launch, { dummyValue: shard.M.dummyValue, targetEnvProblems: shard.M.targetEnvProblems }) : {}, { proofPlan: item.proof_plan === true });
    // A unit's telemetry is its own file, kept in raw/ (it names what the target looked up and reached).
    const telFile = join(u.stepDir, 'telemetry.jsonl');
    mkdirSync(u.stepDir, { recursive: true });
    const shardTel = shard.tel;
    shard.tel = new shard.M.Telemetry(telFile, { run: shard.runId });
    // The last item may finish at most ITEM_GRACE_MS past the shard deadline, so the job ends inside its
    // timeout-minutes and the pump's lease (corpus.yml): items 26 + 5 min, plus prepare and teardown.
    try { res = await shard.runUnit(u, Math.min(deadline + ITEM_GRACE_MS, Date.now() + 20 * 60_000)); } finally { shard.tel = shardTel; }
    driver.install = res.install ? { ok: res.install.ok, kind: res.install.kind, image: res.install.image, resolved_version: res.install.resolved_version, timed_out: !!res.install.timed_out, steps: res.install.steps, egress_hosts_allowed: res.install.egress.filter((e) => e.allowed).length, egress_refused: res.install.egress.filter((e) => !e.allowed).length, egress_hosts: egressHosts(res.install.egress), ...(res.install.oci ? { oci: res.install.oci } : {}), ...(res.install.entry_error ? { entry_error: res.install.entry_error } : {}) } : null;
    driver.error = res.error;
    if (u.binaryInfo) driver.binary_image = u.binaryInfo;
    if (u.proofPlan) { driver.plan_accepted = false; driver.proof_plan_hash = u.acceptedHash; }
    driver.evidence_missing = [...new Set(res.missing)];
    driver.collected = res.collected;
    stages.install = !!res.install?.ok;
    // R-WC-40: a stage ran only when its step ended with a status that means it did (attempted is not ran).
    Object.assign(stages, stagesRan(res.steps));
    summary = summarize({ files: res.files, steps: res.steps, planStdout: res.planStdout, fullRan: res.fullRan, acceptedPlanHash: u.proofPlan ? null : u.acceptedHash }); // a proof item's plan is not accepted: the record says so, with no drift
    const evidenceComplete = ctx.lane !== 'ci' || driver.evidence_missing.length === 0;
    // Every stage that did not run, with its fault side (R-WC-24): the install's own output is read only to tell a
    // package-level error (the subject's) from our limits; it stays in raw/.
    const installLog = res.install && !res.install.ok && existsSync(join(u.stepDir, 'docker.log')) ? readFileSync(join(u.stepDir, 'docker.log'), 'latin1') : '';
    // The server's stderr, read only to say which of our limits stopped a stage (R-WC-40); it stays in raw/.
    const serverLog = res.install?.ok && ['init', 'plan', 'catalog'].some((x) => !stages[x]) ? lastStderr(u.stepDir, res.steps) : '';
    const s = itemSkips({ resolved, res, unit: u, stages, evidenceComplete, installLog, serverLog });
    skips.push(...s.skips);
    Object.assign(driver, s.notes);
    b.put('results/writecheck.json', json({ subject: item.subject, source: resolved.source, package: resolved.package, resolved_version: res.install?.resolved_version ?? null, ...publicSummary(summary) }));
    b.put('observations/writecheck.ndjson', ndjson(observations(summary, { versions: ctx.versions, stagesRan: stages, evidenceComplete, backend: u.backend })));
    addRaw(b, 'raw', res, u.stepDir);
    if (existsSync(telFile)) b.raw('raw/sandbox-telemetry.jsonl', readFileSync(telFile));
    driver.steps = publicSummary(summary).steps;
  }
  if (!summary) {
    b.put('observations/writecheck.ndjson', ndjson([
      { field: 'our_tool_versions', value: ctx.versions },
      { field: 'observation_coverage', value: { ...stages, sandbox_evidence_complete: true } },
    ]));
  }
  for (const c of ctx.controls) {
    b.put(c.output, json(c.file));
    for (const [p, d] of c.raw.files) b.files.set(p, d);
  }
  driver.raw_index = b.rawIndex;
  b.put('logs/driver.json', json(driver));
  const dir = join(shard.out, String(item.index));
  rmSync(dir, { recursive: true, force: true });
  b.write(join(dir, 'bundle'));
  const meta = buildMeta({ subject: item.subject, tools: ctx.tools, settingsDigest: ctx.settingsDigest, startedAt, finishedAt: iso(), skips, controls: ctx.controls });
  writeFileSync(join(dir, 'meta.json'), json(meta));
  return { skipped: skips.length > 0 && !res, code: resolved.skip?.reason ?? (res?.error ? 'harness_error' : res?.install && !res.install.ok ? 'install_failed' : 'ran') };
}

/**
 * The commit of this repository that runs (tool-qa R-PIN-01, R-WC-29): the workflow's checked ACTION_SHA (the pump's
 * tool_sha, else the run's own commit), which must be the checkout's HEAD; without ACTION_SHA (a local run) the HEAD
 * itself, or "local". Never GITHUB_SHA: the YAML runs from the dispatched branch while the lane code is the pinned commit.
 */
export function actionSha(env, head) {
  const h = /^[0-9a-f]{40}$/.test(String(head ?? '')) ? head : null;
  // "local" proves no commit: under tool-qa's pin_check "enforce" such a result is refused (pin_unverified).
  if (env.ACTION_SHA === undefined || env.ACTION_SHA === '') return h ?? 'local';
  if (!/^[0-9a-f]{40}$/.test(env.ACTION_SHA)) throw new InputError('ACTION_SHA must be a full commit SHA');
  if (env.ACTION_SHA !== h) throw new InputError('ACTION_SHA is not the commit checked out');
  return env.ACTION_SHA;
}

/** The checkout's HEAD commit, or null. */
export function gitHead(dir = join(here, '..')) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * The manifest's `tools`: each named by the key tool-qa pins it under (pump/workflows.json versions.tool and
 * versions.probe), so ingest can prove every pin (R-WC-29): mcp-writecheck (CLI_REF), mcp-writecheck-action (the commit
 * that ran), mcp-surface-corpus (SANDBOX_REF), and gVisor's release.
 */
export function toolsFor({ cliRef, actionRef, sandboxRef, gvisor, mckRef = null }) {
  return [
    { name: 'mcp-writecheck', version: cliRef },
    { name: 'mcp-writecheck-action', version: actionRef },
    { name: 'mcp-surface-corpus', version: sandboxRef },
    { name: 'gvisor', version: gvisor },
    // WC14: the OCI resolver, mcp-check at MCP_CHECK_REF (the key tool-qa pins mcp-check under for live-probe).
    ...(mckRef ? [{ name: 'mcp-check', version: mckRef }] : []),
  ];
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  checkId('shard_id', env.SHARD_ID);
  checkId('attempt_id', env.ATTEMPT_ID);
  const items = parseItems(env.ITEMS, { proofLane: isProofLane(env) });
  for (const [k, v] of [['CLI_REF', env.CLI_REF], ['SANDBOX_REF', env.SANDBOX_REF]]) if (!/^[0-9a-f]{40}$/.test(String(v ?? ''))) throw new InputError(`${k} must be a full commit SHA`);
  const actionRef = actionSha(env, gitHead());
  const M = await loadMsc(resolve(o.msc));
  // WC14: mcp-check's live-probe resolver for OCI images (and, failing it, our crate path); without --mck those subjects keep their skip.
  if (o.mck && !/^[0-9a-f]{40}$/.test(String(env.MCP_CHECK_REF ?? ''))) throw new InputError('MCP_CHECK_REF must be a full commit SHA');
  const mck = o.mck ? await loadMck(resolve(o.mck)) : null;
  const seed = loadSeed(o.seed);
  const fixtures = loadFixtures(o.fixtures);
  const shard = new Shard({ o, M, env });
  shard.mck = mck;
  const ctx = { shard, seed, fixtures, mck, lane: o.lane, cliRef: env.CLI_REF, sandboxRef: env.SANDBOX_REF, mckRef: mck ? env.MCP_CHECK_REF : null, actionRef };
  ctx.versions = { mcp_writecheck: env.CLI_REF, mcp_writecheck_action: actionRef, mcp_surface_corpus: env.SANDBOX_REF, gvisor: shard.cfg.release, ...(mck ? { mcp_check: env.MCP_CHECK_REF } : {}) };
  ctx.tools = toolsFor({ cliRef: env.CLI_REF, actionRef, sandboxRef: env.SANDBOX_REF, gvisor: shard.cfg.release, mckRef: ctx.mckRef });
  say(`writecheck shard: ${items.length} item(s)`);
  shard.tel.write('run_start', { kind: 'corpus', lane: o.lane, node: process.version, platform: `linux/${arch()}`, runtime: M.RUNTIME, gvisor_release: shard.cfg.release });
  let ok = false;
  try {
    await shard.prepare();
    await shard.preflight();
    await shard.prepareTools();
    ctx.settingsDigest = sha256(JSON.stringify(settingsFor(ctx)));
    const t0 = Date.now();
    ctx.controls = await runControls(ctx);
    for (const c of ctx.controls) say(`control ${c.kind}: ${c.observed} (expected ${c.expected})`);
    const failed = ctx.controls.filter((c) => c.observed !== c.expected);
    if (failed.length) {
      say(`::error title=writecheck::${failed.length} control(s) failed; no bundle is written and nothing is uploaded`);
      return 1;
    }
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, 'controls_ok=true\n');
    const deadline = t0 + SHARD_BUDGET_MS;
    for (const item of items) {
      const r = await runItem(ctx, item, deadline);
      say(`item ${item.index}: ${r.code}`);
      if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `has_${item.index}=true\nfence_${item.index}=${item.fence}\nrun_key_${item.index}=${item.run_key}\n`);
    }
    ok = true;
    return 0;
  } catch (e) {
    appendFileSync(join(shard.shardDir, 'driver-errors.log'), `${String(e && e.stack).slice(0, 4000)}\n`);
    say(`::error title=writecheck::harness error: ${e instanceof M.HarnessError ? String(e.message).slice(0, 300).replace(/[^\x20-\x7e]/g, '?') : 'see _shard/driver-errors.log'}`);
    return 1;
  } finally {
    try { await shard.dk.sweep(); } catch { /* the workflow stops Docker afterwards */ }
    M.sweepTraces(shard.cfg, 0);
    rmSync(shard.cidDir, { recursive: true, force: true });
    try { shard.tel.end(ok); } catch { /* the telemetry file is best effort at the end */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((rc) => { process.exitCode = rc; }, (e) => {
    say(`::error title=writecheck::${e instanceof InputError ? e.message : 'the driver failed before the shard started'}`);
    if (!(e instanceof InputError)) process.stderr.write(`${e && e.stack}\n`);
    process.exitCode = 1;
  });
}

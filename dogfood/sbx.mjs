#!/usr/bin/env node
/**
 * The sandbox of a dogfood T0 worker (dogfood-*.yml): every install, build and run of third-party code in the job goes
 * through here, into isokron-ai/mcp-surface-corpus's sandbox at SANDBOX_REF (the same library, images and networks as
 * corpus.yml's writecheck lane, loop/run-items.mjs), after that commit's sandbox-guard action has passed on this runner.
 *
 *   node dogfood/sbx.mjs up [--unit-image node22] [--fwd <port>=<last octet>:<port>]... [--pass NAME]...
 *   node dogfood/sbx.mjs build --image <key> --hosts <h,h> --cwd <dir> [--native] [--env K=V]... [--path <dir>]... [--minutes N] -- argv...
 *   node dogfood/sbx.mjs svc --name <n> --ip <last octet> (--image <key> [--cwd <dir>] [--wrap] | --image-ref <pinned ref> [--workdir <dir>] [--entrypoint <path>])
 *                            [--env K=V]... [--secret-env NAME=<file in the sandbox>]... -- argv...
 *   node dogfood/sbx.mjs exec [--cwd <dir>] [--env K=V]... [--path <dir>]... [--bg] -- argv...
 *   node dogfood/sbx.mjs run --image <key> [--cwd <dir>] [--env K=V]... -- argv...
 *   node dogfood/sbx.mjs pull <file in the sandbox> <host file>
 *   node dogfood/sbx.mjs logs <service name> [lines]
 *   node dogfood/sbx.mjs down
 *   (and dogfood/sbx-cli/, the folder the action's cli-path names: the CLI itself, run in the unit)
 *   env: MSC_DIR (the mcp-surface-corpus checkout), SANDBOX_REF, MWSC_CLI_PATH (the CLI built on the host before any of
 *        this), GITHUB_WORKSPACE, RUNNER_TEMP
 *
 * The layout. One work volume of the job is mounted at the common parent of GITHUB_WORKSPACE and RUNNER_TEMP
 * (/home/runner/work on GitHub's runners), and `up` copies the workspace into it at the same path (no .git of ours,
 * not the sandbox checkout or the CLI's sources). Every path, argument and environment value the job's scripts and
 * manifests use is then the same inside the sandbox as it was on the runner, so the manifests run byte for byte at the
 * same `cwd` and the plan hashes a person accepted still apply. Nothing in the volume is ever run on the host.
 *
 * The containers (gVisor, user 65534, no capability, read-only root, mcp-surface-corpus's limits, no runner
 * environment; sandboxRunArgs and helperRunArgs of the pinned commit, never another `docker run`):
 *   - build: one container per command on the sandbox's install network, whose only way out is the allowlist proxy to
 *     the hosts named (registry.npmjs.org, the Go module proxy); the image is one of the sandbox's (node22-build, go).
 *   - unit: the stand-in for the runner's loopback, at .3 of the run network (no way out at all: every name resolves
 *     to the network logger, the host firewall drops the rest). The CLI and the stdio server it starts run there,
 *     with `exec`; loop/sandbox/dogfood-unit.mjs forwards 127.0.0.1:<port> to a service, so `http://127.0.0.1:<port>`
 *     in a manifest reaches it.
 *   - svc: a service of the run network at a fixed address (Grafana, Postgres, Strapi, the Next.js app), detached.
 *     --secret-env makes a random value on the host for it (an admin password) and writes it to a file in the work
 *     volume for the job's set-up scripts; the value is never in the runner's environment or log.
 *   - run: one container of another image on the run network (Python for the Grafana snapshot).
 * Output of a container that ran third-party code is data: it goes to the job log between ::stop-commands:: markers
 * (it can issue no workflow command), and files come back only through mcp-surface-corpus's collect helper (ours, no
 * network, the volume read-only), each checked by name and written only as a new file (`pull`, and the CLI's results).
 * `down` removes every container, network and volume of the run and records the network logger's lines, the egress
 * proxy's requests and the host firewall's drops; loop/teardown.sh then stops Docker. The job that seals the result
 * bundle (t0-manifest) is another job, on another runner, and reads only job results.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { Shard, loadMsc } from '../loop/run-items.mjs';
import { parseCollected } from '../loop/bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TOOLS = '/opt/surface';
const LOOP = `${TOOLS}/loop`;
const CLI_MAIN = `${TOOLS}/wc/dist/src/cli/main.js`;
const PROXY_PORT = 8080;
/** The collect helper's caps for what comes back: a full run leaves thousands of capture files. */
export const COLLECT = { file: 16 * 1024 * 1024, total: 128 * 1024 * 1024, entries: 20000 };
const PART = /^(?!\.\.?$)[A-Za-z0-9._@+=-]{1,200}$/;

export class SbxError extends Error {}
const say = (s) => process.stdout.write(`${s}\n`);

/** The common parent of the workspace and the runner's temp folder: the work volume's mount point. */
export function mirrorRoot(workspace, temp) {
  for (const p of [workspace, temp]) if (!isAbsolute(String(p ?? '')) || !/^\/[A-Za-z0-9._/-]+$/.test(p) || p.includes('/..') || p.includes('/./')) throw new SbxError('GITHUB_WORKSPACE and RUNNER_TEMP must be plain absolute paths');
  const a = resolve(workspace).split('/'); const b = resolve(temp).split('/');
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  const root = a.slice(0, n).join('/');
  if (n < 3 || /^\/(?:proc|sys|dev|etc|tmp|opt|usr|bin|lib|sbin|work)(?:\/|$)/.test(root)) throw new SbxError(`the common parent ${root || '/'} of GITHUB_WORKSPACE and RUNNER_TEMP is not a folder the sandbox may mount`);
  return root;
}

/** A path inside the mirrored layout (the workspace, the temp folder or below), or an error. */
export function inMirror(path, st) {
  const p = resolve(st.workspace, String(path));
  if (!(p === st.mirror || p.startsWith(st.mirror + '/')) || !/^\/[A-Za-z0-9._@+=/-]+$/.test(p)) throw new SbxError(`${String(path).slice(0, 80)} is not under ${st.mirror}`);
  return p;
}

/** --flag value pairs before `--`, and the argv after it. Repeated flags gather in a list. */
export function parseOpts(argv, { lists = [], bools = [] } = {}) {
  const o = { _: [] };
  for (const k of lists) o[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (bools.includes(k)) { o[k] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new SbxError(`${a} takes a value`);
    if (lists.includes(k)) o[k].push(v); else o[k] = v;
  }
  return o;
}

/** K=V options as an object; a name that is not a plain variable name is refused (the sandbox's own check follows). */
export function envPairs(list) {
  const env = {};
  for (const kv of list ?? []) {
    const i = kv.indexOf('=');
    if (i <= 0 || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(kv.slice(0, i))) throw new SbxError(`--env takes NAME=value, not ${kv.slice(0, 40)}`);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

/** A run-network address from its last octet: .5 to .250 for services (.2 the logger, .3 the unit, .4 the probe). */
export function serviceIp(octet, NETS) {
  const n = Number(octet);
  if (!Number.isInteger(n) || n < 5 || n > 250) throw new SbxError('a service takes a last octet from 5 to 250');
  return NETS.run.subnet.replace(/0\/24$/, String(n));
}

/** The folders the CLI writes to (its --out and --state), from its arguments. */
export function cliOutDirs(args) {
  const out = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--out' || args[i] === '--state') out.push(args[i + 1]);
  return out;
}

/**
 * Writes collected files (parseCollected's map: relative path -> bytes) under `dest` on the host, only as new files and
 * only where every part of the path is a plain name, and only under the top-level entries `allow` gives (null: any).
 * Never follows a link (none can be in `dest`: it is ours, made here). Returns { written, refused }.
 */
export function writeCollected(files, dest, { allow = null, exists = existsSync } = {}) {
  let written = 0; let refused = 0;
  for (const [rel, data] of files) {
    const parts = String(rel).split('/');
    if (!parts.every((x) => PART.test(x)) || parts.length > 14 || (allow && !allow(parts[0]))) { refused++; continue; }
    const p = join(dest, ...parts);
    if (!p.startsWith(dest + sep) || exists(p)) { refused++; continue; }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data, { flag: 'wx', mode: 0o644 });
    written++;
  }
  return { written, refused };
}

const stateDir = (env) => join(env.RUNNER_TEMP, 'sbx-host');
const stateFile = (env) => join(stateDir(env), 'state.json');
const loadState = (env) => { try { return JSON.parse(readFileSync(stateFile(env), 'utf8')); } catch { throw new SbxError('the sandbox is not up (dogfood/sbx.mjs up)'); } };
const saveState = (env, st) => writeFileSync(stateFile(env), `${JSON.stringify(st, null, 2)}\n`);

/** The job's variables are set, and the sandbox checkout the driver loads is exactly SANDBOX_REF (a full commit). */
export function checkSandboxCheckout(env) {
  for (const k of ['MSC_DIR', 'SANDBOX_REF', 'GITHUB_WORKSPACE', 'RUNNER_TEMP']) if (!env[k]) throw new SbxError(`${k} is not set`);
  if (!/^[0-9a-f]{40}$/.test(env.SANDBOX_REF)) throw new SbxError('SANDBOX_REF must be a full commit SHA');
  const head = spawnSync('git', ['-C', env.MSC_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  if (head !== env.SANDBOX_REF) throw new SbxError('the sandbox checkout is not SANDBOX_REF');
}

/** The pinned sandbox library, and a Shard of loop/run-items.mjs bound to this job's run (its id, volumes, networks). */
export async function session(env, st = null, what = 'sbx') {
  checkSandboxCheckout(env);
  const M = await loadMsc(resolve(env.MSC_DIR));
  mkdirSync(stateDir(env), { recursive: true });
  const shard = new Shard({ o: { out: stateDir(env), lane: 'ci', cli: resolve(env.GITHUB_WORKSPACE, env.MWSC_CLI_PATH ?? '.') }, M, env });
  if (st) {
    shard.runId = st.runId;
    shard.dk = new M.Docker({ runId: st.runId, log: join(shard.shardDir, 'docker.log') });
    shard.toolsVol = st.toolsVol; shard.outNet = st.outNet;
  }
  shard.tel = new M.Telemetry(join(shard.shardDir, `telemetry-${what}-${process.pid}.jsonl`), { run: shard.runId });
  await shard.prepare();
  return { M, shard };
}

/** Streams a docker command's output to the job log as data: between stop-commands markers, so it can issue no command. */
export function stream(dk, argv, { timeoutMs = 0, onTimeout = null, quiet = false, bare = false, sink = process.stdout } = {}) {
  return new Promise((done) => {
    const token = randomUUID();
    // bare: the caller (the action, for the CLI) switches workflow commands off itself while it prints this output.
    const mark = (s) => { if (!quiet && !bare) sink.write(s); };
    mark(`::stop-commands::${token}\n`);
    const child = spawn('docker', argv, { env: dk.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c) => { if (!quiet) sink.write(c); });
    child.stderr.on('data', (c) => { if (!quiet) sink.write(c); });
    let timer = null; let timedOut = false;
    if (timeoutMs > 0) timer = setTimeout(async () => { timedOut = true; try { await onTimeout?.(); } catch { /* the kill below still runs */ } child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); mark(`\n::${token}::\n`); done({ exit: 127, timedOut }); });
    child.on('close', (code, signal) => { clearTimeout(timer); mark(`\n::${token}::\n`); done({ exit: code ?? 128 + (signal === 'SIGKILL' ? 9 : 15), timedOut }); });
  });
}

/** The unit's environment (runEnv of loop/run-items.mjs: HOME, TMPDIR and the rest are ours) and the in.mjs prefix. */
function inArgs(st, { pidfile = null, path = [] } = {}) {
  return ['node', `${LOOP}/dogfood-in.mjs`, '--env-file', st.envFile, '--temp', st.temp, '--workspace', st.workspace, ...(pidfile ? ['--pidfile', pidfile] : []), ...path.flatMap((p) => ['--path', p]), '--'];
}
const baseEnv = (extra = {}) => ({ HOME: '/tmp/home', TMPDIR: '/tmp', NO_COLOR: '1', DO_NOT_TRACK: '1', CI: '1', npm_config_update_notifier: 'false', SURFACE_SANDBOX: '1', ...extra });

/** Throws unless the sandbox's own rule (mcp-surface-corpus targetEnvProblems) accepts every name and value of env. */
export function checkEnv(M, env, hostEnv = process.env) {
  const bad = M.targetEnvProblems(env, hostEnv);
  if (bad.length) throw new SbxError(`refused: ${bad.join('; ').slice(0, 300)}`);
}

/**
 * The work volume's mounts for a container of ours or of the job: the workspace (read-write: the third-party trees, the
 * results), over it the harness at <workspace>/dogfood read-only (our scripts and manifests: nothing in the sandbox can
 * rewrite what later steps or the CLI read from there), and the tools read-only.
 */
export function workMounts(st, toolsVol) {
  return [{ src: st.wsVol, dst: st.mirror }, { src: st.harnessVol, dst: join(st.workspace, 'dogfood'), ro: true }, { src: toolsVol, dst: TOOLS, ro: true }];
}

/** Registry host names for a build's allowlist proxy: plain DNS names, at least one; no port, path, wildcard or address. */
export function parseHosts(list) {
  const hosts = String(list ?? '').split(',').filter(Boolean);
  if (!hosts.length || !hosts.every((h) => /^(?=.{3,100}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h) && !/^[0-9.]+$/.test(h))) throw new SbxError('--hosts takes registry host names');
  return hosts;
}

/**
 * The job's own variables the unit's commands get (up --pass): names of the workflow's env, such as GRAFANA_URL, which a
 * manifest names in env_public. Checked like every other value (a name or value the runner keeps secret is refused).
 */
export function passed(st, env = process.env) {
  const out = {};
  for (const k of st.pass ?? []) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

async function cmdUp(argv, env) {
  const o = parseOpts(argv, { lists: ['fwd', 'pass'] });
  for (const k of o.pass) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new SbxError(`--pass takes a variable name, not ${k.slice(0, 40)}`);
  if (existsSync(stateFile(env))) throw new SbxError('the sandbox is up already');
  const { M, shard } = await session(env, null, 'up');
  const st = {
    runId: shard.runId, t0: Date.now(), workspace: resolve(env.GITHUB_WORKSPACE), temp: resolve(env.RUNNER_TEMP),
    mirror: mirrorRoot(env.GITHUB_WORKSPACE, env.RUNNER_TEMP), services: [], containers: [], pass: o.pass,
  };
  st.envFile = join(st.temp, 'sbx-env', 'env');
  await shard.preflight();
  st.hostLog = shard.hostLog === true;
  await shard.prepareTools();
  st.toolsVol = shard.toolsVol; st.outNet = shard.outNet;
  // The workspace, at its own path: ours and the third-party checkouts (data until a sandbox container runs them).
  st.wsVol = await shard.dk.volume(`surface-${shard.runId}-ws`);
  const wsRel = relative(st.mirror, st.workspace);
  // dogfood/ (our scripts and manifests) is not in it: it goes into a volume of its own, owned by root and mounted
  // read-only over <workspace>/dogfood in every container, so a third-party install script cannot rewrite the harness.
  const tar = spawnSync('tar', ['-C', st.mirror, '-cf', '-', '--owner=0', '--group=0', `--exclude=${wsRel}/msc`, `--exclude=${wsRel}/mws-cli`, `--exclude=${wsRel}/.git`, `--exclude=${wsRel}/dogfood`, wsRel], { maxBuffer: 4 * 1024 * 1024 * 1024 });
  if (tar.status !== 0) throw new SbxError('packing the workspace failed');
  const tempRel = relative(st.mirror, st.temp);
  await shard.dk.must(shard.helper(null, { user: '0:0', stdin: true, capAdd: ['CHOWN'], mounts: [{ src: st.wsVol, dst: st.mirror }], cmd: ['sh', '-c', 'cd "$1" && tar -x -f - --no-same-owner && mkdir -p "$2/sbx-env" "$2/home" && : > "$2/sbx-env/env" && chown -R 65534:65534 "$1" && mkdir -p "$3/dogfood" && chown 0:0 "$3/dogfood" && chmod 755 "$3/dogfood"', 'sh', st.mirror, tempRel, wsRel] }, { input: tar.stdout, deadline: Date.now() + 600_000 }), 'workspace into the work volume');
  st.harnessVol = await shard.dk.volume(`surface-${shard.runId}-harness`);
  const htar = spawnSync('tar', ['-C', st.workspace, '-cf', '-', '--owner=0', '--group=0', '--mode=a+rX,go-w', 'dogfood'], { maxBuffer: 256 * 1024 * 1024 });
  if (htar.status !== 0) throw new SbxError('packing the harness failed');
  await shard.dk.must(shard.helper(null, { user: '0:0', stdin: true, mounts: [{ src: st.harnessVol, dst: '/h' }], cmd: ['sh', '-c', 'tar -x -f - --no-same-owner --strip-components=1 -C /h && chmod 755 /h'] }, { input: htar.stdout, deadline: Date.now() + 120_000 }), 'harness into its read-only volume');
  // The run network, its logger at .2, and the unit at .3.
  st.runNet = await shard.dk.network(`surface-${shard.runId}-run`, true, null, { sandbox: 'run' });
  st.netlog = await M.startNetlogOn(shard.dk, { net: 'run', network: st.runNet, image: shard.images.node24, toolsVol: shard.toolsVol, labels: shard.dk.labels(), target: null });
  const fwd = (o.fwd ?? []).map((f) => { const m = /^(\d+)=(\d+):(\d+)$/.exec(f); if (!m) throw new SbxError(`--fwd takes <port>=<last octet>:<port>, not ${f}`); return `${m[1]}=${serviceIp(m[2], M.NETS)}:${m[3]}`; });
  const key = o['unit-image'] ?? 'node22';
  if (!/^node(22|24)$/.test(key)) throw new SbxError('the unit image is node22 or node24');
  await shard.dk.image(shard.images[key], key);
  const name = `surface-${shard.runId}-unit`;
  const cidfile = join(shard.cidDir, `${name}.cid`);
  const uargv = M.sandboxRunArgs({ name, image: shard.images[key], network: st.runNet, ip: M.NETS.run.target, resolv: 'run', cidfile, detach: true, labels: shard.dk.labels(), cpus: shard.cpus, workdir: st.workspace, mounts: workMounts(st, shard.toolsVol), env: baseEnv(), cmd: ['node', `${LOOP}/dogfood-unit.mjs`, ...fwd] });
  shard.writeSettings(uargv, { subject: 'unit', role: 'server' });
  await shard.dk.must(shard.dk.d(uargv, { deadline: Date.now() + 120_000 }), 'unit container');
  for (let until = Date.now() + 30_000; ;) {
    const l = await shard.dk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
    if (M.jsonLines(l.stdout).some((x) => Array.isArray(x.listening))) break;
    if (Date.now() >= until) throw new SbxError('the unit did not start');
    await sleep(250);
  }
  st.unit = { name, cidfile, image: key, fwd };
  st.containers.push({ name, cidfile, role: 'unit' });
  saveState(env, st);
  say(`sandbox up: run ${shard.runId}, workspace mirrored at ${st.workspace}, unit ${key}${fwd.length ? `, forwarding ${fwd.join(' ')}` : ''}`);
}

async function cmdBuild(argv, env) {
  const o = parseOpts(argv, { lists: ['env', 'path'], bools: ['native'] });
  if (!o.cmd?.length || !o.image || !o.hosts || !o.cwd) throw new SbxError('build takes --image, --hosts, --cwd and -- argv');
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'build');
  if (!/^(node22|node24)-build$|^go$/.test(o.image)) throw new SbxError('a build runs in node22-build, node24-build or go');
  const image = shard.images[o.image];
  await shard.dk.image(image, o.image);
  const hosts = parseHosts(o.hosts);
  const cwd = inMirror(o.cwd, st);
  const minutes = Number(o.minutes ?? 15);
  if (!(minutes > 0 && minutes <= 30)) throw new SbxError('--minutes is 1 to 30');
  const tag = `b${randomBytes(3).toString('hex')}`;
  const inNet = await shard.dk.network(`surface-${shard.runId}-${tag}-in`, true, null, { sandbox: 'install' });
  const netlog = await M.startNetlogOn(shard.dk, { net: 'install', network: inNet, image: shard.images.node24, toolsVol: shard.toolsVol, labels: shard.dk.labels(), target: tag });
  const proxy = `surface-${shard.runId}-${tag}-proxy`;
  let exit = 1;
  const egress = [];
  try {
    const publicHosts = await shard.resolveRegistries(hosts);
    const pargv = M.helperRunArgs({ name: proxy, image: shard.images.node24, network: shard.outNet, create: true, labels: shard.dk.labels(), memory: '256m', publicHosts, mounts: [{ src: shard.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${TOOLS}/sandbox/egress-proxy.mjs`, String(PROXY_PORT), ...hosts] });
    shard.writeSettings(pargv, { subject: tag, role: 'proxy' });
    await shard.dk.must(shard.dk.d(pargv), 'egress proxy');
    await shard.dk.must(shard.dk.d(['network', 'connect', '--ip', M.NETS.install.proxy, inNet, proxy]), 'egress proxy network');
    await shard.dk.must(shard.dk.d(['start', proxy]), 'egress proxy start');
    for (let until = Date.now() + 30_000; ;) {
      const pl = await shard.dk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
      if (M.jsonLines(pl.stdout).some((x) => Number.isInteger(x.listening))) break;
      if (Date.now() >= until) throw new SbxError('the egress proxy did not start');
      await sleep(250);
    }
    const url = `http://${M.NETS.install.proxy}:${PROXY_PORT}`;
    const benv = {
      ...baseEnv({ HOME: join(st.temp, 'home'), npm_config_cache: join(st.temp, 'home', '.npm'), npm_config_fund: 'false', npm_config_audit: 'false' }),
      HTTPS_PROXY: url, https_proxy: url, HTTP_PROXY: url, http_proxy: url, NO_PROXY: '', no_proxy: '',
      // GOTMPDIR: go's build folder fills the sandbox's 512 MiB /tmp on a large module (the Grafana server); the volume has room.
      ...(o.image === 'go' ? { GOTMPDIR: join(st.temp, 'gotmp'), GOPATH: join(st.temp, 'go'), GOCACHE: join(st.temp, 'gocache'), GOMODCACHE: join(st.temp, 'go', 'pkg', 'mod'), GOTOOLCHAIN: 'local', GOPROXY: 'https://proxy.golang.org', GOSUMDB: 'sum.golang.org', GOTELEMETRY: 'off' } : {}),
      // R-WC-09's build: a native module compiles from source against the image's own Node headers (no download).
      ...(o.native ? { ...M.NATIVE_BUILD_ENV } : { npm_config_nodedir: '/usr/local' }),
      ...envPairs(o.env),
    };
    checkEnv(M, benv);
    const name = `surface-${shard.runId}-${tag}-build`;
    const cidfile = join(shard.cidDir, `${name}.cid`);
    // The go image has no Node: its command runs as given. Every other build runs through dogfood-in.mjs (the temp folder).
    if (o.image === 'go' && o.path.length) throw new SbxError('--path needs dogfood-in.mjs, which the go image cannot run');
    const cmd = o.image === 'go' ? ['sh', '-c', 'mkdir -p "$GOTMPDIR" && exec "$@"', 'sh', ...o.cmd] : [...inArgs(st, { path: o.path.map((x) => inMirror(x, st)) }), ...o.cmd];
    const bargv = M.sandboxRunArgs({ name, image, network: inNet, ip: M.NETS.install.target, resolv: 'install', cidfile, labels: shard.dk.labels(), cpus: shard.cpus, workdir: cwd, mounts: workMounts(st, shard.toolsVol), env: benv, cmd });
    shard.writeSettings(bargv, { subject: tag, role: 'install' });
    const t0 = Date.now();
    say(`build in ${o.image} (egress: ${hosts.join(', ')} only, through the allowlist proxy), in ${relative(st.mirror, cwd)}`);
    const r = await stream(shard.dk, bargv, { timeoutMs: minutes * 60_000, onTimeout: () => shard.dk.kill(name) });
    await shard.recordContainer({ id: shard.readCid(cidfile), t0, exit: r.exit, timedOut: r.timedOut, meta: { subject: tag, role: 'install' } });
    exit = r.timedOut ? 124 : r.exit;
  } finally {
    try { M.writeNetlog(shard.tel, await M.stopNetlog(shard.dk, netlog), { subject: tag, roles: M.rolesOn('install') }); } finally { await shard.dk.kill(netlog); }
    const pl = await shard.dk.d(['logs', proxy], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
    for (const e of M.jsonLines(pl.stdout).slice(0, 5000)) {
      const x = M.fromProxy(e);
      if (x) { shard.tel.tryWrite(x[0], x[1], { source: 'proxy', subject: tag, role: 'proxy' }); egress.push(x[1]); }
    }
    await shard.dk.kill(proxy);
    await shard.dk.d(['network', 'rm', inNet], { deadline: Date.now() + 60_000 });
  }
  const refused = [...new Set(egress.filter((e) => !e.allowed).map((e) => e.host))];
  say(`build exit ${exit}; egress: ${egress.filter((e) => e.allowed).length} request(s) allowed${refused.length ? `, refused to ${refused.slice(0, 10).join(', ')}` : ''}`);
  return exit;
}

async function cmdSvc(argv, env) {
  const o = parseOpts(argv, { lists: ['env', 'secret-env'], bools: ['wrap'] });
  if (!o.name || !/^[a-z][a-z0-9-]{0,20}$/.test(o.name)) throw new SbxError('svc takes --name (lower-case letters, digits, dashes)');
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'svc');
  if (st.services.some((s) => s.name === o.name)) throw new SbxError(`the service ${o.name} is up already`);
  const ip = serviceIp(o.ip, M.NETS);
  if (st.services.some((s) => s.ip === ip)) throw new SbxError(`${ip} is taken`);
  let image;
  if (o['image-ref']) image = M.checkPinned(o['image-ref'], 'service');
  else if (/^(node22|node24|python)$/.test(o.image ?? '')) image = shard.images[o.image];
  else throw new SbxError('svc takes --image node22|node24|python or --image-ref <pinned ref>');
  await shard.dk.image(image, o.name);
  const senv = { ...baseEnv(), ...envPairs(o.env) };
  // A random value for the service only (an admin password): made here, passed to the container, and written to a file in
  // the work volume (owned by the sandbox user, mode 600) for the set-up scripts. It is never in the runner's environment.
  for (const spec of o['secret-env']) {
    const i = spec.indexOf('=');
    const name = spec.slice(0, i); const file = inMirror(spec.slice(i + 1), st);
    if (i <= 0 || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new SbxError('--secret-env takes NAME=<file>');
    const value = randomBytes(18).toString('hex');
    senv[name] = value;
    await shard.dk.must(shard.helper(null, { stdin: true, mounts: [{ src: st.wsVol, dst: st.mirror }], cmd: ['sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', file] }, { input: Buffer.from(value) }), 'write a service secret');
  }
  checkEnv(M, senv);
  const name = `surface-${shard.runId}-svc-${o.name}`;
  const cidfile = join(shard.cidDir, `${name}.cid`);
  // A service of our images works in the mirrored workspace; an image's own (Grafana, Postgres) in a plain folder of it.
  const cwd = o.cwd ? inMirror(o.cwd, st) : o.workdir && o['image-ref'] && /^\/[A-Za-z0-9._/-]{1,120}$/.test(o.workdir) && !o.workdir.includes('..') ? o.workdir : '/tmp';
  if (o.entrypoint && !/^\/[A-Za-z0-9._/-]{1,120}$/.test(o.entrypoint)) throw new SbxError('--entrypoint takes an absolute path');
  const mounts = o['image-ref'] ? [{ src: shard.toolsVol, dst: TOOLS, ro: true }] : workMounts(st, shard.toolsVol);
  const cmd = o.wrap ? [...inArgs(st), ...(o.cmd ?? [])] : (o.cmd ?? []);
  const sargv = M.sandboxRunArgs({ name, image, network: st.runNet, ip, resolv: 'run', cidfile, detach: true, labels: shard.dk.labels(), cpus: shard.cpus, workdir: cwd, mounts, env: senv, cmd, ...(o.entrypoint ? { entrypoint: o.entrypoint } : {}) });
  shard.writeSettings(sargv, { subject: o.name, role: 'server' });
  await shard.dk.must(shard.dk.d(sargv, { deadline: Date.now() + 120_000 }), `service ${o.name}`);
  st.services.push({ name: o.name, container: name, cidfile, ip });
  st.containers.push({ name, cidfile, role: `svc-${o.name}` });
  saveState(env, st);
  say(`service ${o.name} started at ${ip}`);
}

/** The `docker exec` arguments of a command in the unit; its environment must pass the sandbox's own check first. */
export function execArgv(st, M, { cwd, env = {}, path = [], bg = false, pidfile, cmd }, hostEnv = process.env) {
  const all = { ...passed(st, hostEnv), ...env };
  checkEnv(M, all, hostEnv);
  return ['exec', ...(bg ? ['--detach'] : []), '--workdir', cwd, ...Object.entries(all).flatMap(([k, v]) => ['--env', `${k}=${v}`]), st.unit.name, ...inArgs(st, { pidfile, path }), ...cmd];
}

/** `docker exec` in the unit, streamed. With --bg, detached (a helper process of the job, such as the payload shim). */
async function unitExec(st, shard, M, { cwd, env, path = [], bg = false, cmd, sink, signals = false, bare = false }) {
  const pidfile = `/tmp/sbx-${randomBytes(4).toString('hex')}.pid`;
  const argv = execArgv(st, M, { cwd, env, path, bg, pidfile, cmd });
  if (bg) { const r = await shard.dk.d(argv, { deadline: Date.now() + 60_000 }); return r.exit; }
  let cancelled = false;
  const pass = (sig) => { if (cancelled) return; cancelled = true; spawnSync('docker', ['exec', st.unit.name, 'sh', '-c', `kill -${sig === 'SIGINT' ? 'INT' : 'TERM'} "$(cat ${pidfile})"`], { env: shard.dk.env, timeout: 10_000 }); };
  if (signals) { process.on('SIGINT', pass); process.on('SIGTERM', pass); }
  const r = await stream(shard.dk, argv, { sink, bare });
  return r.exit;
}

async function cmdExec(argv, env) {
  const o = parseOpts(argv, { lists: ['env', 'path'], bools: ['bg'] });
  if (!o.cmd?.length) throw new SbxError('exec takes -- argv');
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'exec');
  const cwd = inMirror(o.cwd ?? st.workspace, st);
  return unitExec(st, shard, M, { cwd, env: envPairs(o.env), path: (o.path ?? []).map((p) => inMirror(p, st)), bg: !!o.bg, cmd: o.cmd, signals: true });
}

async function cmdRun(argv, env) {
  const o = parseOpts(argv, { lists: ['env'] });
  if (!o.cmd?.length || !/^(python|node22|node24)$/.test(o.image ?? '')) throw new SbxError('run takes --image python|node22|node24 and -- argv');
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'run');
  const image = shard.images[o.image];
  await shard.dk.image(image, o.image);
  const renv = { ...baseEnv(), ...envPairs(o.env) };
  checkEnv(M, renv);
  const name = `surface-${shard.runId}-run-${randomBytes(3).toString('hex')}`;
  const cidfile = join(shard.cidDir, `${name}.cid`);
  const rargv = M.sandboxRunArgs({ name, image, network: st.runNet, ip: serviceIp(240, M.NETS), resolv: 'run', cidfile, labels: shard.dk.labels(), cpus: shard.cpus, workdir: inMirror(o.cwd ?? st.workspace, st), mounts: workMounts(st, shard.toolsVol), env: renv, cmd: o.cmd });
  shard.writeSettings(rargv, { subject: 'run', role: 'server' });
  const t0 = Date.now();
  const r = await stream(shard.dk, rargv, { timeoutMs: 10 * 60_000, onTimeout: () => shard.dk.kill(name) });
  await shard.recordContainer({ id: shard.readCid(cidfile), t0, exit: r.exit, timedOut: r.timedOut, meta: { subject: 'run', role: 'server' } });
  return r.exit;
}

/**
 * Writes what came back from one of the CLI's folders only under top-level entries that were not on the host before the
 * call: a folder the host had (the action's own plan/ folder, an earlier run's results) never gains or loses a file.
 */
export function writeBack(files, dest, seen) {
  return writeCollected(files, dest, { allow: (top) => !seen.has(top) });
}

/**
 * Runs fn with every long-lived container of the job (the unit and the services) paused, so no process left running there
 * can change a file while it is read (collect, pull); they are resumed afterwards. A pause that fails stops the read.
 */
export async function whilePaused(dk, names, fn) {
  const paused = [];
  try {
    for (const n of names) {
      const r = await dk.d(['pause', n], { deadline: Date.now() + 60_000 });
      if (r.exit !== 0) throw new SbxError(`could not pause ${n}: nothing is read while a container of the job runs`);
      paused.push(n);
    }
    return await fn();
  } finally {
    for (const n of paused.reverse()) await dk.d(['unpause', n], { deadline: Date.now() + 60_000 });
  }
}
const longLived = (st) => (st.containers ?? []).map((c) => c.name);

/** Brings a folder of the work volume back through the collect helper; returns parseCollected's result. */
async function collect(st, shard, root) {
  const c = await whilePaused(shard.dk, longLived(st), () => shard.helper(null, { mounts: [{ src: st.wsVol, dst: st.mirror, ro: true }, { src: shard.toolsVol, dst: TOOLS, ro: true }], cmd: ['node', `${LOOP}/collect.mjs`, root, String(COLLECT.file), String(COLLECT.total), String(COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 256 * 1024 * 1024, deadline: Date.now() + 600_000 }));
  if (c.exit !== 0) throw new SbxError(`collecting ${root} failed (exit ${c.exit})`);
  return parseCollected(c.stdout.toString('utf8'));
}

/** Prints one file of the work volume: only a regular file whose real path is the one asked for (no link on the way). */
export const PULL_JS = `const fs = require('fs'); const p = process.argv[1];
const st = fs.lstatSync(p); if (!st.isFile() || fs.realpathSync(p) !== p || st.size > 16 * 1024 * 1024) process.exit(3);
process.stdout.write(fs.readFileSync(p));`;

async function cmdPull(argv, env) {
  const [from, to] = argv;
  if (!from || !to) throw new SbxError('pull takes <file in the sandbox> <host file>');
  const st = loadState(env);
  const { shard } = await session(env, st, 'pull');
  const src = inMirror(from, st);
  const dest = resolve(to);
  if (existsSync(dest)) throw new SbxError(`${to} exists already`);
  // Our helper (no network, the volume read-only) reads one regular file, never through a link, at most 16 MiB.
  const r = await whilePaused(shard.dk, longLived(st), () => shard.helper(null, { mounts: [{ src: st.wsVol, dst: st.mirror, ro: true }], cmd: ['node', '-e', PULL_JS, src] }, { keepStdout: true, logStdout: false, cap: 16 * 1024 * 1024 + 1024, deadline: Date.now() + 120_000 }));
  if (r.exit !== 0 || r.stdout_truncated) throw new SbxError(`${from} did not come back (not a regular file, a link, missing, or over 16 MiB)`);
  const data = r.stdout;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, data, { flag: 'wx' });
  say(`pulled ${from} (${data.length} bytes) as data`);
}

async function cmdLogs(argv, env) {
  const [svc, lines = '80'] = argv;
  const st = loadState(env);
  const { shard } = await session(env, st, 'logs');
  const s = svc === 'unit' ? { container: st.unit.name } : st.services.find((x) => x.name === svc);
  if (!s || !/^\d{1,4}$/.test(lines)) throw new SbxError('logs takes a service name (or unit) and a line count');
  await stream(shard.dk, ['logs', '--tail', lines, s.container]);
}

async function cmdDown(argv, env) {
  if (!existsSync(stateFile(env))) { say('the sandbox was not up'); return 0; }
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'down');
  const missing = [];
  shard.missing = missing;
  shard.hostLog = st.hostLog === true;
  for (const c of st.containers) {
    await shard.dk.d(['stop', '-t', '5', c.name], { deadline: Date.now() + 30_000 });
    await shard.recordContainer({ id: shard.readCid(c.cidfile), t0: st.t0, exit: null, meta: { subject: c.role, role: 'server' } });
  }
  let net = { records: 0 };
  try { net = M.writeNetlog(shard.tel, await M.stopNetlog(shard.dk, st.netlog), { subject: 'run', roles: { ...M.rolesOn('run', { target: 'unit' }), ...Object.fromEntries(st.services.map((s) => [s.ip, `svc-${s.name}`])) } }) ?? net; } catch { missing.push('the network logger'); }
  const drops = shard.recordDrops(st.t0, 'job');
  await shard.dk.sweep();
  M.sweepTraces(shard.cfg, 0);
  say(`sandbox down: ${st.containers.length} long-lived container(s) removed; network log records ${net.records ?? 'unknown'}; firewall log ${drops ? 'read' : 'not read'}${missing.length ? `; evidence missing: ${missing.join(', ')}` : ''}`);
  appendFileSync(join(stateDir(env), 'down.json'), `${JSON.stringify({ at: new Date().toISOString(), missing })}\n`);
  return 0;
}

/**
 * The CLI, for the action's `cli-path` (dogfood/sbx-cli/): `node <entry> <args>` from the action becomes the pinned CLI
 * (the build in the read-only tools volume) in the unit, in the mirrored workspace, with the same arguments. What it
 * writes under --out and --state comes back through the collect helper, as new files only, so the action reads the
 * results where it expects them. The CLI's stdout and stderr pass through (the action switches workflow commands off
 * while it prints them).
 */
export async function cli(args, env = process.env) {
  const st = loadState(env);
  const { M, shard } = await session(env, st, 'cli');
  const outs = cliOutDirs(args).map((d) => ({ host: resolve(d), box: inMirror(d, st) }));
  const before = new Map(outs.map((d) => [d.host, new Set(existsSync(d.host) ? readdirSync(d.host) : [])]));
  const code = await unitExec(st, shard, M, { cwd: st.workspace, env: {}, cmd: ['node', CLI_MAIN, ...args], sink: process.stdout, signals: true, bare: true });
  for (const d of outs) {
    // --state lies under --out in the action's full run: that folder comes back with --out.
    if (outs.some((x) => x !== d && d.host.startsWith(x.host + sep))) continue;
    let got;
    try { got = await collect(st, shard, d.box); } catch (e) { process.stderr.write(`sbx: ${e.message}\n`); continue; }
    mkdirSync(d.host, { recursive: true });
    const seen = before.get(d.host);
    const w = writeBack(got.files, d.host, seen);
    if (w.refused || got.done?.capped) process.stderr.write(`sbx: ${relative(st.workspace, d.host)}: ${w.written} file(s) back, ${w.refused} refused${got.done?.capped ? ', capped' : ''}\n`);
  }
  return code;
}

const COMMANDS = { up: cmdUp, build: cmdBuild, svc: cmdSvc, exec: cmdExec, run: cmdRun, pull: cmdPull, logs: cmdLogs, down: cmdDown };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const fn = COMMANDS[cmd];
  if (!fn) { process.stderr.write(`usage: sbx.mjs ${Object.keys(COMMANDS).join('|')} ...\n`); process.exit(2); }
  fn(rest, process.env).then((rc) => { process.exitCode = Number.isInteger(rc) ? rc : 0; }, (e) => {
    say(`::error title=sandbox::${e instanceof SbxError || e?.name === 'HarnessError' ? String(e.message).slice(0, 300).replace(/[^\x20-\x7e]/g, '?') : 'the sandbox driver failed'}`);
    if (!(e instanceof SbxError)) process.stderr.write(`${String(e?.stack).slice(0, 2000)}\n`);
    process.exitCode = 1;
  });
}
export { here };

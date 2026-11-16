#!/usr/bin/env node
/**
 * Third-party corpus driver: runs mcp-writecheck against one shard of the corpus target list.
 * The same script runs in the public nightly workflow (lane `ci`) and on IsoKron's own machine for
 * the long tail (lane `mac`), and writes the same record format in both places.
 *
 *   node corpus/run-shard.mjs --targets T.json --cli DIR --out DIR [--work DIR] [--lane ci|mac]
 *                             [--shard N --shards M] [--only ID,ID] [--cli-commit SHA]
 *                             [--consume-targets] [--images corpus/images.json]
 *
 * Isolation (every target is untrusted). No target code runs on the host. Each target's install,
 * set-up, CLI and server run in containers of a digest-pinned image (corpus/images.json), started
 * with `sandboxRunArgs`: user 10001, --cap-drop ALL, no-new-privileges, a read-only root, a tmpfs
 * /tmp, pid and memory limits, and only Docker volumes mounted (the target's own work volume, the
 * CLI read-only and the tools read-only). No bind mount of any host path: not the workspace,
 * RUNNER_TEMP, _actions, the home folder or the Docker socket. Install runs on a network with
 * egress; set-up, the CLI and the server run on an --internal network shared only with that
 * target's backends, which are digest-pinned too. Outputs leave the work volume through a helper
 * that copies regular files and folders only, under a size cap. The host keeps the clear-text
 * target list, the secrets, the encrypt step and the upload; no container can reach them.
 *
 * Public-output rule (the corpus is not a findings channel): stdout carries only
 *
 *     automated candidate, unreviewed: not a finding
 *     run finished, exit N
 *
 * one "run finished" line per target, with no target name, no verdict and no record line.
 * Everything else (install logs, backend logs, the CLI's own output, the server's output,
 * results.json, report.md, the ledger, metadata) goes to files under --out, which the workflow
 * encrypts to the archive's public key before upload.
 *
 * N is the public exit of that target, never a verdict:
 *     0   the CLI ran to completion (CLI exit 0 or 1: exit 1 is a violated MUST, a verdict, so it
 *         is folded to 0 here; the real exit is in the encrypted metadata)
 *     2, 3, 4, 130   the CLI's own usage/manifest error, refusal, stopped run, interruption
 *     70  the CLI crashed (killed by a signal, or an exit status the CLI does not document)
 *     124 the target hit its time limit
 *     125 harness error (download, checksum, install, backend, set-up, a container that did not
 *         start, this script)
 * A CLI problem already recorded for a target in the list (`expect`) reports 0 and is kept in the
 * metadata as expected_cli_error; any other problem keeps its code.
 * The process exits 0 when every target's public exit is 0, and 1 otherwise: only our tool or
 * the harness turns a run red, never a target's verdict.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LABEL = 'automated candidate, unreviewed: not a finding';
export const RUN_FORMAT = 'isokron-corpus-run/2';
export const TARGETS_FORMAT = 'isokron-corpus-targets/2';
export const SANDBOX_USER = '10001:10001';
const CLI_DOCUMENTED = new Set([0, 1, 2, 3, 4, 130]);
/** `docker run` itself failed (daemon error, command not found or not executable). */
const DOCKER_RUN_FAILED = new Set([125, 126, 127]);
const say = (line) => process.stdout.write(`${line}\n`);
const here = dirname(fileURLToPath(import.meta.url));

/** In-container paths. /work is the target's own volume; /opt/mwsc and /opt/tools are read-only. */
export const P = { work: '/work', out: '/work/out', cli: '/opt/mwsc', tools: '/opt/tools', home: '/work/home' };
export const CLI_MAIN = `${P.cli}/dist/src/cli/main.js`;
/** Capabilities a backend may ask for (`cap_add` in the target list); everything else stays dropped. */
export const BACKEND_CAPS = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL', 'NET_BIND_SERVICE']);
/** Size cap for what one target's outputs may bring back to the host (bytes of tar). */
const COPY_OUT_CAP = Number(process.env.CORPUS_COPY_OUT_CAP || 1024 * 1024 * 1024);
/** Per command: log bytes kept on the host, and stdout bytes kept in memory. Output past either is dropped. */
const LOG_CAP = Number(process.env.CORPUS_LOG_CAP || 64 * 1024 * 1024);
const BUF_CAP = Number(process.env.CORPUS_BUF_CAP || 16 * 1024 * 1024);
/** results.json larger than this is recorded by size only, never read into memory. */
const JSON_CAP = 64 * 1024 * 1024;

/** The public exit of one target (see the header). Pure; unit-tested. */
export function publicExit(t) {
  if (t.status === 'timeout') return 124;
  if (t.status === 'harness_error') return 125;
  if (t.status === 'cli_crash') return 70;
  if (t.status === 'cli_error') return CLI_DOCUMENTED.has(t.cli_exit) ? t.cli_exit : 70;
  return 0; // completed, or expected_cli_error (a known CLI problem recorded in the target list)
}

/**
 * Classify one CLI step: completed (0/1), cli_error (2/3/4/130), cli_crash (signal or undocumented),
 * harness_error (the container did not start: docker run's own 125/126/127).
 */
export function classifyCli(step) {
  if (step.timed_out) return 'timeout';
  if (step.spawn_error) return 'harness_error';
  if (step.signal || step.exit === null) return 'cli_crash';
  if (step.exit === 0 || step.exit === 1) return 'completed';
  if (CLI_DOCUMENTED.has(step.exit)) return 'cli_error';
  if (step.container && DOCKER_RUN_FAILED.has(step.exit)) return 'harness_error';
  return 'cli_crash';
}

/** `{{name}}` templates in strings, arrays and objects. Unknown names are an error (harness). */
export function fill(v, vars) {
  if (typeof v === 'string') {
    return v.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new HarnessError(`template variable ${k} is not set`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

/** The generic catalog manifest: the server block and a stub resource (catalog mode calls no tool). */
export function catalogManifest(command, envNames, confirm) {
  const q = (s) => JSON.stringify(s);
  return [
    '# Generated by corpus/run-shard.mjs: catalog and plan only. The stub resource is never called;',
    '# catalog mode reads tools/list and calls no tool. A full run needs a hand-written manifest.',
    'mws: "0.9"',
    'server:',
    `  stdio: [${command.map(q).join(', ')}]`,
    `  env_passthrough: [${envNames.map(q).join(', ')}]`,
    '  processes: separate',
    'target:',
    '  environment: test',
    `  confirm: ${q(confirm)}`,
    'resources:',
    '  - name: catalogstub',
    '    read: { tool: mwsc_catalog_stub, args: { id: "{{id}}" } }',
    '    fixture: { id: mwsc-catalog-stub, name: mwsc-catalog-stub }',
    '    cleanup: leave',
    '',
  ].join('\n');
}

export class HarnessError extends Error {}

const DIGEST_REF = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
/** An image reference must be pinned by digest. */
export function checkPinned(ref, what) {
  if (typeof ref !== 'string' || !DIGEST_REF.test(ref)) throw new HarnessError(`${what}: image is not pinned by digest`);
  return ref;
}

/** A target id is used in container, volume and network names. */
export function checkId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) throw new HarnessError('target id must match [a-z0-9][a-z0-9-]{0,31}');
  return id;
}

/** `linux-x64` or `linux-arm64`, from `docker version`'s server OS/arch. */
export function platformKey(osArch) {
  const [os, a] = String(osArch).trim().split('/');
  if (os !== 'linux') throw new HarnessError(`containers must be Linux, not ${os}`);
  const m = { amd64: 'x64', x86_64: 'x64', arm64: 'arm64', aarch64: 'arm64' }[a];
  if (!m) throw new HarnessError(`unsupported container architecture ${a}`);
  return `linux-${m}`;
}

/**
 * The environment of the docker CLI processes this script starts: what docker needs to find its
 * daemon and config, nothing else. No GITHUB_*, no ACTIONS_*, no RUNNER_*, no token.
 */
export function dockerEnvFrom(env) {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY'];
  return Object.fromEntries(keep.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/** The environment inside a target container (install, set-up, CLI, server). Fixed, plus `extra`. */
export function sandboxEnv(binDir, extra = {}) {
  return {
    // The target's own bin folder comes last: a package that ships a `node`, `npm`, `uv`, `sh` or `tar`
    // (the npm package `node` does) must not replace the tools that run the CLI and the install.
    PATH: [P.tools, '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', binDir].filter(Boolean).join(':'),
    HOME: P.home, TMPDIR: '/tmp', XDG_CACHE_HOME: `${P.home}/.cache`, XDG_CONFIG_HOME: `${P.home}/.config`,
    npm_config_cache: `${P.home}/.npm`, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false',
    UV_CACHE_DIR: `${P.home}/.cache/uv`, UV_PYTHON_INSTALL_DIR: `${P.work}/python`, UV_PYTHON_PREFERENCE: 'only-managed',
    PIP_CACHE_DIR: `${P.home}/.cache/pip`, NO_COLOR: '1', DO_NOT_TRACK: '1', CORPUS_SANDBOX: '1',
    ...extra,
  };
}

/**
 * `docker run` arguments for a container that runs target-controlled code. The flags are fixed here
 * and unit-tested; only volumes (never a bind mount), the network, the env and the command vary.
 */
export function sandboxRunArgs({ name, image, network, mounts, env = {}, labels = {}, workdir = P.work, stdin = false, cmd }) {
  checkPinned(image, 'sandbox');
  const a = [
    'run', '--rm', '--name', name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--user', SANDBOX_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,exec,size=1g',
    '--pids-limit', '1024',
    '--memory', '4g', '--memory-swap', '4g',
    '--init',
    '--hostname', 'corpus',
    '--network', network,
    '--workdir', workdir,
  ];
  for (const m of mounts) a.push('--mount', volumeMount(m));
  for (const [k, v] of Object.entries(env)) a.push('--env', `${k}=${v}`);
  if (stdin) a.push('--interactive');
  a.push(image, ...cmd);
  return a;
}

/** Only named Docker volumes, by a name this script made; never a host path. */
export function volumeMount({ src, dst, ro = false }) {
  if (!/^corpus-[a-z0-9-]+$/.test(src)) throw new HarnessError('only corpus volumes are mounted');
  if (!/^\/(work|opt\/mwsc|opt\/tools)$/.test(dst)) throw new HarnessError(`unexpected mount point ${dst}`);
  return `type=volume,src=${src},dst=${dst}${ro ? ',readonly' : ''}`;
}

/** `docker run -d` arguments for one backend: digest-pinned, on the target's internal network only. */
export function backendRunArgs({ name, image, network, alias, env = {}, args = [], capAdd = [], labels = {} }) {
  checkPinned(image, 'backend');
  for (const c of capAdd) if (!BACKEND_CAPS.has(c)) throw new HarnessError(`backend capability ${c} is not allowed`);
  return [
    'run', '-d', '--name', name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--network', network, '--network-alias', alias,
    '--cap-drop', 'ALL', ...capAdd.flatMap((c) => ['--cap-add', c]),
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '1024', '--memory', '2g',
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    image, ...args,
  ];
}

/**
 * The install commands for one target, in order, each run in its own sandbox container.
 * `net` is `egress` (registries reachable) or `none`. Files are written into the volume first.
 * Hash-locked (M4): npm targets install with `npm ci` from the package-lock.json pinned in the list;
 * PyPI targets with `uv pip install --require-hashes` from the lock pinned for this platform.
 */
export function installPlan(t, plat) {
  const files = [];
  const steps = [];
  if (t.ecosystem === 'npm') {
    if (!t.lock?.package_json || !t.lock?.package_lock) throw new HarnessError('npm target is not hash-locked (lock.package_json, lock.package_lock)');
    files.push({ path: `${P.work}/pkg/artifact.tgz`, artifact: true });
    files.push({ path: `${P.work}/pkg/package.json`, text: t.lock.package_json });
    files.push({ path: `${P.work}/pkg/package-lock.json`, text: t.lock.package_lock });
    steps.push({ name: 'install', net: 'egress', workdir: `${P.work}/pkg`, cmd: ['npm', 'ci', '--no-audit', '--no-fund', '--loglevel=error', ...(t.install_scripts ? [] : ['--ignore-scripts'])] });
    steps.push({ name: 'deps', net: 'none', workdir: `${P.work}/pkg`, cmd: ['npm', 'ls', '--all', '--json'], capture: 'deps.json', mayFail: true });
    return { files, steps, bin: `${P.work}/pkg/node_modules/.bin`, pkgdir: `${P.work}/pkg/node_modules/${t.package}` };
  }
  if (t.ecosystem === 'pypi') {
    const lock = t.lock?.pypi?.[plat];
    if (typeof lock !== 'string') throw new HarnessError(`pypi target is not hash-locked for ${plat} (lock.pypi.${plat})`);
    const file = t.artifact?.file;
    if (!/^[A-Za-z0-9._+-]+\.(whl|tar\.gz|zip)$/.test(file ?? '')) throw new HarnessError('pypi artifact file name');
    const py = `${P.work}/venv/bin/python`;
    const binary = t.allow_build ? [] : ['--only-binary', ':all:'];
    files.push({ path: `${P.work}/dl/${file}`, artifact: true });
    files.push({ path: `${P.work}/lock.txt`, text: lock });
    steps.push({ name: 'install', net: 'egress', cmd: ['uv', 'venv', '--quiet', '--python', t.python ?? '3.12', `${P.work}/venv`] });
    if (lock.trim()) steps.push({ name: 'install', net: 'egress', cmd: ['uv', 'pip', 'install', '--quiet', '--python', py, '--require-hashes', '--no-deps', ...binary, '-r', `${P.work}/lock.txt`] });
    // The target itself: the artifact whose sha256 the host checked, with no dependency resolution.
    steps.push({ name: 'install', net: 'none', cmd: ['uv', 'pip', 'install', '--quiet', '--offline', '--python', py, '--no-deps', ...(file.endsWith('.whl') ? binary : []), `${P.work}/dl/${file}`] });
    steps.push({ name: 'deps', net: 'none', cmd: ['uv', 'pip', 'freeze', '--python', py], capture: 'deps.txt', mayFail: true });
    return { files, steps, bin: `${P.work}/venv/bin`, pkgdir: null, needsUv: true };
  }
  if (t.ecosystem === 'binary') {
    const a = t.artifact?.[plat];
    if (!a) throw new HarnessError(`no artifact for ${plat}`);
    if (!/^[A-Za-z0-9._+-]+\.(tar\.gz|tgz)$/.test(a.file ?? '')) throw new HarnessError('binary artifact file name');
    files.push({ path: `${P.work}/dl/${a.file}`, artifact: true });
    steps.push({ name: 'install', net: 'none', cmd: ['sh', '-c', 'mkdir -p "$2" && tar -xzf "$1" -C "$2" --no-same-owner', 'sh', `${P.work}/dl/${a.file}`, `${P.work}/bin`] });
    return { files, steps, bin: `${P.work}/bin`, pkgdir: null };
  }
  throw new HarnessError(`unknown ecosystem ${t.ecosystem}`);
}

/**
 * The order targets run in, shuffled per run (L2): the public "run finished, exit N" lines then
 * say nothing about which target of the list a line belongs to. The seed is kept in the encrypted
 * shard.json, so the order can be rebuilt. Deterministic for a seed; unit-tested.
 */
export function shuffled(list, seedHex) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const h = createHash('sha256').update(`${seedHex}:${i}`).digest();
    const j = h.readUInt32BE(0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The artifact entry for this platform (binary targets have one per platform). */
function artifactFor(t, plat) {
  return t.ecosystem === 'binary' ? t.artifact?.[plat] : t.artifact;
}

function args(argv) {
  const o = { lane: 'ci', shard: 1, shards: 1, only: null, work: null, cliCommit: null, consumeTargets: false, images: join(here, 'images.json') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => {
      if (i + 1 >= argv.length) throw new HarnessError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--targets') o.targets = v();
    else if (a === '--cli') o.cli = v();
    else if (a === '--out') o.out = v();
    else if (a === '--work') o.work = v();
    else if (a === '--lane') o.lane = v();
    else if (a === '--shard') o.shard = Number(v());
    else if (a === '--shards') o.shards = Number(v());
    else if (a === '--only') o.only = v().split(',').filter(Boolean);
    else if (a === '--cli-commit') o.cliCommit = v();
    else if (a === '--consume-targets') o.consumeTargets = true;
    else if (a === '--images') o.images = v();
    else throw new HarnessError(`unknown option ${a}`);
  }
  for (const k of ['targets', 'cli', 'out']) if (!o[k]) throw new HarnessError(`--${k} is required`);
  if (!(o.shard >= 1 && o.shard <= o.shards)) throw new HarnessError('--shard must be between 1 and --shards');
  return o;
}

const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const sha256Text = (s) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();

/**
 * Run a command with all output to a log file, in its own process group, bounded by `deadline`
 * (ms since epoch). Never throws; returns { exit, signal, timed_out, spawn_error, ms, stdout }.
 * `onTimeout` runs once when the deadline passes (a container is removed there: killing the docker
 * client alone would leave the container running). `keepStdout: 'buffer'` keeps raw bytes.
 */
function run(cmd, argv, { cwd, env, log, deadline, keepStdout = false, input = null, onTimeout = null }) {
  return new Promise((done) => {
    const t0 = Date.now();
    const out = createWriteStream(log, { flags: 'a' });
    out.write(`\n$ ${[cmd, ...argv].join(' ')}\n# at ${now()}\n`);
    const chunks = [];
    let logged = 0;
    let buffered = 0;
    let dropped = 0;
    const toLog = (c) => {
      if (logged + c.length <= LOG_CAP) { logged += c.length; out.write(c); } else dropped += c.length;
    };
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      out.end(`# spawn error: ${e.message}\n`);
      return done({ exit: null, signal: null, timed_out: false, spawn_error: e.message, ms: 0, stdout: '' });
    }
    if (input !== null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.stdout.on('data', (c) => {
      // 'buffer' is ours only (docker cp of a pinned image's file); text captures of target steps are capped.
      if (keepStdout === 'buffer' || (keepStdout && buffered + c.length <= BUF_CAP)) { buffered += c.length; chunks.push(c); }
      if (keepStdout !== 'buffer') toLog(c);
    });
    child.stderr.on('data', (c) => toLog(c));
    let timedOut = false;
    const left = Math.max(1000, deadline - Date.now());
    const timer = setTimeout(() => {
      timedOut = true;
      if (onTimeout) onTimeout();
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 15_000).unref();
    }, left);
    let spawnError = null;
    child.on('error', (e) => { spawnError = e.message; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      // Anything the step left behind in its process group dies with it: an orphan would outlive
      // the job and the runner prints its process name in the public log.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      out.end(`${dropped ? `# ${dropped} bytes of output dropped (log cap)\n` : ''}# exit ${code} signal ${signal}${timedOut ? ' (time limit)' : ''} after ${Date.now() - t0} ms\n`);
      const buf = Buffer.concat(chunks);
      done({ exit: code, signal, timed_out: timedOut, spawn_error: spawnError, ms: Date.now() - t0, stdout: keepStdout === 'buffer' ? buf : buf.toString('utf8') });
    });
  });
}

async function must(step, what) {
  const r = await step;
  if (r.timed_out) throw Object.assign(new HarnessError(`${what}: time limit`), { timeout: true });
  if (r.spawn_error || r.exit !== 0) throw new HarnessError(`${what}: exit ${r.exit} signal ${r.signal} ${r.spawn_error ?? ''}`.trim());
  return r;
}

async function download(url, sha256, log) {
  let buf;
  if (url.startsWith('file://')) buf = readFileSync(new URL(url)); // local artifacts (tests, a mirror)
  else if (url.startsWith('https://')) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new HarnessError(`download: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else throw new HarnessError('download: only https:// and file:// artifacts');
  const got = createHash('sha256').update(buf).digest('hex');
  writeFileSync(log, `download ${url}\nsha256 ${got}\n`, { flag: 'a' });
  if (got !== sha256) throw new HarnessError(`checksum: artifact sha256 ${got} is not the pinned ${sha256}`);
  return { buf, sha256: got };
}

/**
 * Docker plumbing for one shard. Every container, volume and network carries the label
 * isokron.corpus.run=<runId>, so the end of the shard (and the workflow's last sweep) removes all.
 */
class Docker {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.env = dockerEnvFrom(process.env);
    this.log = log;
    this.n = 0;
  }

  labels(extra = {}) {
    return { 'isokron.corpus.run': this.ctx.runId, ...extra };
  }

  d(argv, opts = {}) {
    return run('docker', argv, { cwd: this.ctx.out, env: this.env, log: opts.log ?? this.log, deadline: opts.deadline ?? Date.now() + 300_000, keepStdout: opts.keepStdout ?? false, input: opts.input ?? null });
  }

  /** A sandbox container running `cmd`; removed (with its processes) at the deadline. */
  async sandbox({ log, deadline, network, mounts, env, cmd, workdir, input = null, keepStdout = false, target }) {
    const name = `corpus-${this.ctx.runId}-${target}-${++this.n}`;
    const argv = sandboxRunArgs({ name, image: this.ctx.images.runtime, network, mounts, env, workdir, stdin: input !== null, labels: this.labels({ 'isokron.corpus.target': target }), cmd });
    const r = await run('docker', argv, {
      cwd: this.ctx.out, env: this.env, log, deadline, keepStdout, input,
      onTimeout: () => { spawn('docker', ['rm', '-f', name], { env: this.env, stdio: 'ignore' }).on('error', () => {}); },
    });
    if (r.timed_out) await this.d(['rm', '-f', name], { log });
    return { ...r, container: true };
  }

  /** Ours, not target code: root without capabilities except CHOWN, no network, fixed command. */
  helperArgs({ mounts, cmd, stdin = false, chown = false, user = '0:0' }) {
    return [
      'run', '--rm', ...Object.entries(this.labels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
      '--user', user, '--cap-drop', 'ALL', ...(chown ? ['--cap-add', 'CHOWN'] : []),
      '--security-opt', 'no-new-privileges', '--read-only', '--network', 'none',
      ...mounts.flatMap((m) => ['--mount', volumeMount(m)]),
      ...(stdin ? ['--interactive'] : []),
      this.ctx.images.runtime, ...cmd,
    ];
  }

  /**
   * A digest-pinned image, pulled only when it is not here already (a digest names its content, so
   * a local copy is the same image). Returns the local image id.
   */
  async image(ref, log, what) {
    checkPinned(ref, what);
    let id = await this.d(['image', 'inspect', '--format', '{{.Id}}', ref], { log, keepStdout: true });
    if (id.exit !== 0) {
      await must(this.d(['pull', '-q', ref], { log, deadline: Date.now() + 600_000 }), `${what} pull`);
      id = await must(this.d(['image', 'inspect', '--format', '{{.Id}}', ref], { log, keepStdout: true }), `${what} inspect`);
    }
    return id.stdout.trim();
  }

  async volume(name, log) {
    await must(this.d(['volume', 'create', ...Object.entries(this.labels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name], { log }), 'volume');
    return name;
  }

  async network(name, internal, log) {
    await must(this.d(['network', 'create', ...(internal ? ['--internal'] : []), '--driver', 'bridge',
      '--opt', 'com.docker.network.bridge.enable_icc=true',
      ...Object.entries(this.labels()).flatMap(([k, v]) => ['--label', `${k}=${v}`]), name], { log }), 'network');
    const r = await this.d(['network', 'inspect', '--format', '{{.Internal}}', name], { log, keepStdout: true });
    const isInternal = r.stdout.trim() === 'true';
    if (isInternal !== internal) throw new HarnessError(`network ${internal ? 'is not internal' : 'is internal'}`);
    return { name, internal: isInternal };
  }

  /** Remove everything this shard (or one target, with `target`) created. */
  async sweep(log, target = null) {
    const f = ['--filter', `label=isokron.corpus.run=${this.ctx.runId}`, ...(target ? ['--filter', `label=isokron.corpus.target=${target}`] : [])];
    const ids = (await this.d(['ps', '-aq', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (ids.length) await this.d(['rm', '-f', '-v', ...ids], { log });
    if (target) return;
    const nets = (await this.d(['network', 'ls', '-q', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (nets.length) await this.d(['network', 'rm', ...nets], { log });
    const vols = (await this.d(['volume', 'ls', '-q', ...f], { log, keepStdout: true })).stdout.split('\n').filter(Boolean);
    if (vols.length) await this.d(['volume', 'rm', '-f', ...vols], { log });
  }
}

/** Remove anything under `dir` that is not a regular file or a folder (symlinks, fifos, devices). */
export function keepRegular(dir) {
  let removed = 0;
  if (!existsSync(dir)) return removed;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = lstatSync(p);
    if (s.isDirectory()) removed += keepRegular(p);
    else if (!s.isFile()) {
      rmSync(p, { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Bring /work/out back to the host: a helper (no network, read-only volume) tars regular files and
 * folders only; the host extracts with no owner and no modes, under COPY_OUT_CAP bytes.
 */
function copyOut(dk, vol, dest, log) {
  mkdirSync(dest, { recursive: true });
  const argv = dk.helperArgs({
    user: SANDBOX_USER,
    mounts: [{ src: vol, dst: P.work, ro: true }],
    cmd: ['sh', '-c', 'cd /work/out 2>/dev/null || exit 0; find . -mindepth 1 \\( -type f -o -type d \\) -print0 | tar --null --no-recursion -cf - -T -'],
  });
  return new Promise((done) => {
    const lg = createWriteStream(log, { flags: 'a' });
    lg.write(`\n$ docker ${argv.join(' ')} | tar -x\n`);
    const src = spawn('docker', argv, { env: dk.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-f', '-', '--no-same-owner', '--no-same-permissions', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] });
    let bytes = 0;
    let capped = false;
    src.stderr.on('data', (c) => lg.write(c));
    tar.stderr.on('data', (c) => lg.write(c));
    tar.stdin.on('error', () => {});
    src.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > COPY_OUT_CAP) {
        if (!capped) { capped = true; src.kill('SIGKILL'); tar.stdin.destroy(); }
        return;
      }
      tar.stdin.write(c);
    });
    src.stdout.on('end', () => tar.stdin.end());
    let n = 0;
    let srcExit = null;
    let tarExit = null;
    const fin = () => {
      if (++n < 2) return;
      const removed = keepRegular(dest);
      lg.end(`# copy-out ${bytes} bytes, helper exit ${srcExit}, tar exit ${tarExit}${capped ? ', over the cap' : ''}, ${removed} non-regular removed\n`);
      done({ bytes, capped, ok: srcExit === 0 && tarExit === 0 && !capped, removed });
    };
    src.on('error', () => { srcExit = -1; fin(); });
    src.on('close', (c) => { srcExit = c; fin(); });
    tar.on('close', (c) => { tarExit = c; fin(); });
  });
}

/** One target. Returns its metadata record; never throws. */
async function runTarget(t, o, ctx, dk) {
  const odir = resolve(o.out, t.id);
  mkdirSync(join(odir, 'logs'), { recursive: true });
  const L = (n) => join(odir, 'logs', `${n}.log`);
  const timeoutS = t.timeout_s ?? ctx.defaults.timeout_s ?? 600;
  const deadline = Date.now() + timeoutS * 1000;
  const meta = {
    format: RUN_FORMAT,
    label: LABEL,
    target: {
      id: t.id, name: t.name, ecosystem: t.ecosystem, package: t.package, version: t.version,
      artifact: t.artifact ?? null, source: t.source ?? null, license: t.license ?? null,
      manifest_kind: t.full ? 'hand-written (full)' : 'generic catalog',
      lock_sha256: t.lock ? sha256Text(JSON.stringify(t.lock)) : null,
    },
    cli: ctx.cli,
    spec: ctx.spec,
    runner: ctx.runner,
    images: ctx.imageInfo,
    isolation: ctx.isolation,
    github: ctx.github,
    lane: o.lane,
    started: now(),
    ended: null,
    timeout_s: timeoutS,
    artifact_sha256_verified: null,
    networks: {},
    backends: [],
    deps: null,
    manifest_sha256: null,
    init_draft_sha256: null,
    steps: [],
    status: 'completed',
    cli_exit: null,
    harness_error: null,
    copy_out: null,
    results: [],
  };
  const tag = `${ctx.runId}-${t.id}`;
  let vol = null;
  try {
    checkId(t.id);
    // 1. The artifact, on the host: downloaded and checked against the pinned sha256. Never run here.
    const plan = installPlan(t, ctx.plat);
    const art = artifactFor(t, ctx.plat);
    const dl = await download(art.url, art.sha256, L('install'));
    meta.artifact_sha256_verified = dl.sha256;
    if (plan.needsUv) await ctx.ensureTools();

    // 2. The target's volume and networks: egress for install only, internal for the rest.
    vol = await dk.volume(`corpus-${tag}`, L('install'));
    await must(dk.d(dk.helperArgs({ chown: true, mounts: [{ src: vol, dst: P.work }], cmd: ['sh', '-c', 'mkdir -p /work/home /work/out /work/dl /work/pkg && chmod 700 /work && chown -R 10001:10001 /work'] }), { log: L('install') }), 'volume set-up');
    const egress = await dk.network(`corpus-${tag}-egress`, false, L('install'));
    const internal = await dk.network(`corpus-${tag}-run`, true, L('install'));
    meta.networks = { install: { internal: egress.internal }, run: { internal: internal.internal } };
    const mounts = [{ src: vol, dst: P.work }, { src: ctx.cliVol, dst: P.cli, ro: true }, ...(ctx.toolsVol ? [{ src: ctx.toolsVol, dst: P.tools, ro: true }] : [])];
    const put = (path, buf, log) => must(dk.d(dk.helperArgs({ user: SANDBOX_USER, mounts: [{ src: vol, dst: P.work }], stdin: true, cmd: ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat > "$1"', 'sh', path] }), { log, input: buf }), `write ${path.split('/').pop()}`);

    // 3. Install, in sandbox containers. Only the `egress` steps have a network that leaves the host.
    for (const f of plan.files) await put(f.path, f.artifact ? dl.buf : Buffer.from(f.text), L('install'));
    const envInstall = sandboxEnv(plan.bin);
    if (process.env.CORPUS_INSTALL_CA_FILE) {
      // A machine behind a TLS-inspecting proxy (not GitHub's runners): its CA, for install only.
      await put(`${P.home}/install-ca.pem`, readFileSync(process.env.CORPUS_INSTALL_CA_FILE), L('install'));
      Object.assign(envInstall, { SSL_CERT_FILE: `${P.home}/install-ca.pem`, NODE_EXTRA_CA_CERTS: `${P.home}/install-ca.pem` });
      meta.install_ca = sha256File(process.env.CORPUS_INSTALL_CA_FILE);
    }
    for (const s of plan.steps) {
      const net = s.net === 'egress' ? egress.name : 'none';
      const r = await dk.sandbox({ log: L(s.capture ? 'deps' : 'install'), deadline, network: net, mounts, env: envInstall, workdir: s.workdir ?? P.work, cmd: s.cmd, keepStdout: !!s.capture, target: t.id });
      if (s.capture) {
        writeFileSync(join(odir, s.capture), r.stdout);
        meta.deps = { file: s.capture, sha256: sha256Text(r.stdout) };
      }
      if (!s.mayFail) await must(Promise.resolve(r), s.name);
    }
    const vars = { tdir: P.work, bin: plan.bin, host: '127.0.0.1' };
    if (plan.pkgdir) vars.pkgdir = plan.pkgdir;

    // 4. Backends: digest-pinned, on the internal network only, reachable as b0, b1, ...
    for (const [i, b] of (t.backends ?? []).entries()) {
      const name = `corpus-${tag}-b${i}`;
      const image = checkPinned(b.image, `backend ${i}`);
      const imageId = await dk.image(image, L(`backend-${i}`), `backend ${i}`);
      vars[`host${i}`] = `b${i}`;
      vars[`port${i}`] = String(b.port);
      if (i === 0) vars.host = 'b0';
      const argv = backendRunArgs({ name, image, network: internal.name, alias: `b${i}`, env: fill(b.env ?? {}, vars), args: fill(b.args ?? [], vars), capAdd: b.cap_add ?? [], labels: dk.labels({ 'isokron.corpus.target': t.id }) });
      await must(dk.d(argv, { log: L(`backend-${i}`), deadline }), `backend ${i} start`);
      meta.backends.push({ image, image_id: imageId, container_port: b.port, cap_add: b.cap_add ?? [] });
      const waitUntil = Math.min(deadline, Date.now() + (b.wait_timeout_s ?? 120) * 1000);
      let ok = !b.wait;
      while (!ok && Date.now() < waitUntil) {
        const w = await dk.d(['exec', name, ...fill(b.wait, vars)], { log: L(`backend-${i}`), deadline });
        ok = w.exit === 0;
        if (!ok) await new Promise((r) => setTimeout(r, 2000));
      }
      if (!ok) throw new HarnessError(`backend ${i} not ready`);
      for (const s of b.setup ?? []) {
        const r = await must(dk.d(['exec', ...(s.user ? ['-u', s.user] : []), name, ...fill(s.exec, vars)], { log: L(`backend-${i}`), deadline, keepStdout: !!s.capture }), `backend ${i} set-up`);
        if (s.capture) vars[s.capture] = r.stdout.trim().split('\n').pop();
      }
    }

    // 5. Set-up in the target's work folder, in a sandbox container on the internal network.
    const command = fill(t.server.command, vars);
    const senv = fill(t.server.env ?? {}, vars);
    const envRun = sandboxEnv(plan.bin, senv);
    for (const line of t.setup ?? []) {
      await must(dk.sandbox({ log: L('setup'), deadline, network: internal.name, mounts, env: { ...envRun, TDIR: P.work }, cmd: ['sh', '-c', fill(line, vars)], target: t.id }), 'set-up');
    }

    // 6. The manifests: the init draft (archived as data), then the one the CLI runs.
    const cliStep = async (name, argv) => {
      const r = await dk.sandbox({ log: L(name), deadline, network: internal.name, mounts, env: envRun, cmd: ['node', CLI_MAIN, ...argv], keepStdout: true, target: t.id });
      const step = { step: name, exit: r.exit, signal: r.signal, timed_out: r.timed_out, spawn_error: r.spawn_error, container: true, ms: r.ms };
      meta.steps.push(step);
      return { r, step };
    };
    if (t.init !== false) {
      const { step } = await cliStep('init', ['init', '--out', `${P.out}/init-draft.yaml`, ...Object.keys(senv).flatMap((k) => ['--env', k]), '--', ...command]);
      step.informational = true; // init's result is data: a draft that fails is recorded, not judged
    }
    const manifestText = t.full?.manifest ? fill(t.full.manifest, vars) : catalogManifest(command, Object.keys(senv), `mwsv-corpus-${t.id}`);
    await put(`${P.work}/writecheck.yaml`, Buffer.from(manifestText), L('plan'));
    writeFileSync(join(odir, 'writecheck.yaml'), manifestText);
    meta.manifest_sha256 = sha256Text(manifestText);
    const manifest = `${P.work}/writecheck.yaml`;

    // 7. plan, catalog, and full where a person accepted the plan hash. The first CLI step that does
    //    not complete decides the target's status; later steps still run when they can.
    const decisive = [];
    const planStep = await cliStep('plan', ['plan', '-m', manifest]);
    meta.plan_hash = (/^plan hash: ([0-9a-f]{16})$/m.exec(planStep.r.stdout) ?? [])[1] ?? null;
    decisive.push(planStep.step);
    const cat = await cliStep('catalog', ['catalog', '-m', manifest, '--out', `${P.out}/results`]);
    decisive.push(cat.step);
    if (t.full && t.full.plan_hash) {
      if (meta.plan_hash !== t.full.plan_hash) {
        meta.plan_drift = { accepted: t.full.plan_hash, seen: meta.plan_hash };
      } else {
        const full = await cliStep('full', ['run', '-m', manifest, '--confirm-target', t.full.confirm, '--plan-hash', t.full.plan_hash, '--out', `${P.out}/results`, '--state', `${P.out}/state`]);
        decisive.push(full.step);
      }
    }
    for (const s of decisive) {
      const c = classifyCli(s);
      if (c !== 'completed') {
        meta.status = c;
        meta.cli_exit = s.exit;
        meta.failed_step = s.step;
        break;
      }
      meta.cli_exit = Math.max(meta.cli_exit ?? 0, s.exit ?? 0);
    }
    // A known CLI problem on this target (t.expect: { step, exit, error: regex, issue }) is recorded
    // as expected and does not turn the shard red, so a new problem stays visible; when it stops
    // happening the target is marked for the expectation to be removed (the dogfood pattern).
    if (t.expect) {
      const lg = join(odir, 'logs', `${t.expect.step}.log`);
      const err = existsSync(lg) ? ([...readFileSync(lg, 'utf8').matchAll(/^error: .*$/gm)].pop()?.[0] ?? '') : '';
      const hit = meta.failed_step === t.expect.step && meta.cli_exit === t.expect.exit && new RegExp(t.expect.error).test(err);
      if (hit) meta.status = 'expected_cli_error';
      else if (meta.status === 'completed') meta.expectation_flipped = t.expect.issue ?? true;
      meta.expect = t.expect;
    }
  } catch (e) {
    meta.status = e.timeout ? 'timeout' : 'harness_error';
    meta.harness_error = String(e.message ?? e);
  } finally {
    try { await finishTarget(); } catch (e) {
      // One target's output must never stop the shard: record it and go on to the next target.
      meta.status = 'harness_error';
      meta.harness_error = `record: ${String(e?.message ?? e).slice(0, 200)}`;
    }
    meta.public_exit = publicExit(meta);
    meta.ended = now();
    writeFileSync(join(odir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  }
  return meta;

  async function finishTarget() {
    const lg = L('teardown');
    for (const [i] of (t.backends ?? []).entries()) {
      await dk.d(['logs', `corpus-${tag}-b${i}`], { log: lg, deadline: Date.now() + 60_000 });
    }
    // Every container of this target (backends, and any sandbox still running) goes first, so the
    // copy below reads a volume nothing can write any more.
    await dk.sweep(lg, t.id);
    if (vol) {
      // The CLI's results folders, the ledger of a full run, the init draft: target-writable data,
      // kept under sandbox/ so that it can never replace meta.json or a log of ours.
      const c = await copyOut(dk, vol, join(odir, 'sandbox'), lg);
      meta.copy_out = { bytes: c.bytes, over_cap: c.capped, non_regular_removed: c.removed };
      if (!c.ok && meta.status === 'completed') {
        meta.status = 'harness_error';
        meta.harness_error = c.capped ? 'copy-out: over the size cap' : 'copy-out failed';
      }
      await dk.d(['volume', 'rm', '-f', vol], { log: lg });
    }
    for (const n of ['egress', 'run']) await dk.d(['network', 'rm', `corpus-${tag}-${n}`], { log: lg });
    const draft = join(odir, 'sandbox', 'init-draft.yaml');
    if (existsSync(draft) && lstatSync(draft).isFile()) meta.init_draft_sha256 = sha256File(draft);
    const rdir = join(odir, 'sandbox', 'results');
    if (existsSync(rdir) && lstatSync(rdir).isDirectory()) {
      for (const r of readdirSync(rdir)) {
        const f = join(rdir, r, 'results.json');
        if (!existsSync(f) || !lstatSync(f).isFile()) continue;
        const big = lstatSync(f).size > JSON_CAP;
        meta.results.push({ folder: `sandbox/results/${r}`, sha256: sha256File(f), status: big ? 'too large to read' : safeJson(readFileSync(f, 'utf8'))?.run?.status ?? null });
      }
    }
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Tar of the built CLI package (what the containers need: package.json, dist, schema, runtime deps). */
function cliTar(cliDir) {
  return new Promise((done, fail) => {
    const parts = ['package.json', 'dist', 'schema', 'node_modules'].filter((p) => existsSync(join(cliDir, p)));
    const c = spawn('tar', ['-C', cliDir, '--exclude=node_modules/typescript', '--exclude=node_modules/@types', '--exclude=node_modules/.cache', '-cf', '-', ...parts], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    c.stdout.on('data', (x) => chunks.push(x));
    c.on('error', fail);
    c.on('close', (code) => (code === 0 ? done(Buffer.concat(chunks)) : fail(new HarnessError('CLI tar failed'))));
  });
}

async function context(o) {
  const cliDir = resolve(o.cli);
  const cliEntry = join(cliDir, 'dist', 'src', 'cli', 'main.js');
  if (!existsSync(cliEntry)) throw new HarnessError('the CLI entry script is missing');
  const sink = join(o.out, '_shard', 'context.log');
  const dl = Date.now() + 120_000;
  // Our own CLI, on the host, for its version and requirement list only (no target is involved).
  const q = async (cmd, argv, env = dockerEnvFrom(process.env)) => (await run(cmd, argv, { cwd: o.out, env, log: sink, deadline: dl, keepStdout: true })).stdout.trim();
  const version = await q(process.execPath, [cliEntry, 'version']);
  const reqs = await q(process.execPath, [cliEntry, 'requirements']);
  let commit = o.cliCommit;
  if (!commit) commit = (await q('git', ['-C', cliDir, 'rev-parse', 'HEAD'])) || null;
  const images = JSON.parse(readFileSync(o.images, 'utf8'));
  for (const k of ['runtime', 'uv']) checkPinned(images[k], `images.json ${k}`);
  const runner = {
    lane: o.lane,
    image_os: process.env.ImageOS ?? null,
    image_version: process.env.ImageVersion ?? null,
    runner_os: process.env.RUNNER_OS ?? null,
    runner_arch: process.env.RUNNER_ARCH ?? null,
    platform: `${platform()} ${release()} ${arch()}`,
    os_version: platform() === 'darwin' ? await q('sw_vers', ['-productVersion']) : await q('sh', ['-c', '. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || true']),
    node: process.version,
    docker: await q('docker', ['version', '--format', '{{.Server.Version}}']),
  };
  return {
    o,
    out: o.out,
    cliDir,
    cli: { commit, version, entry_sha256: sha256File(cliEntry), requirements_sha256: sha256Text(reqs) },
    spec: { version: (/\(MWS ([0-9.]+)\)/.exec(version) ?? [])[1] ?? null, requirements: reqs.split('\n').filter((l) => /^MWS-/.test(l.trim())).length },
    runner,
    images,
    github: process.env.GITHUB_RUN_ID
      ? { repository: process.env.GITHUB_REPOSITORY, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA, workflow: process.env.GITHUB_WORKFLOW, event: process.env.GITHUB_EVENT_NAME }
      : null,
    runId: ((process.env.GITHUB_RUN_ID ?? `l${Date.now().toString(36)}`) + `s${o.shard}`).toLowerCase().replace(/[^a-z0-9]/g, ''),
    isolation: { kind: 'container', user: SANDBOX_USER, cap_drop: 'ALL', no_new_privileges: true, read_only_root: true, mounts: 'named volumes only', install_network: 'bridge (egress)', run_network: 'internal' },
  };
}

/** Shard set-up on the Docker side: platform, pinned images pulled, the CLI volume. */
async function prepareDocker(ctx, dk) {
  const log = join(ctx.out, '_shard', 'docker.log');
  const v = await dk.d(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { log, keepStdout: true });
  if (v.exit !== 0) throw new HarnessError('docker is not available');
  ctx.plat = platformKey(v.stdout);
  ctx.runner.container_platform = ctx.plat;
  ctx.imageInfo = {};
  // uv is fetched only when a PyPI target needs it (ensureTools).
  ctx.imageInfo.runtime = { ref: ctx.images.runtime, id: await dk.image(ctx.images.runtime, log, 'runtime image') };
  // The CLI, read-only in every target container. Copied through stdin: no host path is mounted.
  ctx.cliVol = await dk.volume(`corpus-${ctx.runId}-cli`, log);
  const tarBuf = await cliTar(ctx.cliDir);
  await must(dk.d(dk.helperArgs({ mounts: [{ src: ctx.cliVol, dst: P.cli }], stdin: true, cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', P.cli] }), { log, input: tarBuf }), 'CLI volume');
  ctx.toolsVol = null;
  let toolsReady = null;
  ctx.ensureTools = () => {
    toolsReady ??= (async () => {
      const ref = ctx.images.uv;
      ctx.imageInfo.uv = { ref, id: await dk.image(ref, log, 'uv image') };
      const vol = await dk.volume(`corpus-${ctx.runId}-tools`, log);
      const c = `corpus-${ctx.runId}-uvsrc`;
      await must(dk.d(['create', '--name', c, ...Object.entries(dk.labels()).flatMap(([k, val]) => ['--label', `${k}=${val}`]), ref], { log }), 'uv create');
      const t = await must(dk.d(['cp', `${c}:/uv`, '-'], { log, keepStdout: 'buffer' }), 'uv copy');
      await dk.d(['rm', '-f', c], { log });
      await must(dk.d(dk.helperArgs({ mounts: [{ src: vol, dst: P.tools }], stdin: true, cmd: ['tar', '-x', '-f', '-', '--no-same-owner', '-C', P.tools] }), { log, input: t.stdout }), 'tools volume');
      ctx.toolsVol = vol;
    })();
    return toolsReady;
  };
}

async function main() {
  let o;
  let failed = false;
  let dk = null;
  say(LABEL);
  try {
    o = args(process.argv.slice(2));
    mkdirSync(join(o.out, '_shard'), { recursive: true });
    const raw = readFileSync(o.targets);
    if (o.consumeTargets) rmSync(o.targets, { force: true }); // no clear-text list on disk while targets run
    const list = JSON.parse(raw.toString('utf8'));
    if (list.format !== TARGETS_FORMAT) throw new HarnessError('the target list has another format');
    const seed = process.env.CORPUS_ORDER_SEED || randomBytes(16).toString('hex');
    const mine = shuffled(list.targets
      .filter((t) => (t.lane ?? 'ci') === o.lane && t.enabled !== false)
      .filter((t) => !o.only || o.only.includes(t.id))
      .filter((_, i) => i % o.shards === o.shard - 1), seed);
    const ctx = await context(o);
    ctx.defaults = list.defaults ?? {};
    dk = new Docker(ctx, join(o.out, '_shard', 'docker.log'));
    await prepareDocker(ctx, dk);
    const shard = { format: RUN_FORMAT, label: LABEL, lane: o.lane, shard: o.shard, shards: o.shards, targets_list_sha256: createHash('sha256').update(raw).digest('hex'), targets_list_updated: list.updated ?? null, order_seed: seed, order: mine.map((t) => t.id), cli: ctx.cli, spec: ctx.spec, runner: ctx.runner, images: ctx.imageInfo, isolation: ctx.isolation, github: ctx.github, started: now(), targets: [] };
    for (const t of mine) {
      const m = await runTarget(t, o, ctx, dk);
      shard.targets.push({ id: t.id, status: m.status, cli_exit: m.cli_exit, public_exit: m.public_exit, results: m.results.map((r) => r.sha256) });
      say(`run finished, exit ${m.public_exit}`);
      if (m.public_exit !== 0) failed = true;
    }
    shard.ended = now();
    writeFileSync(join(o.out, '_shard', 'shard.json'), JSON.stringify(shard, null, 2) + '\n');
  } catch (e) {
    // A harness failure: the message may name a target, so it goes to a file, not to the log.
    try {
      const out = o?.out ?? '.';
      mkdirSync(join(out, '_shard'), { recursive: true });
      writeFileSync(join(out, '_shard', 'harness-error.txt'), `${now()}\n${e?.stack ?? e}\n`);
    } catch {}
    say('run finished, exit 125');
    failed = true;
  } finally {
    if (dk) await dk.sweep(join(o.out, '_shard', 'docker.log')).catch(() => {});
  }
  process.exitCode = failed ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // An unexpected rejection must not print a stack (it can carry a target's name).
  process.on('uncaughtException', () => { say('run finished, exit 125'); process.exit(1); });
  process.on('unhandledRejection', () => { say('run finished, exit 125'); process.exit(1); });
  main();
}

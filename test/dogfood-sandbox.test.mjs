/**
 * R-DSB-*: the dogfood T0 workers run their third-party code inside mcp-surface-corpus's sandbox (dogfood/sbx.mjs).
 *
 * The workflow checks read each sandboxed worker as text, job by job, and each one is shown to catch its own
 * mutation: the same file with that protection taken out must be refused.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PULL_JS, SbxError, checkSandboxCheckout, cliOutDirs, envPairs, execArgv, inMirror, mirrorRoot, parseHosts, serviceIp, stream, whilePaused, workMounts, writeBack, writeCollected } from '../dogfood/sbx.mjs';
import { commandEnv, readEnvFile } from '../loop/sandbox/dogfood-in.mjs';
import { parseForward } from '../loop/sandbox/dogfood-unit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wf = (f) => readFileSync(join(root, '.github', 'workflows', f), 'utf8');
const SANDBOX_REF = '3738f2c3dabe03e943a1e5ff0a2441aca831e910';
const SANDBOXED = ['dogfood-grafana.yml', 'dogfood-kronicle-lite.yml', 'dogfood-payload.yml', 'dogfood-sea-lite.yml', 'dogfood-writesafe.yml'];

/** The jobs of a workflow as { name: text }. */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + 7);
  const out = {};
  const parts = body.split(/^(?=  [a-z0-9_-]+:\s*$)/m);
  for (const p of parts) { const m = /^  ([a-z0-9_-]+):/.exec(p); if (m) out[m[1]] = p; }
  return out;
}

/** Every command line a job's `run:` steps run (a folded block joined into one line), without comments. */
function runLines(job) {
  const lines = job.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (m[2] !== '|' && m[2] !== '>-' && m[2] !== '>') { out.push(m[2].trim()); continue; }
    const block = [];
    for (i++; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) > indent); i++) block.push(lines[i].trim());
    i--;
    if (m[2] === '|') out.push(...block.filter((l) => l && !l.startsWith('#')));
    else out.push(block.filter(Boolean).join(' '));
  }
  return out;
}

/**
 * Whether a command line has shell syntax that runs more than its first command: an unquoted ; & | < > ( ) or backquote,
 * or a command substitution ($( or a backquote) anywhere outside single quotes. A `node dogfood/sbx.mjs up && npm ci`
 * would otherwise pass for a sandbox step.
 */
export function shellChained(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === '`' || (c === '$' && line[i + 1] === '(')) return true;
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (';&|<>()\n'.includes(c)) return true;
  }
  return q !== null;
}

/** What a work job may run on the runner, each line whole: our own scripts, the sandbox driver, checks that read results. */
const HOST_EXACT = new Set([
  'dogfood/cli-ref.sh', 'dogfood/check-ref.sh', 'dogfood/build-cli.sh', 'dogfood/sandbox-guarded.sh', 'loop/prepare.sh sandbox', 'loop/teardown.sh',
  'dogfood/install-pnpm.sh fetch', 'dogfood/install-pnpm.sh install', 'dogfood/kronicle-lite/candidate-manifest.sh', 'dogfood/kronicle-lite/check-on-main.sh',
  'dogfood/sea-lite/expect-fixed-cli-bugs.sh', 'dogfood/grafana/sandbox.sh start',
  'dogfood/grafana/compare-snaps.py "$RUNNER_TEMP/snap-before.json" "$RUNNER_TEMP/snap-after.json"',
  // grafana's vendor job: the upstream image is created, never started, and its binary copied out as data.
  'mkdir -p grafana-bin', 'docker create --name dogfood-grafana-vendor "$VENDOR_IMAGE" > /dev/null',
  'docker cp dogfood-grafana-vendor:/app/mcp-grafana grafana-bin/mcp-grafana-vendor', 'docker rm dogfood-grafana-vendor > /dev/null',
]);
const HOST_OK = [
  /^dogfood\/check-plan-hash\.sh "\$PLAN_HASH" "\$SEEN" [a-z-]+$/,
  /^dogfood\/grafana\/sandbox\.sh snap "\$RUNNER_TEMP\/snap-(?:before|after)\.json"$/,
  /^node dogfood\/expect-violations\.mjs (?:"\$KL_KNOWN"|dogfood\/[a-z-]+\/known-violations\.txt) "\$RESULTS"$/,
  /^node dogfood\/payload\/expect\.mjs "\$RESULTS\/results\.json" dogfood\/payload\/expected-violations\.[a-z.-]+\.txt$/,
  // The driver: what follows its `--` runs in the sandbox; shellChained refuses anything the runner's shell would run besides.
  /^node dogfood\/sbx\.mjs (?:up|down|logs|build|svc|exec|run|pull)(?: .*)?$/,
];
/** A command line a work job may run on the runner. */
export const hostAllowed = (l) => HOST_EXACT.has(l) || (!shellChained(l) && HOST_OK.some((re) => re.test(l)));
/** The only actions a work job uses: checkout and setup-node at full commits, this action (./), and the sandbox guard. */
const USES_OK = [/^actions\/(?:checkout|setup-node)@[0-9a-f]{40}$/, /^\.\/$/, new RegExp(`^isokron-ai/mcp-surface-corpus/sandbox-guard@${SANDBOX_REF}$`)];
const sbxStep = /node dogfood\/sbx\.mjs (?:build|svc|exec|run) |dogfood\/grafana\/sandbox\.sh start/;

/** Every reason a sandboxed worker's text breaks the rules; empty when it keeps them. */
export function workerProblems(text) {
  const p = [];
  if (!text.includes(`\n  SANDBOX_REF: '${SANDBOX_REF}'\n`)) p.push('SANDBOX_REF is not the pinned sandbox commit');
  if (!/\n  workflow_call:\n    inputs:\n(?:      .*\n)*      proof: \{ type: boolean, required: false, default: false \}\n/.test(text)) p.push('no workflow_call with a proof input');
  const J = jobs(text);
  const conf = J.conformance ?? '';
  if (!conf.includes(`uses: isokron-ai/mcp-surface-corpus/.github/workflows/sandbox-conformance.yml@${SANDBOX_REF} # SANDBOX_REF`)) p.push('conformance: not the reusable sandbox-conformance job at SANDBOX_REF');
  if (!/\n    needs: t0-start\n/.test(conf)) p.push('conformance: does not wait for t0-start');
  const work = Object.keys(J).filter((j) => !['t0-start', 'conformance', 't0-manifest'].includes(j));
  if (work.length === 0) p.push('no work job');
  for (const j of work) {
    const t = J[j];
    const at = (s) => t.indexOf(s);
    if (!/\n    needs: \[t0-start, conformance\]\n/.test(t)) p.push(`${j}: does not need the conformance job`);
    if (!/\n    if: false\n/.test(t) && !/\n    if: needs\.t0-start\.outputs\.go == 'true' && needs\.conformance\.outputs\.verdict == 'pass'/.test(t)) p.push(`${j}: runs without a conformance pass`);
    if (!/\n      MSC_DIR: msc\n/.test(t)) p.push(`${j}: MSC_DIR`);
    const guard = at(`uses: isokron-ai/mcp-surface-corpus/sandbox-guard@${SANDBOX_REF} # SANDBOX_REF`);
    const order = [at('run: loop/prepare.sh sandbox'), guard, at('run: dogfood/sandbox-guarded.sh'), at('node dogfood/sbx.mjs up')];
    if (order.some((x) => x < 0) || order.some((x, i) => i > 0 && x < order[i - 1])) p.push(`${j}: not fetch, guard at SANDBOX_REF, guard check, then up`);
    const first = t.search(sbxStep);
    if (first < 0 || first < order[3]) p.push(`${j}: a sandbox step before up, or none`);
    for (const m of t.matchAll(/uses: \.\/\n\s+with:\n((?:\s{10}.*\n)+)/g)) if (!/cli-path: dogfood\/sbx-cli\n/.test(m[1])) p.push(`${j}: an action step whose CLI is not the sandboxed one`);
    if (!/- name: End the sandbox\n\s+if: always\(\)\n\s+run: node dogfood\/sbx\.mjs down\n\s+- name: Stop Docker, and check nothing of the sandbox is left\n\s+if: always\(\)\n\s+run: loop\/teardown\.sh\n\s*(?:#[^\n]*\n\s*)*$/.test(t)) p.push(`${j}: does not end with down, then teardown`);
    if (/working-directory:|\bservices:|\n\s+shell:|\bcontainer:/.test(t)) p.push(`${j}: a step that builds, serves or picks its shell on the runner`);
    for (const l of runLines(t)) if (!hostAllowed(l)) p.push(`${j}: runs on the runner: ${l.slice(0, 80)}`);
    for (const m of t.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)) if (!USES_OK.some((re) => re.test(m[1]))) p.push(`${j}: uses ${m[1].slice(0, 60)}`);
  }
  const man = J['t0-manifest'] ?? '';
  if (!new RegExp(`\\n    needs: \\[t0-start, conformance, ${work.join(', ')}\\]\\n`).test(man)) p.push('t0-manifest: does not wait for conformance and every work job');
  if (!man.includes("dry-run: ${{ inputs.proof && 'true' || 'false' }}")) p.push('t0-manifest: no dry run for the proof');
  if (/sbx\.mjs|sandbox-guard|\bnpm |pnpm|docker /.test(man)) p.push('t0-manifest: runs workflow code');
  return p;
}

test('R-DSB-01: each sandboxed dogfood worker runs its third-party code only through the sandbox, after conformance and the guard at SANDBOX_REF', () => {
  for (const f of SANDBOXED) assert.deepEqual(workerProblems(wf(f)), [], f);
  // corpus.yml pins the same sandbox commit: one sandbox for the lane and the T0 workers.
  assert.match(wf('corpus.yml'), new RegExp(`SANDBOX_REF: '${SANDBOX_REF}'`));
});

test('R-DSB-01: each protection taken out of a worker is refused (mutations)', () => {
  const kl = wf('dogfood-kronicle-lite.yml');
  const mutations = {
    'no guard': kl.replace(/      - id: sandbox\n        name: Sandbox guard[^\n]*\n        uses: [^\n]*\n/, ''),
    'guard at a branch': kl.replace(`sandbox-guard@${SANDBOX_REF}`, 'sandbox-guard@main'),
    'conformance at another commit': kl.replace(`sandbox-conformance.yml@${SANDBOX_REF}`, `sandbox-conformance.yml@${'0'.repeat(40)}`),
    'no conformance gate': kl.replace(" && needs.conformance.outputs.verdict == 'pass'", ''),
    'build on the runner': kl.replace("run: node dogfood/sbx.mjs build --image node22-build", "run: cd kl && npm ci && npm run build # node dogfood/sbx.mjs build --image node22-build"),
    'a server step on the runner': kl.replace('run: node dogfood/sbx.mjs exec -- dogfood/kronicle-lite/setup.sh', 'run: dogfood/kronicle-lite/setup.sh'),
    'the host CLI': kl.replace('cli-path: dogfood/sbx-cli', 'cli-path: ${{ env.MWSC_CLI_PATH }}'),
    'no teardown': kl.replace(/      - name: Stop Docker, and check nothing of the sandbox is left\n        if: always\(\)\n        run: loop\/teardown\.sh\n/, ''),
    'up before the guard': kl.replace('      - name: Sandbox up (the workspace mirrored into it)\n        run: node dogfood/sbx.mjs up\n', '').replace('      - id: sandbox\n', '      - run: node dogfood/sbx.mjs up\n      - id: sandbox\n'),
    'manifest without conformance': kl.replace('needs: [t0-start, conformance, own]', 'needs: [t0-start, own]'),
    'a real upload in the proof': kl.replace("dry-run: ${{ inputs.proof && 'true' || 'false' }}", "dry-run: 'false'"),
    'setup-go on the runner': wf('dogfood-grafana.yml').replace('      - name: Build the research build (in the sandbox)\n', '      - uses: actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e # v7.0.0\n      - name: Build the research build (in the sandbox)\n'),
    'pnpm on the runner': wf('dogfood-payload.yml').replace('run: dogfood/install-pnpm.sh install', 'run: dogfood/install-pnpm.sh install && pnpm --version'),
    // The review's probes of #80 (all passed the old check).
    'a chain after up': kl.replace('run: node dogfood/sbx.mjs up\n', 'run: node dogfood/sbx.mjs up && (cd kl && npm ci --no-audit)\n'),
    'a command after the hash check': kl.replace('run: dogfood/check-plan-hash.sh "$PLAN_HASH" "$SEEN" own', 'run: dogfood/check-plan-hash.sh "$PLAN_HASH" "$SEEN" own ; node kl/dist/index.js'),
    'a docker action': kl.replace('      - name: Sandbox up (the workspace mirrored into it)\n', '      - uses: docker://node:22\n      - name: Sandbox up (the workspace mirrored into it)\n'),
    'a local action of the subject': kl.replace('      - name: Sandbox up (the workspace mirrored into it)\n', '      - uses: ./dogfood/kronicle-lite\n      - name: Sandbox up (the workspace mirrored into it)\n'),
    'a substitution in a driver line': kl.replace('run: node dogfood/sbx.mjs down', 'run: node dogfood/sbx.mjs down "$(node kl/dist/cli.js)"'),
    'a shell of its own': kl.replace('        run: dogfood/kronicle-lite/check-on-main.sh\n', '        shell: node {0}\n        run: dogfood/kronicle-lite/check-on-main.sh\n'),
  };
  for (const [what, text] of Object.entries(mutations)) {
    assert.notEqual(text, what.includes('setup-go') ? wf('dogfood-grafana.yml') : what.includes('pnpm on') ? wf('dogfood-payload.yml') : kl, `${what}: the mutation applies`);
    assert.ok(workerProblems(text).length > 0, `${what}: refused`);
  }
});

/** Every reason the proof workflow breaks its rules. */
export function proofProblems(raw) {
  const p = [];
  const text = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  if (!/\non:\n  pull_request:\n    paths:\n/.test(text)) p.push('not on pull_request');
  if (/pull_request_target|workflow_run|\bschedule:|\bpush:/.test(text)) p.push('another trigger');
  if (!/\npermissions:\n  contents: read\n  actions: read\n\n/.test(text)) p.push('permissions are not read-only');
  if (/\bsecrets:|\$\{\{ secrets\./.test(text)) p.push('a secret');
  const J = jobs(text);
  const called = Object.values(J).map((t) => /uses: \.\/\.github\/workflows\/(dogfood-[a-z-]+\.yml)\n/.exec(t)?.[1]).filter(Boolean).sort();
  if (JSON.stringify(called) !== JSON.stringify(SANDBOXED)) p.push(`calls ${called.join(', ')}`);
  for (const [n, t] of Object.entries(J)) {
    if (!/\n      proof: true\n/.test(t)) p.push(`${n}: not a proof run`);
    // The worker-kit refuses a fence that is not a positive whole number or a run_key that is not sha256 hex, even in a dry run.
    if (!/\n      fence: '[1-9][0-9]*'\n      run_key: [0-9a-f]{64}\n/.test(t)) p.push(`${n}: a fence or run_key the worker-kit refuses`);
    if (!/\n    if: github\.event\.pull_request\.head\.repo\.full_name == github\.repository\n/.test(t)) p.push(`${n}: runs for a fork`);
  }
  return p;
}

test('R-DSB-02: the pull-request proof calls exactly the sandboxed workers, as a dry run, read-only, never for a fork', () => {
  const text = wf('dogfood-sandbox-proof.yml');
  assert.deepEqual(proofProblems(text), []);
  for (const [what, m] of Object.entries({
    target: text.replace('  pull_request:\n', '  pull_request_target:\n'),
    'write permission': text.replace('  actions: read\n', '  actions: write\n'),
    secrets: text.replace('      proof: true\n', '      proof: true\n    secrets: inherit\n'),
    'not a dry run': text.replace('      proof: true\n', '      proof: false\n'),
    kubernetes: `${text}\n  kubernetes:\n    if: github.event.pull_request.head.repo.full_name == github.repository\n    uses: ./.github/workflows/dogfood-kubernetes.yml\n    with:\n      proof: true\n`,
    fork: text.replace('    if: github.event.pull_request.head.repo.full_name == github.repository\n', ''),
    'a fence the worker-kit refuses': text.replace("      fence: '1'\n", '      fence: proof\n'),
  })) {
    assert.notEqual(m, text, what);
    assert.ok(proofProblems(m).length > 0, `${what}: refused`);
  }
});

/** Why the kubernetes workflow could still produce a bundle tool-qa would trust; empty when it cannot. */
export function kubernetesProblems(text) {
  const p = [];
  if ('t0-manifest' in jobs(text)) p.push('a t0-manifest job');
  if (/tool-qa\/worker-kit|t0-bundle\.mjs/.test(text)) p.push('the worker-kit or the bundle builder');
  if (/workflow_call:/.test(text)) p.push('callable by the proof');
  if (!/^# NOT a T0 worker any more, and NOT in the t0-dogfood lane/.test(text)) p.push('the header does not say it is out of the lane');
  return p;
}

test('R-DSB-03: the kubernetes worker, which kind keeps outside the sandbox, builds no result bundle and is out of the lane', () => {
  const k = wf('dogfood-kubernetes.yml');
  assert.deepEqual(kubernetesProblems(k), []);
  assert.match(k, /privileged/);
  const withManifest = `${k}\n  t0-manifest:\n    needs: [t0-start, research]\n    steps:\n      - uses: isokron-ai/tool-qa/worker-kit@${'b'.repeat(40)}\n`;
  assert.ok(kubernetesProblems(withManifest).length >= 2, 'a sealing job added back is refused');
  assert.ok(kubernetesProblems(k.replace('  workflow_dispatch:\n', '  workflow_call:\n  workflow_dispatch:\n')).length > 0, 'made callable: refused');
});

test('R-DSB-04: the driver mirrors only plain paths under the job\'s own parent, and brings files back only as new files with plain names', () => {
  assert.equal(mirrorRoot('/home/runner/work/x/x', '/home/runner/work/_temp'), '/home/runner/work');
  for (const [w, t] of [['/tmp/a/b', '/tmp/c'], ['/a/b', '/c'], ['/home/runner/work/x/x', 'relative'], ['/home/runner/work/x/../x', '/home/runner/work/_temp'], ['/work/a/b', '/work/a/c']]) assert.throws(() => mirrorRoot(w, t), /plain absolute|not a folder the sandbox may mount/, `${w} ${t}`);
  const st = { mirror: '/home/runner/work', workspace: '/home/runner/work/x/x' };
  assert.equal(inMirror('kl', st), '/home/runner/work/x/x/kl');
  for (const bad of ['../../../etc', '/etc/passwd', '/home/runner/workx', 'a b']) assert.throws(() => inMirror(bad, st), /is not under/, bad);
  assert.throws(() => envPairs(['LD PRELOAD=x']), /NAME=value/);
  assert.deepEqual(envPairs(['A=b=c']), { A: 'b=c' });
  const NETS = { run: { subnet: '10.213.53.0/24' } };
  assert.equal(serviceIp(5, NETS), '10.213.53.5');
  for (const n of [2, 3, 4, 251, 'x']) assert.throws(() => serviceIp(n, NETS));
  assert.deepEqual(cliOutDirs(['run', '-m', 'm.yaml', '--out', '/w/r', '--state', '/w/r/state']), ['/w/r', '/w/r/state']);

  const d = realpathSync(mkdtempSync(join(tmpdir(), 'dsb-')));
  try {
    const dest = join(d, 'out');
    mkdirSync(join(dest, 'old'), { recursive: true });
    writeFileSync(join(dest, 'old', 'keep.json'), 'host');
    const files = new Map([
      ['run-1/results.json', Buffer.from('{}')], ['../escape', Buffer.from('x')], ['run-1/../../escape2', Buffer.from('x')],
      ['old/keep.json', Buffer.from('forged')], ['old/new.json', Buffer.from('x')], ['run-1/a b', Buffer.from('x')], ['/abs', Buffer.from('x')],
    ]);
    const w = writeCollected(files, dest, { allow: (top) => top !== 'old' });
    assert.deepEqual(w, { written: 1, refused: 6 });
    assert.equal(readFileSync(join(dest, 'run-1', 'results.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(dest, 'old', 'keep.json'), 'utf8'), 'host', 'a file the host had is never replaced');
    assert.ok(!existsSync(join(d, 'escape')) && !existsSync(join(d, 'escape2')) && !existsSync(join(dest, 'old', 'new.json')));
    // Without the allow list, an existing file is still never replaced.
    assert.deepEqual(writeCollected(new Map([['old/keep.json', Buffer.from('forged')]]), dest), { written: 0, refused: 1 });

    // The pull helper's reader: one regular file at its own real path, never a link.
    writeFileSync(join(d, 'snap.json'), '{"n":1}');
    symlinkSync(join(d, 'out', 'old', 'keep.json'), join(d, 'link.json'));
    const read = (p) => spawnSync(process.execPath, ['-e', PULL_JS, p], { encoding: 'utf8' });
    assert.equal(read(join(d, 'snap.json')).stdout, '{"n":1}');
    assert.equal(read(join(d, 'link.json')).status, 3, 'a link is refused');
    assert.notEqual(read(join(d, 'out')).status, 0, 'a folder is refused');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R-DSB-04: the driver starts containers only through the sandbox library\'s argument builders', () => {
  const src = readFileSync(join(root, 'dogfood', 'sbx.mjs'), 'utf8');
  assert.doesNotMatch(src, /\[\s*'run',|'--privileged'|'--network', 'host'|'--cap-add'|'--runtime', 'runc'/, 'no docker run argv of its own');
  assert.match(src, /M\.sandboxRunArgs\(\{ name, image: shard\.images\[key\]/, 'the unit');
  assert.match(src, /M\.sandboxRunArgs\(\{ name, image, network: inNet, ip: M\.NETS\.install\.target/, 'builds on the install network');
  assert.match(src, /M\.sandboxRunArgs\(\{ name, image, network: st\.runNet, ip, resolv: 'run'/, 'services on the run network');
  assert.match(src, /M\.targetEnvProblems\(env, hostEnv\)/, 'every environment is checked by the sandbox\'s own rule');
  // The build's, a service's, a run's and every unit command's (execArgv, R-DSB-07) environment.
  for (const v of ['benv', 'senv', 'renv', 'all']) assert.match(src, new RegExp(`checkEnv\\(M, ${v}[,)]`), v);
});

test('R-DSB-05: inside the sandbox, a step\'s env file cannot set a loader, a runner name or PATH, and the unit forwards only to the run network', async () => {
  const text = 'KRONICLE_LITE_DATA_DIR=/home/runner/work/_temp/kl\nLD_PRELOAD=/tmp/x.so\nNODE_OPTIONS=--require /tmp/x\nGITHUB_TOKEN=x\nPATH=/tmp\nbad name=1\nWS_MCP_TOKEN=abc=\n';
  const { vars, skipped } = readEnvFile(text);
  assert.deepEqual(vars, [['KRONICLE_LITE_DATA_DIR', '/home/runner/work/_temp/kl'], ['WS_MCP_TOKEN', 'abc=']]);
  assert.equal(skipped, 5);
  const { env } = commandEnv({ envFile: '/w/_temp/sbx-env/env', temp: '/w/_temp', workspace: '/w/a/a', path: ['/w/a/a/.sbx-pnpm/bin'] }, { PATH: '/usr/bin' }, 'RUNNER_TEMP=/elsewhere\n');
  assert.equal(env.RUNNER_TEMP, '/w/_temp', 'the mirrored path, never a value from the file');
  assert.equal(env.GITHUB_ENV, '/w/_temp/sbx-env/env');
  assert.equal(env.PATH, '/w/a/a/.sbx-pnpm/bin:/usr/bin');

  assert.deepEqual(parseForward('4812=10.213.53.5:4812'), { port: 4812, host: '10.213.53.5', hostPort: 4812 });
  for (const bad of ['4812=127.0.0.1:4812', '4812=10.213.54.3:8080', '4812=10.213.53.2:53', '80=10.213.53.5:80', '4812=169.254.169.254:80', 'x']) assert.ok(parseForward(bad) instanceof Error, bad);

  // Mutations: each check taken out lets through what the test above refuses.
  const mut = async (file, from, to) => {
    const src = readFileSync(join(root, 'loop', 'sandbox', file), 'utf8');
    assert.ok(src.includes(from), `${file}: the mutation applies`);
    return import(`data:text/javascript,${encodeURIComponent(src.replace(from, to))}`);
  };
  const inOff = await mut('dogfood-in.mjs', ' || ENV_FILE_DENY.test(name)', '');
  assert.ok(inOff.readEnvFile(text).vars.some(([k]) => k === 'LD_PRELOAD'), 'without the deny list a loader variable gets through');
  const fwdOff = await mut('dogfood-unit.mjs', "if (!RUN_NET.test(host)) return", 'if (false) return');
  assert.ok(!(fwdOff.parseForward('4812=127.0.0.1:4812') instanceof Error), 'without the run-network check a loopback target gets through');
});

test('R-DSB-06: pnpm is only unpacked on the runner, never run there; the sandbox puts it on PATH', () => {
  const sh = readFileSync(join(root, 'dogfood', 'install-pnpm.sh'), 'utf8');
  const install = sh.slice(sh.indexOf('  install)'), sh.indexOf('  *)'));
  assert.doesNotMatch(install, /npm install|^\s*pnpm |\$dest\/bin\/pnpm"? --|node "\$dest/m);
  assert.match(install, /integrity mismatch[\s\S]*tar -xzf "\$tgz" -C "\$dest"/);
  for (const job of Object.values(jobs(wf('dogfood-payload.yml'))).filter((t) => t.includes('install-pnpm.sh install'))) {
    assert.match(job, /node dogfood\/sbx\.mjs build [^\n]*--path \.sbx-pnpm\/bin [^\n]*-- dogfood\/payload\/stack\.sh build /);
  }
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'dsb-')));
const ST = { mirror: '/home/runner/work', workspace: '/home/runner/work/a/a', temp: '/home/runner/work/_temp', envFile: '/home/runner/work/_temp/sbx-env/env', unit: { name: 'surface-x-unit' }, pass: ['GRAFANA_URL'], wsVol: 'surface-x-ws', harnessVol: 'surface-x-harness' };

test('R-DSB-07: every command in the unit passes the sandbox\'s own environment check first, the job\'s passed names too', () => {
  const ok = { targetEnvProblems: () => [] };
  const argv = execArgv(ST, ok, { cwd: ST.workspace, env: { A: 'b' }, pidfile: '/tmp/p', cmd: ['node', 'x.js'] }, { GRAFANA_URL: 'http://127.0.0.1:4930' });
  assert.deepEqual(argv.slice(0, 7), ['exec', '--workdir', ST.workspace, '--env', 'GRAFANA_URL=http://127.0.0.1:4930', '--env', 'A=b']);
  assert.ok(argv.includes('surface-x-unit') && argv.at(-1) === 'x.js');
  // A value the runner keeps under a secret name, or a refused name: the sandbox library says so, and nothing is run.
  const seen = [];
  const refuses = { targetEnvProblems: (env) => { seen.push(env); return ['GITHUB_TOKEN is never passed to a target']; } };
  assert.throws(() => execArgv(ST, refuses, { cwd: ST.workspace, env: { GITHUB_TOKEN: 'x' }, pidfile: '/tmp/p', cmd: ['true'] }, {}), /refused: GITHUB_TOKEN/);
  assert.deepEqual(seen, [{ GITHUB_TOKEN: 'x' }], 'the check saw the whole environment of the command');
});

test('R-DSB-08: a sandboxed step\'s output reaches the job log only between stop-commands markers', async () => {
  const d = tmp();
  try {
    writeFileSync(join(d, 'docker'), '#!/bin/sh\necho "::error::forged"\necho "::add-mask::x" 1>&2\n');
    chmodSync(join(d, 'docker'), 0o755);
    let out = '';
    const r = await stream({ env: { PATH: `${d}:${process.env.PATH}` } }, ['logs'], { sink: { write: (c) => { out += c; } } });
    assert.equal(r.exit, 0);
    const m = /^::stop-commands::([0-9a-f-]{36})\n([\s\S]*)\n::\1::\n$/.exec(out);
    assert.ok(m, `markers around the output: ${JSON.stringify(out)}`);
    assert.match(m[2], /::error::forged/);
    assert.match(m[2], /::add-mask::x/);
    let bare = '';
    await stream({ env: { PATH: `${d}:${process.env.PATH}` } }, ['logs'], { bare: true, sink: { write: (c) => { bare += c; } } });
    assert.doesNotMatch(bare, /stop-commands/, 'bare: the action switches commands off itself');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R-DSB-09: the driver loads the sandbox only from a checkout at exactly SANDBOX_REF', () => {
  const d = tmp();
  try {
    const git = (...a) => spawnSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'x');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const env = { MSC_DIR: d, SANDBOX_REF: head, GITHUB_WORKSPACE: '/w/a/a', RUNNER_TEMP: '/w/_temp' };
    assert.doesNotThrow(() => checkSandboxCheckout(env));
    assert.throws(() => checkSandboxCheckout({ ...env, SANDBOX_REF: 'f'.repeat(40) }), /the sandbox checkout is not SANDBOX_REF/);
    assert.throws(() => checkSandboxCheckout({ ...env, SANDBOX_REF: head.slice(0, 7) }), /full commit SHA/);
    assert.throws(() => checkSandboxCheckout({ ...env, MSC_DIR: undefined }), /MSC_DIR is not set/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R-DSB-10: a build\'s allowlist takes plain registry host names only', () => {
  assert.deepEqual(parseHosts('registry.npmjs.org'), ['registry.npmjs.org']);
  assert.deepEqual(parseHosts('proxy.golang.org,sum.golang.org'), ['proxy.golang.org', 'sum.golang.org']);
  for (const bad of ['', ',', 'localhost', 'evil.com:443', '*.npmjs.org', 'a/b.org', '10.0.0.1', '-x.org', 'Registry.npmjs.org', `${'x'.repeat(98)}.io`]) {
    assert.throws(() => parseHosts(bad), SbxError, bad);
  }
});

test('R-DSB-11: what comes back from the CLI\'s folders never lands in a folder the host had before the call', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'plan'));
    writeFileSync(join(d, 'plan', 'plan.txt'), 'the action wrote this');
    const files = new Map([['plan/plan.txt', Buffer.from('forged')], ['plan/extra.txt', Buffer.from('x')], ['run-1/results.json', Buffer.from('{}')]]);
    assert.deepEqual(writeBack(files, d, new Set(['plan'])), { written: 1, refused: 2 });
    assert.ok(!existsSync(join(d, 'plan', 'extra.txt')), 'no new file in a folder the host had');
    assert.equal(readFileSync(join(d, 'run-1', 'results.json'), 'utf8'), '{}');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('R-DSB-12: pull reads no file through a linked folder above it; an env file line with a NUL or over 8 KiB is skipped', () => {
  const d = tmp();
  try {
    mkdirSync(join(d, 'real'));
    writeFileSync(join(d, 'real', 'snap.json'), '{"n":1}');
    symlinkSync(join(d, 'real'), join(d, 'linked'));
    const read = (p) => spawnSync(process.execPath, ['-e', PULL_JS, p], { encoding: 'utf8' });
    assert.equal(read(join(d, 'real', 'snap.json')).stdout, '{"n":1}');
    assert.equal(read(join(d, 'linked', 'snap.json')).status, 3, 'the file is regular, but its parent is a link');
  } finally { rmSync(d, { recursive: true, force: true }); }
  const { vars, skipped } = readEnvFile(`A=1\nB=x\0y\nC=${'z'.repeat(9000)}\nD=2\n`);
  assert.deepEqual(vars.map(([k]) => k), ['A', 'D']);
  assert.equal(skipped, 2);
});

test('R-DSB-13: files are read back only while every long-lived container of the job is paused; a failed pause reads nothing', async () => {
  const calls = [];
  const dk = (failOn = null) => ({ d: async (argv) => { calls.push(argv.join(' ')); return { exit: argv[0] === 'pause' && argv[1] === failOn ? 1 : 0 }; } });
  const got = await whilePaused(dk(), ['unit', 'svc-a'], async () => { calls.push('read'); return 7; });
  assert.equal(got, 7);
  assert.deepEqual(calls, ['pause unit', 'pause svc-a', 'read', 'unpause svc-a', 'unpause unit']);
  calls.length = 0;
  await assert.rejects(whilePaused(dk('svc-a'), ['unit', 'svc-a'], async () => { calls.push('read'); }), /could not pause svc-a/);
  assert.deepEqual(calls, ['pause unit', 'pause svc-a', 'unpause unit'], 'nothing read, and what was paused is resumed');
});

test('R-DSB-14: the harness (dogfood/, our scripts and manifests) is mounted read-only over the read-write workspace in every container of the job', () => {
  const m = workMounts(ST, 'surface-x-tools');
  assert.deepEqual(m, [
    { src: 'surface-x-ws', dst: '/home/runner/work' },
    { src: 'surface-x-harness', dst: '/home/runner/work/a/a/dogfood', ro: true },
    { src: 'surface-x-tools', dst: '/opt/surface', ro: true },
  ]);
  const src = readFileSync(join(root, 'dogfood', 'sbx.mjs'), 'utf8');
  assert.match(src, /`--exclude=\$\{wsRel\}\/dogfood`/, 'dogfood/ is not in the read-write copy');
  // Every container that mounts the workspace mounts it through workMounts (the unit, builds, services of our images, run).
  assert.equal((src.match(/mounts: workMounts\(st, shard\.toolsVol\)/g) ?? []).length + (src.match(/: workMounts\(st, shard\.toolsVol\);/g) ?? []).length, 4);
  assert.doesNotMatch(src, /\{ src: st\.wsVol, dst: st\.mirror \}, \{ src: shard\.toolsVol/, 'no container of the job mounts the workspace without the harness over it');
});

test('R-DSB-15: the sandbox mutants are a probes file for the shared mutation-probe caller, every one still applying once', () => {
  // gh workflow run mutation-probe.yml -f ref=<branch> -f probe-files=test/mutations/dogfood-sandbox.json
  assert.ok(existsSync(join(root, '.github', 'workflows', 'mutation-probe.yml')), 'the shared caller (tool-qa\'s reusable mutation-probe workflow)');
  assert.ok(!existsSync(join(root, '.github', 'workflows', 'mutation-probes.yml')), 'no second probe workflow');
  const probes = JSON.parse(readFileSync(join(root, 'test', 'mutations', 'dogfood-sandbox.json'), 'utf8'));
  assert.ok(Array.isArray(probes) && probes.length > 0 && probes.length <= 20, 'a list the caller takes in one run (20 at most)');
  assert.equal(new Set(probes.map((p) => p.id)).size, probes.length, 'unique ids');
  for (const p of probes) {
    assert.equal(p.test, 'test/dogfood-sandbox.test.mjs', p.id);
    assert.equal(typeof p.replace, 'string', p.id);
    // Stale otherwise: the caller records a probe whose text is not there exactly once as stale, and the run fails.
    assert.equal(readFileSync(join(root, p.file), 'utf8').split(p.find).length, 2, `${p.id}: its text is in ${p.file} exactly once`);
  }
  for (const id of ['07', '08', '09', '10', '11', '12', '13', '14']) assert.ok(probes.some((p) => p.id.startsWith(`r-dsb-${id}-`)), `R-DSB-${id} has a probe`);
});

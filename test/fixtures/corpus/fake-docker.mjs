#!/usr/bin/env node
/**
 * A stand-in `docker` for test/corpus.test.mjs, so the driver's container plumbing is tested without
 * a Docker daemon. Every call is appended to $FAKE_DOCKER_LOG as one JSON line (argv). Volumes are
 * folders under $FAKE_DOCKER_ROOT/vols. A sandbox `run` of the CLI behaves like a stand-in CLI that
 * prints target-specific text, writes a results folder and exits with the number in
 * $FAKE_DOCKER_ROOT/cli-exit (catalog step). The driver gives docker an allowlisted environment, so
 * the shim that calls this script sets FAKE_DOCKER_ROOT itself; the log is $FAKE_DOCKER_ROOT/calls.jsonl.
 * The real thing is tested by test/corpus-container.test.mjs (CORPUS_DOCKER_TESTS=1).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const root = process.env.FAKE_DOCKER_ROOT;
const NAME = 'zz-secret-target-name';
const env = JSON.parse(process.env.FAKE_DOCKER_SEEN_ENV ?? '[]');
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ argv, env }) + '\n');
const netFile = join(root, 'networks.json');
const nets = existsSync(netFile) ? JSON.parse(readFileSync(netFile, 'utf8')) : {};
const done = (code = 0, out = '') => {
  if (out) process.stdout.write(out);
  process.exit(code);
};
const stdin = () => new Promise((r) => {
  const c = [];
  process.stdin.on('data', (x) => c.push(x));
  process.stdin.on('end', () => r(Buffer.concat(c)));
});

const [cmd, ...rest] = argv;
const serverVersion = join(root, 'server-version');
if (cmd === 'version') done(0, rest.join(' ').includes('Server.Os') ? 'linux/amd64\n' : existsSync(serverVersion) ? readFileSync(serverVersion, 'utf8') : '29.0.0-fake\n');
if (cmd === 'info') done(0, '4\n');
if (cmd === 'pull') done(0);
if (cmd === 'image') done(0, 'sha256:fake\n');
if (cmd === 'volume') done(0, rest[0] === 'create' ? `${rest.at(-1)}\n` : '');
if (cmd === 'network') {
  if (rest[0] === 'create') {
    nets[rest.at(-1)] = rest.includes('--internal');
    writeFileSync(netFile, JSON.stringify(nets));
    done(0);
  }
  if (rest[0] === 'inspect') done(0, `${nets[rest.at(-1)] ? 'true' : 'false'}\n`);
  done(0);
}
if (['ps', 'rm', 'logs', 'exec', 'create', 'cp'].includes(cmd)) done(0);
if (cmd !== 'run') done(1);

// docker run [options] IMAGE CMD...
const imgAt = rest.findIndex((a, i) => /@sha256:[0-9a-f]{64}$/.test(a) && !['--label', '--name', '--env', '--mount'].includes(rest[i - 1]));
const opts = rest.slice(0, imgAt);
const c = rest.slice(imgAt + 1);
const work = opts.map((a, i) => (opts[i - 1] === '--mount' ? a : null)).filter(Boolean).map((m) => /src=([^,]+),dst=\/work/.exec(m)).find(Boolean)?.[1];
const vol = work ? join(root, 'vols', work) : null;
const inVol = (p) => join(vol, p.replace(/^\/work\/?/, ''));
const script = c[0] === 'sh' && c[1] === '-c' ? c[2] : '';

if (opts.includes('-d')) done(0, 'fakecontainerid\n');
if (opts.includes('--interactive')) {
  const buf = await stdin();
  if (script.includes('cat > "$1"')) {
    mkdirSync(dirname(inVol(c[4])), { recursive: true });
    writeFileSync(inVol(c[4]), buf);
  }
  done(0);
}
if (script.includes('cd /work/out')) {
  const out = inVol('/work/out');
  if (!existsSync(out)) done(0);
  const t = spawn('tar', ['-C', out, '-cf', '-', '.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  t.on('close', (code) => process.exit(code));
} else if (c[1] === '/opt/mwsc/dist/src/cli/main.js') {
  const sub = c[2];
  process.stdout.write(`${NAME} violated MWS-ANN-1 ::error::nope\n`);
  process.stderr.write(`${NAME} on stderr\n`);
  if (sub === 'plan') done(0, 'plan hash: 0123456789abcdef\n');
  if (sub === 'catalog') {
    const r = inVol(join(c[c.indexOf('--out') + 1], 'catalog-x'));
    mkdirSync(r, { recursive: true });
    writeFileSync(join(r, 'results.json'), JSON.stringify({ format: 'mws-results/1', run: { status: 'complete' }, results: [{ requirement: 'MWS-ANN-4', verdict: 'violated' }] }));
    done(Number(readFileSync(join(root, 'cli-exit'), 'utf8')));
  }
  done(4);
} else if (c[0] === 'npm' && c[1] === 'ls') {
  const n = existsSync(join(root, 'deps-bytes')) ? Number(readFileSync(join(root, 'deps-bytes'), 'utf8')) : 0;
  done(0, n ? `${'d'.repeat(n)}\n` : '{"fake":true}\n');
}
else done(0, `${NAME} install output\n`);

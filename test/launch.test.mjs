/**
 * WC14: the writecheck lane starts OCI images and crates (loop/launch.mjs, loop/sandbox/cargo-entry.mjs, the OCI and
 * crate paths of loop/run-items.mjs). No Docker, no network: the live-probe resolver is a stand-in here, and the real
 * one (isokron-ai/mcp-check at MCP_CHECK_REF) is checked against a fake registry when MCK_DIR names a checkout of it
 * (loop-fixture.yml sets it).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BRIDGE_ENV_EMPTY, MAX_IMAGE_VOLUMES, MCK_NEEDS, OCI_MAX_UNPACKED, cargoPlan, launchEnv, loadImages, loadMck, ociPullProblem, ociServer, portableBridge, resolveBeyondSeed, seedCrates } from '../loop/launch.mjs';
import { resolveSubject, loadFixtures } from '../loop/items.mjs';
import { ENTRY_FAULT, entryErrorCode, installFault, itemSkips } from '../loop/skips.mjs';
import { SKIP_FAULTS } from './fixtures/loop/tool-qa/worker-kit/contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = loadFixtures(join(root, 'loop', 'fixtures.json'));
const DIGEST = 'b'.repeat(64);

// The live-probe resolver's DETAILS rows this lane maps (mcp-check corpus/live-probe.mjs at MCP_CHECK_REF).
const DETAILS = {
  no_package: ['no_runnable_artifact', false, 'resolve', 'tool'],
  unsupported_package: ['no_runnable_artifact', false, 'resolve', 'tool'],
  oci_host_not_allowed: ['no_runnable_artifact', false, 'resolve', 'tool'],
  image_too_large: ['too_large', false, 'resolve', 'tool'],
  image_unavailable: ['install_failed_registry', false, 'resolve', 'subject'],
  remote_only: ['remote_only', false, 'resolve', 'subject'],
  rate_limited: ['rate_limited', true, 'resolve', 'infra'],
  upstream_error: ['upstream_unavailable', true, 'resolve', 'infra'],
};
/** A stand-in for mcp-check's module: resolveSubject answers what `answer` says, and records what it was asked. */
const fakeMck = (answer) => {
  const calls = [];
  return { calls, DETAILS, OCI_HOSTS: ['ghcr.io'], OCI_MAX_BYTES: 2 ** 31, resolveSubject: async (item, opts) => { calls.push({ item, seed: opts.seed }); return typeof answer === 'function' ? answer(item, opts) : answer; } };
};
const ociRunnable = { status: 'runnable', launch: { kind: 'docker', image: `ghcr.io/acme/srv:1.2@sha256:${DIGEST}` }, choice: { type: 'oci', matched_by: 'namespace+repository', verified_by: 'namespace', oci_bytes: 123456 } };
const skipped = (detail) => ({ status: 'skipped', detail });

const SEED = {
  map: new Map([
    ['acme/oci', { id: 'acme/oci', transport: 'stdio', packages: [{ registry: 'oci', identifier: 'ghcr.io/acme/srv:1.2' }] }],
    ['acme/crate', { id: 'acme/crate', transport: 'stdio', packages: [{ registry: 'cargo', identifier: 'acme-mcp' }] }],
    ['acme/both', { id: 'acme/both', transport: 'stdio', packages: [{ registry: 'oci', identifier: 'ghcr.io/acme/both:1' }, { registry: 'cargo', identifier: 'both-mcp' }] }],
    ['acme/mcpb', { id: 'acme/mcpb', transport: 'stdio', packages: [{ registry: 'mcpb', identifier: 'https://example.invalid/x.mcpb' }] }],
  ]),
};

test('WC14: a subject with an OCI image or a crate in the seed is passed on; MCPB or NuGet only stays our own gap', () => {
  for (const s of ['acme/oci', 'acme/crate', 'acme/both']) {
    const r = resolveSubject(s, { seed: SEED, fixtures });
    assert.equal(r.skip.reason, 'no_runnable_artifact', s);
    assert.equal(r.skip.beyond, true, s);
    assert.equal(r.entry.id, s);
  }
  const m = resolveSubject('acme/mcpb', { seed: SEED, fixtures });
  assert.equal(m.skip.beyond, undefined);
  assert.equal(itemSkips({ resolved: m }).skips[0].fault, 'tool');
  assert.deepEqual(seedCrates(SEED.map.get('acme/both')), ['both-mcp']);
  assert.deepEqual(seedCrates({ packages: [{ registry: 'cargo', identifier: '--git=https://x' }, { registry: 'cargo', identifier: 'ok_name-1' }] }), ['ok_name-1']);
});

test('R-WC-33: an OCI subject gets the image the live-probe resolver chooses, with its codes and fault sides when there is none', async () => {
  const mck = fakeMck(ociRunnable);
  const r = await resolveBeyondSeed('acme/oci', SEED.map.get('acme/oci'), { mck });
  assert.deepEqual(r.launch, ociRunnable.launch);
  assert.equal(r.source, 'registry');
  assert.equal(r.package, `oci:${DIGEST}`, 'outside raw/ the image is named by its digest only');
  assert.deepEqual(r.choice, { type: 'oci', matched_by: 'namespace+repository', verified_by: 'namespace', oci_bytes: 123456 });
  // The resolver is asked with the subject and its seed packages, as live-probe asks it.
  assert.deepEqual(mck.calls[0].item, { repo: 'acme/oci' });
  assert.deepEqual(mck.calls[0].seed.get('acme/oci'), [{ registry: 'oci', identifier: 'ghcr.io/acme/srv:1.2' }]);
  // No runnable package: the resolver's own reason and fault (DETAILS), so both lanes say the same about the subject.
  for (const [detail, reason, fault] of [['oci_host_not_allowed', 'no_runnable_artifact', 'tool'], ['image_too_large', 'too_large', 'tool'], ['image_unavailable', 'install_failed_registry', 'subject'], ['remote_only', 'remote_only', 'subject']]) {
    const x = await resolveBeyondSeed('acme/oci', SEED.map.get('acme/oci'), { mck: fakeMck(skipped(detail)) });
    assert.deepEqual([x.skip.reason, x.skip.fault, !!x.skip.retryable], [reason, fault, false], detail);
    for (const sk of itemSkips({ resolved: x }).skips) assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault), `${detail}: ${sk.reason}/${sk.fault}`);
  }
  // A rate limit or an outage of the registry: retryable, infra, and never replaced by a build.
  for (const detail of ['rate_limited', 'upstream_error']) {
    const x = await resolveBeyondSeed('acme/both', SEED.map.get('acme/both'), { mck: fakeMck(skipped(detail)) });
    assert.equal(x.skip.retryable, true, detail);
    assert.equal(x.skip.fault, 'infra', detail);
    assert.equal(x.launch, undefined, detail);
  }
  // An HTTP-only runnable package is our gap (this lane starts stdio servers), unless the seed has a crate.
  const http = { status: 'runnable', launch: { kind: 'docker', image: ociRunnable.launch.image, transport: 'http', http: { port: 8080, path: '/mcp' } }, choice: {} };
  assert.deepEqual((await resolveBeyondSeed('acme/oci', SEED.map.get('acme/oci'), { mck: fakeMck(http) })).skip.reason, 'unsupported_transport');
  assert.equal((await resolveBeyondSeed('acme/both', SEED.map.get('acme/both'), { mck: fakeMck(http) })).launch.kind, 'cargo');
  // The driver loads the resolver only with every name it uses, and pins it in both loop workflows at one full SHA.
  const pins = ['corpus.yml', 'loop-fixture.yml'].map((wf) => /MCP_CHECK_REF: '([0-9a-f]{40})'/.exec(readFileSync(join(root, '.github', 'workflows', wf), 'utf8'))?.[1]);
  assert.ok(pins[0] && pins[0] === pins[1]);
  assert.match(readFileSync(join(root, 'loop', 'prepare.sh'), 'utf8'), /fetch_at isokron-ai\/mcp-check "\$MCP_CHECK_REF" mck /);
  for (const wf of ['corpus.yml', 'loop-fixture.yml']) {
    const t = readFileSync(join(root, '.github', 'workflows', wf), 'utf8');
    // Only when the pinned checkout fetched it: an older pinned driver (tool_sha) does not take --mck.
    assert.match(t, /mck=\(\); if \[ -d mck\/corpus \]; then mck=\(--mck mck\); fi\n\s*node loop\/run-items\.mjs --msc msc "\$\{mck\[@\]\}" /, wf);
  }
  await assert.rejects(loadMck(mkdtempSync(join(tmpdir(), 'wc-no-mck-'))));
});

test('R-WC-42: a Go repository the live-probe resolver builds at its commit is named by its package path, never go:undefined, and the loop fetches the resolver\'s Go entry module', async () => {
  const sha = 'ab'.repeat(20);
  const goRunnable = { status: 'runnable', launch: { kind: 'go', module: 'github.com/acme/srv/cmd/srv', version: sha }, choice: { type: 'go', matched_by: 'repository', verified_by: 'source_commit' } };
  const r = await resolveBeyondSeed('acme/oci', SEED.map.get('acme/oci'), { mck: fakeMck(goRunnable) });
  assert.deepEqual(r.launch, goRunnable.launch);
  assert.equal(r.package, 'go:github.com/acme/srv/cmd/srv');
  assert.equal(r.source, 'registry');
  assert.equal(r.choice.type, 'go');
  // live-probe.mjs imports corpus/go-entry.mjs: the sparse checkout of mcp-check must hold it, or the resolver does not load.
  assert.match(readFileSync(join(root, 'loop', 'prepare.sh'), 'utf8'), /fetch_at isokron-ai\/mcp-check "\$MCP_CHECK_REF" mck [^\n]*\/corpus\/go-entry\.mjs /);
});

test('R-WC-33: with a checkout of mcp-check at MCP_CHECK_REF, its own resolver chooses the image from a registry entry', { skip: !process.env.MCK_DIR && 'set MCK_DIR to a checkout of isokron-ai/mcp-check at MCP_CHECK_REF' }, async () => {
  const mck = await loadMck(process.env.MCK_DIR);
  assert.deepEqual(MCK_NEEDS.filter((n) => mck[n] === undefined), []);
  // A fake registry and image host: the official MCP Registry lists acme/oci's image under its own namespace.
  const leaf = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { size: 100 }, layers: [{ size: 1000 }, { size: 2000 }] }));
  const leafDigest = `sha256:${createHash('sha256').update(leaf).digest('hex')}`;
  const index = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: leafDigest, platform: { os: 'linux', architecture: 'amd64' } }] }));
  const indexDigest = `sha256:${createHash('sha256').update(index).digest('hex')}`;
  const entry = { server: { name: 'io.github.acme/oci', version: '1.2.0', repository: { url: 'https://github.com/acme/oci' }, packages: [{ registryType: 'oci', identifier: 'ghcr.io/acme/srv:1.2', transport: { type: 'stdio' } }] } };
  const res = (status, body, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, arrayBuffer: async () => body });
  const fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('https://registry.modelcontextprotocol.io/v0.1/servers?')) return res(200, Buffer.from(JSON.stringify({ servers: [entry] })));
    if (u === 'https://ghcr.io/v2/acme/srv/manifests/1.2') return res(200, index);
    if (u === `https://ghcr.io/v2/acme/srv/manifests/${encodeURIComponent(leafDigest)}`) return res(200, leaf);
    return res(404, Buffer.from('{}'));
  };
  const r = await resolveBeyondSeed('acme/oci', SEED.map.get('acme/oci'), { mck, fetch });
  assert.equal(r.launch?.kind, 'docker', JSON.stringify(r).slice(0, 300));
  assert.equal(r.launch.image, `ghcr.io/acme/srv:1.2@${indexDigest}`);
  assert.equal(r.package, `oci:${indexDigest.slice(7)}`);
  assert.equal(r.choice.oci_bytes, 3100);
  // A crate-only subject: the resolver finds nothing runnable, so the crate is the launch.
  const c = await resolveBeyondSeed('acme/crate', SEED.map.get('acme/crate'), { mck, fetch: async () => res(200, Buffer.from('{"servers":[]}')) });
  assert.deepEqual(c.launch, { kind: 'cargo', crate: 'acme-mcp', version: 'latest' });
});

test('R-WC-32: an OCI subject starts as docker run would start it, with the bridge through the portable runtime', async () => {
  const { RT_SCRIPT, portableLoader } = await import('../loop/run-items.mjs');
  // Docker's rules: Entrypoint, then the launch's args or else the image's Cmd; a replaced entrypoint drops the image's Cmd.
  assert.deepEqual(ociServer({ Entrypoint: ['/srv'], Cmd: ['--stdio'], WorkingDir: '/app' }, {}), { cmd: ['/srv', '--stdio'], workdir: '/app', env: {}, volumes: 0 });
  assert.deepEqual(ociServer({ Entrypoint: ['/srv'], Cmd: ['--stdio'] }, { args: ['stdio', '--read-only'] }).cmd, ['/srv', 'stdio', '--read-only']);
  assert.deepEqual(ociServer({ Entrypoint: null, Cmd: ['python', 'main.py'] }, {}).cmd, ['python', 'main.py']);
  assert.deepEqual(ociServer({ Entrypoint: ['/srv'], Cmd: ['--http'] }, { entrypoint: '/other' }).cmd, ['/other']);
  assert.equal(ociServer({ Entrypoint: null, Cmd: null }, {}).error, 'image_has_no_command');
  assert.equal(ociServer({ Entrypoint: ['/srv\nrm -rf /'] }, {}).error, 'image_config_unreadable');
  assert.equal(ociServer({ Entrypoint: 'sh -c x' }, {}).error, 'image_config_unreadable');
  assert.equal(ociServer({ Cmd: Array.from({ length: 61 }, () => 'x') }, {}).error, 'image_config_unreadable');
  assert.equal(ociServer({ Cmd: ['/srv'], WorkingDir: '../etc' }, {}).workdir, '/');
  assert.equal(ociServer({ Cmd: ['/srv'], WorkingDir: '/app/../etc' }, {}).workdir, '/');
  assert.equal(ociServer({ Cmd: ['/srv'] }, {}).workdir, '/');
  // The bridge: Node from the read-only tools volume through the glibc loader copied beside it, and nothing set in the
  // environment for the server it spawns (no LD_ variable: --library-path is an argument of the loader).
  const b = portableBridge({ loader: 'ld-linux-x86-64.so.2', port: 7300, serverCmd: ['/srv', '--stdio'] });
  assert.deepEqual(b, { entrypoint: '/opt/surface/rt/ld-linux-x86-64.so.2', cmd: ['--library-path', '/opt/surface/rt', '/opt/surface/node/node', '/opt/surface/loop/bridge.mjs', '7300', '--', '/srv', '--stdio'] });
  assert.throws(() => portableBridge({ loader: '../../bin/sh', port: 7300, serverCmd: ['x'] }));
  assert.throws(() => portableBridge({ loader: null, port: 7300, serverCmd: ['x'] }));
  assert.equal(portableLoader('ld-linux-x86-64.so.2\nlibc.so.6\nlibdl.so.2\nlibgcc_s.so.1\nlibm.so.6\nlibpthread.so.0\nlibstdc++.so.6\n'), 'ld-linux-x86-64.so.2');
  assert.equal(portableLoader('ld-linux-aarch64.so.1\nlibc.so.6\n'), 'ld-linux-aarch64.so.1');
  assert.equal(portableLoader('libc.so.6\n'), null, 'no loader');
  assert.equal(portableLoader('ld-linux-x86-64.so.2\nld-linux-aarch64.so.1\nlibc.so.6\n'), null, 'two loaders');
  assert.equal(portableLoader('ld-linux-x86-64.so.2\n'), null, 'no libc');
  assert.match(RT_SCRIPT, /ldd \/usr\/local\/bin\/node/);
  assert.match(RT_SCRIPT, /cp -L "\$f" \/opt\/surface\/rt\//);
  // The driver starts an OCI subject only with the runtime in place, in its own image, without a volume of ours but the tools.
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /if \(!this\.loader\) throw new M\.HarnessError\('the portable runtime for the bridge is not in the tools volume'\);/);
  assert.match(src, /image = u\.launch\.image;\n\s*serverCmd = server\.cmd;\n(?:\s*\/\/[^\n]*\n)*\s*u\.oci = \{ workdir: server\.workdir, serverEnv: /);
});

test('R-WC-35: an OCI subject\'s image is removed when its unit ends, after its containers', () => {
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  const fin = src.slice(src.indexOf("try { await this.dk.sweep(u.tag); }"), src.indexOf('watch.stop();'));
  assert.match(fin, /if \(u\.pulled\) \{ try \{ await this\.dk\.d\(\['image', 'rm', '--force', u\.pulled\]/);
  assert.ok(src.indexOf('u.pulled = ref;') < src.indexOf("['pull', '-q', ref]"), 'recorded before the pull, so a pull that fails half way is removed too');
});

test('R-WC-34: a crate builds with its own lockfile in the pinned Rust image, through crates.io only, and leaves only its binary', () => {
  const p = cargoPlan({ kind: 'cargo', crate: 'acme-mcp', version: 'latest' });
  assert.equal(p.image, 'rust-build');
  assert.match(p.image, /-build$/, 'the build time limit (MS.build) applies');
  assert.equal(p.runImage, 'rust-build');
  assert.deepEqual(p.registries, ['index.crates.io', 'static.crates.io']);
  assert.deepEqual(p.install.map((s) => s.name), ['install', 'entry', 'clean']);
  assert.deepEqual(p.install[0].cmd, ['cargo', 'install', '--locked', '--root', '/work/pkg', '--', 'acme-mcp']);
  assert.equal(p.install[0].env.CARGO_TARGET_DIR, '/work/target');
  assert.equal(p.install[0].env.CARGO_HOME, '/work/cargo-home');
  assert.deepEqual(p.install[1].cmd, ['/opt/surface/node/node', '/opt/surface/loop/cargo-entry.mjs', '/work/pkg', 'acme-mcp']);
  assert.equal(p.install[1].out, 'entry.json');
  assert.deepEqual(p.install[2].cmd, ['rm', '-rf', '/work/target', '/work/cargo-home']);
  assert.deepEqual(p.run({ script: '/work/pkg/bin/acme-mcp' }), ['/work/pkg/bin/acme-mcp']);
  assert.deepEqual(cargoPlan({ kind: 'cargo', crate: 'x', version: '1.2.3' }).install[0].cmd, ['cargo', 'install', '--locked', '--root', '/work/pkg', '--version', '1.2.3', '--', 'x']);
  for (const bad of ['--git=https://example.invalid/x', 'a b', '../x', '', 'x'.repeat(65)]) assert.throws(() => cargoPlan({ kind: 'cargo', crate: bad, version: 'latest' }), bad);
  assert.throws(() => cargoPlan({ kind: 'cargo', crate: 'x', version: '--path=/' }));
  // The Rust image is the sandbox's own (rust-build in its images.json since 4504c0b), pinned by its index digest; ours takes no key of the sandbox's.
  const imgs = loadImages();
  if (process.env.MSC_DIR) assert.match(JSON.parse(readFileSync(join(process.env.MSC_DIR, 'images.json'), 'utf8'))['rust-build'], /^docker\.io\/library\/rust:1\.\d+\.\d+-bookworm@sha256:[0-9a-f]{64}$/);
  assert.ok(!Object.hasOwn(imgs, 'rust-build'), 'the sandbox names rust-build; a second entry of ours would stop the harness');
  if (process.env.MSC_DIR) for (const k of Object.keys(imgs)) assert.ok(!Object.hasOwn(JSON.parse(readFileSync(join(process.env.MSC_DIR, 'images.json'), 'utf8')), k), k);
  else for (const k of Object.keys(imgs)) assert.ok(!['node24', 'node22', 'node24-build', 'node22-build', 'python', 'go'].includes(k), k);
  const dir = mkdtempSync(join(tmpdir(), 'wc-images-'));
  writeFileSync(join(dir, 'images.json'), JSON.stringify({ x: 'docker.io/library/rust:latest' }));
  assert.throws(() => loadImages(join(dir, 'images.json')), /by tag and index digest/);
});

test('R-WC-34: the crate\'s binary is the one cargo recorded, picked without a guess', () => {
  const entry = join(root, 'loop', 'sandbox', 'cargo-entry.mjs');
  const REG = '(registry+https://github.com/rust-lang/crates.io-index)';
  const setup = (installs, files) => {
    const d = mkdtempSync(join(tmpdir(), 'wc-cargo-'));
    mkdirSync(join(d, 'bin'));
    for (const f of files) { writeFileSync(join(d, 'bin', f), '#!/bin/true\n'); chmodSync(join(d, 'bin', f), 0o755); }
    if (installs) writeFileSync(join(d, '.crates2.json'), JSON.stringify({ installs }));
    return d;
  };
  const run = (d, crate) => { const r = spawnSync(process.execPath, [entry, d, crate], { encoding: 'utf8' }); return { status: r.status, out: JSON.parse(r.stdout.trim()) }; };
  let d = setup({ [`fm-mcp 0.1.3 ${REG}`]: { bins: ['fm-mcp'] } }, ['fm-mcp']);
  assert.deepEqual(run(d, 'fm-mcp'), { status: 0, out: { script: join(d, 'bin', 'fm-mcp'), version: '0.1.3', bins: 1 } });
  // A binary named otherwise is still the only one.
  d = setup({ [`ferric-fred-mcp 0.3.11 ${REG}`]: { bins: ['fred-mcp'] } }, ['fred-mcp']);
  assert.equal(run(d, 'ferric-fred-mcp').out.script, join(d, 'bin', 'fred-mcp'));
  // Several: the one named for the crate (- and _ alike), else the only one that says mcp; else no guess.
  d = setup({ [`agentic_ssh 1.0.0 ${REG}`]: { bins: ['agentic-ssh', 'ssh-helper'] } }, ['agentic-ssh', 'ssh-helper']);
  assert.equal(run(d, 'agentic_ssh').out.script, join(d, 'bin', 'agentic-ssh'));
  d = setup({ [`sqry 4.0.0 ${REG}`]: { bins: ['sqry', 'sqry-mcp'] } }, ['sqry', 'sqry-mcp']);
  assert.equal(run(d, 'sqry').out.script, join(d, 'bin', 'sqry'));
  d = setup({ [`tool 1.0.0 ${REG}`]: { bins: ['tool-cli', 'tool-mcp'] } }, ['tool-cli', 'tool-mcp']);
  assert.equal(run(d, 'tool').out.script, join(d, 'bin', 'tool-mcp'));
  d = setup({ [`tool 1.0.0 ${REG}`]: { bins: ['a', 'b'] } }, ['a', 'b']);
  assert.deepEqual(run(d, 'tool'), { status: 1, out: { error: 'several_binaries', bins: ['a', 'b'] } });
  // Nothing to start, or nothing of that crate from crates.io.
  d = setup({ [`lib 1.0.0 ${REG}`]: { bins: [] } }, []);
  assert.equal(run(d, 'lib').out.error, 'no_binary');
  d = setup({ 'lib 1.0.0 (git+https://example.invalid/lib#abc)': { bins: ['lib'] } }, ['lib']);
  assert.equal(run(d, 'lib').out.error, 'not_installed');
  d = setup(null, []);
  assert.equal(run(d, 'lib').out.error, 'not_installed');
  // A recorded binary that is not a file in bin/ (a link a build script left) is not started.
  d = setup({ [`x 1.0.0 ${REG}`]: { bins: ['x'] } }, []);
  assert.equal(run(d, 'x').out.error, 'no_binary');
  assert.equal(spawnSync(process.execPath, [entry, d, '--git=x'], { encoding: 'utf8' }).status, 2);
});

test('R-WC-36: an install that ended without a server to start is the subject\'s only for its own lack (no command, no binary)', () => {
  const done = (o) => ({ ok: false, timed_out: false, egress: [], ...o });
  assert.equal(installFault(done({ kind: 'docker', steps: [{ name: 'pull', exit: 0 }, { name: 'config', exit: 1 }], entry_error: 'image_has_no_command' })), 'subject');
  assert.equal(installFault(done({ kind: 'docker', steps: [{ name: 'pull', exit: 0 }, { name: 'config', exit: 1 }], entry_error: 'image_config_unreadable' })), 'tool');
  assert.equal(installFault(done({ kind: 'docker', steps: [{ name: 'pull', exit: 0 }, { name: 'config', exit: 1 }], entry_error: 'image_platform' })), 'tool');
  assert.equal(installFault(done({ kind: 'docker', steps: [{ name: 'pull', exit: 1 }] }), 'Error response from daemon: manifest unknown'), 'tool');
  assert.equal(installFault(done({ kind: 'docker', steps: [{ name: 'pull', exit: 1, timed_out: true }] })), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], entry_error: 'no_binary' })), 'subject');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], entry_error: 'several_binaries' })), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], entry_error: 'not_installed' })), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', package: 'acme-mcp', steps: [{ name: 'install', exit: 101 }] }), 'error: could not find `acme-mcp` in registry `crates-io` with version `*`'), 'subject');
  // Only for the crate asked for, before anything compiled (a build script could print the line), with no network trouble.
  assert.equal(installFault(done({ kind: 'cargo', package: 'acme-mcp', steps: [{ name: 'install', exit: 101 }] }), 'error: could not find `other-dep` in registry `crates-io`'), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', package: 'acme-mcp', steps: [{ name: 'install', exit: 101 }] }), '   Compiling serde v1.0.0\nerror: could not find `acme-mcp` in registry `crates-io`'), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', package: 'acme-mcp', steps: [{ name: 'install', exit: 101 }] }), 'warning: spurious network error (2 tries remaining)\nerror: could not find `acme-mcp` in registry `crates-io`'), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 101 }] }), 'error: could not find `acme-mcp` in registry `crates-io`'), 'tool', 'no crate recorded: no evidence');
  // A crate's entry helper that crashed or printed no JSON is ours.
  assert.equal(entryErrorCode(null, 1), 'entry_failed');
  assert.equal(entryErrorCode({ error: 'no_binary' }, 139), 'entry_crashed');
  assert.equal(entryErrorCode({ error: 'no_binary' }, 1), 'no_binary');
  assert.equal(entryErrorCode({ error: 'made_up_code' }, 1), 'entry_failed');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 0 }, { name: 'entry', exit: 1 }], entry_error: entryErrorCode(null, 1) })), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 101 }] }), 'error: failed to run custom build command for `openssl-sys v0.9.1`'), 'tool');
  assert.equal(installFault(done({ kind: 'cargo', steps: [{ name: 'install', exit: 101 }], egress: [{ host: 'github.com', allowed: false }] }), 'error: could not find `x` in registry `crates-io`'), 'tool');
  for (const [code, fault] of Object.entries(ENTRY_FAULT)) assert.ok(['tool', 'subject'].includes(fault), code);
  // Through itemSkips, each is a fault the reason allows.
  for (const ee of Object.keys(ENTRY_FAULT)) {
    for (const sk of itemSkips({ resolved: {}, res: { error: null, install: done({ kind: 'cargo', steps: [{ name: 'entry', exit: 1 }], entry_error: ee }), fullRan: false } }).skips) assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault), `${ee}: ${sk.reason}/${sk.fault}`);
  }
});

test('WC14: a registry launch\'s declared environment gets dummy values, only names the sandbox passes', () => {
  const M = { dummyValue: (n) => `dummy-${n}`, targetEnvProblems: (e) => Object.keys(e).filter((k) => /^(PATH|LD_.*|GITHUB_.*)$/.test(k)) };
  assert.deepEqual(launchEnv({ env: { API_TOKEN: null, MODE: 'stdio', LD_PRELOAD: null, GITHUB_TOKEN: null } }, M), { API_TOKEN: 'dummy-API_TOKEN', MODE: 'stdio' });
  assert.deepEqual(launchEnv({}, M), {});
});

test('R-WC-37: the bridge starts with the image\'s Node, OpenSSL and glibc variables emptied, the server gets the image\'s environment back, and a bridge that does not start is not retried', async () => {
  const { runEnv, serverContainer } = await import('../loop/run-items.mjs');
  // The image's Env is read as Docker wrote it; LD_PRELOAD or LD_AUDIT (which msc never lets us empty) is refused.
  const s = ociServer({ Cmd: ['/srv'], Env: ['PATH=/usr/local/bin:/usr/bin', 'NODE_OPTIONS=--require /x.js', 'APP_MODE=a=b'] }, {});
  assert.deepEqual(s.env, { PATH: '/usr/local/bin:/usr/bin', NODE_OPTIONS: '--require /x.js', APP_MODE: 'a=b' });
  assert.equal(ociServer({ Cmd: ['/srv'], Env: ['LD_PRELOAD=/usr/lib/libjemalloc.so'] }, {}).error, 'image_env_loader');
  assert.equal(ociServer({ Cmd: ['/srv'], Env: ['LD_AUDIT=/a.so'] }, {}).error, 'image_env_loader');
  assert.equal(ociServer({ Cmd: ['/srv'], Env: ['LD_LIBRARY_PATH=/usr/local/lib'] }, {}).error, undefined, '--library-path overrides it for the bridge');
  assert.equal(ociServer({ Cmd: ['/srv'], Env: ['NOT AN ASSIGNMENT'] }, {}).error, 'image_config_unreadable');
  assert.equal(ociServer({ Cmd: ['/srv'], Env: 'PATH=/bin' }, {}).error, 'image_config_unreadable');
  for (const k of ['NODE_OPTIONS', 'OPENSSL_CONF', 'GCONV_PATH', 'GLIBC_TUNABLES']) assert.equal(BRIDGE_ENV_EMPTY[k], '', k);
  // The server's environment rides as a bridge argument; the reserved names are ours, whatever the image or unit says.
  const serverEnv = runEnv({ ...s.env, HOME: '/root', SURFACE_SANDBOX: '0', API_TOKEN: 'dummy' });
  assert.equal(serverEnv.HOME, '/tmp/home');
  assert.equal(serverEnv.SURFACE_SANDBOX, '1');
  assert.equal(serverEnv.NODE_OPTIONS, '--require /x.js');
  const b = portableBridge({ loader: 'ld-linux-x86-64.so.2', port: 7300, serverCmd: ['/srv'], serverEnv });
  const i = b.cmd.indexOf('--env');
  assert.ok(i > 0 && b.cmd[i + 2] === '--');
  assert.deepEqual(JSON.parse(Buffer.from(b.cmd[i + 1], 'base64').toString('utf8')), serverEnv);
  assert.deepEqual(serverContainer({ oci: { workdir: '/', serverEnv } }, { work: 'w', toolsVol: 't', serverCmd: ['/srv'], loader: 'ld-linux-x86-64.so.2' }).cmd, b.cmd);
  // The container's own environment empties those variables for the bridge (OCI only).
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /env: u\.oci \? \{ \.\.\.runEnv\(\), \.\.\.BRIDGE_ENV_EMPTY \} : runEnv\(\{ \.\.\.\(u\.env \?\? \{\}\) \}\)/);
  assert.match(src, /u\.oci = \{ workdir: server\.workdir, serverEnv: runEnv\(\{ \.\.\.server\.env, \.\.\.\(u\.env \?\? \{\}\) \}\) \};/);
  // The bridge passes the environment to the server, and only to it.
  const bridge = join(root, 'loop', 'sandbox', 'bridge.mjs');
  const env64 = Buffer.from(JSON.stringify({ PATH: process.env.PATH, MARK: 'server-env' })).toString('base64');
  const { spawn } = await import('node:child_process');
  const { connect } = await import('node:net');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const p = spawn(process.execPath, [bridge, String(port), '--env', env64, '--', process.execPath, '-e', 'process.stdout.write(JSON.stringify({ mark: process.env.MARK ?? null, opts: process.env.NODE_OPTIONS ?? null }))'], { env: { ...process.env, NODE_OPTIONS: '' } });
  await new Promise((r) => p.stdout.once('data', r));
  const got = await new Promise((resolve, reject) => { let d = ''; const c = connect(port, '127.0.0.1'); c.on('data', (x) => { d += x; }); c.on('close', () => resolve(d)); c.on('error', reject); c.end(); });
  p.kill();
  assert.deepEqual(JSON.parse(got), { mark: 'server-env', opts: null });
  assert.notEqual(spawnSync(process.execPath, [bridge, '7301', '--env', 'not-base64-json', '--', 'x']).status, 0);
  // A bridge that does not start in an OCI image: tool_error, fault tool, not retryable (it would fail the same way again).
  const k = itemSkips({ resolved: {}, res: { error: 'oci_bridge', install: { ok: true }, fullRan: false }, stages: { install: true } });
  assert.deepEqual(k.skips.map((x) => `${x.stage}:${x.reason}:${x.fault}:${!!x.retryable}`), ['init:tool_error:tool:false', 'plan:tool_error:tool:false', 'catalog:tool_error:tool:false']);
  for (const sk of k.skips) assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault));
  assert.match(src, /throw Object\.assign\(new M\.HarnessError\('the server bridge did not start'\), u\.oci \? \{ ociBridge: true \} : \{\}\);/);
  assert.match(src, /res\.error = e\.ociBridge \? 'oci_bridge' : 'harness';/);
});

test('R-WC-38: an OCI image is pulled only from an allowed host, within the size cap, with room on the data root; its unpacked size is capped too', () => {
  const mck = { OCI_HOSTS: ['ghcr.io', 'docker.io'], OCI_MAX_BYTES: 2 * 1024 ** 3 };
  const img = `ghcr.io/acme/srv:1@sha256:${DIGEST}`;
  assert.equal(ociPullProblem({ image: img, bytes: 100e6, freeBytes: 10e9 }, mck), null);
  assert.equal(ociPullProblem({ image: img, bytes: 100e6, freeBytes: null }, mck), null, 'room unknown: the pull itself is the evidence');
  assert.deepEqual(ociPullProblem({ image: `evil.example/acme/srv:1@sha256:${DIGEST}`, bytes: 1, freeBytes: 10e9 }, mck), { stage: 'install', reason: 'no_runnable_artifact', fault: 'tool', detail: 'the image is not on an OCI host this lane pulls from (oci_host_not_allowed)' });
  assert.equal(ociPullProblem({ image: img, bytes: mck.OCI_MAX_BYTES + 1, freeBytes: 1e12 }, mck).reason, 'too_large');
  assert.equal(ociPullProblem({ image: img, bytes: null, freeBytes: 1e12 }, mck).fault, 'tool');
  const low = ociPullProblem({ image: img, bytes: 1e9, freeBytes: 3.9e9 }, mck);
  assert.deepEqual([low.reason, low.fault, low.retryable], ['upstream_unavailable', 'infra', true]);
  for (const p of [ociPullProblem({ image: `x.io/a:1@sha256:${DIGEST}`, bytes: 1 }, mck), ociPullProblem({ image: img, bytes: 3e9 }, mck), low]) {
    for (const sk of itemSkips({ resolved: { skip: p } }).skips) assert.ok(SKIP_FAULTS[sk.reason].allowed.includes(sk.fault), `${sk.reason}/${sk.fault}`);
  }
  assert.equal(OCI_MAX_UNPACKED(mck), 6 * 1024 ** 3);
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /const problem = ociPullProblem\(\{ image: resolved\.launch\.image, bytes: resolved\.choice\?\.oci_bytes, freeBytes: shard\.freeBytes\(\) \}, ctx\.mck\);/);
  assert.match(src, /if \(!server\.error && !\(inst\.oci\.bytes !== null && inst\.oci\.bytes <= OCI_MAX_UNPACKED\(this\.mck\)\)\) server = \{ error: 'image_too_large' \};/);
  assert.equal(installFault({ kind: 'docker', ok: false, steps: [{ name: 'pull', exit: 0 }, { name: 'config', exit: 1 }], egress: [], entry_error: 'image_too_large' }), 'tool');
});

test('R-WC-39: an image that declares more VOLUME paths than a few is refused; the count is recorded', () => {
  const vols = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`/data${i}`, {}]));
  assert.equal(ociServer({ Cmd: ['/srv'], Volumes: vols(MAX_IMAGE_VOLUMES) }, {}).volumes, MAX_IMAGE_VOLUMES);
  assert.deepEqual(ociServer({ Cmd: ['/srv'], Volumes: vols(MAX_IMAGE_VOLUMES + 1) }, {}), { error: 'image_volumes', volumes: MAX_IMAGE_VOLUMES + 1 });
  assert.equal(ociServer({ Cmd: ['/srv'], Volumes: ['/data'] }, {}).error, 'image_config_unreadable');
  assert.equal(ociServer({ Cmd: ['/srv'], Volumes: null }, {}).volumes, 0);
  assert.equal(installFault({ kind: 'docker', ok: false, steps: [{ name: 'pull', exit: 0 }, { name: 'config', exit: 1 }], egress: [], entry_error: 'image_volumes' }), 'tool');
  const src = readFileSync(join(root, 'loop', 'run-items.mjs'), 'utf8');
  assert.match(src, /if \(Number\.isSafeInteger\(server\.volumes\)\) inst\.oci\.volumes = server\.volumes;/);
});

test('R-WC-35: with a stand-in Docker, the subject\'s image is gone from the image list after its unit, also when the unit ends early', async () => {
  const { Shard } = await import('../loop/run-items.mjs');
  class HarnessError extends Error {}
  const state = { images: new Set(['docker.io/library/node:keep']), calls: [] };
  class Docker {
    constructor() { this.state = state; }
    name(t, w) { return `n-${t}-${w}`; }
    labels() { return {}; }
    async volume(n) { return n; }
    async must(p) { const r = await p; if (r.exit !== 0) throw new HarnessError('x'); return r; }
    async sweep() {}
    async kill() {}
    async killAll() {}
    async d(argv) {
      this.state.calls.push(argv.join(' '));
      const ok = (stdout = '') => ({ exit: 0, stdout: Buffer.from(stdout), timed_out: false });
      if (argv[0] === 'pull') { this.state.images.add(argv[2]); return this.state.failPull ? { exit: 1, stdout: Buffer.alloc(0), timed_out: false } : ok(); }
      if (argv[0] === 'image' && argv[1] === 'inspect') return ok(`${JSON.stringify(this.state.config)}\tlinux/amd64\t1000\n`);
      if (argv[0] === 'image' && argv[1] === 'rm') { this.state.images.delete(argv[3]); return ok(); }
      if (argv[0] === 'image' && argv[1] === 'ls') return ok([...this.state.images].join('\n'));
      return ok();
    }
  }
  const M = {
    HarnessError, Docker, LIMITS: { cpus: 2 }, dir: tmpdir(),
    Telemetry: class { write() {} tryWrite() { return true; } end() {} },
    loadRunscConfig: () => ({ release: 'test' }), checkPinned: (r) => r, helperRunArgs: (o) => ['run', ...(o.cmd ?? [])],
    watchTraces: () => ({ stop() {}, overflow() { return false; } }), sweepTraces() {}, readHostLog: () => ({ ok: false }),
  };
  const out = mkdtempSync(join(tmpdir(), 'wc-shard-'));
  const shard = new Shard({ o: { out, msc: out, lane: 'local' }, M, env: {} });
  shard.images = { node24: 'docker.io/library/node:keep' };
  shard.loader = 'ld-linux-x86-64.so.2';
  shard.mck = { OCI_MAX_BYTES: 2 * 1024 ** 3 };
  const run = async (tag) => {
    const image = `ghcr.io/acme/${tag}:1@sha256:${DIGEST}`;
    const res = await shard.runUnit({ tag, stepDir: join(out, tag), launch: { kind: 'docker', image }, env: {} }, Date.now() + 60_000);
    const listed = (await new Docker().d(['image', 'ls', '--format', '{{.Repository}}@{{.Digest}}'])).stdout.toString();
    return { res, image, listed };
  };
  // An image with no command: the unit ends after the pull, and its image is removed.
  state.config = { Entrypoint: null, Cmd: null };
  let r = await run('a');
  assert.equal(r.res.install.entry_error, 'image_has_no_command');
  assert.ok(!r.listed.includes(r.image), 'removed after a unit that ended early');
  // A pull that failed half way: removed too (recorded before the pull).
  state.failPull = true;
  r = await run('b');
  assert.equal(r.res.install.ok, false);
  assert.ok(!r.listed.includes(r.image), 'removed after a failed pull');
  assert.ok(r.listed.includes('docker.io/library/node:keep'), 'our own images stay');
  assert.ok(state.calls.some((c) => c === `image rm --force ${r.image}`));
});

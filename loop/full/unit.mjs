// Full mode in the sandbox: one item of a full-mode shard (loop/full/hook.mjs), in place of the split run of
// loop/run-items.mjs for that item, with the same containers and the same order for init, plan and catalog, and the
// stand-in and the full write test around them. Everything runs on the run network of mcp-surface-corpus's sandbox
// (no way out at all):
//
//   .5 (standin.json octet)  the stand-in: its image pinned by digest (loop/full/standins.json), started as a sandbox
//                            container of its own (gVisor, uid 65534, read-only root, no capability), with credentials
//                            made for the unit; health-checked and seeded by our helper (node24) at .6
//   .3                       the server under test behind our bridge, with the env of loop/full/env-wire.mjs
//   .4                       the CLI (our helper), through our relay: init, plan and catalog with the generic catalog
//                            manifest, as for every subject; then, on the host, the thin declaration
//                            (loop/full/declare.mjs) from the catalog's tools/list; `plan` on it; on the host, the rule
//                            check (loop/full/rule-check.mjs); and only when that accepts, `run` with the plan hash
//
// A stand-in that does not start, answer or take its seed, a server with no name to route it, or a declaration that
// cannot be made is a skip of ours (u.fullMode.outcome; loop/full/hook.mjs turns it into the bundle's skip and
// logs/driver.json), never the server's. The stand-in's counts are read after the seed and after the run, as evidence
// of whether the run's writes landed there.
//
// Only Node's standard library and the driver's own Shard (passed in).
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { parseCollected } from '../bundle.mjs';
import { BRIDGE_ENV_EMPTY } from '../launch.mjs';
import { findRunFolder } from '../summary.mjs';
import { thinDeclaration, readTools, MAX_CATALOG_BYTES } from './declare.mjs';
import { foreignTarget, makeCredentials, standInAddr, wireEnv } from './env-wire.mjs';
import { ruleCheck } from './rule-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
/** Our helpers' address on the run network while the stand-in is checked, seeded and read. */
export const HELPER_OCTET = 6;
const FULL_MANIFEST = 'writecheck-full.yaml';

/** One of our scripts (health, seed, evidence) in our helper image on the run network, fed on stdin; its one JSON line. */
async function standinScript(shard, u, { network, ip, script, args, env = {}, deadlineMs = 120_000, log }) {
  const r = await shard.dk.d(shard.M.helperRunArgs({ name: shard.name(u.tag, 'h'), image: shard.images.node24, network, ip, resolv: 'run', labels: shard.dk.labels(u.tag), stdin: true, env, cmd: ['node', '--input-type=module', '-', ...args] }), { input: readFileSync(script), deadline: Date.now() + deadlineMs, keepStdout: true, logStdout: false, cap: 64 * 1024, log });
  let j = null;
  try { j = JSON.parse(r.stdout.toString('utf8').trim().split('\n').pop()); } catch { /* below */ }
  return { exit: r.exit, timed_out: r.timed_out, json: j && typeof j === 'object' && !Array.isArray(j) ? j : null };
}

/** The stand-in's own counts (evidence.mjs), as checked integers, or null. */
const counts = (j) => (j && Number.isSafeInteger(j.collections) && Number.isSafeInteger(j.documents) ? { collections: j.collections, documents: j.documents } : null);

/**
 * The split run of a full-mode item. `opts` as the driver's splitRun: { work, image, serverCmd, res, unitDeadline };
 * `C` the driver's constants and helpers: { TOOLS, NODE, LOOP, OUTD, CLI_MAIN, MANIFEST, BRIDGE_PORT, MS, COLLECT,
 * runEnv, serverContainer, catalogManifest, ownSplitRun } (ownSplitRun: the driver's own split run, for an item full mode
 * cannot take: no name routes it, or the stand-in image did not pull).
 */
export async function fullSplitRun(shard, u, { work, image, serverCmd, res, unitDeadline }, C) {
  const M = shard.M;
  const fm = u.fullMode;
  const s = fm.standIn;
  const def = s.def;
  const addr = standInAddr(def, M.NETS);
  const helperIp = M.NETS.run.subnet.replace(/0\/24$/, String(HELPER_OCTET));
  const creds = makeCredentials(def);
  let w = wireEnv({ names: fm.envNames, def, addr, creds });
  fm.env = { wired: w.ok ? w.wired : [], unset: w.unset };
  if (!w.ok) { fm.outcome = { status: 'not_run', code: w.code, detail: w.detail }; return C.ownSplitRun.call(shard, u, { work, image, serverCmd, res, unitDeadline }); }
  if (fm.mutation === 'foreign_target') { w = foreignTarget(w); fm.mutated = w.mutated ?? null; }
  try { await shard.dk.image(s.image, `stand-in ${s.id}`); } catch (e) {
    if (!(e instanceof M.HarnessError)) throw e;
    fm.outcome = { status: 'not_run', code: 'stand_in_mismatch', detail: 'the stand-in image did not pull' };
    return C.ownSplitRun.call(shard, u, { work, image, serverCmd, res, unitDeadline });
  }
  const marker = `wcguard${randomBytes(16).toString('hex')}`;
  const relay = [C.NODE, `${C.LOOP}/relay.mjs`, M.NETS.run.target, String(C.BRIDGE_PORT)];
  const out = await shard.dk.volume(`surface-${shard.runId}-${u.tag}-out`, u.tag);
  await shard.dk.must(shard.helper(u.tag, { user: '0:0', mounts: [{ src: out, dst: C.OUTD }], capAdd: ['CHOWN'], cmd: ['sh', '-c', `chown 65534:65534 ${C.OUTD}`] }), 'output volume');
  const put = (path, text) => shard.dk.must(shard.helper(u.tag, { stdin: true, mounts: [{ src: out, dst: C.OUTD }], cmd: ['sh', '-c', 'cat > "$1"', 'sh', path] }, { input: Buffer.from(text) }), 'write a file into the output volume');
  await put(C.MANIFEST, C.catalogManifest(relay, [], `loop-${u.tag}`));
  const left = (cap) => Math.max(1000, Math.min(cap, unitDeadline - Date.now()));
  const collect = async () => {
    const c = await shard.helper(u.tag, { mounts: [{ src: out, dst: C.OUTD, ro: true }, { src: shard.toolsVol, dst: C.TOOLS, ro: true }], cmd: ['node', `${C.LOOP}/collect.mjs`, C.OUTD, String(C.COLLECT.file), String(C.COLLECT.total), String(C.COLLECT.entries)] }, { keepStdout: true, logStdout: false, cap: 48 * 1024 * 1024 });
    return { c, parsed: parseCollected(c.stdout.toString('utf8')) };
  };
  const secretEnv = Object.fromEntries(w.secretNames.map((n) => [n, w.env[n]]));
  const publicEnv = Object.fromEntries(Object.entries(w.env).filter(([k]) => !w.secretNames.includes(k)));
  fm.outcome = { status: 'not_run', code: 'stand_in_mismatch', detail: 'the stand-in did not start' };
  await shard.withRunNet(u, async (network) => {
    // The stand-in, as a sandbox service of its own.
    const sname = shard.name(u.tag, 's');
    const scid = join(shard.cidDir, `${sname}.cid`);
    const sargv = M.sandboxRunArgs({ name: sname, image: s.image, network, ip: addr.ip, resolv: 'run', cidfile: scid, detach: true, labels: shard.dk.labels(u.tag), cpus: shard.cpus, workdir: '/tmp', env: { HOME: '/tmp', TMPDIR: '/tmp' }, entrypoint: def.entrypoint, cmd: def.args.map((a) => a.replaceAll('{{api_key}}', creds.api_key ?? '')) });
    shard.writeSettings(sargv, { subject: u.tag, role: 'server' });
    const st0 = Date.now();
    const started = await u.tdk.d(sargv, { deadline: Date.now() + 120_000 });
    let standinUp = false;
    try {
      const hl = join(u.stepDir, 'standin-health.log');
      const h = started.exit !== 0 ? { json: null } : await standinScript(shard, u, { network, ip: helperIp, script: join(here, 'standins', 'health.mjs'), args: [addr.base, def.health.path, String(def.health.timeout_ms ?? 60_000)], deadlineMs: (def.health.timeout_ms ?? 60_000) + 30_000, log: hl });
      fm.health = { healthy: h.json?.healthy === true, ms: Number.isSafeInteger(h.json?.ms) ? h.json.ms : null };
      if (!fm.health.healthy) { fm.outcome = { status: 'not_run', code: 'stand_in_mismatch', detail: 'the stand-in did not answer its health check' }; }
      else {
        const sd = await standinScript(shard, u, { network, ip: helperIp, script: join(repo, s.dir, def.seed), args: [addr.base, marker], env: { STANDIN_API_KEY: creds.api_key ?? '' }, log: join(u.stepDir, 'standin-seed.log') });
        if (sd.json?.seeded !== true) fm.outcome = { status: 'not_run', code: 'stand_in_mismatch', detail: 'the stand-in did not take its seed' };
        else {
          standinUp = true;
          const ev = await standinScript(shard, u, { network, ip: helperIp, script: join(repo, s.dir, def.evidence), args: [addr.base], env: { STANDIN_API_KEY: creds.api_key ?? '' } });
          fm.evidence = { after_seed: counts(ev.json), after_run: null };
        }
      }
      // The server under test, behind the bridge, with the stand-in's env when it is up (else as for any subject).
      const wired = standinUp ? w.env : {};
      if (u.oci) u.oci.serverEnv = { ...u.oci.serverEnv, ...wired };
      const name = shard.name(u.tag, 's');
      const cidfile = join(shard.cidDir, `${name}.cid`);
      const argv = M.sandboxRunArgs({ name, image, network, ip: M.NETS.run.target, resolv: 'run', cidfile, detach: true, labels: shard.dk.labels(u.tag), cpus: shard.cpus, ...C.serverContainer(u, { work, toolsVol: shard.toolsVol, serverCmd, loader: shard.loader }), env: u.oci ? { ...C.runEnv(), ...BRIDGE_ENV_EMPTY } : C.runEnv({ ...(u.env ?? {}), ...wired }) });
      shard.writeSettings(argv, { subject: u.tag, role: 'server' });
      const t0 = Date.now();
      await shard.dk.must(u.tdk.d(argv, { deadline: Date.now() + 60_000 }), 'server container');
      try {
        for (let until = Date.now() + 30_000; ;) {
          const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 64 * 1024, deadline: Date.now() + 10_000 });
          if (M.jsonLines(l.stdout).some((x) => x.listening === C.BRIDGE_PORT)) break;
          if (Date.now() >= until) throw Object.assign(new M.HarnessError('the server bridge did not start'), u.oci ? { ociBridge: true } : {});
          await sleep(250);
        }
        const cliStep = async (step, args, { keepStdout = false, env = {}, cap = C.MS.step } = {}) => {
          const cname = shard.name(u.tag, 'c');
          const ccid = join(shard.cidDir, `${cname}.cid`);
          const cargv = M.helperRunArgs({ name: cname, image: shard.images.node24, network, ip: M.NETS.run.probe, resolv: 'run', cidfile: ccid, labels: shard.dk.labels(u.tag), cpus: shard.cpus, mounts: [{ src: out, dst: C.OUTD }, { src: shard.toolsVol, dst: C.TOOLS, ro: true }], env: { HOME: '/tmp', TMPDIR: '/tmp', NO_COLOR: '1', ...env }, cmd: ['sh', '-c', `cd ${C.OUTD} && exec "$@"`, 'sh', C.NODE, C.CLI_MAIN, ...args] });
          shard.writeSettings(cargv, { subject: u.tag, role: 'probe' });
          const c0 = Date.now();
          const r = await shard.dk.d(cargv, { log: join(u.stepDir, `${step}.log`), deadline: Date.now() + left(cap), keepStdout, cap: 1024 * 1024, logCap: 4 * 1024 * 1024, onTimeout: () => shard.dk.kill(cname) });
          await shard.dk.kill(cname);
          await shard.recordContainer({ id: shard.readCid(ccid), t0: c0, exit: r.exit, signal: r.signal, timedOut: r.timed_out, meta: { subject: u.tag, role: 'probe' } });
          res.steps.push({ step, exit: r.exit, timed_out: r.timed_out, ms: Date.now() - c0 });
          return r;
        };
        // The stages every subject gets, unchanged.
        if (u.init !== false) await cliStep('init', ['init', '--out', `${C.OUTD}/init-draft.yaml`, '--', ...relay]);
        res.planStdout = (await cliStep('plan', ['plan', '-m', C.MANIFEST], { keepStdout: true })).stdout.toString('utf8');
        await cliStep('catalog', ['catalog', '-m', C.MANIFEST, '--out', `${C.OUTD}/results`]);
        if (!standinUp) return;
        // The thin declaration, on the host, from the catalog's tools/list (data).
        const mid = await collect();
        const cat = findRunFolder(mid.parsed.files, 'results', { catalog: true });
        const buf = cat.dir ? mid.parsed.files.get(`${cat.dir}/catalog.json`) : null;
        let catDoc = null;
        if (buf && buf.length <= MAX_CATALOG_BYTES) { try { catDoc = JSON.parse(buf.toString('utf8')); } catch { /* below */ } }
        if (!catDoc) { fm.outcome = { status: 'not_run', code: 'catalog_not_read', detail: `the catalog stage left no readable catalog.json (${cat.why ?? 'unparsable'})` }; return; }
        const decl = thinDeclaration({ tools: readTools(catDoc), standIn: s, relay, publicEnv, secretNames: w.secretNames, marker });
        fm.declaration = { ...decl.summary, sha256: decl.ok ? decl.sha256 : null };
        if (!decl.ok) { fm.outcome = { status: 'not_run', code: 'declaration_missing', detail: decl.missing.join('; ') }; return; }
        await put(`${C.OUTD}/${FULL_MANIFEST}`, decl.text);
        const confirm = decl.doc.target.confirm;
        const fp = await cliStep('full-plan', ['plan', '-m', `${C.OUTD}/${FULL_MANIFEST}`], { keepStdout: true, env: secretEnv });
        const planStdout = fp.stdout.toString('utf8');
        writeFileSync(join(u.stepDir, 'full-plan.stdout'), planStdout);
        const rc = ruleCheck({ planStdout, confirm, addr, serverEnv: w.env, doc: decl.doc, relay });
        fm.plan = { plan_hash: rc.plan_hash, hosts: rc.hosts, accepted: rc.accepted, accepted_by: rc.accepted_by, ...(rc.accepted ? {} : { code: rc.code, detail: rc.detail, foreign: rc.foreign }), plan_exit: fp.exit, ran: false };
        if (!rc.accepted) { fm.outcome = { status: 'refused', code: rc.code, detail: rc.detail }; return; }
        if (Date.now() + 60_000 >= unitDeadline) { fm.outcome = { status: 'not_run', code: 'unit_time_spent', detail: 'the unit had under a minute left for the full write test' }; return; }
        res.fullRan = true;
        fm.plan.ran = true;
        const r = await cliStep('full', ['run', '-m', `${C.OUTD}/${FULL_MANIFEST}`, '--confirm-target', confirm, '--plan-hash', rc.plan_hash, '--out', `${C.OUTD}/full`, '--state', `${C.OUTD}/state`], { env: secretEnv, cap: C.MS.full });
        fm.outcome = { status: 'ran', code: null, detail: null, exit: Number.isInteger(r.exit) ? r.exit : null, timed_out: !!r.timed_out };
        const ev = await standinScript(shard, u, { network, ip: helperIp, script: join(repo, s.dir, def.evidence), args: [addr.base], env: { STANDIN_API_KEY: creds.api_key ?? '' } });
        if (fm.evidence) fm.evidence.after_run = counts(ev.json);
      } finally {
        const l = await u.tdk.d(['logs', name], { keepStdout: true, logStdout: false, cap: 4 * 1024 * 1024 });
        writeFileSync(join(u.stepDir, 'server.log'), l.stdout);
        await shard.dk.kill(name);
        await shard.recordContainer({ id: shard.readCid(cidfile), t0, exit: null, meta: { subject: u.tag, role: 'server' } });
      }
    } finally {
      const sl = await u.tdk.d(['logs', sname], { keepStdout: true, logStdout: false, cap: 1024 * 1024 });
      writeFileSync(join(u.stepDir, 'standin.log'), sl.stdout);
      await shard.dk.kill(sname);
      await shard.recordContainer({ id: shard.readCid(scid), t0: st0, exit: null, meta: { subject: u.tag, role: 'server' } });
    }
  });
  const { c, parsed } = await collect();
  res.files = parsed.files;
  res.collected = { exit: c.exit, entries: parsed.entries.length, bad: parsed.bad, done: parsed.done, truncated: c.stdout_truncated, split: true };
  return undefined;
}

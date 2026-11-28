// Where full mode meets the writecheck driver, without changing it. loop/run-items.mjs is used as it is: loop/full/run.mjs
// (the entry corpus.yml runs for a shard with mode inputs) wraps one method of its Shard, splitRun, so that a
// third-party item of a full-mode shard gets loop/full/unit.mjs's split run instead; every other unit (the controls,
// our fixtures, every item of a default shard) gets the driver's own. After the driver has written each item's bundle
// and before the worker-kit seals it, finishBundle() adds what full mode knows: the full stage's skip, the labelled
// field records, logs/driver.json's full_mode block, mode, backend and stand-in in results/writecheck.json, and the
// stand-in's logs in raw/. A shard without mode inputs never reaches this file (corpus.yml runs loop/run-items.mjs).
//
// Only Node's standard library and the driver's own modules.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { RAW_TOTAL_CAP } from '../bundle.mjs';
import { catalogManifest } from '../items.mjs';
import { findRunFolder } from '../summary.mjs';
import { shardMode } from './contract.mjs';
import { fullObservations, labelRecords, labelledCounts } from './results.mjs';
import { fullSplitRun } from './unit.mjs';

export const PROOF_MUTATIONS = Object.freeze(['foreign_target']);
const WRAPPED = Symbol('writecheck full mode');

/**
 * The driver's in-container paths and limits that the full-mode split run uses as the driver's own split run does
 * (loop/run-items.mjs: TOOLS, NODE, LOOP, OUTD, CLI_MAIN, MANIFEST, BRIDGE_PORT, MS.step, MS.full, COLLECT).
 * test/loop-full.test.mjs keeps them equal to the driver's source.
 */
export const DRIVER = Object.freeze({
  TOOLS: '/opt/surface',
  NODE: '/opt/surface/node/node',
  LOOP: '/opt/surface/loop',
  OUTD: '/work/out',
  CLI_MAIN: '/opt/surface/wc/dist/src/cli/main.js',
  MANIFEST: '/work/out/writecheck.yaml',
  BRIDGE_PORT: 7300,
  MS: Object.freeze({ step: 150_000, full: 900_000 }),
  COLLECT: Object.freeze({ file: 4 * 1024 * 1024, total: 24 * 1024 * 1024, entries: 2000 }),
});

/** The shard's mode, and the proof's mutation (read only in this repository's own pull-request proof of full mode). */
export function fromEnv(env, items, o = {}) {
  const full = shardMode(env, items, o);
  if (full.mode === 'full') {
    const m = String(env.FULL_PROOF_MUTATION ?? '');
    full.mutation = full.proofLane && PROOF_MUTATIONS.includes(m) ? m : null;
  }
  return full;
}

/** The item index of a driver unit tag (`i<index>`), or null (a control: ctl-*). */
export const itemIndex = (tag) => { const m = /^i(\d{1,2})$/.exec(String(tag)); return m ? Number(m[1]) : null; };

/**
 * Wraps Shard.prototype.splitRun for a full-mode shard. Returns the map item index -> unit state that finishBundle reads.
 * A unit is taken into full mode only when it is an item (tag i<n>), a third-party subject (no fixture of ours, no
 * fixture manifest), and the shard is in full mode; anything else runs the driver's own split run.
 */
export function install(Shard, full, { runEnv, serverContainer }) {
  const units = new Map();
  if (full.mode !== 'full') return units;
  // Installed once per process: a second install would take the first wrapper for the driver's own split run.
  if (Shard.prototype.splitRun[WRAPPED]) throw new Error('full mode is installed already');
  const own = Shard.prototype.splitRun;
  const C = { ...DRIVER, runEnv, serverContainer, catalogManifest, ownSplitRun: own };
  Shard.prototype.splitRun = async function splitRunFull(u, opts) {
    const i = itemIndex(u?.tag);
    if (i === null || u.fixture || u.manifestFile || u.forgery) return own.call(this, u, opts);
    u.fullMode = { standIn: full.standIn, backend: full.backend, backendKind: full.backendKind, envNames: full.envNames[i] ?? [], mutation: full.mutation, outcome: null, stepDir: u.stepDir };
    units.set(i, u.fullMode);
    try { return await fullSplitRun(this, u, opts, C); } finally { u.fullMode.files = opts.res.files; }
  };
  Shard.prototype.splitRun[WRAPPED] = true;
  return units;
}

const ev = { evidence: 'logs/driver.json' };

/**
 * The item's skips after full mode. A refused mode adds a `mode` skip (ours); the switch off turns the full stage's
 * skip into `lane_disabled` (policy); in full mode the full stage's skip says why the write test did not start (ours,
 * never the server's), in place of the default "never given a manifest that writes", and there is none once it ran.
 */
export function finishSkips(full, f, list) {
  if (full.mode === 'default') {
    if (!full.skip) return list;
    if (full.skip.stage === 'full') return list.map((s) => (s.stage === 'full' && s.reason === 'policy_excluded' ? { stage: 'full', reason: full.skip.reason, fault: full.skip.fault, ...ev } : s));
    return [...list, { stage: 'mode', reason: full.skip.reason, fault: full.skip.fault, ...ev }];
  }
  if (!f) return list;
  if (f.outcome?.status === 'ran') return list.filter((s) => !(s.stage === 'full' && s.reason === 'policy_excluded'));
  return [...list.filter((s) => s.stage !== 'full'), { stage: 'full', reason: 'unsupported_layout', fault: 'tool', ...ev }];
}

/** logs/driver.json's full_mode block: codes, names (env names, checked tool names), hosts and counts only. */
export function fullNotes(full, f) {
  if (full.mode === 'default') return full.skip ? { mode: 'default', refused: { stage: full.skip.stage, code: full.skip.code, detail: full.skip.detail } } : null;
  if (!f) return { mode: 'full', applies: false, why: 'not a third-party item of this shard that started' };
  return {
    mode: 'full', backend: f.backend, backend_kind: f.backendKind,
    stand_in: { id: f.standIn.id, image: f.standIn.image, fidelity: f.standIn.fidelity, version: f.standIn.version },
    env: f.env ?? null, mutation: f.mutation, mutated: f.mutated ?? null,
    health: f.health ?? null, evidence: f.evidence ?? null, declaration: f.declaration ?? null, plan: f.plan ?? null,
    outcome: f.outcome ?? { status: 'not_run', code: 'not_started' },
    code: f.outcome?.status === 'ran' ? null : (f.outcome?.code ?? 'not_started'),
    labelled: f.labelled ? { relabelled: f.labelled.relabelled, dropped: f.labelled.dropped, records: f.labelled.records.length } : null,
  };
}

/** The labelled records of a unit's full run (its CLI results.json among the collected files), or null. */
export function labelUnit(f) {
  if (f?.outcome?.status !== 'ran' || !f.files) return null;
  const dir = findRunFolder(f.files, 'full');
  if (!dir.dir) return null;
  let doc = null;
  try { doc = JSON.parse(f.files.get(`${dir.dir}/results.json`).toString('utf8')); } catch { return null; }
  return labelRecords(doc, { fidelity: f.standIn.fidelity });
}

const RAW_ADD = ['full-plan.log', 'full-plan.stdout', 'standin.log', 'standin-health.log', 'standin-seed.log'];
const RAW_ADD_CAP = 1024 * 1024;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

/**
 * Adds full mode's part to one item's bundle as the driver wrote it (<dir>/bundle, <dir>/meta.json), before the
 * worker-kit seals it. `f` is the unit's state (undefined for an item that did not start, or a fixture of ours).
 */
export function finishBundle(dir, full, f) {
  const bdir = join(dir, 'bundle');
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath) || !existsSync(join(bdir, 'logs', 'driver.json'))) return false;
  const meta = readJson(metaPath);
  meta.skips = finishSkips(full, f, meta.skips ?? []);
  writeJson(metaPath, meta);
  if (f) f.labelled = labelUnit(f);
  const driverPath = join(bdir, 'logs', 'driver.json');
  const driver = readJson(driverPath);
  const notes = fullNotes(full, f);
  if (notes) driver.full_mode = notes;
  // The driver's note for the full stage says why a third-party server got no write manifest; full mode's own says why.
  if (f && f.outcome?.status !== 'ran' && typeof driver.full_detail === 'string') driver.full_detail = `full mode: ${f.outcome?.code ?? 'not_started'} (logs/driver.json full_mode)`;
  if (f?.stepDir) {
    // Within the driver's raw total (loop/bundle.mjs RAW_TOTAL_CAP), counting what it kept already.
    let room = RAW_TOTAL_CAP - (driver.raw_index ?? []).reduce((n, x) => n + (Number.isSafeInteger(x?.kept) ? x.kept : 0), 0);
    for (const name of RAW_ADD) {
      const p = join(f.stepDir, name);
      if (!existsSync(p)) continue;
      const buf = readFileSync(p);
      const kept = buf.subarray(0, Math.max(0, Math.min(RAW_ADD_CAP, room)));
      room -= kept.length;
      const rel = `raw/steps/${name}`;
      mkdirSync(dirname(join(bdir, rel)), { recursive: true });
      writeFileSync(join(bdir, rel), kept, { flag: 'wx' });
      (driver.raw_index ??= []).push({ path: rel, bytes: buf.length, kept: kept.length, sha256: sha256(buf), truncated: kept.length < buf.length });
    }
  }
  writeJson(driverPath, driver);
  const resPath = join(bdir, 'results', 'writecheck.json');
  if (existsSync(resPath)) {
    const r = readJson(resPath);
    if (full.mode === 'full' && f) {
      r.mode = 'full'; r.backend = f.backend; r.stand_in = f.standIn.id;
      // The full stage's counts as labelled (a backend-semantic record a partial stand-in cannot judge is not tested).
      if (f.labelled && r.full) r.full.verdicts = labelledCounts(f.labelled.records);
    } else r.mode = 'default';
    writeJson(resPath, r);
  }
  const obsPath = join(bdir, 'observations', 'writecheck.ndjson');
  if (full.mode === 'full' && f && existsSync(obsPath)) {
    const recs = readFileSync(obsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const out = fullObservations(recs, { labelled: f.labelled, standIn: f.standIn, backendKind: f.backendKind, plan: f.plan });
    writeFileSync(obsPath, out.map((x) => JSON.stringify(x)).join('\n') + (out.length ? '\n' : ''));
  }
  return true;
}

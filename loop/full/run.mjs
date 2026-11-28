#!/usr/bin/env node
/**
 * The writecheck driver for a shard that carries mode inputs (tool-qa PR #119): loop/run-items.mjs's own main(), with
 * full mode around it (loop/full/hook.mjs). corpus.yml runs this file in place of loop/run-items.mjs only when a mode
 * input is set; a default shard never reaches it.
 *
 *   node loop/full/run.mjs <the arguments of loop/run-items.mjs>
 *   env: as loop/run-items.mjs, and WC_MODE, WC_BACKEND, WC_BACKEND_KIND, WC_STAND_IN, WC_SPEC_URL, WC_SPEC_FORMAT,
 *        WC_ENV_NAMES (the mode inputs), LANE_WRITECHECK_FULL_ENABLED (this repository's switch), FULL_PROOF_MUTATION
 *        (read only in loop-full-proof.yml)
 *
 * Order: the mode inputs are checked (a refused mode is a skip of ours and the shard runs as a default one); the
 * driver runs the controls and the items, a full-mode item through loop/full/unit.mjs; then, before the step ends and
 * so before the sandbox is torn down and any bundle is sealed, each item's bundle gets its full-mode part. The exit
 * status is the driver's.
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InputError, parseItems } from '../items.mjs';
import { Shard, main, parseArgs, runEnv, serverContainer } from '../run-items.mjs';
import { finishBundle, fromEnv, install } from './hook.mjs';

const say = (line) => process.stdout.write(`${line}\n`);

export async function run(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv);
  const items = parseItems(env.ITEMS);
  const full = fromEnv(env, items);
  say(full.mode === 'full'
    ? `writecheck mode: full (backend ${full.backend}, stand-in ${full.standIn.id}${full.mutation ? `, proof mutation ${full.mutation}` : ''})`
    : `writecheck mode: default${full.skip ? ` (mode inputs refused: ${full.skip.code})` : ''}`);
  const units = install(Shard, full, { runEnv, serverContainer });
  const rc = await main(argv, env);
  // Every bundle the driver wrote, whatever its exit status: the seal steps take each item that has one.
  for (const it of items) {
    const f = units.get(it.index);
    const done = finishBundle(join(resolve(o.out), String(it.index)), full, f);
    say(`item ${it.index}: full mode ${f ? `${f.outcome?.status ?? 'not_run'}${f.outcome?.code ? ` (${f.outcome.code})` : ''}` : full.mode === 'full' ? 'not applied' : 'off'}${done ? '' : '; no bundle'}`);
  }
  return rc;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().then((rc) => { process.exitCode = rc; }, (e) => {
    say(`::error title=writecheck::${e instanceof InputError ? e.message : 'the full-mode driver failed before the shard started'}`);
    if (!(e instanceof InputError)) process.stderr.write(`${e && e.stack}\n`);
    process.exitCode = 1;
  });
}

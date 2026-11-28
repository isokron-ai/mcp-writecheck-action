#!/usr/bin/env node
/**
 * Mutation probes for the dogfood sandbox (dogfood/sbx.mjs, loop/sandbox/dogfood-*.mjs): each protection below is taken
 * out of a copy of the repository in turn, and test/dogfood-sandbox.test.mjs must then fail. A mutant that does not
 * apply (its text is gone) or that survives fails the run. Run on GitHub Actions by .github/workflows/mutation-probes.yml.
 *
 *   node test/mutants/dogfood-sandbox.mjs
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEST = 'test/dogfood-sandbox.test.mjs';

/** [file, text, replacement, what]: R-DSB-07 to 14, the survivors the review of #80 found, and two more. */
export const MUTANTS = [
  ['dogfood/sbx.mjs', '  checkEnv(M, all, hostEnv);\n', '', 'the environment check of a command in the unit (R-DSB-07)'],
  ['dogfood/sbx.mjs', '    mark(`::stop-commands::${token}\\n`);', '', 'the stop-commands marker before sandboxed output (R-DSB-08)'],
  ['dogfood/sbx.mjs', "  if (head !== env.SANDBOX_REF) throw new SbxError('the sandbox checkout is not SANDBOX_REF');", '', 'the SANDBOX_REF HEAD check (R-DSB-09)'],
  ['dogfood/sbx.mjs', '!hosts.every((h) => /^(?=.{3,100}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h) && !/^[0-9.]+$/.test(h))', '!hosts.every((h) => /^[a-z0-9.:*\\/-]{1,100}$/i.test(h))', 'the --hosts pattern (R-DSB-10)'],
  ['dogfood/sbx.mjs', 'allow: (top) => !seen.has(top)', 'allow: null', 'the folders the host had before the call (R-DSB-11)'],
  ['dogfood/sbx.mjs', ' || fs.realpathSync(p) !== p', '', 'pull\'s realpath check (R-DSB-12)'],
  ['loop/sandbox/dogfood-in.mjs', " || line.includes('\\0') || line.length > 8192", '', 'the env file\'s NUL and length check (R-DSB-12)'],
  ['dogfood/sbx.mjs', '      if (r.exit !== 0) throw new SbxError(`could not pause ${n}: nothing is read while a container of the job runs`);\n', '', 'a failed pause stops the read (R-DSB-13)'],
  ['dogfood/sbx.mjs', "{ src: st.harnessVol, dst: join(st.workspace, 'dogfood'), ro: true }, ", '', 'the read-only harness mount (R-DSB-14)'],
  ['loop/sandbox/dogfood-in.mjs', ' || ENV_FILE_DENY.test(name)', '', 'the env file deny list (R-DSB-05)'],
  ['loop/sandbox/dogfood-unit.mjs', 'if (!RUN_NET.test(host)) return', 'if (false) return', 'the unit forwards only to the run network (R-DSB-05)'],
];

const run = (dir) => spawnSync(process.execPath, ['--test', TEST], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), 'dsb-mut-'));
  cpSync(root, d, { recursive: true, filter: (src) => !/\/(?:\.git|node_modules|msc|mws-cli)(?:\/|$)/.test(src.slice(root.length)) });
  return d;
};

const base = copy();
const b = run(base);
rmSync(base, { recursive: true, force: true });
if (b.status !== 0) { process.stdout.write(`baseline: ${TEST} fails without a mutation\n${b.stdout.slice(-4000)}\n`); process.exit(1); }
let bad = 0;
for (const [file, from, to, what] of MUTANTS) {
  const d = copy();
  try {
    const src = readFileSync(join(d, file), 'utf8');
    if (src.split(from).length !== 2) { bad++; process.stdout.write(`NOT APPLIED  ${what} (${file})\n`); continue; }
    writeFileSync(join(d, file), src.replace(from, to));
    const r = run(d);
    const failed = /ℹ fail (\d+)/.exec(r.stdout)?.[1] ?? '?';
    if (r.status === 0) { bad++; process.stdout.write(`SURVIVED     ${what}\n`); } else process.stdout.write(`killed       ${what} (${failed} test(s) fail)\n`);
  } finally { rmSync(d, { recursive: true, force: true }); }
}
process.stdout.write(`${MUTANTS.length - bad} of ${MUTANTS.length} mutants killed\n`);
process.exit(bad ? 1 : 0);

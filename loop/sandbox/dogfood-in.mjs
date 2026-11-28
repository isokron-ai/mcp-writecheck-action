#!/usr/bin/env node
/**
 * Runs one command of a dogfood worker inside its sandbox (dogfood/sbx.mjs; ours, from the read-only tools volume).
 * It stands in for the runner's step environment there, where the job's scripts expect it:
 *
 *   node dogfood-in.mjs --env-file <file> --temp <dir> --workspace <dir> [--pidfile <file>] [--path <dir>]... -- <argv...>
 *
 * The command gets this process's environment (what `docker exec` or `docker run` set: only names the host driver
 * checked), then the variables of <env-file> (NAME=value lines, the sandbox's own GITHUB_ENV: an earlier sandboxed
 * step wrote them, so they never come from the host), then RUNNER_TEMP, GITHUB_WORKSPACE and GITHUB_ENV set to the
 * mirrored paths inside the sandbox. Those three are names the host driver may not pass (mcp-surface-corpus ENV_DENY
 * refuses every RUNNER_ and GITHUB_ name, so no runner value can reach a target); here they are set to fixed paths of
 * the work volume, never to a value of the runner. A name in the file that is not a plain variable name, or one that
 * changes how a program loads (LD_*, NODE_OPTIONS, BASH_ENV and the like), is skipped and counted on stderr.
 * --path prepends a folder to PATH (pnpm, unpacked in the work volume). --pidfile records the command's pid, so the host
 * can pass a cancel on with `kill`. Exits with the command's status (128 + n for a signal).
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/** Variable names an env file may never set: they change what a later program loads or runs, or who it thinks it is. */
export const ENV_FILE_DENY = /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PATH$|HOME$|RUNNER_|GITHUB_|ACTIONS_|SURFACE_)/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The NAME=value lines of an env file, as [name, value] pairs, and how many lines were skipped. */
export function readEnvFile(text) {
  const vars = [];
  let skipped = 0;
  for (const line of String(text).split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    const name = i > 0 ? line.slice(0, i) : '';
    if (!NAME.test(name) || ENV_FILE_DENY.test(name) || line.includes('\0') || line.length > 8192) { skipped++; continue; }
    vars.push([name, line.slice(i + 1).replace(/\r$/, '')]);
  }
  return { vars, skipped };
}

export function parseArgs(argv) {
  const o = { envFile: null, temp: null, workspace: null, pidfile: null, path: [], cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--') { o.cmd = argv.slice(i + 1); break; }
    const v = argv[++i];
    if (v === undefined || !v.startsWith('/')) throw new Error(`${k} takes an absolute path`);
    if (k === '--env-file') o.envFile = v;
    else if (k === '--temp') o.temp = v;
    else if (k === '--workspace') o.workspace = v;
    else if (k === '--pidfile') o.pidfile = v;
    else if (k === '--path') o.path.push(v);
    else throw new Error(`unknown argument ${k}`);
  }
  if (!o.envFile || !o.temp || !o.workspace || o.cmd.length === 0) throw new Error('usage: dogfood-in.mjs --env-file F --temp D --workspace D [--pidfile F] [--path D]... -- argv...');
  return o;
}

export function commandEnv(o, base = process.env, fileText = '') {
  const { vars, skipped } = readEnvFile(fileText);
  const env = { ...base };
  for (const [k, v] of vars) env[k] = v;
  env.RUNNER_TEMP = o.temp;
  env.GITHUB_WORKSPACE = o.workspace;
  env.GITHUB_ENV = o.envFile;
  if (o.path.length) env.PATH = [...o.path, env.PATH ?? '/usr/local/bin:/usr/bin:/bin'].join(':');
  return { env, skipped };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { process.stderr.write(`dogfood-in: ${e.message}\n`); process.exit(2); }
  let text = '';
  try { text = readFileSync(o.envFile, 'utf8'); } catch { /* no variables yet */ }
  const { env, skipped } = commandEnv(o, process.env, text);
  if (skipped) process.stderr.write(`dogfood-in: ${skipped} line(s) of the sandbox env file skipped\n`);
  const child = spawn(o.cmd[0], o.cmd.slice(1), { env, stdio: 'inherit' });
  if (o.pidfile) { try { writeFileSync(o.pidfile, `${child.pid}\n`); } catch { /* cancel then ends with the container */ } }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } });
  child.on('error', (e) => { process.stderr.write(`dogfood-in: could not start ${o.cmd[0]}: ${e.code ?? e.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? 128 + ({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal] ?? 1)));
}

/**
 * The peak memory of the CLI's process tree: the CLI, the supervisor it starts for each server, the
 * servers and whatever they start. Sampled from outside, by this action, so that a CLI killed for lack
 * of memory still has a figure, and so that no CLI release is needed.
 *
 *   Linux    every second, from /proc: the sum of VmRSS over the tree, and each process's own peak
 *            (VmHWM). Each reading is exact; a spike shorter than the interval can fall between two.
 *   macOS    every two seconds, one `ps -A -o pid=,ppid=,rss=`: the sum of RSS over the tree.
 *            Approximate: `ps` reports current RSS only, and the tree comes from one listing.
 *   Windows  not measured.
 *
 * Nothing here may change the job's outcome or stop the action: every error ends sampling and is
 * reported as text. The pure parts (parse*, treeOf, sumOver) take text, so the unit tests use fake
 * /proc and `ps` output.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export const METHOD = { exact: 'exact', approximate: 'approximate', none: 'not measured' };

/** `VmRSS` or `VmHWM` of a /proc/<pid>/status text, in KiB, or null. */
export function parseStatusKib(text, field) {
  const m = new RegExp(`^${field}:\\s+(\\d+)\\s+kB\\s*$`, 'm').exec(String(text));
  return m ? Number(m[1]) : null;
}

/** The parent pid from a /proc/<pid>/stat text, or null. The command name may hold spaces and ')'. */
export function parseStatPpid(text) {
  const s = String(text);
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  const f = s.slice(close + 2).split(' ');
  const ppid = Number(f[1]);
  return Number.isInteger(ppid) ? ppid : null;
}

/** `ps -A -o pid=,ppid=,rss=` output: Map pid -> { ppid, kib }. Lines that do not parse are skipped. */
export function parsePs(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) out.set(Number(m[1]), { ppid: Number(m[2]), kib: Number(m[3]) });
  }
  return out;
}

/** The pids of root and every descendant, given Map pid -> ppid. */
export function treeOf(root, ppids) {
  const children = new Map();
  for (const [pid, ppid] of ppids) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const seen = new Set();
  const todo = ppids.has(root) ? [root] : [];
  while (todo.length) {
    const p = todo.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    for (const c of children.get(p) ?? []) todo.push(c);
  }
  return [...seen];
}

/** One Linux reading: { tree, maxHwm } in KiB, or null when the root is gone. `fs` is injectable for tests. */
export function readLinuxTree(root, fs = { readdir: (p) => readdirSync(p), read: (p) => readFileSync(p, 'utf8') }) {
  const ppids = new Map();
  for (const d of fs.readdir('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    let stat;
    try {
      stat = fs.read(`/proc/${d}/stat`);
    } catch {
      continue; // why: a process can end between the listing and the read
    }
    const ppid = parseStatPpid(stat);
    if (ppid !== null) ppids.set(Number(d), ppid);
  }
  if (!ppids.has(root)) return null;
  let tree = 0;
  let maxHwm = 0;
  for (const pid of treeOf(root, ppids)) {
    let status;
    try {
      status = fs.read(`/proc/${pid}/status`);
    } catch {
      continue;
    }
    tree += parseStatusKib(status, 'VmRSS') ?? 0;
    maxHwm = Math.max(maxHwm, parseStatusKib(status, 'VmHWM') ?? 0);
  }
  return { tree, maxHwm };
}

/** One macOS reading from `ps` output: { tree } in KiB, or null when the root is not listed. */
export function readPsTree(root, psText) {
  const rows = parsePs(psText);
  if (!rows.has(root)) return null;
  const ppids = new Map([...rows].map(([pid, r]) => [pid, r.ppid]));
  return { tree: treeOf(root, ppids).reduce((s, pid) => s + rows.get(pid).kib, 0) };
}

/**
 * Start sampling the tree under `root`. `stop()` takes a last reading and returns
 *   { method, peakKib, samples, intervalMs, note }
 * with method `exact`, `approximate` or `not measured`; peakKib is null when nothing was read.
 * @param {{ root: number|undefined, platform?: string, intervalMs?: number, earlyMs?: number[], readLinux?: Function, runPs?: Function }} o
 */
export function startSampler(o) {
  const platform = o.platform ?? process.platform;
  const method = platform === 'linux' ? METHOD.exact : platform === 'darwin' ? METHOD.approximate : METHOD.none;
  const intervalMs = o.intervalMs ?? (platform === 'darwin' ? 2000 : 1000);
  const state = { peakKib: null, samples: 0, note: null, stopped: false, ended: false, busy: false };
  if (method === METHOD.none || !Number.isInteger(o.root)) {
    return { stop: async () => ({ method: METHOD.none, peakKib: null, samples: 0, intervalMs, note: method === METHOD.none ? `on ${platform === 'win32' ? 'Windows' : platform}` : 'the CLI has no process id' }) };
  }
  const readLinux = o.readLinux ?? ((root) => readLinuxTree(root));
  const runPs = o.runPs ?? (() => new Promise((res, rej) => execFile('ps', ['-A', '-o', 'pid=,ppid=,rss='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(out)))));
  const keep = (r) => {
    if (!r) return;
    state.samples++;
    const v = Math.max(r.tree ?? 0, r.maxHwm ?? 0);
    state.peakKib = Math.max(state.peakKib ?? 0, v);
  };
  const fail = (e) => {
    state.note = `sampling stopped: ${String(e?.message ?? e).split('\n')[0].replace(/[^\w .,:/=()-]/g, ' ').slice(0, 200)}`;
    state.stopped = true;
  };
  const once = async () => {
    if (state.stopped || state.busy) return;
    state.busy = true;
    try {
      if (method === METHOD.exact) keep(readLinux(o.root));
      else keep(readPsTree(o.root, await runPs()));
    } catch (e) {
      fail(e);
    } finally {
      state.busy = false;
    }
  };
  // why: a short run (a plan, a refusal) ends within a second; readings close together at the start keep its figure from being the
  // size of a process that has only just started. Then one reading per interval.
  const early = o.earlyMs ?? [50, 50, 100, 200, 400];
  let timer = null;
  let k = 0;
  const next = () => {
    if (state.stopped || state.ended) return;
    timer = setTimeout(() => void once().then(next), k < early.length ? early[k++] : intervalMs);
    timer.unref?.();
  };
  void once().then(next);
  return {
    async stop() {
      state.ended = true;
      clearTimeout(timer);
      // why: the last reading before the CLI is reaped can still see the tree; after it, the root is gone and the reading is null.
      if (!state.busy) await once();
      const m = state.samples ? method : METHOD.none;
      const note = state.note ?? (state.samples && state.samples < 3 ? 'the CLI ended after fewer than three readings, so its real peak can be higher' : null);
      return { method: m, peakKib: state.samples ? state.peakKib : null, samples: state.samples, intervalMs, note };
    },
  };
}

/** The `max-rss-mb` input: '' (no ceiling) or a positive whole number of MiB. Returns null or the number; throws a message. */
export function parseCeilingMb(v) {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  if (!/^[1-9]\d{0,6}$/.test(s)) throw new Error(`max-rss-mb: ${JSON.stringify(s)} is not a whole number of MB greater than 0.`);
  return Number(s);
}

const mb = (kib) => kib / 1024;
/** A size in KiB for the summary: "512 MB", "1.4 GB". MB and GB are 1024-based here, as in the input. */
export function sizeText(kib) {
  const m = mb(kib);
  return m >= 1024 ? `${(m / 1024).toFixed(1)} GB` : `${Math.round(m)} MB`;
}

/** The summary's table row text for a measurement (no Markdown from outside: all text is ours). */
export function memoryCell(mem) {
  if (!mem || mem.method === METHOD.none || mem.peakKib === null) return `not measured${mem?.note ? ` (${mem.note})` : ''}`;
  const how = mem.method === METHOD.exact ? `exact: /proc, read every ${mem.intervalMs / 1000} s` : `approximate: \`ps\`, read every ${mem.intervalMs / 1000} s`;
  return `${sizeText(mem.peakKib)}, the CLI and every process under it (${how}${mem.note ? `; ${mem.note}` : ''})`;
}

/** The "Needs attention" line when the peak reached the ceiling, or null. Never a reason to fail the job. */
export function memoryAttention(mem, ceilingMb) {
  if (ceilingMb === null || ceilingMb === undefined || !mem || mem.peakKib === null) return null;
  if (mb(mem.peakKib) < ceilingMb) return null;
  return `The peak memory of the CLI and the processes under it, ${sizeText(mem.peakKib)} (${mem.method}), reached the \`max-rss-mb\` ceiling of ${ceilingMb} MB. The job status does not depend on this. A run near the runner's memory limit can be killed part-way; see "Time and memory" in the action's README.`;
}

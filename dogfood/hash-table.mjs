#!/usr/bin/env node
// Builds hash-table.json and hash-table.md from the plan-hash-row notices that dogfood/check-plan-hash.sh
// writes in the runs given as arguments (run ids). Reads annotations through the API (gh, GH_TOKEN, actions: read).
// Old = the hash pinned in the repository files (the row's `pinned`); new = the hash the plan step computed
// (`seen`). Nothing here accepts a hash. Usage: node dogfood/hash-table.mjs <out dir> <run id>...
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const [out, ...runs] = process.argv.slice(2);
if (!out || runs.length === 0 || !runs.every((r) => /^\d+$/.test(r))) { console.error('usage: hash-table.mjs <out dir> <run id>...'); process.exit(2); }
const repo = process.env.GITHUB_REPOSITORY || 'isokron-ai/mcp-writecheck-action';
const gh = (path) => JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).flat();
const rows = [];
for (const run of runs) {
  const jobs = gh(`repos/${repo}/actions/runs/${run}/jobs?per_page=100`).flatMap((p) => p.jobs ?? [p]);
  for (const job of jobs) {
    if (!job.steps?.some((s) => /compare the plan hash/i.test(s.name) && s.conclusion !== 'skipped' && s.conclusion !== null)) continue;
    for (const a of gh(`repos/${repo}/check-runs/${job.id}/annotations?per_page=100`)) {
      if (a.title !== 'plan-hash-row') continue;
      try { rows.push({ run: Number(run), job_name: job.name, job_id: job.id, ...JSON.parse(a.message) }); } catch { /* not a row */ }
    }
  }
}
const seenKey = new Set();
const uniq = rows.filter((r) => { const k = `${r.run}|${r.job_id}|${r.key}|${r.pinned}|${r.seen}`; if (seenKey.has(k)) return false; seenKey.add(k); return true; });
const table = uniq.map((r) => ({ run: r.run, workflow: r.workflow, job: r.job_name, key: r.key, cell: r.cell, old_pinned: r.pinned, accepted_in_effect: r.accepted, new_computed: r.seen, changed: r.seen !== r.pinned }));
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/hash-table.json`, JSON.stringify({ format: 'writecheck-hash-table/1', note: 'old_pinned is the hash pinned in the repository files; new_computed is what CI computed for the pinned CLI. None is accepted.', rows: table }, null, 2) + '\n');
// Group by (old, new): the cells that share both are changed by the same thing.
const groups = new Map();
for (const t of table) { const k = `${t.old_pinned} -> ${t.new_computed}`; (groups.get(k) ?? groups.set(k, []).get(k)).push(t); }
let md = '## Plan hash table (computed by CI, none accepted)\n\n| Workflow | Job / key | Cell | Old pinned | New computed | Changed |\n|---|---|---|---|---|---|\n';
for (const t of table) md += `| ${t.workflow} | ${t.job}${t.key ? ` (${t.key})` : ''} | ${t.cell || ''} | ${t.old_pinned} | ${t.new_computed || '(none)'} | ${t.changed ? 'yes' : 'no'} |\n`;
md += '\n### Grouped by old -> new hash (rows in one group changed identically)\n\n';
for (const [k, g] of [...groups].sort((a, b) => b[1].length - a[1].length)) md += `- \`${k}\`: ${g.length} row(s): ${g.map((t) => t.cell || `${t.workflow}/${t.key || t.job}`).join(', ')}\n`;
writeFileSync(`${out}/hash-table.md`, md);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, md, { flag: 'a' });
console.log(md);

#!/usr/bin/env node
/**
 * The disposable Grafana of one job, inside its sandbox (dogfood/sbx.mjs). Grafana is the sandbox service `grafana`
 * at 10.213.53.5:3000, which the unit (where this runs, and the CLI) reaches as GRAFANA_URL, http://127.0.0.1:4930.
 * The admin password is the file the service was started with (svc --secret-env): never printed, never on a command line.
 *
 *   node dogfood/grafana/setup.mjs start      wait for Grafana; make an Editor service account and its token, written to
 *                                             the sandbox's own GITHUB_ENV as GRAFANA_SERVICE_ACCOUNT_TOKEN (the CLI reads it)
 *   node dogfood/grafana/setup.mjs fixtures   the folder and dashboards the manifest names, and the bystanders
 *
 * Env: GRAFANA_URL, RUNNER_TEMP, GITHUB_ENV (loop/sandbox/dogfood-in.mjs sets the last two inside the sandbox).
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const G = process.env.GRAFANA_URL;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(G ?? '')) { console.error('GRAFANA_URL must be http://127.0.0.1:<port>'); process.exit(2); }
const pw = readFileSync(join(process.env.RUNNER_TEMP, 'grafana-secrets', 'admin-pw'), 'utf8').trim();
const auth = `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}`;

async function api(method, path, body) {
  const r = await fetch(G + path, { method, headers: { authorization: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: HTTP ${r.status}`);
  return r.json();
}

const mode = process.argv[2];
if (mode === 'start') {
  let ok = false;
  for (let i = 0; i < 90 && !ok; i++) {
    try { ok = (await fetch(`${G}/api/health`)).status === 200; } catch { /* not up yet */ }
    if (!ok) await sleep(2000);
  }
  if (!ok) { console.error('Grafana did not become healthy'); process.exit(1); }
  const sa = await api('POST', '/api/serviceaccounts', { name: 'mwsv-editor', role: 'Editor' });
  if (!Number.isInteger(sa.id)) throw new Error('unexpected service account id');
  const tok = await api('POST', `/api/serviceaccounts/${sa.id}/tokens`, { name: 'mwsv-editor-token' });
  // A value from Grafana: refuse anything but a service-account token before it reaches the env file.
  if (!/^glsa_[A-Za-z0-9_]+$/.test(String(tok.key))) throw new Error('unexpected token format');
  appendFileSync(process.env.GITHUB_ENV, `GRAFANA_SERVICE_ACCOUNT_TOKEN=${tok.key}\n`);
  console.log('Grafana up; Editor service account made');
} else if (mode === 'fixtures') {
  await api('POST', '/api/folders', { uid: 'mwsv-fixture', title: 'mwsv-fixture' });
  await api('POST', '/api/dashboards/db', { dashboard: { uid: 'mwsv-canary', title: 'mwsv canary (never written by the run)', description: 'canary', tags: ['mwsv'], panels: [{ id: 1, type: 'text', title: 'C1', gridPos: { x: 0, y: 0, w: 8, h: 4 } }] }, folderUid: 'mwsv-fixture', overwrite: true });
  await api('POST', '/api/dashboards/db', { dashboard: { uid: 'mwsv-annhost', title: 'mwsv annotation host', tags: ['mwsv'], panels: [{ id: 1, type: 'text', title: 'A1', gridPos: { x: 0, y: 0, w: 8, h: 4 } }] }, folderUid: 'mwsv-fixture', overwrite: true });
  // bystanders: objects the tester did not create, which must be unchanged after the run
  await api('POST', '/api/folders', { uid: 'mwsv-bystander', title: 'mwsv-bystander' });
  await api('POST', '/api/dashboards/db', { dashboard: { uid: 'mwsv-bystander-dash', title: 'mwsv bystander dashboard', description: 'bystander', tags: ['mwsv'], panels: [{ id: 1, type: 'text', title: 'B1', gridPos: { x: 0, y: 0, w: 8, h: 4 } }] }, folderUid: 'mwsv-bystander', overwrite: true });
  for (const n of [1, 2]) await api('POST', '/api/annotations', { dashboardUID: 'mwsv-annhost', time: Number(`179470000${n}000`), text: `mwsv bystander annotation ${n}`, tags: ['mwsv', 'bystander'] });
  console.log('fixtures and bystanders made');
} else { console.error('usage: setup.mjs start|fixtures'); process.exit(2); }

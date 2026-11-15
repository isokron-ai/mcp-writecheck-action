#!/usr/bin/env node
// Seeds the sandbox app for one CI job: editor-a and editor-b (random passwords), editor-a's MCP API
// key, the fixed rows (task 1 mwsv-guard-task, task 2 mwsv-archived-task) and six bystanders the
// tester does not create. Writes MWSV_MCP_KEY and MWSV_JWT_A to $GITHUB_ENV, each masked first.
// Nothing secret is printed. Needs a fresh database (the guard and archived tasks must get ids 1, 2).
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const BASE = process.env.PAYLOAD_URL ?? 'http://127.0.0.1:4960';
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(BASE)) throw new Error('PAYLOAD_URL must be a loopback URL');
const pass = `Pw-${randomBytes(18).toString('base64url')}`;
const j = async (method, path, body, token) => {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `JWT ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let b = null; try { b = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: b };
};
const A = { email: 'editor-a@mwsv.test', password: pass, name: 'editor-a' };
const B = { email: 'editor-b@mwsv.test', password: pass, name: 'editor-b' };
const init = await j('GET', '/api/users/init');
if (init.body?.initialized !== false) throw new Error(`expected a fresh database (users/init: ${init.status})`);
const reg = await j('POST', '/api/users/first-register', { ...A, confirm_password: pass });
if (reg.status >= 300) throw new Error(`first-register ${reg.status}`);
const login = async (u) => { const r = await j('POST', '/api/users/login', { email: u.email, password: u.password }); if (!r.body?.token) throw new Error(`login ${u.email}: ${r.status}`); return { token: r.body.token, id: r.body.user.id }; };
const a = await login(A);
const cb = await j('POST', '/api/users', B, a.token);
if (cb.status >= 300) throw new Error(`create editor-b ${cb.status}`);
const key = randomUUID();
const all = { find: true, create: true, update: true, delete: true };
const kr = await j('POST', '/api/payload-mcp-api-keys', { label: 'dogfood editor-a', enableAPIKey: true, apiKey: key, posts: all, listings: all, tasks: all }, a.token);
if (kr.status >= 300) throw new Error(`mcp key ${kr.status}`);
const mk = async (c, body) => { const r = await j('POST', `/api/${c}`, body, a.token); if (r.status >= 300) throw new Error(`seed ${c} ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`); return r.body.doc.id; };
const guard = await mk('tasks', { title: 'mwsv-guard-task', status: 'todo', owner: 'mwsv', priority: 1 });
const archived = await mk('tasks', { title: 'mwsv-archived-task', status: 'todo', owner: 'mwsv', priority: 1, archived: true });
if (guard !== 1 || archived !== 2) throw new Error(`the fixed tasks got ids ${guard} and ${archived}, not 1 and 2`);
await mk('tasks', { title: 'mwsv-bystander-task-1', status: 'todo', owner: 'carol', priority: 2 });
await mk('tasks', { title: 'mwsv-bystander-task-2', status: 'doing', owner: 'dave', priority: 4 });
await mk('listings', { name: 'mwsv-bystander-listing-1', sku: 'MWSV-BY-1', price: 10 });
await mk('listings', { name: 'mwsv-bystander-listing-2', sku: 'MWSV-BY-2', price: 20 });
await mk('posts', { title: 'mwsv-bystander-post-1', slug: 'mwsv-bystander-post-1' });
await mk('posts', { title: 'mwsv-bystander-post-2', slug: 'mwsv-bystander-post-2' });
const out = process.env.GITHUB_ENV;
if (out) {
  for (const v of [key, a.token]) console.log(`::add-mask::${v}`);
  appendFileSync(out, `MWSV_MCP_KEY=${key}\nMWSV_JWT_A=${a.token}\n`);
}
console.log(`seeded: users editor-a, editor-b; MCP key for editor-a; tasks 1 (guard), 2 (archived); 6 bystanders`);

#!/usr/bin/env node
// Raw MCP stdio client for hand checks. No SDK: newline-delimited JSON-RPC straight to the server.
//   node mcp.mjs list                                  -> tools/list (JSON)
//   node mcp.mjs call <tool> '<json args>' [call ...]  -> each result
// The server is started with launch-kms.sh (same directory as this file, or MWSV_LAUNCH) and the caller's environment.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const rest = process.argv.slice(2);
const launch = process.env.MWSV_LAUNCH ?? join(dirname(fileURLToPath(import.meta.url)), 'launch-kms.sh');
const child = spawn('bash', [launch], { env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout });
const waiting = new Map(); let nextId = 1;
rl.on('line', (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
child.on('exit', (code) => { for (const w of waiting.values()) w({ error: { code: -1, message: `server exited (${code})` } }); });
const rpc = (method, params) => new Promise((res, rej) => { const id = nextId++; const t = setTimeout(() => rej(new Error(`timeout ${method}`)), Number(process.env.MWSV_TIMEOUT_MS ?? 60000)); waiting.set(id, (m) => { clearTimeout(t); res(m); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const note = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mwsv-hand', version: '0' } });
  if (init.error) throw new Error(`initialize: ${init.error.message}`);
  note('notifications/initialized', {});
  if (rest[0] === 'list') { const r = await rpc('tools/list', {}); console.log(JSON.stringify({ server: init.result?.serverInfo, protocol: init.result?.protocolVersion, tools: r.result?.tools }, null, 1)); }
  else for (let i = 0; i < rest.length; i += 3) {
    if (rest[i] !== 'call') throw new Error('expected call');
    const r = await rpc('tools/call', { name: rest[i + 1], arguments: JSON.parse(rest[i + 2] ?? '{}') });
    console.log(`### ${rest[i + 1]} ${rest[i + 2]}`); console.log(JSON.stringify(r.error ? { jsonrpc_error: r.error } : { isError: r.result?.isError ?? false, text: (r.result?.content ?? []).map((c) => c.text).join('\n'), ...(process.env.MWSV_SHOW_STRUCTURED ? { structured: r.result?.structuredContent } : {}) }, null, 1));
  }
} catch (e) { console.error(String(e)); process.exitCode = 1; } finally { child.stdin.end(); setTimeout(() => child.kill(), 300); }

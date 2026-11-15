#!/usr/bin/env node
// A pass-through adapter between mcp-writecheck and the plugin's /api/mcp, for the research-shim job.
//
// What it does, and only that:
//   1. mcp-writecheck reads an object from `structuredContent`, or from a text block that is JSON or
//      YAML as a whole. The plugin answers with prose followed by JSON ("Resource from collection
//      "x":\n{...}", or fenced ```json blocks). The shim copies that same JSON into
//      `structuredContent`. `content`, `isError` and every other member go through unchanged.
//   2. It adds ONE synthetic read-only tool, `mwsv_guard`, to tools/list, for the run's target
//      guard; it answers by calling the real `findTasks` for the seeded guard task. The plugin's
//      own tool entries are passed through unchanged.
//
// Request bodies and headers are forwarded as received.
//
//   node shim.mjs --listen 4961 --upstream http://127.0.0.1:4960 [--no-guard] [--no-structured]
import http from 'node:http';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i < 0 ? d : process.argv[i + 1]; };
const flag = (n) => process.argv.includes(n);
const LISTEN = Number(arg('--listen', '4961'));
const UP = new URL(arg('--upstream', 'http://127.0.0.1:4960'));
const GUARD = !flag('--no-guard');
const STRUCT = !flag('--no-structured');
const GUARD_TOOL = { name: 'mwsv_guard', description: 'Synthetic tester-side tool added by the dogfood shim (not part of the plugin): returns the title of the seeded guard task.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } };
const GUARD_TITLE = 'mwsv-guard-task';

// JSON.stringify output has no raw newline, so each fenced block is one line; its label is the line before the fence.
const fences = (text) => { const out = []; const re = /```json\n(.*)\n```/g; let m; while ((m = re.exec(text))) { const before = text.slice(0, m.index).replace(/\n$/, ''); const label = before.slice(before.lastIndexOf('\n') + 1).trim(); try { out.push({ label, value: JSON.parse(m[1]) }); } catch { return null; } } return out; };

/** The JSON the text already carries, as an object; null when the text carries none (plain errors). */
export function structured(text) {
  let m = /^Resource from collection "[^"]*":\n([\s\S]+)$/.exec(text);
  if (m) { try { return { doc: JSON.parse(m[1]) }; } catch { return null; } }
  m = /^Collection: "[^"]*"\nTotal: (\d+) documents\nPage: (\S+) of (\S+)\n/.exec(text);
  if (m) { const f = fences(text); if (f === null) return null; const n = (s) => (/^\d+$/.test(s) ? Number(s) : null); return { docs: f.map((x) => x.value), totalDocs: Number(m[1]), page: n(m[2]), totalPages: n(m[3]) }; }
  if (/^(Resource created successfully|Document updated successfully|Document deleted successfully|Multiple documents updated) /.test(text)) {
    const f = fences(text); if (f === null) return null;
    const out = {};
    for (const x of f) {
      if (/^(Created resource|Updated document|Deleted document):$/.test(x.label)) out.doc = x.value;
      else if (/^(Updated documents|Deleted documents):$/.test(x.label)) out.docs = x.value;
      else if (/^Errors:$/.test(x.label)) out.errors = x.value;
    }
    const c = /\n(?:Updated|Deleted): (\d+) documents\nErrors: (\d+)\n/.exec(text);
    if (c) { out.docs ??= []; out.errors ??= []; out.count = Number(c[1]); out.error_count = Number(c[2]); }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

function upstream(method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const h = { ...headers, host: UP.host }; delete h['content-length']; delete h['connection']; delete h['transfer-encoding'];
    if (body && body.length) h['content-length'] = String(body.length);
    const req = http.request({ host: UP.hostname, port: UP.port, method, path, headers: h, agent: false }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); res.on('error', reject); });
    req.on('error', reject); req.end(body);
  });
}

function patchMessage(msg, reqMsg) {
  if (!msg || typeof msg !== 'object' || !msg.result || !reqMsg) return msg;
  if (reqMsg.method === 'tools/list' && GUARD && Array.isArray(msg.result.tools)) msg.result.tools = [...msg.result.tools, GUARD_TOOL];
  if (reqMsg.method === 'tools/call' && STRUCT && msg.result.structuredContent === undefined && Array.isArray(msg.result.content)) {
    const t = msg.result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    const s = t ? structured(t.text) : null;
    if (s !== null) msg.result.structuredContent = s;
  }
  return msg;
}

async function guardAnswer(reqMsg, headers) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'findTasks', arguments: { where: JSON.stringify({ title: { equals: GUARD_TITLE } }), limit: 1 } } }));
  const h = { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const r = await upstream('POST', '/api/mcp', h, body);
  const text = r.body.toString('utf8');
  const payloads = /text\/event-stream/.test(String(r.headers['content-type'])) ? text.split(/\r?\n\r?\n/).map((ev) => ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')).filter(Boolean) : [text];
  let tenant = null;
  for (const p of payloads) { try { const m = JSON.parse(p); const t = m?.result?.content?.[0]?.text; const s = typeof t === 'string' ? structured(t) : null; if (s?.docs?.length === 1 && s.docs[0].title === GUARD_TITLE) tenant = s.docs[0].title; } catch { /* not JSON */ } }
  const result = tenant ? { content: [{ type: 'text', text: JSON.stringify({ tenant }) }], structuredContent: { tenant } } : { content: [{ type: 'text', text: 'mwsv_guard: the guard task was not found behind this endpoint' }], isError: true };
  return { jsonrpc: '2.0', id: reqMsg.id, result };
}

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  let reqMsg = null;
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/mcp') { try { const j = JSON.parse(body.toString('utf8')); if (j && !Array.isArray(j)) reqMsg = j; } catch { /* forwarded as is */ } }
  try {
    if (GUARD && reqMsg?.method === 'tools/call' && reqMsg.params?.name === GUARD_TOOL.name) {
      const out = Buffer.from(JSON.stringify(await guardAnswer(reqMsg, req.headers)));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(out.length) }); res.end(out); return;
    }
    const r = await upstream(req.method, req.url, req.headers, body);
    let out = r.body;
    const ct = String(r.headers['content-type'] ?? '');
    if (reqMsg && (reqMsg.method === 'tools/list' || reqMsg.method === 'tools/call') && r.status === 200) {
      const text = r.body.toString('utf8');
      if (ct.includes('text/event-stream')) {
        out = Buffer.from(text.split(/(\r?\n\r?\n)/).map((ev) => { if (!/^data:/m.test(ev)) return ev; const lines = ev.split(/\r?\n/); const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n'); try { const patched = JSON.stringify(patchMessage(JSON.parse(data), reqMsg)); return [...lines.filter((l) => !l.startsWith('data:')), `data: ${patched}`].join('\n'); } catch { return ev; } }).join(''));
      } else if (ct.includes('application/json')) { try { out = Buffer.from(JSON.stringify(patchMessage(JSON.parse(text), reqMsg))); } catch { /* as is */ } }
    }
    const h = { ...r.headers }; delete h['transfer-encoding']; delete h['content-length']; delete h['connection'];
    res.writeHead(r.status ?? 502, { ...h, 'content-length': String(out.length) }); res.end(out);
  } catch (e) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`dogfood shim: upstream error: ${e.message}`); }
}).listen(LISTEN, '127.0.0.1', () => console.log(JSON.stringify({ shim: `http://127.0.0.1:${LISTEN}/api/mcp`, upstream: UP.href, guard: GUARD, structured: STRUCT })));

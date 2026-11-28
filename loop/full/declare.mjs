#!/usr/bin/env node
// Full mode's thin declaration (owner decision 27 Nov, OWNER-NOTES.md section 7, item 2): a minimal mcp-writecheck
// manifest made by plain code from the server's tools/list and the stand-in's own seed, never by a person and never by
// a model. It holds only what those two sources state:
//
//   server     our relay (the server runs behind the bridge, as for every subject), the env we set (loop/full/env-wire.mjs):
//              pointers to the stand-in as `env`, its generated credentials as `env_passthrough` (redacted, and looked for
//              in every result by MWS-SEC-1)
//   target     environment test, confirm `standin-<id>`, the stand-in's image as provenance, and the guard: a tool that
//              declares readOnlyHint: true and whose required arguments are exactly (else at least) the names of the
//              stand-in's seeded guard object; its pattern is the marker the seed wrote for the unit, so the run starts
//              only when the server answered from this stand-in
//   resources  one read-only resource on the seeded fixture object, through a readOnlyHint: true tool whose required
//              arguments are the fixture's address and its id key
//
// What it never holds: a create, update or delete mapping, fields, values, paths into a result, or anything else that
// would need a guess about what a tool does. A requirement that needs such detail is `not tested`, code
// `declaration_missing` (loop/full/results.mjs): the CLI says so itself (its coverage records), and no record of the run
// is ever held or violated on a guessed field. When no guard or no fixture read can be built, there is no declaration:
// the full write test does not start (`declaration_missing`, a skip of ours).
//
// The output is JSON, which is YAML, so no value of the target is ever quoted by hand. tools/list is the target's own
// data: names and schemas are taken only where they pass the same checks as the bundle's (letters, digits, . _ -).
//
//   node loop/full/declare.mjs --catalogs <dir> --stand-in <id> --out <dir>
//     (the declarations workflow: every catalog.json under <dir>, one declaration each, with placeholder credentials)
//
// Only Node's standard library.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DECLARATION_FORMAT = 'isokron-writecheck-thin/1';
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_TOOLS = 1000;
const MAX_PROPS = 200;
export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/**
 * The tools of a catalog.json ({ tools, ... }), as checked data: name, readOnlyHint (only a boolean true counts), and per
 * top-level property its JSON type when it is one plain string, and the required names. Anything else is dropped.
 */
export function readTools(doc) {
  const out = [];
  for (const t of Array.isArray(doc?.tools) ? doc.tools.slice(0, MAX_TOOLS) : []) {
    if (typeof t?.name !== 'string' || !TOOL_NAME.test(t.name)) continue;
    const s = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? t.inputSchema : {};
    const props = Object.create(null);
    const raw = s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties) ? s.properties : {};
    for (const [k, v] of Object.entries(raw).slice(0, MAX_PROPS)) if (PROP_NAME.test(k)) props[k] = typeof v?.type === 'string' && /^[a-z]{1,16}$/.test(v.type) ? v.type : null;
    const required = Array.isArray(s.required) ? s.required.filter((r) => typeof r === 'string' && Object.hasOwn(props, r)) : [];
    out.push({ name: t.name, readOnly: t?.annotations?.readOnlyHint === true, props, required: [...new Set(required)] });
  }
  return out;
}

/**
 * The read-only tool that reads an object of the stand-in by its address: readOnlyHint true, every required argument
 * a string named in `address` (plus `idKey`, when given, which must be required), every address name an argument.
 * An exact match of the required names wins over a looser one; ties go to the first name in sort order.
 */
export function pickReader(tools, address, idKey = null) {
  const names = [...Object.keys(address), ...(idKey ? [idKey] : [])];
  const fits = tools.filter((t) => t.readOnly
    && (idKey === null || t.required.includes(idKey))
    && t.required.length > 0
    && t.required.every((r) => names.includes(r) && t.props[r] === 'string')
    && names.every((n) => Object.hasOwn(t.props, n) && (t.props[n] === 'string' || t.props[n] === null)));
  const exact = fits.filter((t) => t.required.length === names.length);
  const pool = (exact.length ? exact : fits).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pool[0] ?? null;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * The thin declaration for one server. Returns { ok: true, text, doc, sha256, summary } or
 * { ok: false, code: 'declaration_missing', missing, summary }.
 *   tools        readTools() of the server's catalog.json
 *   standIn      the stand-in (loop/full/contract.mjs loadStandins entry, with .def)
 *   relay        our relay command (the CLI's stdio server)
 *   publicEnv    the env we set that is not a credential (names -> values)
 *   secretNames  the names of the credentials we set
 *   marker       the unit's guard marker (wcguard + 32 hex)
 */
export function thinDeclaration({ tools, standIn, relay, publicEnv = {}, secretNames = [], marker }) {
  const def = standIn.def;
  const missing = [];
  const guardTool = pickReader(tools, def.guard.address);
  if (!guardTool) missing.push('guard: no tool declares readOnlyHint: true and takes exactly the seeded guard object\'s address');
  const reader = pickReader(tools, def.fixture.address, def.fixture.id_key);
  if (!reader) missing.push('resource: no tool declares readOnlyHint: true and reads one object by the fixture\'s address and id');
  missing.push('write resources: tools/list states no create, update or delete mapping that needs no guess (fields, values, result paths)');
  const summary = { format: DECLARATION_FORMAT, stand_in: standIn.id, guard_tool: guardTool?.name ?? null, read_tool: reader?.name ?? null, tools_read: tools.length, resources: reader ? ['standin-fixture'] : [], write_resources: 0, missing };
  if (!guardTool || !reader) return { ok: false, code: 'declaration_missing', missing, summary };
  if (!/^wcguard[0-9a-f]{32}$/.test(String(marker))) throw new Error('the guard marker is malformed');
  const pick = (t, a) => Object.fromEntries(Object.entries(a).filter(([k]) => Object.hasOwn(t.props, k)));
  const doc = {
    mws: '0.9',
    server: {
      stdio: [...relay],
      ...(Object.keys(publicEnv).length ? { env: Object.fromEntries(Object.entries(publicEnv).sort(([a], [b]) => (a < b ? -1 : 1))) } : {}),
      env_passthrough: [...secretNames].sort(),
      processes: 'separate',
    },
    target: {
      environment: 'test',
      confirm: `standin-${standIn.id}`,
      guard: { tool: guardTool.name, args: pick(guardTool, def.guard.address), pattern: marker },
      provenance: { backend: [{ name: standIn.id, image: standIn.image, version: standIn.version }] },
    },
    resources: [{
      name: 'standin-fixture',
      fixture: { id: def.fixture.id, name: def.fixture.name },
      read: { tool: reader.name, args: { ...pick(reader, def.fixture.address), [def.fixture.id_key]: '{{id}}' } },
      cleanup: 'leave',
    }],
  };
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  return { ok: true, text, doc, sha256: sha256(text), summary };
}

/** catalog.json files under a folder (the declarations workflow's input), at most 500, each at most MAX_CATALOG_BYTES. */
export function findCatalogs(dir) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 8 || out.length >= 500) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name === 'catalog.json' && statSync(p).size <= MAX_CATALOG_BYTES) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/**
 * The declarations workflow (declarations.yml): one thin declaration per catalog.json, with the stand-in's address as
 * full mode would wire it and placeholders for the credentials (the run makes its own). Writes <out>/<n>.json and
 * <out>/index.json; returns the index.
 */
export async function declareAll({ catalogs, standInId, out, NETS = { run: { subnet: '10.213.53.0/24', target: '10.213.53.3' } } }) {
  const { loadStandins } = await import('./contract.mjs');
  const { standInAddr, wireEnv } = await import('./env-wire.mjs');
  const standIn = loadStandins()[standInId];
  if (!standIn) throw new Error(`stand-in ${standInId} is not in loop/full/standins.json`);
  const addr = standInAddr(standIn.def, NETS);
  const relay = ['/opt/surface/node/node', '/opt/surface/loop/relay.mjs', NETS.run.target, '7300'];
  mkdirSync(out, { recursive: true });
  const index = { format: 'isokron-writecheck-declarations/1', stand_in: standInId, image: standIn.image, declarations: [] };
  for (const [i, file] of findCatalogs(catalogs).entries()) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { /* recorded below */ }
    const tools = readTools(doc);
    // The stand-in's own names (its first prefix with URL and, when it has one, API_KEY): a batch has no shard's env_names.
    const p0 = standIn.def.env_prefixes[0];
    const w = wireEnv({ names: [`${p0}URL`, ...(standIn.def.credentials.api_key ? [`${p0}API_KEY`] : [])], def: standIn.def, addr, creds: { api_key: 'PLACEHOLDER', username: 'PLACEHOLDER', password: 'PLACEHOLDER' } });
    const publicEnv = w.ok ? Object.fromEntries(Object.entries(w.env).filter(([k]) => !w.secretNames.includes(k))) : {};
    const d = thinDeclaration({ tools, standIn, relay, publicEnv, secretNames: w.ok ? w.secretNames : [], marker: `wcguard${'0'.repeat(32)}` });
    const entry = { source: relative(catalogs, file), catalog_parsed: doc !== null, ...d.summary, ok: d.ok, ...(d.ok ? { file: `${i}.json`, sha256: d.sha256 } : { code: d.code }) };
    if (d.ok) writeFileSync(join(out, `${i}.json`), d.text, { flag: 'wx' });
    index.declarations.push(entry);
  }
  writeFileSync(join(out, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, { flag: 'wx' });
  return index;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const catalogs = opt('--catalogs'); const standInId = opt('--stand-in'); const out = opt('--out');
  if (!catalogs || !standInId || !out || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(standInId)) { process.stderr.write('usage: declare.mjs --catalogs <dir> --stand-in <id> --out <dir>\n'); process.exit(2); }
  declareAll({ catalogs: resolve(catalogs), standInId, out: resolve(out) }).then((ix) => {
    const ok = ix.declarations.filter((d) => d.ok).length;
    process.stdout.write(`declarations: ${ix.declarations.length} catalog(s), ${ok} declaration(s), ${ix.declarations.length - ok} declaration_missing\n`);
  }, (e) => { process.stderr.write(`declare.mjs: ${String(e?.message).slice(0, 300)}\n`); process.exit(1); });
}

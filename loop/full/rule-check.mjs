// The stand-in run tier's rule check (owner decision 27 Nov, company-audit research/ci-loop-2026-11-21/OWNER-NOTES.md
// section 7): a third-party server's write plan is accepted without a person only when every write target in it is
// the stand-in we started for the unit. Anything else is refused and the full write test does not start: `not tested`,
// code `target_not_standin` (a skip of ours, fault tool). There is no per-server approval and no other way in. Our own
// fixtures keep their person-accepted plan hashes (loop/fixtures.json); this check never applies to them.
//
// What is checked, all of it on the runner, as data, after the CLI's `plan` ran in the sandbox:
//   1. The plan's own header, which the CLI prints before any text a target can influence: line 1 is
//      "Plan <hash> for target <our confirm> (environment: test)" and line 2 is
//      "Hosts reached or given to the server: <hosts>" (mcp-write-safety core/plan.ts renderPlan). The plan hash on the
//      last "plan hash:" line must be the header's. Every host on line 2 must be the stand-in's address, with no port or
//      one of the stand-in's ports. "none" is refused too: a plan that reaches nothing reaches no stand-in.
//   2. The server environment we set: every value that is a URL or a host must be the stand-in's address.
//   3. The declaration is the thin one: a stdio server (our relay), no server.url or launch, no control arm, no
//      allow_hosts, no backend gate (each could add a host the plan reaches).
// Only Node's standard library.

const HEADER = /^Plan ([0-9a-f]{16}) for target (.{1,200}) \(environment: test\)$/;
const HOSTS = /^Hosts reached or given to the server: (.{1,4000})$/;
const HOST_TOKEN = /^(?:\[[0-9a-f:.]{2,45}\]|[a-z0-9](?:[a-z0-9.-]{0,252}))(?::(\d{1,5}))?$/;

/** The plan's target hosts from its header, or { error }. */
export function planHosts(stdout, { confirm }) {
  const text = String(stdout ?? '');
  const lines = text.split('\n');
  const h = HEADER.exec(lines[0] ?? '');
  if (!h) return { error: 'the plan does not start with its header' };
  if (h[2] !== confirm) return { error: 'the plan is for another target' };
  const hashes = new Set([...text.matchAll(/^plan hash: ([0-9a-f]{16})$/gm)].map((m) => m[1]));
  if (hashes.size !== 1 || !hashes.has(h[1])) return { error: 'the plan hash is not the header\'s' };
  const m = HOSTS.exec(lines[1] ?? '');
  if (!m) return { error: 'the plan has no hosts line under its header' };
  if (/^none \(/.test(m[1])) return { hash: h[1], hosts: [] };
  const hosts = m[1].split(', ');
  if (!hosts.every((x) => HOST_TOKEN.test(x))) return { error: 'a host on the plan\'s hosts line is not a host' };
  return { hash: h[1], hosts };
}

/** Is `host` (host or host:port, as the CLI prints it) the stand-in? */
export function isStandIn(host, addr) {
  const m = /^(.+?)(?::(\d{1,5}))?$/.exec(String(host));
  if (!m || m[1] !== addr.ip) return false;
  return m[2] === undefined || addr.ports.includes(Number(m[2]));
}

/** The hosts one env value names: a URL's host, or the value itself when it is a host or host:port. */
export function valueHosts(v) {
  const s = String(v ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try { const u = new URL(s); return u.host ? [u.host] : []; } catch { return [s]; }
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?$/.test(s) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/i.test(s) || /^localhost(?::\d{1,5})?$/i.test(s)) return [s.toLowerCase()];
  return [];
}

/** Anything in the declaration that could make the plan reach a host other than through the server env we set. */
export function declarationProblems(doc, relay) {
  const out = [];
  const s = doc?.server ?? {};
  if (s.url !== undefined || s.launch !== undefined || s.headers_env !== undefined) out.push('the server is not a stdio server we start');
  if (JSON.stringify(s.stdio) !== JSON.stringify(relay)) out.push('the server command is not our relay');
  if (doc?.target?.allow_hosts !== undefined) out.push('target.allow_hosts is set');
  if (doc?.backend !== undefined) out.push('a backend gate is declared');
  for (const r of doc?.resources ?? []) if (r?.control !== undefined) out.push(`resource ${String(r?.name).slice(0, 40)} has a control arm`);
  return out;
}

/**
 * The rule check. Returns { accepted: true, accepted_by: 'rule', plan_hash, hosts } or
 * { accepted: false, accepted_by: null, code, detail, plan_hash, hosts, foreign }.
 *   planStdout  the CLI's `plan` stdout for the thin declaration
 *   confirm     the declaration's target.confirm (ours)
 *   addr        the stand-in's address ({ ip, ports })
 *   serverEnv   the env we set for the server (names -> values)
 *   doc, relay  the declaration we generated and our relay command
 */
export function ruleCheck({ planStdout, confirm, addr, serverEnv, doc, relay }) {
  const refuse = (code, detail, extra = {}) => ({ accepted: false, accepted_by: null, code, detail, plan_hash: null, hosts: [], foreign: [], ...extra });
  const p = planHosts(planStdout, { confirm });
  if (p.error) return refuse('plan_unreadable', p.error);
  const base = { plan_hash: p.hash, hosts: p.hosts };
  const dp = declarationProblems(doc, relay);
  if (dp.length) return refuse('declaration_not_thin', dp.join('; '), base);
  if (!p.hosts.length) return refuse('target_not_standin', 'the plan reaches no host, so no write of it goes to the stand-in', base);
  const foreign = p.hosts.filter((h) => !isStandIn(h, addr));
  for (const [name, v] of Object.entries(serverEnv ?? {})) for (const h of valueHosts(v)) if (!isStandIn(h, addr)) foreign.push(`${h} (${name})`);
  if (foreign.length) return refuse('target_not_standin', `a write target is not the stand-in: ${foreign.slice(0, 5).join(', ')}`, { ...base, foreign: [...new Set(foreign)].slice(0, 20) });
  return { accepted: true, accepted_by: 'rule', ...base };
}

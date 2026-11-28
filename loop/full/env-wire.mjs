// Full mode's server environment (tool-qa PR #119, "What the worker must do with them"): the env names the shard gives
// for an item, each set to a value that points at the stand-in inside the sandbox, or left unset. Only names that start
// with one of the stand-in's own prefixes (standin.json env_prefixes, e.g. TYPESENSE_) are set, and only by the role
// their last word gives:
//
//   *_URL, *_URI, *_BASE_URL, *_ENDPOINT        <protocol>://<stand-in address>:<port>
//   *_HOST                                      <stand-in address>
//   *_ADDR                                      <stand-in address>:<port>
//   *_PORT                                      <port>
//   *_PROTOCOL, *_SCHEME                        <protocol>
//   *_API_KEY, *_KEY, *_TOKEN, *_SECRET         the unit's generated api_key (when the stand-in has one)
//   *_USER, *_USERNAME                          the unit's username (when the stand-in has one)
//   *_PASSWORD, *_PASS, *_PWD                   the unit's generated password (when the stand-in has one)
//
// Every other name is left unset and listed (a read-only switch, a timeout, an org id, another service's key): we never
// guess a value. Credentials are made for the unit (randomBytes), never real ones; the stand-in is started with the same
// values. Egress stays denied: the address is on the sandbox's run network, which has no way out. A server with no name
// that points it at the stand-in cannot be routed there: a skip of ours (`cannot_route`), never the server's.
//
// Only Node's standard library.
import { randomBytes } from 'node:crypto';

/** The contract's base-URL names (meta-backend `base_url_env`): *_URL, *_URI, *_HOST, *_ENDPOINT, *_BASE_URL, *_ADDR. */
export const BASE_URL_NAME = /_(URL|URI|HOST|ENDPOINT|BASE_URL|ADDR)$/;
const ROLES = [
  ['url', /_(BASE_URL|URL|URI|ENDPOINT)$/],
  ['host', /_HOST$/],
  ['addr', /_ADDR$/],
  ['port', /_PORT$/],
  ['protocol', /_(PROTOCOL|SCHEME)$/],
  ['api_key', /_(API_KEY|KEY|TOKEN|SECRET)$/],
  ['username', /_(USER|USERNAME)$/],
  ['password', /_(PASSWORD|PASS|PWD)$/],
];
/** Roles whose value is a credential: passed to the CLI as env_passthrough (redacted, looked for in results). */
export const SECRET_ROLES = Object.freeze(['api_key', 'password']);
/** Roles that point the server at the stand-in. */
export const ROUTE_ROLES = Object.freeze(['url', 'host', 'addr']);
/** Names a server env must never be given here, whatever their prefix (the sandbox refuses them too). */
const NEVER = /^(PATH|HOME|TMPDIR|NODE_OPTIONS|NODE_PATH|LD_[A-Z_]*|DYLD_[A-Z_]*|PYTHON[A-Z_]*|GITHUB_[A-Z_]*|RUNNER_[A-Z_]*|ACTIONS_[A-Z_]*|SURFACE_[A-Z_]*)$/;

/** The stand-in's address on the run network: <subnet>.<octet>. */
export function standInAddr(def, NETS) {
  const ip = NETS.run.subnet.replace(/0\/24$/, String(def.octet));
  if (!/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) throw new Error('the run network is not a 10/8 subnet');
  return { ip, port: def.port, ports: [...def.ports], protocol: def.protocol, base: `${def.protocol}://${ip}:${def.port}` };
}

/** The unit's credentials for the stand-in (standin.json `credentials`): random hex, or a fixed word. Never a real one. */
export function makeCredentials(def, rand = randomBytes) {
  const out = {};
  for (const [k, spec] of Object.entries(def.credentials ?? {})) {
    const m = /^random_hex_(\d+)$/.exec(spec);
    out[k] = m ? rand(Number(m[1])).toString('hex') : spec.slice('fixed:'.length);
  }
  return out;
}

const roleOf = (name) => ROLES.find(([, re]) => re.test(name))?.[0] ?? null;

/**
 * The server env for one item. Returns { ok: true, env, wired: [{ name, role }], unset: [names], secretNames } or
 * { ok: false, code: 'cannot_route', detail, unset }.
 */
export function wireEnv({ names, def, addr, creds }) {
  const env = {};
  const wired = [];
  const unset = [];
  const value = (role) => ({ url: addr.base, host: addr.ip, addr: `${addr.ip}:${addr.port}`, port: String(addr.port), protocol: addr.protocol, api_key: creds.api_key, username: creds.username, password: creds.password })[role];
  for (const name of names) {
    const role = roleOf(name);
    const v = role ? value(role) : undefined;
    if (NEVER.test(name) || !def.env_prefixes.some((p) => name.startsWith(p)) || typeof v !== 'string' || v === '') { unset.push(name); continue; }
    env[name] = v;
    wired.push({ name, role });
  }
  if (!wired.some((w) => ROUTE_ROLES.includes(w.role))) return { ok: false, code: 'cannot_route', detail: `no env name the server reads points it at the stand-in (names that start with ${def.env_prefixes.join(', ')} and end in _URL, _URI, _HOST, _ENDPOINT, _BASE_URL or _ADDR)`, unset };
  return { ok: true, env, wired, unset, secretNames: wired.filter((w) => SECRET_ROLES.includes(w.role)).map((w) => w.name) };
}

/** TEST-NET-1 (RFC 5737): never routed anywhere, and the run network has no way out in any case. */
export const FOREIGN_HOST = '192.0.2.10';

/**
 * The pull-request proof's mutation (loop-full-proof.yml, `FULL_PROOF_MUTATION=foreign_target`, read only in that
 * proof): the first name that points the server at the stand-in points it at a host that is not the stand-in instead,
 * so the proof shows the rule check refusing the plan. Returns a new wiring.
 */
export function foreignTarget(w) {
  const i = w.wired.findIndex((x) => ROUTE_ROLES.includes(x.role));
  if (i < 0) return w;
  const { name, role } = w.wired[i];
  const env = { ...w.env, [name]: role === 'url' ? w.env[name].replace(/^(\w+:\/\/)[^:/]+/, `$1${FOREIGN_HOST}`) : role === 'addr' ? w.env[name].replace(/^[^:]+/, FOREIGN_HOST) : FOREIGN_HOST };
  return { ...w, env, mutated: { name, role } };
}

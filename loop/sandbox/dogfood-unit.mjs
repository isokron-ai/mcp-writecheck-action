#!/usr/bin/env node
/**
 * The long-lived main process of a dogfood worker's unit container (dogfood/sbx.mjs; ours, from the read-only tools
 * volume). The unit is the sandbox's stand-in for the runner's own loopback: the CLI and the stdio server it starts
 * run there through `docker exec`, and each `<port>=<ip>:<port>` argument forwards 127.0.0.1:<port> inside the unit
 * to a service container of the same run network (Grafana, Strapi, Postgres, the Next.js app), so the manifests'
 * `http://127.0.0.1:<port>` URLs (covered by their accepted plan hashes) stay as they are:
 *
 *   node dogfood-unit.mjs [<port>=<ip>:<port>]...
 *
 * Only addresses of the sandbox's run network (10.213.53.0/24) are forwarded to. It prints one JSON line when every
 * listener is up ({"listening":[ports]}) and then runs until the container is removed.
 */
import { createConnection, createServer } from 'node:net';

const RUN_NET = /^10\.213\.53\.(?:[3-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-4])$/;

/** `<port>=<ip>:<port>` as { port, host, hostPort }, or an Error. */
export function parseForward(s) {
  const m = /^(\d{2,5})=(\d+\.\d+\.\d+\.\d+):(\d{2,5})$/.exec(String(s));
  if (!m) return new Error(`not <port>=<ip>:<port>: ${String(s).slice(0, 60)}`);
  const [port, host, hostPort] = [Number(m[1]), m[2], Number(m[3])];
  if (!(port >= 1024 && port <= 65535) || !(hostPort >= 1 && hostPort <= 65535)) return new Error('a port is out of range');
  if (!RUN_NET.test(host)) return new Error(`${host} is not an address of the sandbox run network`);
  return { port, host, hostPort };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const specs = process.argv.slice(2).map(parseForward);
  const bad = specs.find((s) => s instanceof Error);
  if (bad) { process.stderr.write(`dogfood-unit: ${bad.message}\n`); process.exit(2); }
  let up = 0;
  const ready = () => { if (++up >= specs.length) process.stdout.write(`${JSON.stringify({ listening: specs.map((s) => s.port) })}\n`); };
  if (specs.length === 0) process.stdout.write(`${JSON.stringify({ listening: [] })}\n`);
  for (const s of specs) {
    const server = createServer((client) => {
      const up2 = createConnection({ host: s.host, port: s.hostPort });
      const end = () => { client.destroy(); up2.destroy(); };
      client.on('error', end); up2.on('error', end);
      client.pipe(up2); up2.pipe(client);
    });
    server.on('error', (e) => { process.stderr.write(`dogfood-unit: 127.0.0.1:${s.port}: ${e.code ?? e.message}\n`); process.exit(1); });
    server.listen(s.port, '127.0.0.1', ready);
  }
  setInterval(() => {}, 1 << 30);
}

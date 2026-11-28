#!/usr/bin/env node
// The mcp-writecheck CLI as the dogfood workers' action steps see it (cli-path: dogfood/sbx-cli): every call runs the
// pinned CLI inside the job's sandbox, next to the server it starts (dogfood/sbx.mjs, `cli`). Nothing here runs a server.
import { cli } from '../../../../sbx.mjs';

cli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(`mcp-writecheck (sandboxed): ${String(e?.message ?? e).slice(0, 300)}\n`);
  process.exitCode = 3;
});

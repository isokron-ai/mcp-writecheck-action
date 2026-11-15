/**
 * Checks contract.mjs against the things it describes. Run with `node --test test/`.
 *
 *   always                 the registry's own shape; action.yml against the script and the contract
 *   CLI_DIR=<built CLI>    the commands and flags the action uses exist in the CLI's own help, and
 *                          the registry differences are exactly the ones NOTES.md records
 *   MWS_SPEC=<mws.md>      the registry equals Annex C of the spec, and section 9's levels
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CLI, CLI_DEFAULT_REF, CLI_ENTRY, LEFT_BY_DECLARATION, REQUIREMENT_ID, requirementUrl, SPEC, SPEC_DEFAULT_URL, VERDICTS } from '../contract.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cliDir = process.env.CLI_DIR;
const specFile = process.env.MWS_SPEC;

test('the registry has well-formed, unique requirement IDs', () => {
  const ids = SPEC.requirements.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of SPEC.requirements) {
    assert.match(r.id, REQUIREMENT_ID);
    assert.ok(['MUST', 'SHOULD'].includes(r.level), r.id);
    assert.ok(r.short.length > 0, r.id);
  }
});

test('a requirement link is the base URL and the lower-case ID as the anchor', () => {
  assert.equal(requirementUrl('https://isokron.ai/mws', 'MWS-UPD-1'), 'https://isokron.ai/mws#mws-upd-1');
  assert.equal(requirementUrl('https://example.test/spec/#top', 'MWS-CONC-2'), 'https://example.test/spec/#mws-conc-2');
});

test('action.yml: every input reaches the script, and the defaults are the contract\'s', () => {
  const yml = readFileSync(join(root, 'action.yml'), 'utf8');
  const main = readFileSync(join(root, 'src', 'main.mjs'), 'utf8');
  const inputsBlock = yml.slice(yml.indexOf('\ninputs:'), yml.indexOf('\noutputs:'));
  const inputs = [...inputsBlock.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]);
  assert.ok(inputs.length >= 4);
  for (const name of inputs) {
    const envName = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
    assert.ok(yml.includes(`${envName}: \${{ inputs.${name} }}`), `action.yml does not pass ${name} as ${envName}`);
    assert.ok(main.includes(`input('${name}'`), `src/main.mjs does not read ${name}`);
  }
  for (const m of main.matchAll(/input\('([a-z-]+)'/g)) assert.ok(inputs.includes(m[1]), `src/main.mjs reads ${m[1]}, which action.yml does not declare`);
  const def = (name) => new RegExp(`^ {2}${name}:\\n(?: {4}.*\\n)*? {4}default: (.*)$`, 'm').exec(inputsBlock)?.[1];
  assert.equal(def('cli-ref'), CLI_DEFAULT_REF);
  assert.equal(def('spec-url'), SPEC_DEFAULT_URL);
  assert.equal(def('mode'), 'plan', 'the default mode must be the one that writes nothing');
  // No input is interpolated into a shell command, on a run line or in a `run: |` block.
  const lines = yml.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const m = /^(\s+)(?:- )?run: (.*)$/.exec(lines[n]);
    if (!m) continue;
    assert.ok(!m[2].includes('${{'), `interpolation in a run line: ${m[2]}`);
    if (!/^[|>]/.test(m[2])) continue;
    for (let k = n + 1; k < lines.length && (lines[k].trim() === '' || lines[k].search(/\S/) > m[1].length); k++) {
      assert.ok(!lines[k].includes('${{'), `interpolation in a run block: ${lines[k].trim()}`);
    }
  }
  // Outputs the script writes are the ones action.yml maps.
  for (const m of yml.matchAll(/steps\.(?:run|cli)\.outputs\.([a-z-]+)/g)) assert.ok(main.includes(`'${m[1]}'`), `src/main.mjs does not write the output ${m[1]}`);
  // cli-token reaches only the obtain step.
  const steps = yml.slice(yml.indexOf('\n  steps:')).split(/\n {4}- /);
  const withToken = steps.filter((st) => st.includes('INPUT_CLI_TOKEN'));
  assert.equal(withToken.length, 1, 'exactly one step gets INPUT_CLI_TOKEN');
  assert.match(withToken[0], /main\.mjs" obtain$/m, 'the step that gets INPUT_CLI_TOKEN is the obtain step');
});

test('only contract.mjs names CLI flags, requirement IDs and the spec URL', () => {
  for (const f of ['src/main.mjs', 'src/install.mjs', 'src/summary.mjs']) {
    const code = readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(code, /MWS-[A-Z]+-\d/, `${f} names a requirement ID`);
    assert.doesNotMatch(code, /isokron\.ai|github\.com/, `${f} names a host`);
    assert.doesNotMatch(code, /'--(?!quiet|depth|detach)[a-z-]+'/, `${f} names a CLI flag`);
  }
});

test('the pinned CLI has the commands, flags and exit statuses the contract uses', { skip: !cliDir && 'set CLI_DIR to a built packages/writecheck' }, () => {
  const entry = join(cliDir, CLI_ENTRY);
  assert.ok(existsSync(entry), entry);
  const cli = (...args) => spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' });
  assert.match(cli(...CLI.versionArgs()).stdout, /^mcp-writecheck \S+ \(MWS 0\.9\)$/m);

  const flagsOf = (args) => args.filter((a) => a.startsWith('-'));
  const planHelp = cli('plan', '--help').stdout;
  for (const f of flagsOf(CLI.planArgs({ manifest: 'm', catalog: 'c' }))) assert.ok(planHelp.includes(f), `plan --help does not mention ${f}`);
  const catalogHelp = cli('catalog', '--help').stdout;
  for (const f of flagsOf(CLI.catalogArgs({ manifest: 'm', catalog: null, out: 'o' }))) assert.ok(catalogHelp.includes(f), `catalog --help does not mention ${f}`);
  for (const f of flagsOf(CLI.catalogArgs({ manifest: 'm', catalog: 'c', out: 'o' }))) assert.ok(catalogHelp.includes(f), `catalog --help does not mention ${f}`);
  const runHelp = cli('run', '--help').stdout;
  for (const f of flagsOf(CLI.runArgs({ manifest: 'm', confirmTarget: 't', planHash: 'h', out: 'o', state: 's' }))) assert.ok(runHelp.includes(f), `run --help does not mention ${f}`);

  const usage = cli('help').stdout;
  assert.match(usage, /Exit status: 0 done; 1 a violated MUST not in the baseline \(or a stale baseline entry\);\n2 usage or manifest error; 3 refused \(target, confirmation, guard, open ledger\); 4 stopped or failed\./);
  // There is still no way to skip the confirmation.
  assert.equal(cli('run', '--yes').status, 2);
  // An unknown command is refused, so a renamed command cannot pass silently.
  assert.equal(cli('catalogue').status, 2);
  // The results format the action reads is the one the CLI's schema names.
  const schema = JSON.parse(readFileSync(join(cliDir, 'schema', 'mws-results-1.schema.json'), 'utf8'));
  assert.equal(schema.properties.format.const, CLI.resultsFormat);
  assert.deepEqual(schema.properties.run.properties.status.enum, ['complete', 'stopped']);
  assert.ok(schema.properties.results.items.required.includes('attribution'));
  assert.deepEqual([...schema.properties.results.items.properties.verdict.enum].sort(), [...VERDICTS].sort());
});

test('registry differences between the pinned CLI and the spec are the recorded ones', { skip: !cliDir && 'set CLI_DIR to a built packages/writecheck' }, () => {
  const out = spawnSync(process.execPath, [join(cliDir, CLI_ENTRY), 'requirements'], { encoding: 'utf8' }).stdout;
  const cli = new Map(out.trim().split('\n').map((l) => l.split('\t')).map(([id, level]) => [id, level]));
  const spec = new Map(SPEC.requirements.map((r) => [r.id, r.level]));
  for (const id of cli.keys()) assert.ok(spec.has(id), `the CLI knows ${id}, which the registry does not have`);
  const missing = [...spec.keys()].filter((id) => !cli.has(id));
  const levelDiffers = [...cli].filter(([id, level]) => spec.get(id) !== level).map(([id, level]) => `${id}: CLI ${level}, spec ${spec.get(id)}`);
  // At 0295ed6 the CLI knows the 37 IDs at the spec's levels. If a difference returns, the summary marks it
  // and the `must` rule counts the stricter level (NOTES.md, design choice 4); record it here and in NOTES.md.
  assert.deepEqual(missing, []);
  assert.deepEqual(levelDiffers, []);
  assert.deepEqual([...cli.keys()], SPEC.requirements.map((r) => r.id), 'the same order as Annex C');
});

test('the registry equals Annex C and the levels of section 9', { skip: !specFile && 'set MWS_SPEC to spec/mws.md' }, () => {
  const text = readFileSync(specFile, 'utf8');
  const annex = text.slice(text.indexOf('## Annex C'), text.indexOf('## Annex D'));
  const rows = [...annex.matchAll(/^\| (MWS-[A-Z]+-\d+) \| (MUST|SHOULD) \| (.+?) \| .+? \| (?:yes|no) \|$/gm)].map((m) => ({ id: m[1], level: m[2], short: m[3] }));
  assert.deepEqual(SPEC.requirements, rows);
  const section9 = [...text.matchAll(/^#### (MWS-[A-Z]+-\d+)\n\n- \*\*Level:\*\* (MUST|SHOULD)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(SPEC.requirements.map((r) => `${r.id} ${r.level}`), section9);
  assert.match(text, new RegExp(`\\| Version \\| ${SPEC.version.replace('.', '\\.')} `));
  // The seven verdicts of section 8.1.
  const verdicts = [...text.slice(text.indexOf('## 8. Verdicts'), text.indexOf('8.2. **Rules')).matchAll(/^\| `([a-z -]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...VERDICTS].sort(), verdicts.sort());
});

/**
 * The skills were written against spec commit 516c4ed and are not changed by this series (the caller skill
 * only gains the two P-7 lines). Between 516c4ed and the registry's commit the IDs and levels are the same;
 * the requirement sentences of MWS-RES-2, MWS-RETRY-2 and MWS-ANN-4 and the applicability of MWS-TGT-3
 * changed (NOTES.md). When the skills are re-derived, move this to SPEC.commit.
 */
const SKILLS_SPEC_COMMIT = '516c4ed';

// The skills sit beside the action in the mcp-write-safety repository (integrations/skills) and inside it in
// the action's own repository (skills/).
const skillsDir = [join(root, 'skills'), join(root, '..', 'skills')].find((d) => existsSync(d));

test('the two skills cite only requirement IDs of the registry, and the builder skill has every one at its level', { skip: !skillsDir && 'no skills folder' }, () => {
  const known = new Map(SPEC.requirements.map((r) => [r.id, r.level]));
  const builder = readFileSync(join(skillsDir, 'mcp-write-safe-builder', 'SKILL.md'), 'utf8');
  const caller = readFileSync(join(skillsDir, 'mcp-write-safe-caller', 'SKILL.md'), 'utf8');
  for (const text of [builder, caller]) for (const m of text.matchAll(/MWS-[A-Z]+-\d+/g)) assert.ok(known.has(m[0]), `${m[0]} is not in the registry`);
  const rules = [...builder.matchAll(/^\*\*(MWS-[A-Z]+-\d+) \((MUST|SHOULD)/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(rules, SPEC.requirements.map((r) => `${r.id} ${r.level}`));
  for (const text of [builder, caller]) assert.ok(text.includes(`spec commit \`${SKILLS_SPEC_COMMIT}\``), 'a skill names another spec commit than the one recorded for the skills');
});

test('the pinned CLI writes the leftover reasons LEFT_BY_DECLARATION matches', { skip: !cliDir && 'set CLI_DIR to a built packages/writecheck' }, () => {
  // why: the summary keeps objects left by the manifest's clean-up policy out of "Needs attention" by their
  // reason text; if the CLI rewords one, the summary would warn again, so the texts are checked here.
  const src = readFileSync(join(cliDir, 'dist', 'src', 'core', 'cleanup.js'), 'utf8');
  for (const re of LEFT_BY_DECLARATION) {
    const literal = re.source.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1');
    assert.ok(src.includes(literal), `core/cleanup.js does not write the leftover reason "${literal}"`);
  }
});

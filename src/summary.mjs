/**
 * Pure functions: the job-status decision and the Markdown for the job summary. No file or
 * process access, so `test/summary.test.mjs` can exercise them with recorded results.
 *
 * The summary follows the tester rules of MWS sections 5 and 8 that apply to any report:
 *   - one row per requirement and write path; no total, percentage, count of verdicts or grade
 *     (section 5.2);
 *   - a verdict is printed with its level (section 8.2, rule 12);
 *   - a `violated` record is printed with its attribution, full reason and notes (section 8.2,
 *     rule 3);
 *   - `self-attested` is printed with the answer given.
 *
 * What the tester's seat belts saw comes before the verdicts: objects the tester did not create
 * that were lost (the bystander inventory), setup that was not released, objects left behind.
 */

import { CLI, LEFT_BY_DECLARATION, RESULTS_FIELDS, requirementUrl, REQUIREMENT_ID, SPEC, VERDICTS } from '../contract.mjs';

const REGISTRY = new Map(SPEC.requirements.map((r) => [r.id, r]));

// ---------------------------------------------------------------------------------------------
// Text helpers. Everything read from results.json or from the CLI's output is untrusted here: it
// can quote tool names, error texts and other strings that the server under test produced.
// ---------------------------------------------------------------------------------------------

/** Escape free text for use inside a Markdown paragraph or table cell. */
export function md(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1')
    .replace(/\s*\r?\n\s*/g, ' ');
}

/** An inline code span that cannot be closed from inside, safe in a table cell. */
export function code(s) {
  return '`' + String(s ?? '').replace(/`/g, "'").replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ') + '`';
}

/** A fenced block whose fence is longer than any run of backticks in the text. */
export function fence(text) {
  const longest = Math.max(2, ...(String(text).match(/`+/g) ?? []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}text\n${String(text).replace(/\s+$/, '')}\n${f}`;
}

const writePath = (r) => `${r.write_path?.resource ?? '?'}:${r.write_path?.tool ?? '?'}`;
const link = (id, base) => (REQUIREMENT_ID.test(id) ? `[${id}](${requirementUrl(base, id)})` : code(id));
const uniq = (a) => [...new Set(a)];

// ---------------------------------------------------------------------------------------------
// Levels. The CLI at the pinned commit and the spec at the pinned commit agree on all 37; the
// rule below is kept as a guard for a later CLI or spec (NOTES.md, owner decision 1).
// ---------------------------------------------------------------------------------------------

/**
 * The level of a record. `recorded` is what the CLI wrote; `registry` is the spec's (contract.mjs).
 * `must` is true when either says MUST: the job-status rule is never more lenient than the spec.
 */
export function levelOf(record) {
  const registry = REGISTRY.get(record.requirement)?.level ?? null;
  const recorded = record.level ?? null;
  return { recorded, registry, must: recorded === 'MUST' || registry === 'MUST', differs: registry !== null && recorded !== null && registry !== recorded };
}

export function levelText(record) {
  const l = levelOf(record);
  if (l.differs) return `${l.registry} in MWS ${SPEC.version}; recorded as ${l.recorded}`;
  return l.recorded ?? l.registry ?? 'level not recorded';
}

// ---------------------------------------------------------------------------------------------
// The safety facts: what the tester's seat belts saw, apart from the verdicts
// ---------------------------------------------------------------------------------------------

/**
 * @param {object|null} doc  results.json
 * @returns {{ lost: object[], setupUnresolved: object[], leftovers: object[], leftByDeclaration: object[], cleanupFailed: object[], cleanupUnknown: object[], cleanupStopped: string|null, canariesChanged: object[], fixturesNotRestored: object[], inventories: object[] }}
 */
const byDeclaration = (x) => typeof x?.reason === 'string' && LEFT_BY_DECLARATION.some((re) => re.test(x.reason));

export function safetyFacts(doc) {
  const results = Array.isArray(doc?.results) ? doc.results : [];
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    lost: results.filter((r) => arr(r.numbers?.[RESULTS_FIELDS.bystandersLost]).length > 0),
    setupUnresolved: arr(doc?.safety?.[RESULTS_FIELDS.setupUnresolved]),
    // why: an object left because the manifest's cleanup policy says so (ephemeral, leave, archive) is not
    // something a person has to act on; only the others are leftovers that need attention.
    leftovers: arr(doc?.leftovers).filter((x) => !byDeclaration(x)),
    leftByDeclaration: arr(doc?.leftovers).filter(byDeclaration),
    cleanupFailed: arr(doc?.cleanup?.failed),
    cleanupUnknown: arr(doc?.cleanup?.unknown),
    cleanupStopped: typeof doc?.cleanup?.stopped === 'string' && doc.cleanup.stopped ? doc.cleanup.stopped : null,
    canariesChanged: arr(doc?.safety?.canaries).filter((c) => c?.unchanged === false),
    fixturesNotRestored: arr(doc?.safety?.fixtures_restored).filter((f) => f && !f.restored),
    inventories: results.filter((r) => r.numbers?.[RESULTS_FIELDS.bystanderInventory] && typeof r.numbers[RESULTS_FIELDS.bystanderInventory] === 'object'),
  };
}

// ---------------------------------------------------------------------------------------------
// The job status
// ---------------------------------------------------------------------------------------------

/**
 * @param {{ failOn: 'none'|'must'|'any', cliExit: number|null, doc: object|null }} o
 * @returns {{ fail: boolean, reasons: string[], failing: object[] }}
 *
 * 1. A run that lost an object the tester did not create (a bystander), left setup on the platform
 *    that it could not release, or could not finish its clean-up (deletes that failed, creates of
 *    unknown outcome, a clean-up that stopped), fails the job whatever fail-on says: a person has to
 *    act, and with an open ledger the next run against the target is refused.
 * 2. A run that did not complete fails the job whatever fail-on says: there is nothing to judge,
 *    and a green job would hide that.
 * 3. Otherwise fail-on decides, from the `violated` records alone. No other verdict fails a job.
 */
export function decide({ failOn, cliExit, doc }) {
  const reasons = [];
  const facts = safetyFacts(doc);
  // why: these come first. They hold whether or not the run completed, and they are about the test
  // environment, not about the server's verdicts, so no fail-on value can hide them.
  if (facts.lost.length) reasons.push('Objects the tester did not create were changed or deleted during the run. A lost bystander fails the job whatever `fail-on` says.');
  if (facts.setupUnresolved.length) reasons.push('Setup the run made through the platform\'s API was not released, or not confirmed released. This fails the job whatever `fail-on` says.');
  // why: a test environment that failed during the run (seen: the backend gone 20 s in) gives a run the CLI
  // reports as complete with exit 0, every later check `not tested`; the unfinished clean-up is the signal.
  if (facts.cleanupFailed.length || facts.cleanupUnknown.length || facts.cleanupStopped) reasons.push(`The clean-up did not finish${facts.cleanupStopped ? ` (${md(facts.cleanupStopped)})` : ''}: objects of this run may still be in the test environment, and the next run against it is refused until \`mcp-writecheck cleanup\` has run. This fails the job whatever \`fail-on\` says.`);
  if (!CLI.exitRanToCompletion.includes(cliExit)) {
    reasons.push(`mcp-writecheck exited with status ${cliExit} (${CLI.exit[cliExit] ?? 'not a status it documents'}). A run that did not complete fails the job whatever \`fail-on\` says.`);
  }
  if (!doc) {
    if (!reasons.length) reasons.push('mcp-writecheck exited normally but wrote no results that this action could read.');
    return { fail: true, reasons, failing: [] };
  }
  if (doc.run?.status !== 'complete') {
    reasons.push(`The run stopped before it finished${doc.run?.stopped_reason ? ` (${md(doc.run.stopped_reason)})` : ''}. The records below are partial.`);
  }
  if (!CLI.exitRanToCompletion.includes(cliExit) || doc.run?.status !== 'complete') return { fail: true, reasons, failing: [] };

  const violated = (doc.results ?? []).filter((r) => r.verdict === 'violated');
  const failing = failOn === 'none' ? [] : failOn === 'must' ? violated.filter((r) => levelOf(r).must) : violated;
  if (failing.length) {
    reasons.push(failOn === 'must' ? '`fail-on` is `must`, and a record of a MUST is `violated`.' : '`fail-on` is `any`, and a record is `violated`.');
  } else if (failOn !== 'none' && cliExit === 1) {
    // why: without a baseline this cannot happen; if it does, the action must not be more lenient than the CLI.
    reasons.push('mcp-writecheck exited with status 1 (a violated MUST), although this action found no such record in results.json.');
  }
  return { fail: reasons.length > 0, reasons, failing };
}

// ---------------------------------------------------------------------------------------------
// The summary of a run
// ---------------------------------------------------------------------------------------------

const VERDICT_MEANING = [
  ['violated', 'the behavior the requirement forbids was reproduced'],
  ['platform', 'reproduced through the server and through the platform API as well'],
  ['held', 'the condition was forced and the server did what the requirement says in every trial'],
  ['not observed', 'attempted but not forced, or a search; nothing was seen; not evidence that the requirement is met'],
  ['not tested', 'not run, or the result cannot be used; the record says why'],
  ['not applicable', 'the requirement\'s condition is false for this write path'],
  ['self-attested', 'a person\'s answer to a review-only question, recorded as given'],
];

/** Spec 8.2, rule 3: a violated or platform record of a requirement that lists platform carries its attribution. */
const attributionText = (r) => (r.attribution ? `attribution: ${md(r.attribution)}` : '');

function attested(r) {
  const a = r.numbers?.answer;
  return a === true ? 'self-attested: yes' : a === false ? 'self-attested: no' : 'self-attested';
}

/** One table cell: for each verdict present, the write paths that have it. */
function verdictCell(records) {
  const groups = [];
  for (const v of VERDICTS) {
    const of = records.filter((r) => r.verdict === v);
    if (!of.length) continue;
    if (v === 'self-attested') {
      for (const label of uniq(of.map(attested))) groups.push(`${label}: ${uniq(of.filter((r) => attested(r) === label).map(writePath)).map(code).join(', ')}`);
    } else groups.push(`${v === 'violated' ? '**violated**' : v}: ${uniq(of.map(writePath)).map(code).join(', ')}`);
  }
  const other = records.filter((r) => !VERDICTS.includes(r.verdict));
  if (other.length) groups.push(`${uniq(other.map((r) => md(r.verdict))).join(', ')} (not a verdict this action knows): ${uniq(other.map(writePath)).map(code).join(', ')}`);
  return groups.join('<br>');
}

function numbersText(r) {
  const e = Object.entries(r.numbers ?? {}).filter(([, v]) => v !== null && v !== undefined);
  return e.map(([k, v]) => `${k}=${typeof v === 'number' ? v : JSON.stringify(v)}`).join(', ');
}

function statusLines(decision, failOn) {
  if (decision.fail) return [`**Job status: failed.** ${decision.reasons.join(' ')}`];
  const rule = failOn === 'none' ? '`fail-on` is `none`, so no verdict fails this job.' : failOn === 'must' ? '`fail-on` is `must`, and no record of a MUST is `violated`.' : '`fail-on` is `any`, and no record is `violated`.';
  return [
    `**Job status: not failed.** ${rule}`,
    '',
    'This is not a statement that the server meets MWS. The records are per requirement and write path; `not observed`, `not tested`, `not applicable` and `self-attested` records do not fail a job and each says why it has that verdict.',
  ];
}

/** The lines of the sections that come before the verdicts: what the tester's seat belts saw. */
function safetySections(doc, facts) {
  const L = [];
  if (facts.lost.length) {
    L.push('');
    L.push('### Objects the tester did not create were changed or deleted');
    L.push('');
    L.push('The tester lists every object it can list outside its own before and after each targeting call. These were gone, changed, or missing from every listing afterwards. Check them, and restore what was lost from your backup; each line names the record of the call around which the loss was seen. A change is not attributed to the call: other activity on the backend can change an object.');
    L.push('');
    for (const r of facts.lost) L.push(`- ${code(r.requirement)} on ${code(writePath(r))} (${md(r.verdict)}): ${r.numbers[RESULTS_FIELDS.bystandersLost].map(code).join(', ')}`);
  }
  if (facts.setupUnresolved.length) {
    L.push('');
    L.push('### Setup not released');
    L.push('');
    L.push('Setup this run made through the platform\'s own API could not be released, or could not be confirmed released by a read. Something the tester put on the platform (for example a lock) may still be in place. Download the artifact and run `mcp-writecheck cleanup` with its `state` folder against the same target; if that cannot release it, send the release by hand.');
    L.push('');
    for (const u of facts.setupUnresolved) {
      L.push(`- ${md(u.kind)} ${code(u.name)} on ${md(u.resource)} ${code(JSON.stringify(u.object_id ?? null))}: ${md(u.reason)}.${u.check ? ` To see whether it is in place: ${code(u.check)}.` : ''}${Array.isArray(u.release) && u.release.length ? ` To release it: ${u.release.map(code).join('; ')}.` : ''}`);
    }
  }
  const warn = [];
  if (facts.leftovers.length) {
    const shown = facts.leftovers.slice(0, 20).map((x) => `${md(x.resource)} ${code(JSON.stringify(x.id ?? null))}${x.reason ? ` (${md(x.reason)})` : ''}`).join('; ');
    warn.push(`Objects of this run were left behind in the test environment: ${shown}${facts.leftovers.length > 20 ? '; and more, listed in `' + CLI.reportFile + '`' : ''}. Search the environment for the prefix ${code(doc.run?.prefix)}.`);
  }
  if (facts.cleanupFailed.length) warn.push(`Clean-up could not delete: ${facts.cleanupFailed.slice(0, 20).map((x) => `${md(x.resource)} ${code(JSON.stringify(x.id ?? null))}${x.reason ? ` (${md(x.reason)})` : ''}`).join('; ')}.`);
  if (facts.cleanupStopped) warn.push(`Clean-up stopped: ${md(facts.cleanupStopped)}.`);
  if (facts.cleanupUnknown.length) warn.push(`Creates whose outcome is unknown are still open in the ledger (${facts.cleanupUnknown.slice(0, 20).map((x) => md(x.resource ?? '?')).join(', ')}). Download the artifact and run \`mcp-writecheck cleanup\` with its \`state\` folder against the same target.`);
  for (const c of facts.canariesChanged) warn.push(`Untouched-state canary ${code(c.name)} changed during the run${c.note ? ` (${md(c.note)})` : ''}.`);
  for (const f of facts.fixturesNotRestored) warn.push(`Fixture ${code(f.resource)} was not put back to its original values${f.note ? ` (${md(f.note)})` : ''}.`);
  if (warn.length) {
    L.push('');
    L.push('### Needs attention');
    L.push('');
    for (const w of warn) L.push(`- ${w}`);
  }
  if (facts.leftByDeclaration.length) {
    const policies = uniq(facts.leftByDeclaration.map((x) => x.reason)).map(md).join('; ');
    L.push('');
    L.push(`Objects of this run were left in the test environment because the manifest's clean-up policy says so (${policies}). They carry the prefix ${code(doc.run?.prefix)}; ${CLI.reportFile} lists them.`);
  }
  return L;
}

/**
 * @param {{ doc: object, specUrl: string, failOn: string, cliExit: number, decision: object, cliVersion: string, artifactName: string, mode?: 'full'|'catalog', maxBytes?: number }} o
 */
export function renderRun(o) {
  const { doc, specUrl } = o;
  const mode = o.mode ?? 'full';
  const results = doc.results ?? [];
  const facts = safetyFacts(doc);
  const L = [];
  L.push(`## mcp-writecheck: ${mode === 'catalog' ? 'catalog only' : md(doc.target?.confirm ?? 'results')}`);
  L.push('');
  L.push(md(doc.scope ?? ''));
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Tester | ${md(o.cliVersion || `${doc.suite?.name} ${doc.suite?.version} (MWS ${doc.spec?.version})`)} |`);
  L.push(`| Run | ${code(doc.run?.id)}, ${md(doc.run?.started)} to ${md(doc.run?.ended)}, ${md(doc.run?.status)}${doc.run?.stopped_reason ? `: ${md(doc.run.stopped_reason)}` : ''} |`);
  if (mode !== 'catalog') L.push(`| Plan hash | ${code(doc.plan?.hash)} |`);
  if (doc.manifest?.sha256) L.push(`| Manifest | sha256 ${code(doc.manifest.sha256)} |`);
  if (doc.target?.catalog_fingerprint) L.push(`| Catalog | ${code(doc.target.catalog_fingerprint)} |`);
  L.push(`| Mode, fail-on | ${mode}, ${md(o.failOn)} |`);
  L.push(`| CLI exit status | ${o.cliExit} (${md(CLI.exit[o.cliExit] ?? 'not documented')}) |`);
  L.push('');
  L.push(...statusLines(o.decision, o.failOn));
  if (mode === 'catalog') {
    L.push('');
    L.push(`Catalog-only mode: only \`tools/list\` was read and no tool was called. Only what needs nothing else is judged (${CLI.catalogRequirements.map((id) => link(id, specUrl)).join(', ')}, per tool); every other requirement is \`not tested\`.`);
  }

  // Things a person must not miss, whatever the verdicts are.
  L.push(...safetySections(doc, facts));

  // Violated records, in full.
  const violated = results.filter((r) => r.verdict === 'violated');
  if (violated.length) {
    L.push('');
    L.push('### Violated records');
    L.push('');
    for (const r of violated) {
      L.push(`- ${link(r.requirement, specUrl)} on ${code(writePath(r))}, scenario ${code(`${r.scenario?.id} v${r.scenario?.version}`)}: **violated (${levelText(r)})**${r.attribution ? `, ${attributionText(r)}` : ''}. ${md(r.reason)}${r.notes?.length ? ` _${md(r.notes.join(' '))}_` : ''}`);
    }
  }

  // One row per requirement of the spec, then any ID the registry does not have.
  L.push('');
  L.push('### Per requirement');
  L.push('');
  L.push(`Each requirement ID links to its text in MWS ${SPEC.version}. Levels are those of the spec at commit ${code(SPEC.commit)}. There is no total and no score. Read the rows.`);
  L.push('');
  L.push('| Requirement | Level | Verdicts, by write path |');
  L.push('|---|---|---|');
  const noRecord = [];
  const levelNotes = [];
  for (const req of SPEC.requirements) {
    const recs = results.filter((r) => r.requirement === req.id);
    const recorded = uniq(recs.map((r) => r.level).filter(Boolean));
    if (recorded.some((l) => l !== req.level)) levelNotes.push(`${link(req.id, specUrl)} is a ${req.level} in MWS ${SPEC.version}; this release of mcp-writecheck records it as ${recorded.join(' and ')}. For \`fail-on: must\` this action counts it as a MUST.`);
    if (!recs.length) noRecord.push(req.id);
    L.push(`| ${link(req.id, specUrl)} | ${req.level} | ${recs.length ? verdictCell(recs) : 'no record in this run'} |`);
  }
  const unknownIds = uniq(results.map((r) => r.requirement)).filter((id) => !REGISTRY.has(id));
  for (const id of unknownIds) {
    const recs = results.filter((r) => r.requirement === id);
    L.push(`| ${link(id, specUrl)} | ${md(uniq(recs.map((r) => r.level)).join(', '))} (as recorded) | ${verdictCell(recs)} |`);
  }

  const notes = [...levelNotes];
  if (levelNotes.length) notes.push('Where the levels differ, this release of mcp-writecheck was written against an earlier draft of the requirement. Each record\'s reason says what was tested; read it against the linked text.');
  if (noRecord.length) notes.push(`No record in this run for ${noRecord.map((id) => link(id, specUrl)).join(', ')}. ${doc.run?.status === 'complete' ? 'This release of mcp-writecheck wrote none for them; they are not tested.' : 'The run did not finish.'}`);
  if (unknownIds.length) notes.push(`${unknownIds.map(code).join(', ')}: recorded by mcp-writecheck but not in the requirement registry this action carries (MWS ${SPEC.version}, spec commit ${code(SPEC.commit)}).`);
  for (const n of doc.not_built ?? []) notes.push(`${link(n.requirement, specUrl)}: ${md(n.verdict)}. ${md(n.reason)}`);
  if (notes.length) {
    L.push('');
    for (const n of notes) L.push(`- ${n}`);
  }

  // Every record.
  const detail = [];
  detail.push('');
  detail.push('<details>');
  detail.push('<summary>Every record, with its reason</summary>');
  detail.push('');
  detail.push('| Requirement | Level | Write path | Scenario | Verdict | Numbers | Why |');
  detail.push('|---|---|---|---|---|---|---|');
  const order = [...SPEC.requirements.map((r) => r.id), ...unknownIds];
  for (const id of order) {
    for (const r of results.filter((x) => x.requirement === id)) {
      detail.push(`| ${link(r.requirement, specUrl)} | ${md(levelText(r))} | ${code(writePath(r))} | ${code(`${r.scenario?.id} v${r.scenario?.version}`)} | ${r.verdict === 'self-attested' ? attested(r) : md(r.verdict)}${r.attribution ? ` (${attributionText(r)})` : ''} | ${md(numbersText(r))} | ${md(r.reason)}${r.notes?.length ? ` _${md(r.notes.join(' '))}_` : ''} |`);
    }
  }
  detail.push('');
  detail.push('</details>');

  if (facts.inventories.length) {
    detail.push('');
    detail.push('<details>');
    detail.push('<summary>What the bystander inventory covered</summary>');
    detail.push('');
    detail.push('Objects outside the tester\'s own that the server\'s lists do not show (another scope, a further page, a filtered list) are not covered: "not seen to be lost" is the most a record says.');
    detail.push('');
    for (const r of facts.inventories) {
      const b = r.numbers[RESULTS_FIELDS.bystanderInventory];
      const scopes = Array.isArray(b.scopes) ? b.scopes : [];
      const lists = Array.isArray(b.lists) ? b.lists : [];
      const partial = Array.isArray(b.partial) ? b.partial : [];
      detail.push(`- ${code(r.requirement)} on ${code(writePath(r))} (${md(r.verdict)}): ${b.unavailable ? `no inventory (${md(b.unavailable)})` : `scopes ${scopes.map((x) => code(String(x))).join(', ') || 'none'}; objects listed: ${md(String(b.objects ?? 0))}; through ${lists.map(code).join(', ') || 'no list'}${b.read_back_by_id ? '; each read back by id' : ''}${partial.length ? `; partial: ${partial.map(md).join('; ')}` : ''}`}`);
    }
    detail.push('');
    detail.push('</details>');
  }

  const tail = [];
  tail.push('');
  tail.push(`Verdicts: ${VERDICT_MEANING.map(([v, m]) => `\`${v}\` (${m})`).join('; ')}.`);
  tail.push('');
  tail.push(`The results folder is uploaded as the artifact ${code(o.artifactName)}: \`${CLI.reportFile}\`, \`${CLI.resultsFile}\`, \`junit.xml\`${mode === 'catalog' ? ', `catalog.json`' : ', the captured calls, the `state` folder'} and \`SHA256SUMS\`.${mode === 'catalog' ? '' : ' A `violated` record from simultaneous or stale calls was produced deliberately and says nothing about how often the behavior occurs in normal use.'}`);

  // The job summary has a size limit; the full table is the first thing to go.
  const head = L.join('\n');
  const full = [head, detail.join('\n'), tail.join('\n')].join('\n');
  const max = o.maxBytes ?? 900_000;
  if (Buffer.byteLength(full) <= max) return full + '\n';
  return [head, '', `The table of every record is left out because it is too large for a job summary. It is in \`${CLI.reportFile}\` in the artifact.`, tail.join('\n')].join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// The summary of a plan, and of a run with no results
// ---------------------------------------------------------------------------------------------

/**
 * @param {{ manifest: string, catalog: string|null, cliExit: number, planHash: string|null, planText: string, cliVersion: string, decision: object }} o
 */
export function renderPlan(o) {
  const L = [];
  L.push('## mcp-writecheck: plan');
  L.push('');
  L.push(`Plan mode. ${o.catalog ? `The plan was built from the manifest and the saved catalog ${code(o.catalog)}; no server was started and no call was made.` : 'The plan was built from the manifest and one `tools/list` request; no tool was called.'} Nothing was written.`);
  L.push('');
  L.push('A plan has no verdicts. It lists every call a full run would make, what would not be tested and why, and the plan hash that a full run must be given.');
  L.push('');
  L.push('| | |');
  L.push('|---|---|');
  L.push(`| Tester | ${md(o.cliVersion)} |`);
  L.push(`| Manifest | ${code(o.manifest)} |`);
  L.push(`| Plan hash | ${o.planHash ? code(o.planHash) : 'not printed'} |`);
  L.push(`| CLI exit status | ${o.cliExit} (${md(CLI.exit[o.cliExit] ?? 'not documented')}) |`);
  L.push('');
  if (o.decision.fail) L.push(`**Job status: failed.** ${o.decision.reasons.join(' ')}`);
  else L.push('**Job status: not failed.** The plan was built. This says nothing about the server\'s behavior: no write path was exercised.');
  if (o.planHash) {
    L.push('');
    L.push('The hash covers the manifest, the catalog, the suite version, the limits and every host named by a URL in the server\'s environment. A full run has the same hash only if all of these are the same there.');
  }
  if (o.planText.trim()) {
    L.push('');
    L.push('<details>');
    L.push('<summary>The plan</summary>');
    L.push('');
    L.push(fence(o.planText));
    L.push('');
    L.push('</details>');
  }
  return L.join('\n') + '\n';
}

/**
 * A full run that left no results: a refusal, a usage error or a crash.
 * @param {{ cliExit: number|null, decision: object, lastLines: string, planHashGiven: string, planHashSeen: string|null, cliVersion: string }} o
 */
export function renderNoResults(o) {
  const L = [];
  L.push('## mcp-writecheck: no results');
  L.push('');
  L.push(`**Job status: failed.** ${o.decision.reasons.join(' ')}`);
  if (o.planHashSeen && o.planHashGiven && o.planHashSeen !== o.planHashGiven) {
    L.push('');
    L.push(`The \`plan-hash\` input is ${code(o.planHashGiven)}; today's plan has the hash ${code(o.planHashSeen)}. The manifest, the catalog, the limits, the suite or the hosts changed since the hash was written into the workflow. Read the plan (run this action with \`mode: plan\`, or \`mcp-writecheck plan\`), and only then update the input. The action does not do this for you: the hash is the confirmation that a person has seen what the run will write.`);
  }
  if (o.lastLines.trim()) {
    L.push('');
    L.push('The last lines mcp-writecheck printed:');
    L.push('');
    L.push(fence(o.lastLines));
  }
  return L.join('\n') + '\n';
}

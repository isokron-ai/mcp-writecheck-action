// How full mode labels what the CLI found (tool-qa PR #119, "What the worker must do with them"; owner decision 27 Nov,
// item 3). Every requirement record of a full-mode run carries `mode: full` and `basis` (the harness the verdict rests on:
// `stand-in-product` for a stand-in of fidelity real or faithful, `stand-in-partial` otherwise). Two kinds of record are
// relabelled `not tested`, each with a `reason_code`:
//   backend_semantics_not_exercised  UPD-1/2, CONC-1/2/3, TGT-1/3, RES-1 and ATOM-2 need the backend's own semantics;
//                                    they keep the CLI's verdict only when the stand-in's fidelity is real or faithful
//   declaration_missing              the CLI's own coverage record (scenario `coverage`): the thin declaration gives
//                                    nothing that requirement's test needs
// A record the CLI already left `not tested` because no write tool or resource was declared is labelled
// `declaration_missing` too. Values are checked one by one, as in loop/summary.mjs; no text of the target is copied.
//
// Only Node's standard library.

/** The requirements that need real backend semantics (owner decision 27 Nov, item 3). */
export const BACKEND_SEMANTIC = Object.freeze(['MWS-UPD-1', 'MWS-UPD-2', 'MWS-CONC-1', 'MWS-CONC-2', 'MWS-CONC-3', 'MWS-TGT-1', 'MWS-TGT-3', 'MWS-RES-1', 'MWS-ATOM-2']);
/** Fidelity words under which those may be judged. */
export const SEMANTIC_FIDELITY = Object.freeze(['real', 'faithful']);
export const BASIS = Object.freeze({ real: 'stand-in-product', faithful: 'stand-in-product', partial: 'stand-in-partial', not_faithful: 'stand-in-partial' });

const REQUIREMENT_RE = /^MWS-[A-Z]{2,6}-[0-9]{1,2}$/;
const VERDICTS = ['held', 'violated', 'not tested', 'not applicable', 'not observed', 'self-attested'];
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const PLACEHOLDER = /^\((?:catalog|server|no tool called|declaration|none)\)$/;
const SCENARIO_RE = /^[a-z][a-z0-9-]{0,39}$/;
const MAX_RECORDS = 2000;
const name = (v) => (typeof v === 'string' && (NAME_RE.test(v) || PLACEHOLDER.test(v)) ? v : null);

/** The records of a full-mode results.json, labelled. Returns { records, relabelled: { code: n }, dropped }. */
export function labelRecords(doc, { fidelity }) {
  const out = { records: [], relabelled: {}, dropped: 0, truncated: false };
  const basis = BASIS[fidelity] ?? 'stand-in-partial';
  const semantic = SEMANTIC_FIDELITY.includes(fidelity);
  const count = (c) => { out.relabelled[c] = (out.relabelled[c] ?? 0) + 1; };
  for (const r of Array.isArray(doc?.results) ? doc.results : []) {
    if (out.records.length >= MAX_RECORDS) { out.truncated = true; break; }
    const requirement = typeof r?.requirement === 'string' && REQUIREMENT_RE.test(r.requirement) ? r.requirement : null;
    const verdict0 = VERDICTS.includes(r?.verdict) ? r.verdict : null;
    if (!requirement || !verdict0) { out.dropped++; continue; }
    const scenario = typeof r?.scenario?.id === 'string' && SCENARIO_RE.test(r.scenario.id) ? r.scenario.id : null;
    const rec = { requirement, verdict: verdict0, resource: name(r?.write_path?.resource), tool: name(r?.write_path?.tool), mode: 'full', basis, backend_environment: 'stand-in' };
    if (BACKEND_SEMANTIC.includes(requirement) && !semantic) {
      rec.verdict = 'not tested';
      rec.reason_code = 'backend_semantics_not_exercised';
      count(rec.reason_code);
    } else if (verdict0 === 'not tested' && (scenario === 'coverage' || rec.resource === '(declaration)')) {
      rec.reason_code = 'declaration_missing';
      count(rec.reason_code);
    }
    out.records.push(rec);
  }
  return out;
}

/** Counts of records by requirement, verdict and reason code: [{ requirement, verdict, reason_code, n }], sorted. */
export function labelledCounts(records) {
  const m = new Map();
  for (const r of records) { const k = `${r.requirement}\u0000${r.verdict}\u0000${r.reason_code ?? ''}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return [...m.entries()].map(([k, n]) => { const [requirement, verdict, rc] = k.split('\u0000'); return { requirement, verdict, ...(rc ? { reason_code: rc } : {}), n }; })
    .sort((a, b) => (a.requirement < b.requirement ? -1 : a.requirement > b.requirement ? 1 : a.verdict < b.verdict ? -1 : 1));
}

/**
 * The field records of a full-mode unit, from loop/summary.mjs observations(): the full stage's requirement_verdicts
 * replaced by the labelled records, observation_coverage saying the backend was the stand-in, and the stand-in's version
 * and the rule-accepted plan added.
 */
export function fullObservations(recs, { labelled, standIn, backendKind, plan }) {
  const out = [];
  for (const r of recs) {
    if (r.field === 'observation_coverage' && r.value && typeof r.value === 'object') {
      out.push({ ...r, value: { ...r.value, backend_environment: labelled ? 'stand-in' : r.value.backend_environment, backend_kind: labelled ? backendKind : r.value.backend_kind, mode: 'full' } });
      continue;
    }
    if (r.stage === 'full' && labelled && ['requirement_verdicts', 'annotation_honesty_behaviour_confirmed', 'idempotency_evidence_behaviour', 'conflict_behaviour', 'backend_version'].includes(r.field)) continue;
    out.push(r);
  }
  if (labelled) {
    out.push({ field: 'backend_version', value: standIn.version, stage: 'full' });
    out.push({ field: 'requirement_verdicts', value: labelled.records, stage: 'full' });
    const pick = (p) => ({ backend_environment: 'stand-in', records: labelled.records.filter((x) => x.requirement.startsWith(p)).map(({ requirement, verdict, tool, resource, basis, reason_code }) => ({ requirement, verdict, tool, resource, basis, ...(reason_code ? { reason_code } : {}) })), counts: labelledCounts(labelled.records.filter((x) => x.requirement.startsWith(p))) });
    out.push({ field: 'annotation_honesty_behaviour_confirmed', value: pick('MWS-ANN-'), stage: 'full' });
    out.push({ field: 'idempotency_evidence_behaviour', value: pick('MWS-RETRY-'), stage: 'full' });
    out.push({ field: 'conflict_behaviour', value: pick('MWS-CONC-'), stage: 'full' });
  }
  if (plan?.plan_hash) out.push({ field: 'plan_hash_and_drift', value: { plan_hash: plan.plan_hash, accepted: plan.accepted ? plan.plan_hash : null, accepted_by: plan.accepted_by, drift: false, full_run: plan.ran === true }, stage: 'full' });
  return out;
}

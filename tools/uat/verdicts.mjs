// Verdicts on what a UAT run found. Every finding ends up with one, so the share of findings that were real defects
// (the harness’s precision) can be counted across runs (tools/uat-stats.mjs). Before this, most findings stayed “not
// reviewed”, and no one could say how many were real.
//
// A verdict records who set it and when. The verifier (a model, after the run) sets one on what has none; a person
// or a reviewing session can set or override any (tools/uat-verdict.mjs), and theirs wins over the verifier’s, so a
// recheck never puts the verifier’s back.

/** The verdicts, and what each means. */
export const VERDICTS = {
  confirmed: 'a defect in Postbox',
  duplicate: 'an open issue already covers it (give its number)',
  harness: 'caused by the UAT harness, not by Postbox',
  agent: 'a flaw in the agent’s own reasoning or work, not in Postbox',
  'by-design': 'Postbox does it on purpose',
  'not-reproduced': 'the evidence doesn’t support it',
  measurement: 'not a defect: a count or a coverage record the run keeps',
};

/** Who can set a verdict. A person’s or a reviewer’s outranks the verifier’s; checks and the runner set their own. */
export const SETTERS = { person: 2, reviewer: 2, verifier: 1, check: 1, runner: 1 };

/** Older runs’ names for the same verdicts. */
const OLD = { 'agent-work': 'agent', 'not reproduced': 'not-reproduced', 'not-reviewed': null, 'by design': 'by-design' };

/**
 * A verdict in this set, from what a run or a person wrote; null for none or one that isn’t a verdict.
 * @param {unknown} v
 * @returns {string|null}
 */
export function normalVerdict(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  if (Object.hasOwn(VERDICTS, s)) return s;
  // “measurement: …” and other notes after the word.
  const head = s.split(/[:\s(]/)[0];
  if (Object.hasOwn(VERDICTS, head)) return head;
  return Object.hasOwn(OLD, s) ? OLD[s] : null;
}

/** A finding’s stable key in its run: its check and key, or the tester’s title, as the runner keys them. @param {any} f */
export const findingKey = (f) =>
  f.source === 'tester'
    ? `tester:${String(f.title ?? '')
        .toLowerCase()
        .replace(/\W+/g, '-')
        .slice(0, 60)}`
    : `${f.check ?? f.source ?? 'run'}:${f.key ?? f.step ?? ''}`;

/**
 * The finding a reference names: its index in findings.json, or its key (exactly, or a unique prefix).
 * @param {any[]} findings  @param {string} ref
 * @returns {{ index: number, finding: any }}
 */
export function findFinding(findings, ref) {
  const r = String(ref ?? '').trim();
  if (/^\d+$/.test(r)) {
    const i = Number(r);
    if (!findings[i]) throw new Error(`There’s no finding ${i}: this run has ${findings.length} (0 to ${findings.length - 1}).`);
    return { index: i, finding: findings[i] };
  }
  const exact = findings.findIndex((f) => findingKey(f) === r);
  if (exact >= 0) return { index: exact, finding: findings[exact] };
  const some = findings.map((f, i) => [i, findingKey(f)]).filter(([, k]) => String(k).startsWith(r));
  if (some.length === 1) return { index: Number(some[0][0]), finding: findings[Number(some[0][0])] };
  if (some.length > 1)
    throw new Error(
      `“${r}” matches ${some.length} findings: ${some
        .slice(0, 5)
        .map(([i, k]) => `${i} (${k})`)
        .join(', ')}. Give its index or more of its key.`,
    );
  throw new Error(`No finding has the key “${r}”. List them with: node tools/uat-verdict.mjs <run> --list`);
}

/**
 * Records a verdict on a finding, unless one from a higher-ranked setter is already there (a person’s or a reviewer’s
 * beats the verifier’s). Each verdict is kept in the finding’s `verdicts`, so a refit can compare the verifier’s with a
 * reviewer’s. Changes the finding in place, and says whether it took.
 * @param {any} f  @param {{ verdict: string, by: string, note?: string|null, issue?: number|null, at?: string }} v
 * @returns {boolean}
 */
export function setVerdict(f, { verdict, by, note = null, issue = null, at = new Date().toISOString() }) {
  const v = normalVerdict(verdict);
  if (!v) throw new Error(`“${verdict}” isn’t a verdict. Use one of: ${Object.keys(VERDICTS).join(', ')}.`);
  if (!Object.hasOwn(SETTERS, by)) throw new Error(`A verdict is set by ${Object.keys(SETTERS).join(', ')}, not “${by}”.`);
  const held = f.verdict ? (SETTERS[f.verdictBy] ?? 0) : 0;
  if (held > SETTERS[by]) return false;
  f.verdicts = [...(Array.isArray(f.verdicts) ? f.verdicts : []), { verdict: v, by, at, ...(note ? { note } : {}), ...(issue ? { issue } : {}) }];
  f.verdict = v;
  f.verdictBy = by;
  f.verdictAt = at;
  if (note !== null) f.note = note;
  if (v === 'duplicate') f.duplicateOf = issue ?? f.duplicateOf;
  else delete f.duplicateOf;
  return true;
}

/**
 * The verdict a finding carries for counting: its own, in this set, or one implied by how the run handled it, as
 * presetVerdicts sets it on new runs: a filed finding was confirmed, and a check that matched an open issue caught it
 * again. Null for one no one reviewed (a tester’s match to an issue is a guess until verified), and for a check’s match
 * to a closed issue that wasn’t verified (#213, tools/uat/regressions.mjs).
 * @param {any} f
 * @returns {string|null}
 */
export function verdictOf(f) {
  const v = normalVerdict(f.verdict);
  if (v) return v;
  if (f.filed) return 'confirmed';
  if (f.duplicateOf || (f.source === 'check' && Number.isInteger(f.issue) && !f.closedIssue)) return 'duplicate';
  return null;
}

/**
 * Keeps the verdicts a person or a reviewer recorded on disk (tools/uat-verdict.mjs) over what a process holding the
 * findings in memory has, when the one on disk is theirs and newer: a recheck that verifies for minutes mustn’t write
 * over a verdict set meanwhile. Matched by the finding’s key. Changes `findings` in place.
 * @param {any[]} findings  @param {any[]} onDisk
 */
export function mergePeopleVerdicts(findings, onDisk) {
  const theirs = new Map(
    (Array.isArray(onDisk) ? onDisk : []).filter((f) => f && (SETTERS[f.verdictBy] ?? 0) >= SETTERS.person).map((f) => [findingKey(f), f]),
  );
  for (const f of findings) {
    const d = theirs.get(findingKey(f));
    if (!d || (f.verdictBy === d.verdictBy && f.verdictAt === d.verdictAt)) continue;
    if ((SETTERS[f.verdictBy] ?? 0) >= SETTERS.person && String(f.verdictAt ?? '') >= String(d.verdictAt ?? '')) continue;
    for (const k of ['verdict', 'verdictBy', 'verdictAt', 'verdicts', 'note', 'duplicateOf']) if (d[k] !== undefined) f[k] = d[k];
  }
}

/**
 * Verdicts that need no model: a check that matched an open issue caught that issue again (a duplicate of it), and
 * a measurement or a coverage gap carries its own. A match to a closed issue (closedIssue, from markClosed in
 * tools/uat/regressions.mjs) isn’t preset: it may be a stale check (#213). Leaves a finding with a verdict as it is.
 * @param {any[]} findings
 */
export function presetVerdicts(findings) {
  for (const f of findings) {
    if (f.verdict && !f.verdictBy) f.verdictBy = f.source === 'run' ? 'runner' : f.source === 'check' ? 'check' : 'verifier';
    if (f.verdict) {
      const v = normalVerdict(f.verdict);
      if (v && v !== f.verdict) f.verdict = v;
      continue;
    }
    if (f.source === 'check' && Number.isInteger(f.issue) && !f.closedIssue)
      setVerdict(f, { verdict: 'duplicate', by: 'check', issue: f.issue, note: `A check caught #${f.issue} again.` });
  }
}

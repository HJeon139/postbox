// SkillSpector’s findings on the prompt surface, as prompt-surface-scan.yml judges them: what a pull request adds,
// which of it stops a merge, and the report for the job summary. Moved out of tools/prompt-gate.mjs, which runs it.

const RANK = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
/**
 * The findings in `head` that aren’t in `base`, matched by SkillSpector’s fingerprint, so a finding main already has
 * doesn’t fail every pull request.
 * @param {{ issues?: any[] }} base @param {{ issues?: any[] }} head
 */
export function newFindings(base, head) {
  const known = new Set((base.issues ?? []).map((i) => i.match_fingerprint));
  return (head.issues ?? []).filter((i) => !known.has(i.match_fingerprint));
}
/** Whether a finding should stop a merge: high or critical. */
export const blocks = (i) => RANK.indexOf(String(i.severity).toUpperCase()) >= RANK.indexOf('HIGH');

/** A Markdown table cell: pipes escaped, newlines folded, cut to length. */
const cell = (s, n = 160) =>
  String(s ?? '')
    .slice(0, n)
    .replace(/[\\|]/g, '\\$&')
    .replace(/\s+/g, ' ');

/** The findings report for a job summary. */
export function findingsReport(base, head) {
  const added = newFindings(base, head);
  const score = (r) => r.risk_assessment?.score ?? '—';
  const lines = [
    `SkillSpector, static rules only: risk score ${score(base)} on the base, ${score(head)} with this pull request. It scanned ${head.analysis_completeness?.scanned_components ?? '?'} files.`,
  ];
  if (!added.length) return [...lines, '', 'No new findings.'].join('\n');
  return [
    ...lines,
    '',
    '| Severity | Rule | File | Line | What matched |',
    '|---|---|---|---|---|',
    ...added.map(
      (i) =>
        `| ${cell(i.severity)} | ${cell(`${i.id} ${i.category ?? ''}`)} | ${cell(i.location?.file)} | ${i.location?.start_line ?? ''} | ${cell(i.finding)} |`,
    ),
  ].join('\n');
}

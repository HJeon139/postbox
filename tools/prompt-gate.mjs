// The prompt-surface gate’s two decisions (SECURITY.md, “Prompt changes”):
//
//   node tools/prompt-gate.mjs touched <paths file>          the changed files (one per line, on stdin) that are prompt
//                                                            surface; exit 0 either way
//   node tools/prompt-gate.mjs findings <base.json> <head.json>  SkillSpector’s findings the head adds, as Markdown;
//                                                            exit 1 if any is high or critical
//
// The paths file lists globs, one per line, with # for comments: `*` matches within a folder, `**/` any folders.
// The gate workflow runs this from main’s checkout, never the pull request’s, so a pull request can’t change its own
// verdict.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The globs in a paths file. @param {string} text */
export const globsOf = (text) =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);

/** A glob as an anchored regular expression: two stars and a slash are any folders, two stars anything, one star anything within a folder. */
export function globRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The files among `changed` that some glob matches. @param {string[]} changed @param {string[]} globs */
export function touched(changed, globs) {
  const res = globs.map(globRegExp);
  return changed.filter((f) => res.some((re) => re.test(f)));
}

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'touched' && a) {
    const changed = readFileSync(0, 'utf8').split('\n').filter(Boolean);
    for (const f of touched(changed, globsOf(readFileSync(a, 'utf8')))) console.log(f);
  } else if (cmd === 'findings' && a && b) {
    const [base, head] = [a, b].map((f) => JSON.parse(readFileSync(f, 'utf8')));
    console.log(findingsReport(base, head));
    process.exitCode = newFindings(base, head).some(blocks) ? 1 : 0;
  } else {
    console.error('Usage: node tools/prompt-gate.mjs touched <paths file> < changed | findings <base.json> <head.json>');
    process.exitCode = 2;
  }
}

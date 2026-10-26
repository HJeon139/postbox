// SkillSpector’s findings on the prompt surface, as prompt-surface-scan.yml judges them: what a pull request adds,
// which of it fails the scan, and the report for the job summary.
//
//   node tools/prompt-findings.mjs findings <base.json> <head.json> [accepted.json]  the findings the head adds, as
//                                                    Markdown; exit 1 if one is high or critical and not accepted, or
//                                                    an accepted one no longer matches
//   node tools/prompt-findings.mjs annotations <base.json> <head.json> [accepted.json]  the same, as run-page annotations
//
// A high or critical finding the pull request adds fails the scan, unless .github/prompt-surface-accepted.json accepts it:
// an entry names one match by SkillSpector’s fingerprint, which stays the same when the line moves and changes when
// the matched text does, and says why it isn’t a threat. Adding to the list is a change a reviewer reads like any
// other. Whole rules are never turned off: the rule that flags a mention of ~/.npmrc in a test note is the one that
// catches an instruction to read it.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RANK = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
/** Where the accepted findings are listed, in the repository. */
export const ACCEPTED_FILE = '.github/prompt-surface-accepted.json';

/**
 * The findings in `head` that aren’t in `base`, matched by SkillSpector’s fingerprint, so a finding main already has
 * doesn’t fail every pull request.
 * @param {{ issues?: any[] }} base @param {{ issues?: any[] }} head
 */
export function newFindings(base, head) {
  const known = new Set((base.issues ?? []).map((i) => i.match_fingerprint));
  return (head.issues ?? []).filter((i) => !known.has(i.match_fingerprint));
}
/** Whether a finding fails the scan: high or critical. */
export const blocks = (i) => RANK.indexOf(String(i.severity).toUpperCase()) >= RANK.indexOf('HIGH');

/**
 * What’s wrong with an accepted list, if anything: each entry needs a fingerprint, the rule, the file, and a reason.
 * @param {unknown} list
 */
export function acceptedProblems(list) {
  if (!Array.isArray(list)) return [`${ACCEPTED_FILE} must be a JSON array.`];
  const seen = new Set();
  return list.flatMap((e, n) => {
    const at = `Entry ${n + 1}`;
    if (!e || typeof e !== 'object') return [`${at} isn’t an object.`];
    const problems = [];
    if (!/^[0-9a-f]{64}$/.test(e.fingerprint ?? '')) problems.push(`${at} needs SkillSpector’s match_fingerprint, 64 hex digits.`);
    else if (seen.has(e.fingerprint)) problems.push(`${at} repeats a fingerprint.`);
    seen.add(e.fingerprint);
    if (!String(e.rule ?? '').trim()) problems.push(`${at} needs the rule, such as PE3.`);
    if (!String(e.file ?? '').trim()) problems.push(`${at} needs the file, as the scan names it.`);
    if (String(e.reason ?? '').trim().length < 20) problems.push(`${at} needs a reason: a sentence on why it isn’t a threat.`);
    return problems;
  });
}

/**
 * The verdict on a pull request’s findings: what it adds, what of that fails the scan, what the list accepts, and which
 * entries no longer match anything, so the list doesn’t keep excuses for text that’s gone.
 * @param {{ issues?: any[] }} base @param {{ issues?: any[] }} head @param {any[]} [accepted]
 */
export function judge(base, head, accepted = []) {
  const byPrint = new Map(accepted.map((e) => [e.fingerprint, e]));
  const added = newFindings(base, head);
  const present = new Set((head.issues ?? []).map((i) => i.match_fingerprint));
  return {
    added,
    blocking: added.filter((i) => blocks(i) && !byPrint.has(i.match_fingerprint)),
    accepted: added.filter((i) => byPrint.has(i.match_fingerprint)).map((i) => ({ finding: i, entry: byPrint.get(i.match_fingerprint) })),
    stale: accepted.filter((e) => !present.has(e.fingerprint)),
  };
}

/** A Markdown table cell: pipes escaped, newlines folded, cut to length. */
const cell = (s, n = 160) =>
  String(s ?? '')
    .slice(0, n)
    .replace(/[\\|]/g, '\\$&')
    .replace(/\s+/g, ' ');

/** The list entry that would accept a finding, with its reason left for the person to write. */
const entryFor = (i) => JSON.stringify({ fingerprint: i.match_fingerprint, rule: i.id, file: i.location?.file ?? '', reason: 'Say why this isn’t a threat.' });

/** The findings report for a job summary. @param {any} base @param {any} head @param {any[]} [accepted] */
export function findingsReport(base, head, accepted = []) {
  const { added, blocking, accepted: ok, stale } = judge(base, head, accepted);
  const score = (r) => r.risk_assessment?.score ?? '—';
  const lines = [
    `SkillSpector, static rules only: risk score ${score(base)} on the base, ${score(head)} with this pull request. It scanned ${head.analysis_completeness?.scanned_components ?? '?'} files.`,
  ];
  if (added.length) {
    const verdict = (i) => {
      const entry = ok.find((a) => a.finding === i)?.entry;
      if (entry) return `accepted: ${entry.reason}`;
      return blocks(i) ? '**blocks**' : 'advice';
    };
    lines.push(
      '',
      '| Severity | Rule | File | Line | What matched | Verdict |',
      '|---|---|---|---|---|---|',
      ...added.map(
        (i) =>
          `| ${cell(i.severity)} | ${cell(`${i.id} ${i.category ?? ''}`)} | ${cell(i.location?.file)} | ${i.location?.start_line ?? ''} | ${cell(i.finding)} | ${cell(verdict(i))} |`,
      ),
    );
  } else lines.push('', 'No new findings.');
  if (blocking.length)
    lines.push(
      '',
      '### If a finding isn’t a threat',
      '',
      `Reword the text if it can change: a fact about a file doesn’t need the file’s path, for one. If it has to stay, add its line below to \`${ACCEPTED_FILE}\` with a reason a reviewer can check. A reviewer reads the entry in the diff, like any change. If the matched text changes later, the finding gets a new fingerprint and is flagged again.`,
      '',
      '```json',
      ...blocking.map(entryFor),
      '```',
    );
  if (stale.length)
    lines.push(
      '',
      `### Accepted findings that no longer match`,
      '',
      `Remove these from \`${ACCEPTED_FILE}\`:`,
      ...stale.map((e) => `- ${cell(e.rule)} in ${cell(e.file)}: ${cell(e.reason)}`),
    );
  return lines.join('\n');
}

/** Text in a workflow command: a property also ends at a colon or comma. */
const esc = (s, property = false) => {
  const t = String(s ?? '')
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
  return property ? t.replace(/:/g, '%3A').replace(/,/g, '%2C') : t;
};

/**
 * The run page’s annotations: one error for each finding that fails the scan, on the repository file when the
 * scan read one (repo/), and a warning for each stale entry. A viewer who isn’t signed in sees these, not the summary.
 * @param {any} base @param {any} head @param {any[]} [accepted]
 */
export function annotations(base, head, accepted = []) {
  const { blocking, stale } = judge(base, head, accepted);
  return [
    ...blocking.map((i) => {
      const file = String(i.location?.file ?? '');
      const where = file.startsWith('repo/') ? `file=${esc(file.slice(5), true)},line=${Number(i.location?.start_line) || 1},` : '';
      const title = esc(`SkillSpector ${i.id} (${i.severity})`, true);
      return `::error ${where}title=${title}::${esc(`${i.category ?? ''} in ${file}: ${i.finding}. ${i.explanation ?? ''} To accept it, see the job summary.`)}`;
    }),
    ...stale.map((e) => `::warning title=Stale accepted finding::${esc(`${e.rule} in ${e.file} no longer matches. Remove it from ${ACCEPTED_FILE}.`)}`),
  ];
}

// The real path: run through a symlink, a plain comparison would skip the command line and pass with no output.
if (process.argv[1] && existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const [cmd, a, b, accepted] = process.argv.slice(2);
  if ((cmd === 'findings' || cmd === 'annotations') && a && b) {
    const [base, head] = [a, b].map((f) => JSON.parse(readFileSync(f, 'utf8')));
    const list = accepted && existsSync(accepted) ? JSON.parse(readFileSync(accepted, 'utf8')) : [];
    const problems = acceptedProblems(list);
    if (problems.length) {
      console.log(
        cmd === 'annotations'
          ? problems.map((p) => `::error title=Accepted findings::${p}`).join('\n')
          : ['The accepted findings list has problems:', ...problems.map((p) => `- ${p}`)].join('\n'),
      );
      process.exitCode = 1;
    } else if (cmd === 'annotations') console.log(annotations(base, head, list).join('\n'));
    else {
      console.log(findingsReport(base, head, list));
      const { blocking, stale } = judge(base, head, list);
      process.exitCode = blocking.length || stale.length ? 1 : 0;
    }
  } else {
    console.error('Usage: node tools/prompt-findings.mjs findings|annotations <base.json> <head.json> [accepted.json]');
    process.exitCode = 2;
  }
}

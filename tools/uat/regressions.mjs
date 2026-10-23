// A closed issue that a check matches again (#213). A check written before its issue’s fix can keep firing after it,
// so a match to a closed issue isn’t a duplicate on sight: it’s a possible regression, and a stale check looks the
// same. Whether the run had the fix needs no model: the fix is the commit that closed the issue (or its closing pull
// request), and git says whether the run’s commit has it. Only then does a verifier judge whether the evidence shows
// the defect. A confirmed one is commented on the issue, for the triage session or the person to reopen; the runner
// never reopens an issue.

import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { askOnce } from './tester.mjs';
import { normalVerdict, presetVerdicts, setVerdict, unmatchClosed, verdictOf } from './verdicts.mjs';

/** @typedef {(args: string[]) => { status: number|null, stdout: string, stderr?: string }} Cli */

/** @param {string} bin @param {string} root @returns {Cli} */
const cli = (bin, root) => (args) => spawnSync(bin, args, { cwd: root, encoding: 'utf8' });
const short = (sha) => String(sha ?? '').slice(0, 7);
const json = (r) => {
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
};

/**
 * Each closed issue among these numbers, with its fix: the commit its last “closed” event names, else every closing
 * pull request’s merge and head commits (the run has the fix if it has any of them). An open issue is left out. One gh can’t read is kept as unread: it may be
 * closed, so it mustn’t be preset as a duplicate.
 * @param {number[]} numbers  @param {Cli} gh
 * @returns {Map<number, { fix: string[], by: string|null, unread?: true }>}
 */
export function closedIssues(numbers, gh) {
  const out = new Map();
  for (const n of new Set(numbers)) {
    const issue = json(gh(['issue', 'view', String(n), '--json', 'state,closedByPullRequestsReferences']));
    if (!issue) out.set(n, { fix: [], by: null, unread: true });
    if (issue?.state !== 'CLOSED') continue;
    const events = gh(['api', '--paginate', `repos/{owner}/{repo}/issues/${n}/events`, '--jq', '.[] | select(.event == "closed") | (.commit_id // "-")']);
    const commit = events.status === 0 ? events.stdout.trim().split('\n').at(-1) : null;
    if (commit && /^[0-9a-f]{40}$/.test(commit)) {
      out.set(n, { fix: [commit], by: `commit ${short(commit)}` });
      continue;
    }
    const prs = (issue.closedByPullRequestsReferences ?? []).map((p) => p.number).filter(Number.isInteger);
    const fix = prs
      .flatMap((pr) => {
        const merged = json(gh(['pr', 'view', String(pr), '--json', 'mergeCommit,headRefOid']));
        return [merged?.mergeCommit?.oid, merged?.headRefOid];
      })
      .filter((s) => typeof s === 'string' && s);
    out.set(n, { fix, by: fix.length ? `pull request${prs.length > 1 ? 's' : ''} #${prs.join(', #')}` : null });
  }
  return out;
}

/**
 * Whether a run’s commit has a fix: true if it descends from any of the fix’s commits, false if from none, null when
 * git can’t tell (a commit this clone doesn’t have).
 * @param {string[]} fix  @param {string} commit  @param {Cli} git
 */
export function hasFix(fix, commit, git) {
  let unknown = !fix.length;
  for (const sha of fix) {
    const r = git(['merge-base', '--is-ancestor', sha, commit]);
    if (r.status === 0) return true;
    if (r.status !== 1) unknown = true;
  }
  return unknown ? null : false;
}

/**
 * Marks every check finding that matches a closed issue with what the run’s commit says about it (closedIssue), so
 * the preset passes it by. Before the fix, it’s the defect as it was: a duplicate, by the runner, from git. With the
 * fix, it waits for verifyRegressions. With no commit or no fix to compare, or an issue gh couldn’t read, it isn’t
 * verified, and its note says why. A verdict it already has stays; one that isn’t a duplicate (the verifier found the
 * check wrong) takes the issue off the finding, so the report doesn’t list it as caught again.
 * @param {any[]} findings  @param {{ closed: Map<number, { fix: string[], by: string|null, unread?: true }>, commit: string|null, git: Cli }} o
 */
export function markClosed(findings, { closed, commit, git }) {
  for (const f of findings) {
    const c = f.source === 'check' && Number.isInteger(f.issue) ? closed.get(f.issue) : undefined;
    if (!c) continue;
    const n = f.issue;
    const has = commit && c.fix.length ? hasFix(c.fix, commit, git) : null;
    f.closedIssue = { issue: n, fix: c.fix[0] ?? null, by: c.by, commit, hasFix: has, ...(c.unread ? { unread: true } : {}) };
    if (f.verdict) {
      if (normalVerdict(f.verdict) !== 'duplicate') unmatchClosed(f);
      continue;
    }
    if (c.unread) f.note = `gh couldn’t read #${n}, so whether it’s closed can’t be told, and it isn’t preset. Not verified.`;
    else if (has === false)
      setVerdict(f, {
        verdict: 'duplicate',
        by: 'runner',
        issue: n,
        note: `The run’s commit ${short(commit)} predates #${n}’s fix (${c.by}): the defect as it was.`,
      });
    else
      f.note = !commit
        ? `#${n} is closed, and this run recorded no commit, so whether it had the fix can’t be told. Not verified.`
        : has === null
          ? `#${n} is closed, and ${c.by ? `whether ${short(commit)} has its fix (${c.by}) can’t be told in this clone` : 'it names no fix to compare'}. Not verified.`
          : `#${n} is closed, and the run’s commit ${short(commit)} has its fix (${c.by}): a possible regression, for the verifier.`;
  }
}

/**
 * The verdicts that need no model, in a checkout: a match to a closed issue is marked first (markClosed), and the
 * rest are preset (presetVerdicts).
 * @param {any[]} findings  @param {{ root: string, commit: string|null, gh?: Cli, git?: Cli }} o
 */
export function presetFindings(findings, { root, commit, gh = cli('gh', root), git = cli('git', root) }) {
  const numbers = findings.filter((f) => f.source === 'check' && Number.isInteger(f.issue)).map((f) => f.issue);
  markClosed(findings, { closed: numbers.length ? closedIssues(numbers, gh) : new Map(), commit, git });
  presetVerdicts(findings);
}

export const REGRESSION_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer' },
          shown: { type: 'boolean', description: 'Whether the evidence shows the defect the issue describes.' },
          note: { type: 'string', description: 'Why, in one or two sentences, from the evidence.' },
        },
        required: ['index', 'shown', 'note'],
      },
    },
  },
  required: ['results'],
};

/** @param {{ findings: any[], issues: Map<number, { title?: string, body?: string }> }} o */
export function regressionPrompt({ findings, issues }) {
  return `A deterministic check in Postbox’s end-to-end test matched each finding below to a closed issue, in a run whose commit has that issue’s fix. Either the defect came back, or the check is wrong: written before the fix, it can misread what the fixed code does.

For each, judge only whether the evidence shows the defect the issue describes. Read the run’s files in this folder (findings.json, events.jsonl, data/, streams/, shots/) when the evidence isn’t enough. Be skeptical: “shown” reopens a closed issue.

${findings
  .map((f, i) => {
    const n = f.closedIssue.issue;
    const issue = issues.get(n);
    return `[${i}] #${n} ${issue?.title ?? ''}\nIts fix: ${f.closedIssue.by}.\nThe issue: ${String(issue?.body ?? '').slice(0, 1500)}\nThe check, ${f.check}: ${f.title}\nEvidence: ${f.evidence}`;
  })
  .join('\n\n')}`;
}

/**
 * Asks a verifier whether each finding on a closed issue that the run had the fix for shows the defect. Shown: a
 * duplicate of that issue, marked as a regression, for commentRegressions. Not shown: harness, naming the check, so
 * the check gets fixed. A finding whose issue gh can’t read isn’t verified: the verifier would judge it blind.
 * @param {{ root: string, testerModel: string, dir: string, findings: any[], log: (l: string) => void, file: boolean, ask?: typeof askOnce, gh?: Cli }} o
 */
export async function verifyRegressions({ root, testerModel, dir, findings, log, file, ask = askOnce, gh = cli('gh', root) }) {
  const waiting = findings.filter((f) => f.closedIssue?.hasFix === true && !f.verdict);
  const issues = new Map();
  for (const n of new Set(waiting.map((f) => f.closedIssue.issue))) {
    const issue = json(gh(['issue', 'view', String(n), '--json', 'title,body']));
    if (issue) issues.set(n, issue);
    else log(`Couldn’t read #${n}, so its findings weren’t verified.`);
  }
  const pending = waiting.filter((f) => issues.has(f.closedIssue.issue));
  if (!pending.length) return;
  log(`Verifying ${pending.length} findings on closed issues, whose fixes the run had…`);
  let results;
  try {
    const { value } = await ask({ cwd: dir, model: testerModel, prompt: regressionPrompt({ findings: pending, issues }), schema: REGRESSION_SCHEMA });
    results = value.results;
    if (!Array.isArray(results)) throw new Error('the answer had no results');
  } catch (e) {
    return log(`Verifying the findings on closed issues failed: ${e.message}`);
  }
  for (const r of results) {
    const f = pending[r.index];
    if (!f) continue;
    const n = f.closedIssue.issue;
    if (!r.shown) {
      setVerdict(f, { verdict: 'harness', by: 'verifier', note: `The ${f.check} check matched closed #${n}, and the evidence doesn’t show it: ${r.note}` });
      continue;
    }
    if (!setVerdict(f, { verdict: 'duplicate', by: 'verifier', issue: n, note: `#${n} came back after its fix (${f.closedIssue.by}): ${r.note}` })) continue;
    f.regression = true;
    f.regressionNote = r.note;
    if (!file) log(`#${n} came back after its fix. With --file no, the issue wasn’t commented on: a recheck of this run that files will.`);
  }
}

/**
 * Comments on each issue with a confirmed regression in this run, once per issue per run, listing the run’s findings
 * on it: one confirmed by a pass that didn’t file (--file no) is commented on by a recheck of the run that does. Only
 * while the finding is still a duplicate of that issue: a person or a reviewer who judged it otherwise clears it
 * (setVerdict). A hidden mark names the run, so a comment the run already left isn’t posted again. The runner never
 * reopens the issue.
 * @param {{ root: string, dir: string, findings: any[], log: (l: string) => void, gh?: Cli }} o
 */
export function commentRegressions({ root, dir, findings, log, gh = cli('gh', root) }) {
  const run = basename(dir);
  const mark = `<!-- uat-regression:${run} -->`;
  /** @type {Map<number, any[]>} */
  const byIssue = new Map();
  for (const f of findings) {
    const n = f.closedIssue?.issue;
    if (f.regression && verdictOf(f) === 'duplicate' && f.duplicateOf === n) byIssue.set(n, [...(byIssue.get(n) ?? []), f]);
  }
  for (const [n, list] of byIssue) {
    if (list.every((f) => f.regressionComment)) continue;
    const seen = json(gh(['issue', 'view', String(n), '--json', 'comments']));
    if (!seen) {
      log(`Couldn’t read #${n}’s comments, so it wasn’t commented on.`);
      continue;
    }
    let url = (seen.comments ?? []).find((c) => String(c.body ?? '').includes(mark))?.url;
    if (!url) {
      const c = gh(['issue', 'comment', String(n), '--body', regressionComment(list, run, mark)]);
      if (c.status !== 0) {
        log(`Couldn’t comment on #${n}: ${String(c.stderr ?? '').trim()}`);
        continue;
      }
      url = c.stdout.trim();
    }
    for (const f of list) f.regressionComment = url;
  }
}

/** The comment a run’s confirmed regressions leave on their issue. @param {any[]} list  @param {string} run  @param {string} mark */
const regressionComment = (list, run, mark) =>
  [
    `A UAT run caught this again after its fix, and the verifier confirmed it from the run’s evidence.`,
    '',
    `**Run:** \`${run}\`, at ${list[0].closedIssue.commit}, which has the fix (${list[0].closedIssue.by}).`,
    '',
    ...list.map((f) => `- \`${f.check}\`, finding \`${f.key}\`: ${f.evidence} **Verifier:** ${f.regressionNote ?? f.note}`),
    '',
    'The runner doesn’t reopen issues: the triage session or the person decides.',
    '',
    mark,
  ].join('\n');

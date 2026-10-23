// After a run, or a recheck: verifying the findings that have no verdict, and filing the confirmed ones
// (tools/uat-run.mjs calls it).

import { spawnSync } from 'node:child_process';
import { commentRegressions, verifyRegressions } from './regressions.mjs';
import { askOnce, VERIFY_SCHEMA, verifyPrompt } from './tester.mjs';
import { setVerdict } from './verdicts.mjs';

// ── Filing ─────────────────────────────────────────────────────────────────────────────────
// New findings (no open issue matched) are verified in a fresh session, then the confirmed ones are filed
// with the bug template. A hidden fingerprint in each issue keeps a later run from filing the same one.

const PRIORITY = { critical: 'P0', high: 'P1', medium: 'P2', low: 'P3' };
const fingerprint = (f) =>
  `uat:${f.check ?? 'tester'}:${String(f.check ? f.key : f.title)
    .toLowerCase()
    .replace(/\W+/g, '-')
    .slice(0, 60)}`;

/**
 * Verifies the findings on closed issues against their fixes (tools/uat/regressions.mjs), then the rest.
 * @param {{ root: string, testerModel: string, dir: string, scenario: any, findings: any[], timeline: any[], log: (l: string) => void, verify: boolean, file: boolean }} o
 */
export async function reviewFindings(o) {
  if (o.verify) await verifyRegressions(o);
  if (o.file) commentRegressions(o);
  await verifyAndFile(o);
}

/**
 * Gives every finding without a verdict one, in a fresh model session (verify), then files the confirmed ones that no
 * open issue covers (file). A verdict a person or a reviewer set is never re-verified (tools/uat/verdicts.mjs), and a
 * match to a closed issue is verifyRegressions’s.
 */
async function verifyAndFile({ root, testerModel, dir, scenario, findings, timeline, log, verify, file }) {
  const gh = (args) => spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  const open = gh(['issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,body']);
  // Without the open issues, the verifier can’t tell a duplicate, and would confirm it: wait for a recheck with gh.
  if (open.status !== 0) return log('Verifying and filing skipped: the gh CLI isn’t available or signed in. Recheck the run once it is.');
  const issues = JSON.parse(open.stdout);
  const filedBefore = new Map(issues.flatMap((i) => [...(i.body ?? '').matchAll(/<!-- (uat:[^ ]+) -->/g)].map((m) => [m[1], i.number])));
  for (const f of findings.filter((x) => !x.issue && !x.filed && !x.verdict && filedBefore.has(fingerprint(x)))) {
    const n = filedBefore.get(fingerprint(f));
    setVerdict(f, { verdict: 'duplicate', by: 'runner', issue: n, note: `Filed by an earlier run as #${n}.` });
  }
  const toVerify = findings.filter((f) => !f.filed && !f.verdict && !f.closedIssue);
  if (verify && toVerify.length) {
    log(`Verifying ${toVerify.length} findings${file ? ' before filing' : ''}…`);
    try {
      const { value } = await askOnce({
        cwd: dir,
        model: testerModel,
        prompt: verifyPrompt({ scenario, findings: toVerify, timeline, issues }),
        schema: VERIFY_SCHEMA,
      });
      for (const r of value.results) {
        const f = toVerify[r.index];
        if (!f) continue;
        if (!setVerdict(f, { verdict: r.verdict, by: 'verifier', note: r.note, issue: r.duplicateOf ?? null })) continue;
        // The tester matched it to an open issue, and the verifier didn’t agree: it isn’t a catch of that issue.
        if (f.issue && !(f.verdict === 'duplicate' && f.duplicateOf === f.issue)) {
          f.matchedIssue = f.issue;
          f.issue = f.verdict === 'duplicate' ? (f.duplicateOf ?? null) : null;
        }
        if (f.verdict === 'confirmed') f.filing = r;
      }
    } catch (e) {
      log(`Verification failed, so nothing was filed: ${e.message}`);
      return;
    }
  }
  if (!file || open.status !== 0) return;
  for (const f of findings.filter((x) => x.verdict === 'confirmed' && x.filing && !x.filed && !x.issue)) {
    const r = f.filing;
    const body = [
      `**Component:** ${r.component}`,
      `**Urgency:** ${r.urgency}`,
      '',
      '## Steps to reproduce',
      '',
      ...r.steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '## Expected',
      '',
      r.expected,
      '',
      '## What failed instead',
      '',
      r.actual,
      ...(r.cause ? ['', '## Suspected cause', '', r.cause] : []),
      '',
      `Found by the end-to-end UAT ([tests/uat/e2e](https://github.com/HJeon139/postbox/tree/main/tests/uat/e2e)), ${scenario.title}, step ${f.step}. Verified before filing: ${f.note}`,
      '',
      `<!-- ${fingerprint(f)} -->`,
    ].join('\n');
    const labels = ['uat', f.category === 'ux' ? 'ux' : 'bug', PRIORITY[f.severity] ?? 'P2'].join(',');
    const made = gh(['issue', 'create', '--title', r.title, '--body', body, '--label', labels]);
    if (made.status !== 0) {
      log(`Couldn’t file “${r.title}”: ${made.stderr.trim()}`);
      continue;
    }
    f.filed = Number(made.stdout.trim().split('/').pop());
    log(`Filed #${f.filed}: ${r.title}`);
  }
}

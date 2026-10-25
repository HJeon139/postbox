// The run’s report: report.md, findings.json and run.log, written after a run and again after a recheck
// (tools/uat-run.mjs calls it).

import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { budgetNote } from './budget.mjs';
import { agyTokens, kiroCredits, waitingOnYou } from './checks.mjs';
import { agentsSpent } from './cost.mjs';
import { writeJsonAtomic } from './runs.mjs';
import { cell as esc } from './trigger-facts.mjs';
import { coverageSection } from './triggers.mjs';
import { mergePeopleVerdicts } from './verdicts.mjs';

/**
 * What the run spent, by whom, and what the agents ran on: the report’s first paragraph ends with it. With a run budget
 * (facts.budget, a summary from tools/uat/budget.mjs), it also says the cap, and whether the run stopped at it.
 * @param {any} facts  @param {{ spent: number }} tester
 */
function usageLine(facts, tester) {
  const agentCost = agentsSpent(facts.streams);
  // Kiro reports credits, not dollars: they’re listed beside the agents’ cost when a run had Kiro turns.
  const credits = kiroCredits(facts.kiroStreams ?? []);
  // Antigravity reports tokens, not dollars: they’re listed beside the agents’ cost when a run had its turns (#143).
  const tokens = agyTokens(facts.agyStreams ?? []);
  return `Usage: agents $${agentCost.toFixed(2)}${credits ? ` and ${credits.toFixed(2)} Kiro credits` : ''}${tokens ? ` and ${tokens.toLocaleString('en-US')} Antigravity tokens` : ''}, tester $${tester.spent.toFixed(2)}.${budgetNote(facts.budget)}${facts.agentModels ? ` Agents: ${facts.agentModels}.` : ''}`;
}

export async function writeReport({ dir, scenario, issues, findings, timeline, started, tester, facts, logLines, coverage = [], rechecked = false }) {
  const title = (n) => issues.find((i) => i.number === n)?.title ?? '(closed, or not in the list)';
  const usage = usageLine(facts, tester);
  const caught = new Map();
  for (const f of findings) if (f.issue) caught.set(f.issue, [...(caught.get(f.issue) ?? []), f]);
  const { CHECKS } = await import('./checks.mjs');
  const watched = [...new Set(CHECKS.map((c) => c.issue).filter(Boolean))].sort((a, b) => a - b);
  const md = [
    `# UAT: ${scenario.title}`,
    '',
    rechecked
      ? `Run on ${new Date(started).toISOString().slice(0, 16).replace('T', ' ')}, ${timeline.length} steps; checks rerun over its saved data on ${new Date().toISOString().slice(0, 16).replace('T', ' ')}. ${usage}`
      : `Run on ${new Date(started).toISOString().slice(0, 16).replace('T', ' ')}, ${Math.round((Date.now() - started) / 60000)} min, ${timeline.length} steps. ${usage}`,
    '',
    // What the run left unanswered: an agent that asked is stuck on it, so a run should end with none.
    ...(() => {
      const left = facts.state ? waitingOnYou(facts.state, facts.threads ?? []) : [];
      return left.length ? [`**Left waiting on you:** ${left.map((w) => w.what).join('; ')}.`, ''] : [];
    })(),
    // A targeted run says first which fixes it reached, and which it didn’t test.
    ...coverageSection(coverage, { rechecked }),
    '## Known issues caught again',
    '',
    `${caught.size} open issues reproduced. The checks watch ${watched.length} issues; the tester can match any open issue.`,
    '',
    '| Issue | Title | Caught by | Evidence |',
    '|---|---|---|---|',
    ...[...caught.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(
        ([n, fs]) =>
          `| #${n} | ${esc(title(n))} | ${[...new Set(fs.map((f) => (f.source === 'check' ? `check ${f.check}` : 'tester')))].join(', ')} | ${esc(String(fs[0].evidence ?? '').slice(0, 220))} |`,
      ),
    '',
    '### Watched by a check, not seen this run',
    '',
    watched
      .filter((n) => !caught.has(n))
      .map((n) => `- #${n} ${title(n)}`)
      .join('\n') || '- None.',
    '',
    '## New findings',
    '',
    'Check each against its screenshot before filing; a verdict records what a review found.',
    '',
    '| Severity | Category | Component | Finding | Evidence | Source | Verdict |',
    '|---|---|---|---|---|---|---|',
    ...findings
      .filter((f) => !f.issue && f.verdict !== 'harness')
      .map(
        (f) =>
          `| ${f.severity ?? '—'} | ${f.category ?? '—'} | ${esc(f.component ?? f.check)} | ${esc(f.title)} | ${esc(String(f.evidence ?? '').slice(0, 260))} | ${f.source} (step ${f.step}) | ${f.filed ? `filed #${f.filed}` : f.duplicateOf ? `duplicate of #${f.duplicateOf}` : esc(f.verdict ?? 'not reviewed')}${f.verdictBy ? ` (${f.verdictBy})` : ''}${f.note ? `: ${esc(f.note)}` : ''} |`,
      ),
    '',
    ...(findings.some((f) => f.verdict === 'harness')
      ? [
          '### The harness’s own problems',
          '',
          'Findings a review traced to the UAT harness, not to Postbox.',
          '',
          ...findings.filter((f) => f.verdict === 'harness').map((f) => `- **${esc(f.title)}.** ${esc(f.note ?? '')}`),
          '',
        ]
      : []),
    '## Timeline',
    '',
    ...timeline.map((t) => `${t.step}. **${t.phase}.** ${t.assessment} Next: \`${JSON.stringify(t.action)}\``),
    '',
    'Screenshots are in `shots/`, each agent turn’s raw stream in `streams/`, and the full log in `run.log`.',
    '',
  ].join('\n');
  await writeFile(join(dir, 'report.md'), md);
  keepPeopleVerdicts(findings, join(dir, 'findings.json'));
  writeJsonAtomic(join(dir, 'findings.json'), {
    scenario: scenario.title,
    started,
    testerSpent: tester.spent,
    findings,
    timeline,
    probes: facts.probes,
    samples: facts.samples,
    coverage,
    ...(facts.telemetryOut ? { telemetry: facts.telemetryOut } : {}),
    ...(facts.budget ? { budget: facts.budget } : {}),
  });
  if (rechecked) await writeFile(join(dir, 'run.log'), `${readFileSync(join(dir, 'run.log'), 'utf8')}${logLines.join('\n')}\n`);
  else await writeFile(join(dir, 'run.log'), `${logLines.join('\n')}\n`);
  console.log(
    `\nReport: ${join(dir, 'report.md')} · ${caught.size} known issues caught again · ${findings.filter((f) => !f.issue && f.verdict !== 'harness').length} new findings`,
  );
}

/**
 * A verdict a person or a reviewer recorded in findings.json (tools/uat-verdict.mjs) while this process held the
 * findings in memory, such as during a recheck’s verification, is kept rather than written over.
 * @param {any[]} findings  @param {string} file
 */
function keepPeopleVerdicts(findings, file) {
  if (!existsSync(file)) return;
  try {
    mergePeopleVerdicts(findings, JSON.parse(readFileSync(file, 'utf8')).findings ?? []);
  } catch (e) {
    console.log(`Couldn’t read ${file} to keep the verdicts in it: ${e.message}`);
  }
}

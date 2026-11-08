// A pair for a run that finished before the side-by-side judge (#995): the words answer and the judge’s pick, from the
// run’s folder, saved into its run.json as a live run would have. The runner’s item labels aren’t kept, so the
// picture’s label is the one the customer judged first, which `- judge: visual` asks of the first visual.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstExchange } from './picture-choice.mjs';
import { readRun, writeJsonAtomic } from './runs.mjs';
import { parseScenario } from './scenario.mjs';
import { sideBySide } from './side-by-side.mjs';

/** The item the customer judged first, from the report’s visual verdicts, or null. @param {string} report */
export function firstJudged(report) {
  const at = report.indexOf('## Visual verdicts');
  if (at < 0) return null;
  return /^\| \d+ \| (I\d+) \|/m.exec(report.slice(at))?.[1] ?? null;
}

/**
 * Adds sideBySide to a finished run’s run.json, unless it has one. Returns the pair, or why there’s none.
 * @param {string} dir  the run’s folder
 * @param {{ scenarios: string, ask: (args: any) => Promise<{ value: any, cost: number }>, judgeModel: string }} o
 */
export async function backfillPair(dir, { scenarios, ask, judgeModel }) {
  const saved = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  if (saved.sideBySide) return saved.sideBySide;
  const record = readRun(dir, { scenarios });
  const file = join(scenarios, `${record?.scenario}.md`);
  if (!record || !existsSync(file)) return { skipped: `no scenario file for ${record?.scenario ?? dir}` };
  const report = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
  const label = firstJudged(report);
  const visual = firstExchange(join(dir, 'data'))?.visual;
  if (!label || !visual) return { skipped: 'no judged first picture' };
  const pair = await sideBySide({
    scenario: parseScenario(readFileSync(file, 'utf8')),
    dir,
    data: join(dir, 'data'),
    shots: join(dir, 'shots'),
    labels: new Map([[visual.itemId, label]]),
    agent: { model: record.agents.model, effort: record.agents.effort },
    judgeModel,
    ask,
  });
  const cost = (pair.cost?.words ?? 0) + (pair.cost?.judge ?? 0);
  writeJsonAtomic(join(dir, 'run.json'), { ...saved, sideBySide: pair, pictureJudges: { usd: Math.round(cost * 100) / 100, backfilled: true } });
  return pair;
}

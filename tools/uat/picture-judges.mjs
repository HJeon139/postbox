// The judges a run asks after its last step, for #995’s measures of agents’ pictures: whether each judged app’s
// takeaway carries the agent’s intent (tools/uat/intent-match.mjs), and whether the person would rather have had the
// first picture or a words-only answer (tools/uat/side-by-side.mjs). They run for a run that judges visuals or says
// which answer its question should get, as the picture-or-words line does (tools/uat/picture-choice.mjs).

import { matchIntents } from './intent-match.mjs';
import { streamModel } from './runs.mjs';
import { sideBySide } from './side-by-side.mjs';
import { askOnce } from './tester.mjs';

/**
 * Adds intents and matches to the timeline’s visuals, and the pair to facts.sideBySide. A judge that fails is logged
 * and recorded, never a failed run. Their cost is counted with the verifier’s, after the run.
 * @param {{ scenario: any, dir: string, paths: { data: string, shots: string }, labels: Map<string, string>,
 *   keys: Map<string, string>, timeline: any[], facts: any, ask?: (args: any) => Promise<{ value: any, cost: number }>,
 *   model: string, log: (line: string) => void }} o  ask: the budget’s verifier when the run has a cap, else askOnce
 */
export async function judgePictures({ scenario, dir, paths, labels, keys, timeline, facts, ask = askOnce, model, log }) {
  if (scenario.judge !== 'visual' && !scenario.expects) return;
  const shots = paths.shots;
  const matched = await matchIntents({ timeline, data: paths.data, shots, keys, ask, cwd: dir, model, log });
  let pair;
  try {
    pair = await sideBySide({
      scenario,
      dir,
      data: paths.data,
      shots,
      labels,
      agent: { model: streamModel(facts.streams), effort: facts.agentEffort ?? null },
      judgeModel: model,
      ask,
    });
  } catch (e) {
    log(`The side-by-side judge failed: ${e.message}`);
    pair = { skipped: `the judge failed: ${e.message}` };
  }
  facts.sideBySide = pair;
  facts.pictureJudges = { usd: Math.round((matched + (pair.cost?.words ?? 0) + (pair.cost?.judge ?? 0)) * 100) / 100 };
  log(`Picture judges: ${pair.skipped ? `no pair (${pair.skipped})` : `preferred ${pair.pick}`}, $${facts.pictureJudges.usd.toFixed(2)}.`);
}

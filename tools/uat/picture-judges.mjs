// The judges a run asks after its last step, for #995’s measures of agents’ pictures: whether each judged app’s
// takeaway carries the agent’s intent (tools/uat/intent-match.mjs). They run for a run that judges visuals or says
// which answer its question should get, as the picture-or-words line does (tools/uat/picture-choice.mjs).

import { matchIntents } from './intent-match.mjs';
import { askOnce } from './tester.mjs';

/**
 * Adds intents and matches to the timeline’s visuals. A judge that fails is logged, never a failed run. Their cost is
 * counted with the verifier’s, after the run.
 * @param {{ scenario: any, dir: string, paths: { data: string, shots: string, workspace: string }, labels: Map<string, string>,
 *   keys: Map<string, string>, timeline: any[], facts: any, ask?: (args: any) => Promise<{ value: any, cost: number }>,
 *   model: string, log: (line: string) => void }} o  ask: the budget’s verifier when the run has a cap, else askOnce
 */
export async function judgePictures({ scenario, dir, paths, keys, timeline, facts, ask = askOnce, model, log }) {
  if (scenario.judge !== 'visual' && !scenario.expects) return;
  const matched = await matchIntents({ timeline, data: paths.data, shots: paths.shots, keys, ask, cwd: dir, model, log });
  facts.pictureJudges = { usd: Math.round(matched * 100) / 100 };
}

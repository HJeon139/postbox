// What a run records after its last step, for #995’s measures of agents’ pictures: whether each judged app’s takeaway
// carries the agent’s intent (tools/uat/intent-match.mjs), and its first picture with what it was meant to say, for
// the side-by-side judge to compare with another run’s (tools/uat/side-by-side.mjs). They run for a run that judges
// visuals or says which answer its question should get, as the picture-or-words line does (tools/uat/picture-choice.mjs).

import { matchIntents } from './intent-match.mjs';
import { firstPicture } from './side-by-side.mjs';
import { askOnce } from './tester.mjs';

/**
 * Adds intents and matches to the timeline’s visuals, and the first picture to facts.firstPicture. A judge that fails
 * is logged, never a failed run. Its cost is counted with the verifier’s, after the run.
 * @param {{ scenario: any, dir: string, paths: { data: string, shots: string }, labels: Map<string, string>,
 *   keys: Map<string, string>, timeline: any[], facts: any, ask?: (args: any) => Promise<{ value: any, cost: number }>,
 *   shoot?: (label: string, file: string) => Promise<string|null>, model: string, log: (line: string) => void }} o
 *   ask: the budget’s verifier when the run has a cap, else askOnce; shoot: a shot of an item by its label, now
 */
export async function judgePictures({ scenario, dir, paths, labels, keys, timeline, facts, shoot, ask = askOnce, model, log }) {
  if (scenario.judge !== 'visual' && !scenario.expects) return;
  const matched = await matchIntents({ timeline, data: paths.data, shots: paths.shots, keys, ask, cwd: dir, model, log });
  facts.firstPicture = await firstPicture({ dir, data: paths.data, shots: paths.shots, labels, shoot });
  facts.pictureJudges = { usd: Math.round(matched * 100) / 100 };
  log(`First picture: ${facts.firstPicture.skipped ? `none (${facts.firstPicture.skipped})` : facts.firstPicture.shot}.`);
}

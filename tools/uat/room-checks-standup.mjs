// What a room did after a standup (#1746), as a measurement, not a defect: idle-work-waiting says whether the room
// stalled (tools/uat/room-checks-idle.mjs); this says what the stall, or the lack of one, was made of. For the first
// quiet minute after the round: what was waiting and what moved the room, and each agent’s last turn before it (what
// woke it, whether it did work or only wrote, whether it reacted, whom its reply reached). That is what tells the
// reply rules ending an exchange (server/reply-back.mjs) from nobody having been given the next step. Part of
// tools/uat/room-checks.mjs’s CHECKS; a run with no standup round gets nothing.

import { nightlyWork } from './nightly-log.mjs';
import { clockOf, quietStretches } from './quiet-stretches.mjs';
import { QUIET_LISTED_MS, stretchLine } from './room-checks-idle.mjs';
import { lastTurns, STANDUP, standupRounds } from './standup.mjs';

/**
 * The measurement for the run’s first standup round, or none.
 * @param {any} f  @param {{ says?: RegExp, work?: import('./quiet-stretches.mjs').Work }} [opts]
 */
export function afterStandup(f, { says = STANDUP, work = nightlyWork(f) } = {}) {
  const [round] = standupRounds(f, { says });
  if (!round) return [];
  const silent = round.answers.filter((a) => !a.wrote).map((a) => `@${a.handle}`);
  const held = `@${round.by} ran a standup at ${clockOf(round.at)}: ${round.answers.length} agents took a turn on it${silent.length ? `, and ${silent.join(', ')} wrote nothing` : ''}.`;
  const quiet = quietStretches(f, work).find((s) => s.from >= round.endedAt && s.ms >= QUIET_LISTED_MS);
  const after = quiet ? `Then the room was quiet for ${stretchLine(quiet)}` : 'The room wasn’t quiet for a minute after it.';
  const turns = quiet ? lastTurns(f, quiet.from).map((t) => t.line) : [];
  return [
    {
      title: quiet ? 'What each agent’s last turn did before the room went quiet after the standup' : 'A standup was held, and the room went on',
      evidence: [held, after, ...turns].join(' '),
      verdict: 'measurement',
      note: 'Not a defect: what woke each agent’s last turn, what it did and whom its reply reached, to tell why a room stopped.',
    },
  ];
}

export const STANDUP_CHECKS = [{ id: 'after-standup', inputs: ['events', 'threads'], issue: null, run: (/** @type {any} */ f) => afterStandup(f) }];

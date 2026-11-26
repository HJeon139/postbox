// What a sprint room was doing each time it went quiet (#1746), as a measurement, not a defect: idle-work-waiting says
// whether the room stalled (tools/uat/room-checks-idle.mjs); this says what the stall, or the lack of one, was made
// of. For each quiet minute: which ceremony came before it, which of the sprint’s stories weren’t done and whose they
// were, and each agent’s last turn before it (what woke it, whether it did work or only wrote, whether it reacted, whom
// its reply reached). That is what shows whether a standup, with its replies that only write, is where a room dies:
// the reply rules ending an exchange (server/reply-back.mjs) read differently from nobody having taken the next
// story. Part of tools/uat/room-checks.mjs’s CHECKS; a run with no sprint board gets nothing.

import { boardLog, openStories, sprintWork, workOf } from './board-log.mjs';
import { quietStretches } from './quiet-stretches.mjs';
import { QUIET_LISTED_MS, stretchLine } from './room-checks-idle.mjs';
import { ceremonies } from './sprint-ceremonies.mjs';
import { lastTurns } from './standup.mjs';

const CEREMONY = {
  groomed: 'backlog grooming',
  estimated: 'estimation',
  planned: 'sprint planning',
  'took-actions': 'sprint planning',
  elected: 'task election',
  standup: 'a standup',
  demo: 'the demo',
  'demo-answered': 'the customer’s answer to the demo',
  'sent-back': 'a story sent back',
  retro: 'the retrospective',
};

/** One quiet stretch of a sprint room, as evidence. @param {any} f @param {any[]} log @param {ReturnType<typeof ceremonies>} held @param {ReturnType<typeof quietStretches>[number]} s */
function context(f, log, held, s) {
  const last = held.findLast((c) => c.at <= s.from);
  const open = openStories(log, s.from).map((x) => `${x.id} (${x.owner ? `@${x.owner}’s` : 'nobody’s yet'})`);
  return [
    `Quiet for ${stretchLine(s)}`,
    last ? `It came after ${CEREMONY[/** @type {keyof typeof CEREMONY} */ (last.name)]}.` : 'No ceremony had been held yet.',
    open.length ? `Not done in the sprint: ${open.join(', ')}.` : 'No story of a sprint was open.',
    ...lastTurns(f, s.from).map((t) => t.line),
  ].join(' ');
}

/** What a sprint room’s report says when the team never used the board: the stall check can’t tell that from a stall. */
const NO_BOARD = {
  title: 'No board command was recorded in this run',
  evidence:
    'The person’s request named the sprint board, and the board’s record is empty: the team kept no board with the tool, so no ceremony can be read from it, and idle-work-waiting can’t tell a sprint that finished from one that stopped.',
  verdict: 'measurement',
  note: 'Not a defect in Postbox: what the run’s other sprint findings rest on.',
};

/**
 * The measurement: every classed quiet stretch of a minute or more in a sprint room, each with its context.
 * @param {any} f  @param {import('./quiet-stretches.mjs').Work} [work]
 */
export function afterCeremony(f, work = workOf(f)) {
  const log = boardLog(f);
  if (!log.length) return sprintWork(f).asked === null ? [] : [NO_BOARD];
  const quiet = quietStretches(f, work).filter((s) => s.ms >= QUIET_LISTED_MS && s.waiting !== 'unknown');
  if (!quiet.length) return [];
  const held = ceremonies(f);
  return [
    {
      title: 'What the sprint was doing each time the room went quiet',
      evidence: quiet.map((s) => context(f, log, held, s)).join(' — '),
      verdict: 'measurement',
      note: 'Not a defect: the ceremony before each quiet minute, the stories open, and what each agent’s last turn did, to tell why a room stopped.',
    },
  ];
}

export const SPRINT_CHECKS = [{ id: 'after-ceremony', inputs: ['events', 'threads'], issue: null, run: (/** @type {any} */ f) => afterCeremony(f) }];

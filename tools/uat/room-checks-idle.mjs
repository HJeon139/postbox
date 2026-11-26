// The checks of a room that stopped while work was waiting (#1746). Part of tools/uat/room-checks.mjs’s CHECKS.
//   idle-work-waiting        a quiet stretch with the work not done, nobody asked and nothing scheduled, 5 minutes
//                            or more after the next step could have started
//   ask-uncounted-mid-turn   an ask shown while its turn ran that the room didn’t count as needing the person
//   quiet-stretches          not a defect: every quiet stretch of a minute or more, with its length, what was waiting
//                            and what moved the room, and how long after the timed step was due the room knew it
//                            had passed, so two runs can be compared
// Each reads the run’s event history, and the first also the scenario’s definition of done, which only
// tests/uat/e2e/scenarios/idleroom.md gives: in any other run it finds nothing.

import { midTurnAsks } from './mid-turn-asks.mjs';
import { nightlyWork } from './nightly-log.mjs';
import { clockOf, quietStretches } from './quiet-stretches.mjs';

/**
 * How long a room may sit with work waiting and nothing to restart it before that is the finding, counted from when
 * the next step could have started: the moment the timed step was due, or the stretch’s start when no timed step had
 * been queued. So a room that waits out a 12-minute step isn’t idle for those 12 minutes. #1746 counted more than 10
 * minutes from the last activity; this is 5 from when work could go on, since the person in the scenario is back about
 * 8 minutes after the step is due, and a bar of 10 would need a run 10 minutes longer. It’s a bar on a fix too: one
 * that moves the room later than 5 minutes after the step was due still fails. The lengths are reported whatever it is.
 */
export const IDLE_MIN_MS = 5 * 60_000;
/** The shortest quiet stretch the measurement lists: under a minute is the pause between two agents’ turns. */
export const QUIET_LISTED_MS = 60_000;
/**
 * How long an ask may be on screen in a running turn before not counting it is the finding. In the recorded runs a
 * turn that showed one ended 2.5 to 4.5 s later, on a closing line; past 30 s the agent is doing other work.
 */
export const ASK_UNCOUNTED_MS = 30_000;

/** A length for a person to read: “10 min 12 s”, “45 s”. @param {number} ms */
export function lengthOf(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const WAITING = {
  person: 'waiting on the person',
  scheduled: 'waiting on a scheduled wake',
  nothing: 'work waiting, with nothing to restart it',
  done: 'the work was done',
  unknown: 'the records can’t say whether work was waiting',
};

/** One stretch as a line of evidence. @param {ReturnType<typeof quietStretches>[number]} s */
export function stretchLine(s) {
  const what = s.what.length ? ` (${s.what.join('; ')})` : '';
  const overdue = s.overdueMs ? `, ${lengthOf(s.overdueMs)} of it after the timed step was due` : '';
  const moved = s.open ? 'still quiet when the records end' : `moved by ${s.movedBy}`;
  return `${lengthOf(s.ms)} from ${clockOf(s.from)}: ${WAITING[s.waiting]}${what}${overdue}; ${moved}.`;
}

/** How long a stretch went on after work could have gone on: past the timed step’s end, or all of it with none queued. @param {ReturnType<typeof quietStretches>[number]} s */
const idleFor = (s) => s.overdueMs ?? s.ms;

/**
 * Each quiet stretch with the work not done, nobody asked and nothing scheduled, that went on `min` or more after the
 * next step could have started, as a finding. It says whether the timed step had been queued: a hand-off dropped
 * before anyone queued it is a room idle with work waiting too, from another cause.
 * @param {any} f  @param {{ min?: number, work?: import('./quiet-stretches.mjs').Work }} [opts]
 */
export function idleFindings(f, { min = IDLE_MIN_MS, work = nightlyWork(f) } = {}) {
  return quietStretches(f, work)
    .filter((s) => s.waiting === 'nothing' && idleFor(s) >= min)
    .map((s) => {
      const queued = s.overdueMs !== null;
      const how = queued
        ? 'after the timed step was due, with nothing to restart it'
        : 'with work waiting, the timed step never queued and nothing to restart it';
      return {
        key: `idle-work-waiting:${s.from}`,
        title: `The room sat idle for ${lengthOf(idleFor(s))} ${how}`,
        evidence: `No agent was in a turn and no item arrived for ${stretchLine(s)} ${queued ? 'The timed step had been queued, and nothing told the room it had finished.' : 'Nobody had queued the timed step: the work stopped before it.'} The definition of done wasn’t met, no ask was open and no wake was scheduled.`,
      };
    });
}

/**
 * The one number that compares two runs whatever moved the room: how long after the timed step was due the room
 * first knew it had passed. Empty for a run with no timed step. @param {import('./quiet-stretches.mjs').Work} work
 */
export function timedStepLine({ queued, passed }) {
  if (!queued?.due) return '';
  const known = passed
    ? `first passed ${lengthOf(Math.max(0, passed.at - queued.due))} after that, at ${clockOf(passed.at)}`
    : 'hadn’t passed when the records end';
  return `The timed step was due at ${clockOf(queued.due)} and ${known}.`;
}

const COUNTED = { never: 'never, in what the run recorded', 'mid-turn': 'while the turn ran', 'at-turn-end': 'when the turn ended' };

/**
 * Each ask shown while its turn ran that went `min` or more before its session named it as its need, as a finding.
 * @param {any} f  @param {{ min?: number }} [opts]
 */
export function uncountedAskFindings(f, { min = ASK_UNCOUNTED_MS } = {}) {
  return midTurnAsks(f)
    .filter((a) => a.uncountedMs >= min)
    .map((a) => ({
      key: `ask-uncounted-mid-turn:${a.itemId}`,
      title: `An ask shown mid-turn didn’t count as needing you for ${lengthOf(a.uncountedMs)}`,
      evidence: `@${a.handle} showed “${a.title}” at ${clockOf(a.shownAt)} and its turn ran ${lengthOf(a.turnMs)} more. Its session first named it as what it needs ${COUNTED[a.counted]}.`,
    }));
}

/**
 * The measurement: each classed quiet stretch of a minute or more, and the timed step’s own line. None for a run with
 * neither. @param {any} f  @param {import('./quiet-stretches.mjs').Work} [work]
 */
export function quietMeasure(f, work = nightlyWork(f)) {
  const listed = quietStretches(f, work).filter((s) => s.ms >= QUIET_LISTED_MS && s.waiting !== 'unknown');
  const step = timedStepLine(work);
  if (!listed.length && !step) return [];
  return [
    {
      title: `The room was quiet for a minute or more ${listed.length === 1 ? 'once' : `${listed.length} times`}`,
      evidence: [...listed.map(stretchLine), step].filter(Boolean).join(' '),
      verdict: 'measurement',
      note: 'Not a defect: how long the room was quiet, what was waiting and what moved it, to compare runs.',
    },
  ];
}

export const IDLE_CHECKS = [
  { id: 'idle-work-waiting', inputs: ['events', 'threads'], issue: 1746, run: (/** @type {any} */ f) => idleFindings(f) },
  { id: 'ask-uncounted-mid-turn', inputs: ['events'], issue: 1746, run: (/** @type {any} */ f) => uncountedAskFindings(f) },
  {
    id: 'quiet-stretches',
    inputs: ['events', 'threads'],
    issue: null,
    run: (/** @type {any} */ f) => quietMeasure(f),
  },
];

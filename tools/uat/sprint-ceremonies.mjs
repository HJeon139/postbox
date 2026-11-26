// The ceremonies of a sprint, as a run’s records show them (#1746; the idleroom scenarios): backlog grooming,
// estimation, sprint planning, task election, a standup, the demo and the customer’s answer, a story sent back, the
// retrospective’s action items, and the next sprint’s plan taking them up. Each is read from the sprint board’s own
// record (tools/uat/board-log.mjs), with who ran each command from the work ledger, and, for what is said and not
// recorded on a board, from the turns in the event history (tools/uat/standup.mjs): a standup is a round of turns, and
// the customer’s answer is the person’s message. Nothing here reads what an agent wrote for a ceremony’s name, so an
// agent that says “standup” and holds none doesn’t count, and one that holds one without the word does.

import { boardAt, boardLog, demos, openStories, whoRan } from './board-log.mjs';
import { clockOf } from './quiet-stretches.mjs';
import { standupRounds } from './standup.mjs';

/** @typedef {{ name: string, at: number, sprint?: number, taken?: number, backlog?: number, evidence: string }} Ceremony */

/** The distinct agents that ran these lines’ commands, in the order each first did, with when. @param {any} f @param {any[]} lines */
function ranBy(f, lines) {
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const x of lines) {
    const who = whoRan(f, x.at, undefined, new RegExp(`\\b${x.did}\\s+${x.story}\\b`));
    if (who && !first.has(who)) first.set(who, x.at);
  }
  return [...first].map(([handle, at]) => ({ handle, at }));
}

const names = (/** @type {{ handle: string }[]} */ agents) => agents.map((a) => `@${a.handle}`).join(', ');

/** Before the first sprint: the backlog put in order, split or clarified, and stories sized by more than one agent. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function beforeSprint(f, log) {
  const planned = log.find((x) => x.did === 'plan')?.at ?? Number.POSITIVE_INFINITY;
  const early = log.filter((x) => x.at < planned);
  const stories = early.filter((x) => x.did === 'add').length;
  const groomed = early.filter((x) => ['order', 'split', 'clarify'].includes(x.did));
  const sizers = ranBy(
    f,
    early.filter((x) => x.did === 'estimate'),
  );
  /** @type {Ceremony[]} */
  const out = [];
  if (stories >= 3 && groomed.length)
    out.push({
      name: 'groomed',
      at: groomed[0].at,
      evidence: `${stories} stories in the backlog, and ${groomed.length} of them put in order, split or clarified before the first sprint.`,
    });
  if (sizers.length >= 2) out.push({ name: 'estimated', at: sizers[1].at, evidence: `${names(sizers)} each gave estimates before the first sprint.` });
  return out;
}

/**
 * The stories the customer sent back, with when the board showed it: put back with `return` after their answer to a
 * demo, or simply taken again by a later sprint’s plan after it, which is what “take it back into the next sprint”
 * also reads as. Taken again counts for a story that was done when they answered: one left unfinished and carried
 * over is the team’s, and nobody sent it back.
 * @param {any} f @param {any[]} log @returns {{ story: string, at: number, how: string }[]}
 */
function sentBack(f, log) {
  const first = demos(f, log).find((d) => d.answer)?.answer.at ?? Number.POSITIVE_INFINITY;
  const shown = boardAt(log, first).stories;
  const out = [];
  for (const x of log.filter((y) => y.at > first)) {
    if (x.did === 'return') out.push({ story: x.story, at: x.at, how: 'went back to the backlog' });
    if (x.did !== 'plan') continue;
    for (const id of x.items)
      if (shown.get(id)?.done && !out.some((b) => b.story === id)) out.push({ story: id, at: x.at, how: `was taken again into sprint ${x.sprint}` });
  }
  return out;
}

/** Each sprint’s plan, and the agents that took a story in it themselves. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function sprints(f, log) {
  const plans = log.filter((x) => x.did === 'plan');
  return plans.flatMap((p, i) => {
    const until = plans[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    const backlog = boardAt(log, p.at).stories.size;
    const taken = p.items.filter((/** @type {string} */ id) => id.startsWith('S'));
    const actions = p.items.filter((/** @type {string} */ id) => id.startsWith('A'));
    const back = taken.filter((/** @type {string} */ id) => sentBack(f, log).some((b) => b.story === id && b.at <= p.at));
    const takers = ranBy(
      f,
      log.filter((x) => x.did === 'claim' && x.at > p.at && x.at < until),
    );
    /** @type {Ceremony[]} */
    const out = [
      {
        name: 'planned',
        at: p.at,
        sprint: p.sprint,
        taken: taken.length,
        backlog,
        evidence: `Sprint ${p.sprint} took ${taken.length} of the board’s ${backlog} stories. Goal: ${p.goal}`,
      },
    ];
    if (actions.length && back.length)
      out.push({
        name: 'took-actions',
        at: p.at,
        sprint: p.sprint,
        evidence: `Sprint ${p.sprint}’s plan took ${actions.join(', ')} and ${back.join(', ')}, which the customer had sent back.`,
      });
    if (takers.length >= 3)
      out.push({ name: 'elected', at: takers[2].at, sprint: p.sprint, evidence: `${names(takers)} each took a story of sprint ${p.sprint} themselves.` });
    return out;
  });
}

/** The sprint’s end: the demo, the customer’s answer, a story sent back, and the retrospective’s action items. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function reviews(f, log) {
  return demos(f, log).flatMap((demo) => {
    const answer = demo.answer;
    const back = answer ? sentBack(f, log).find((b) => b.at > answer.at) : null;
    const actions = log.filter((x) => x.did === 'action' && x.at > demo.at);
    /** @type {Ceremony[]} */
    const out = [
      {
        name: 'demo',
        at: demo.at,
        sprint: demo.sprint,
        evidence: `Sprint ${demo.sprint}’s stories were listed for the customer at ${clockOf(demo.at)}, with one or more done.`,
      },
    ];
    if (answer)
      out.push({
        name: 'demo-answered',
        at: answer.at,
        sprint: demo.sprint,
        evidence: `The person answered sprint ${demo.sprint}’s demo at ${clockOf(answer.at)}.`,
      });
    if (back) out.push({ name: 'sent-back', at: back.at, sprint: demo.sprint, evidence: `${back.story} ${back.how} after the customer’s answer.` });
    if (actions.length)
      out.push({
        name: 'retro',
        at: actions[0].at,
        sprint: demo.sprint,
        evidence: `${actions.length} action ${actions.length === 1 ? 'item' : 'items'} after sprint ${demo.sprint}’s demo: ${actions.map((x) => x.action).join(', ')}.`,
      });
    return out;
  });
}

/** Each standup: a round of turns (one agent’s, then an answer to it from every other agent) while a story someone had taken wasn’t done. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function standups(f, log) {
  return standupRounds(f, { says: null, toAsker: true })
    .filter((r) => openStories(log, r.at).some((s) => s.owner))
    .map((r) => ({
      name: 'standup',
      at: r.endedAt,
      evidence: `@${r.by} asked at ${clockOf(r.at)}${r.said ? ', by that word' : ''}, and ${r.answers.map((a) => `@${a.handle} ${a.wrote ? 'answered' : 'took a turn and wrote nothing'}`).join(', ')}, with ${openStories(log, r.at).length} of the sprint’s stories not done.`,
    }));
}

/**
 * Every ceremony the run’s records show, in the order it happened. Empty for a run with no sprint board.
 * @param {{ events?: any[], workspace?: string|null, workspaceKept?: string|null }} f  @returns {Ceremony[]}
 */
export function ceremonies(f) {
  const log = boardLog(f);
  if (!log.length) return [];
  return [...beforeSprint(f, log), ...sprints(f, log), ...standups(f, log), ...reviews(f, log)].sort((a, b) => a.at - b.at);
}

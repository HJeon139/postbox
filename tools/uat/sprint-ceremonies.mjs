// The ceremonies of a sprint, as a run’s records show them (#1746; the idleroom scenarios): backlog grooming,
// estimation, sprint planning, task election, a standup, the demo and the customer’s answer, a story sent back, the
// retrospective’s action items, and the next sprint’s plan taking them up. Each is read from the sprint board’s own
// record (tools/uat/board-log.mjs), with who ran each command from the work ledger, and, for what is said and not
// recorded on a board, from the turns in the event history (tools/uat/standup.mjs): a standup is a round of turns, and
// the customer’s answer is the person’s message. Nothing here reads what an agent wrote for a ceremony’s name, so an
// agent that says “standup” and holds none doesn’t count, and one that holds one without the word does.

import { boardAt, boardLog, openStories, whoRan } from './board-log.mjs';
import { clockOf } from './quiet-stretches.mjs';
import { standupRounds } from './standup.mjs';

/** @typedef {{ name: string, at: number, sprint?: number, taken?: number, backlog?: number, evidence: string }} Ceremony */

/** The distinct agents that ran these lines’ commands, in the order each first did, with when. @param {any} f @param {any[]} lines */
function ranBy(f, lines) {
  /** @type {Map<string, number>} */
  const first = new Map();
  for (const x of lines) {
    const who = whoRan(f, x.at);
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

/** Each sprint’s plan, and the agents that took a story in it themselves. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function sprints(f, log) {
  const plans = log.filter((x) => x.did === 'plan');
  return plans.flatMap((p, i) => {
    const until = plans[i + 1]?.at ?? Number.POSITIVE_INFINITY;
    const backlog = boardAt(log, p.at).stories.size;
    const taken = p.items.filter((/** @type {string} */ id) => id.startsWith('S'));
    const actions = p.items.filter((/** @type {string} */ id) => id.startsWith('A'));
    const back = taken.filter((/** @type {string} */ id) => log.some((x) => x.did === 'return' && x.story === id && x.at < p.at));
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
  const said = (f.events ?? [])
    .filter((/** @type {any} */ e) => e?.type === 'item.add' && e.data?.item?.kind === 'user')
    .map((/** @type {any} */ e) => e.data.item);
  return log
    .filter((x) => x.did === 'demo')
    .flatMap((demo) => {
      const answer = said.find((/** @type {any} */ m) => m.at > demo.at);
      const back = log.find((x) => x.did === 'return' && answer && x.at > answer.at);
      const actions = log.filter((x) => x.did === 'action' && x.at > demo.at);
      /** @type {Ceremony[]} */
      const out = [
        { name: 'demo', at: demo.at, sprint: demo.sprint, evidence: `Sprint ${demo.sprint}’s stories were listed for the customer at ${clockOf(demo.at)}.` },
      ];
      if (answer)
        out.push({
          name: 'demo-answered',
          at: answer.at,
          sprint: demo.sprint,
          evidence: `The person answered sprint ${demo.sprint}’s demo at ${clockOf(answer.at)}.`,
        });
      if (back)
        out.push({ name: 'sent-back', at: back.at, sprint: demo.sprint, evidence: `${back.story} went back to the backlog after the customer’s answer.` });
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

/** Each standup: a round of turns (one agent’s, then every other agent’s on it) while a story someone had taken wasn’t done. @param {any} f @param {any[]} log @returns {Ceremony[]} */
function standups(f, log) {
  return standupRounds(f, { says: null })
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

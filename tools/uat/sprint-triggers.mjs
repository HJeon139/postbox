// The idleroom scenarios’ triggers, one per sprint ceremony (#1746; tools/uat/triggers.mjs has what a trigger is), so a
// run that skipped a ceremony says which: each is a ceremony the run’s records show (tools/uat/sprint-ceremonies.mjs),
// with what more the scenario asks of it. A trigger says the room reached the ceremony, not that it went well.

import { ceremonies } from './sprint-ceremonies.mjs';

/** What each trigger needs of a ceremony, and what Postbox “showed”. @type {Record<string, { name: string, says: string, when?: (c: import('./sprint-ceremonies.mjs').Ceremony) => boolean }>} */
const NEEDS = {
  'backlog-groomed': { name: 'groomed', says: 'the team put the backlog on the board and ordered, split or clarified its stories before the first sprint' },
  'stories-estimated': {
    name: 'estimated',
    says: 'two agents or more, the scrum master among them if it gave one, each entered their own estimates of the stories',
  },
  'sprint-planned': {
    name: 'planned',
    says: 'a first sprint was planned with a goal and fewer stories than the backlog holds',
    when: (c) => c.sprint === 1 && (c.taken ?? 0) < (c.backlog ?? 0),
  },
  'tasks-elected': { name: 'elected', says: 'three agents, the scrum master among them if it took one, each took a story of a sprint themselves' },
  'standup-round-held': {
    name: 'standup',
    says: 'one agent asked every other agent for its status in one turn, and each took a turn on it, while a story someone had taken wasn’t done',
  },
  'demo-shown': { name: 'demo', says: 'a sprint’s stories were listed for the customer’s demo, with one or more done' },
  'demo-answered': { name: 'demo-answered', says: 'the person answered a sprint’s demo' },
  'story-sent-back': { name: 'sent-back', says: 'a story the customer didn’t accept went back to the backlog, or into a later sprint’s plan' },
  'retro-held': { name: 'retro', says: 'the retrospective put action items on the board' },
  'next-sprint-took-actions': {
    name: 'took-actions',
    says: 'a later sprint’s plan took an action item and the story sent back',
  },
};

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const SPRINT_TRIGGERS = Object.fromEntries(
  Object.entries(NEEDS).map(([id, need]) => [
    id,
    {
      issue: 1746,
      says: need.says,
      // The board’s record is in the run’s workspace: facts with none can’t say a ceremony didn’t happen.
      recorded: (/** @type {any} */ f) => typeof (f.workspaceKept ?? f.workspace) === 'string',
      run: (/** @type {any} */ f) =>
        ceremonies(f)
          .filter((c) => c.name === need.name && (need.when?.(c) ?? true))
          .map((c) => ({ at: c.at, evidence: c.evidence })),
    },
  ]),
);

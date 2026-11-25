// #1735's UAT triggers (tools/uat/triggers.mjs has what a trigger is): an agent was added to a conversation, and one
// removed from it, through the Members list of the room's form in the main menu, the only place either is done. Read
// from what the runner's members action recorded: the list as it stood once the change took.

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const MEMBERS_TRIGGERS = {
  'member-added-in-menu': {
    issue: 1735,
    says: 'an agent was added to the conversation through the main menu’s Members list',
    recorded: (f) => Array.isArray(f.probes?.members),
    run: (f) =>
      (f.probes?.members ?? [])
        .filter((/** @type {any} */ p) => p.add && p.members.includes(`@${p.add}`))
        .map((/** @type {any} */ p) => ({ at: p.at ?? null, evidence: `@${p.add} was added, and the Members list then read: ${p.members.join(', ')}.` })),
  },
  'member-removed-in-menu': {
    issue: 1735,
    says: 'an agent was removed from the conversation through the main menu’s Members list',
    recorded: (f) => Array.isArray(f.probes?.members),
    run: (f) =>
      (f.probes?.members ?? [])
        .filter((/** @type {any} */ p) => p.remove && !p.members.includes(`@${p.remove}`))
        .map((/** @type {any} */ p) => ({ at: p.at ?? null, evidence: `@${p.remove} was removed, and the Members list then read: ${p.members.join(', ')}.` })),
  },
};

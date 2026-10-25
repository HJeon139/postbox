// The check of going to what an agent needs (#285): the runner’s go_to_needs action clicks the top bar’s “Next that
// needs you” button or an agent’s needs-you ring, and records where focus landed (facts.probes.jumps). Part of
// server/room-checks.mjs’s CHECKS, kept apart to keep that file to its size.

import { conversationOf, needsOrder, whereNeeds } from '../shared/needs.mjs';

const PLACES = {
  next: 'the “Next that needs you” button',
  rail: 'its rail row',
  agents: 'its row in the Agents section',
  overview: 'its overview card',
  message: 'the ring beside its message',
  topbar: 'its ring in the top bar',
};

/**
 * Who needed you when the runner clicked, in the order ⌃J takes them from the page it was on (a location.hash).
 * @param {any} state  @param {string} hash
 * @returns {{ here: string|null, needing: { handle: string, sessionId: string, itemId: string, kind: string, threadId: string, side: boolean, here: boolean }[] }}
 */
export function needsAt(state, hash) {
  const m = /^#\/t\/([^/]+)/.exec(String(hash ?? ''));
  const here = m && state.threads[m[1]] ? conversationOf(state, m[1]) : null;
  const live = Object.values(state.sessions ?? {}).filter((se) => !se.archived && !se.deleting && state.threads[se.threadId]);
  return {
    here,
    needing: needsOrder(state, live, here).map((se) => {
      const threadId = whereNeeds(state, se);
      const kind = state.threads[threadId]?.kind;
      return {
        handle: se.handle,
        sessionId: se.id,
        itemId: se.needs.itemId,
        kind: se.needs.kind,
        threadId,
        side: kind === 'side' || kind === 'topic',
        here: !!here && conversationOf(state, threadId) === here,
      };
    }),
  };
}

/** Where a jump should land: the agent clicked, or for ⌃J, the first in its order unless it follows another press. */
function expected(j, prev) {
  const needing = j.expect?.needing ?? [];
  if (j.from !== 'next') return needing.find((n) => n.handle === j.handle) ?? null;
  // Pressed again right after a press, it moves on through the rest: any of them is right.
  return prev?.from === 'next' ? null : (needing[0] ?? null);
}

export const NEEDS_CHECKS = [
  {
    id: 'needs-jump-missed',
    inputs: ['probes'],
    issue: 285,
    run: (f) =>
      (f.probes?.jumps ?? []).flatMap((j, i, all) => {
        const needing = j.expect?.needing ?? [];
        if (!needing.length) return [];
        const want = expected(j, all[i - 1]);
        // An agent that didn’t need you when clicked: its ring does what it always did.
        if (j.from !== 'next' && !want) return [];
        const onAsk = needing.find((n) => n.itemId === j.landed?.key);
        const right = want ? j.landed?.key === want.itemId : !!onAsk;
        const where = j.landed
          ? `${onAsk ? `@${onAsk.handle}’s ask` : `item ${j.landed.key}`}${j.landed.onScreen ? '' : ' (off screen)'}${j.landed.outlined ? '' : ' (not outlined)'}`
          : 'nothing';
        if (right && j.landed?.onScreen && j.landed?.outlined) return [];
        const who = want ? `@${want.handle}` : 'the next agent';
        return [
          {
            title: `Going to what ${who} needs from ${PLACES[j.from] ?? j.from} didn’t land on its ask`,
            evidence: `Step ${j.step}: from ${j.before}, with ${needing.map((n) => `@${n.handle}${n.side ? ' (side thread)' : ''}`).join(', ')} waiting, focus landed on ${where}${want && !right ? `, not @${want.handle}’s ask` : ''}.`,
          },
        ];
      }),
  },
];

export const NEEDS_TRIGGERS = {
  'two-need-you': {
    issue: 285,
    says: 'two or more agents needed you at once when you went to one of them',
    recorded: (f) => Array.isArray(f.probes?.jumps),
    run: (f) =>
      (f.probes.jumps ?? [])
        .filter((j) => (j.expect?.needing ?? []).length >= 2)
        .map((j) => ({ at: j.at ?? null, evidence: `${j.expect.needing.map((n) => `@${n.handle}`).join(', ')} were waiting at step ${j.step}.` })),
  },
  'side-thread-need': {
    issue: 285,
    says: 'you went to what an agent needed in a side or topic thread',
    recorded: (f) => Array.isArray(f.probes?.jumps),
    run: (f) =>
      (f.probes.jumps ?? [])
        .filter((j) => (j.expect?.needing ?? []).some((n) => n.side && (j.from === 'next' || n.handle === j.handle)))
        .map((j) => ({ at: j.at ?? null, evidence: `Step ${j.step}, from ${PLACES[j.from] ?? j.from}.` })),
  },
  'ring-jump': {
    issue: 285,
    says: 'you clicked a waiting agent’s ring or row, not the global button',
    recorded: (f) => Array.isArray(f.probes?.jumps),
    run: (f) =>
      (f.probes.jumps ?? [])
        .filter((j) => j.from !== 'next' && (j.expect?.needing ?? []).some((n) => n.handle === j.handle))
        .map((j) => ({ at: j.at ?? null, evidence: `@${j.handle}, from ${PLACES[j.from] ?? j.from}, at step ${j.step}.` })),
  },
};

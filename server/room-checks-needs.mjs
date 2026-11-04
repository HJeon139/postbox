// The check of going to what an agent needs (#285): the runner’s go_to_needs action clicks the top bar’s “Next that
// needs you” button or an agent’s needs-you ring, and records where focus landed (facts.probes.jumps). Part of
// server/room-checks.mjs’s CHECKS, kept apart to keep that file to its size.

import { conversationOf, needsOrder, whereNeeds } from '../shared/needs.mjs';
import { escapeRegExp } from '../shared/regex.mjs';

const PLACES = {
  next: 'the “Next that needs you” button',
  rail: 'its rail row',
  agents: 'its ring in the Agents section',
  message: 'the ring beside its message',
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

/**
 * Each time an agent's need fell back to an app card (#366): the app card was its need, a newer need of another kind
 * took its place, and when that was answered the need went back to the same app card, with no gap where it needed
 * nothing. Reads the sessions' needs as the history kept them (server/room-events.mjs).
 * @param {any[]} events
 */
function appFallbacks(events) {
  // By session: its need's kind and card, the app card it last needed you for, and whether a need of another kind
  // has taken that card's place since.
  /** @type {Map<string, { key: string, app: string|null, other: boolean }>} */
  const bySession = new Map();
  const found = [];
  for (const e of events ?? []) {
    if (e.type !== 'session' || !Object.hasOwn(e.data ?? {}, 'needs')) continue;
    const n = e.data.needs;
    const key = n ? `${n.kind}:${n.itemId}` : '';
    const was = bySession.get(e.data.id) ?? { key: '', app: null, other: false };
    // A session event comes with every patch: only a change of need counts.
    if (key === was.key) continue;
    let { app, other } = was;
    if (!n) {
      app = null;
      other = false;
    } else if (n.kind !== 'appsend') {
      other = app !== null;
    } else {
      if (other && app === n.itemId) {
        found.push({ at: null, evidence: `@${e.data.handle ?? e.data.id}’s need fell back to its app card ${n.itemId} (event ${e.seq}).` });
      }
      app = n.itemId;
      other = false;
    }
    bySession.set(e.data.id, { key, app, other });
  }
  return found;
}

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
  'declined-add-no-card': {
    issue: 693,
    says: 'after you declined adding an agent, another agent mentioned it in prose, and no new card asked you again',
    recorded: (f) => !!f.state,
    run: declinedThenMentioned,
  },
  'app-need-fallback': {
    issue: 366,
    says: 'an app card was an agent’s need, a newer need of another kind took it, and once that was answered the need fell back to the same app card',
    // A history from before sessions' needs were kept (server/room-events.mjs) didn't record them.
    recorded: (f) => (f.events ?? []).some((e) => e.type === 'session' && Object.hasOwn(e.data ?? {}, 'needs')),
    run: (f) => appFallbacks(f.events),
  },
};

/**
 * Each prose mention of an agent the person declined to add, later in that conversation, with no add-agent card for it
 * after the decline (#693). Read from the items alone, in the order the conversation keeps them; O(items).
 * @param {any} f  the run's facts: threads, and state.items by thread
 */
function declinedThenMentioned(f) {
  const out = [];
  for (const t of f.threads ?? []) {
    const items = f.state?.items?.[t] ?? [];
    items.forEach((card, i) => {
      if (card.kind !== 'hop' || !card.join || card.status !== 'declined') return;
      const after = items.slice(i + 1);
      const askedAgain = after.some((x) => x.kind === 'hop' && x.join && x.to === card.to);
      const mention = new RegExp(`(^|[^\\w@])@${escapeRegExp(card.to)}(?![\\w-])`);
      const said = after.find((x) => x.kind === 'agent' && typeof x.text === 'string' && mention.test(x.text));
      if (said && !askedAgain)
        out.push({
          at: said.at ?? null,
          evidence: `card ${card.id} to add @${card.to} was declined; @${said.handle} then mentioned @${card.to} (${said.id}), and no card asked again`,
        });
    });
  }
  return out;
}

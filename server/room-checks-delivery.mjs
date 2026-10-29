// The delivery checks (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to add”): a message
// addressed to an agent that never reached it, one that reached it twice without saying so, and a catch-up marker
// that moved in a turn that produced nothing. Each reads only what `main` records (server/room-delivery.mjs), and
// names the requirements it serves beside its issue. Part of server/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../shared/text.mjs';
import { addressed, headOf, holds, inputsOf, labeled, notCheckableAll, plain, recorded, turnsOf, unreadable } from './room-delivery.mjs';

/** A turn’s stream starts a moment after Postbox builds its prompt, which is when the marker moves. */
const MARKER_TO_SPAWN_MS = 30_000;

const said = (a) => `${a.how === 'mention' ? 'mention' : a.how === 'held' ? 'wake held on a card' : 'allowed wake'}${a.itemId ? ` ${a.itemId}` : ''}`;

/**
 * delivery-dropped: due to an agent, and in none of its prompts or tool results by the end of its next two turns.
 * One of those turns with no line in the transcript (stopped before Claude Code wrote its prompt) may have held it,
 * so the check says it couldn’t check it there.
 */
function droppedDeliveries(f) {
  const inputs = new Map();
  const unread = new Map();
  const out = [];
  for (const a of addressed(f)) {
    if (!inputs.has(a.to)) inputs.set(a.to, inputsOf(f, a.to));
    const got = inputs.get(a.to);
    // No transcript of the agent: what reached it can’t be read, so the check says it didn’t check it.
    if (!got) {
      unreadable(unread, a.to);
      continue;
    }
    const next = turnsOf(f, a.to).filter((t) => t.started > a.due);
    if (next.length < 2) continue;
    if (got.some((x) => x.at >= a.from - 1000 && x.at <= next[1].ended && holds(x, a))) continue;
    const blind = next.slice(0, 2).find((t) => !recorded(got, t));
    if (blind) {
      unreadable(unread, a.to, blind);
      continue;
    }
    out.push({
      key: `delivery-dropped:${a.to}:${a.itemId ?? headOf(a.text)}`,
      title: `A message addressed to @${a.to} never reached it`,
      evidence: `The ${said(a)} (“${clip(a.text, 100)}”) was due to @${a.to} from ${new Date(a.due).toISOString()}, and none of its prompts or tool results held it by the end of its next two turns.`,
    });
  }
  return [...notCheckableAll(f, 'delivery-dropped', unread), ...out];
}

/**
 * unlabeled-repeat: the same delivery, whole, in two of an agent’s prompts, the later one without a resend label.
 * Tool results don’t count: an agent may read a message again with read_message, and that’s its own doing. A turn
 * since it was due with no line in the transcript may have held a copy: when that could make two, the check says it
 * couldn’t check it there.
 */
function unlabeledRepeats(f) {
  const out = [];
  const inputs = new Map();
  const unread = new Map();
  for (const a of addressed(f)) {
    if (!inputs.has(a.to)) inputs.set(a.to, inputsOf(f, a.to));
    const head = headOf(a.text);
    if (!head) continue;
    const got = inputs.get(a.to);
    if (!got) {
      unreadable(unread, a.to);
      continue;
    }
    // In full: every letter and digit of it, in order. A pointer to it, or a message that quotes its start, isn’t.
    const all = plain(a.text);
    const whole = got.filter((x) => x.kind === 'prompt' && x.key.includes(all));
    const bare = whole.slice(1).find((x) => !labeled(x.text, a.text));
    if (!bare) {
      const blind = turnsOf(f, a.to).filter((t) => t.started >= a.from - 1000 && !recorded(got, t));
      if (whole.length + blind.length >= 2 && blind.length) unreadable(unread, a.to, blind[0]);
      continue;
    }
    out.push({
      key: `unlabeled-repeat:${a.to}:${a.itemId ?? head}`,
      title: `@${a.to} was given the same message twice, and the second time didn’t say it was a repeat`,
      evidence: `The ${said(a)} (“${clip(a.text, 100)}”) was in ${whole.length} of @${a.to}’s prompts, first at ${new Date(whole[0].at).toISOString()}, again at ${new Date(bare.at).toISOString()} with no resend label.`,
    });
  }
  return [...notCheckableAll(f, 'unlabeled-repeat', unread), ...out];
}

/**
 * marker-before-output: a session’s catch-up marker (seenItem) moved for a turn whose stream then produced no
 * output, so what the catch-up gave counts as read though the agent never saw it (DL-3, #508’s design: a turn that
 * fails before output leaves its deliveries waiting and the marker unmoved). The move is the session event that
 * changed it; its turn is that agent’s next stream, started within MARKER_TO_SPAWN_MS of it. It reads the session
 * events and streams, not transcripts, so a turn stopped before its transcript was written is checked all the same.
 */
function markersBeforeOutput(f) {
  const last = new Map();
  const out = [];
  for (const e of f.events ?? []) {
    if (e.type !== 'session' || !Object.hasOwn(e.data ?? {}, 'seenItem')) continue;
    const id = e.data.id;
    const before = last.get(id);
    last.set(id, e.data.seenItem);
    if (before === undefined || before === e.data.seenItem || !Number.isFinite(e.data.updatedAt)) continue;
    const handle = f.state?.sessions?.[id]?.handle;
    if (!handle) continue;
    const turn = turnsOf(f, handle).find((t) => t.started >= e.data.updatedAt - 1000 && t.started <= e.data.updatedAt + MARKER_TO_SPAWN_MS);
    if (!turn || turn.output) continue;
    out.push({
      key: `marker-before-output:${id}:${e.seq}`,
      title: `@${handle}’s catch-up marker moved in a turn that produced no output`,
      evidence: `Event ${e.seq} moved @${handle}’s marker from ${before ?? 'the start'} to ${e.data.seenItem}, and its turn started at ${new Date(turn.started).toISOString()} wrote nothing before it ended.`,
    });
  }
  return out;
}

export const DELIVERY_CHECKS = [
  {
    id: 'delivery-dropped',
    inputs: ['state', 'threads', 'streams', 'events', 'transcripts'],
    issue: 484,
    requirements: ['DL-1', 'SW-2'],
    run: droppedDeliveries,
  },
  { id: 'unlabeled-repeat', inputs: ['state', 'threads', 'events', 'transcripts'], issue: 484, requirements: ['DL-2', 'INV-4'], run: unlabeledRepeats },
  // DL-3 is #508’s own requirement (requirements.md; design.md, “A turn fails before any output”), not closed #484’s
  // defect, which was a summary leaving out a mention or giving a queued one twice.
  { id: 'marker-before-output', inputs: ['state', 'streams', 'events'], issue: 508, requirements: ['DL-3', 'INV-6'], run: markersBeforeOutput },
];

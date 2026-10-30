// The delivery checks (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to add”): a message
// addressed to an agent that never reached it, one that reached it twice without saying so, and a catch-up marker
// that moved in a turn that produced nothing. Each reads only what `main` records (server/room-delivery.mjs), and
// names the requirements it serves beside its issue. Part of server/room-checks.mjs’s CHECKS, kept apart for size.

import { clip } from '../shared/text.mjs';
import { addressed, headOf, holds, inputsOf, labeled, plain, recorded, tellable, turnsOf } from './room-delivery.mjs';
import { backendOf, notCheckableAll, notCheckableText, unreadable } from './room-unverified.mjs';

/** A turn’s stream starts a moment after Postbox builds its prompt, which is when the marker moves. */
const MARKER_TO_SPAWN_MS = 30_000;

const said = (a) => `${a.how === 'mention' ? 'mention' : a.how === 'held' ? 'wake held on a card' : 'allowed wake'}${a.itemId ? ` ${a.itemId}` : ''}`;

/**
 * delivery-dropped: due to an agent, and in none of its prompts or tool results by the end of its next two turns,
 * both ended: a turn still running may yet read it. A message with a head is matched by its start, a short one by its
 * whole text, within that window (holds); one too short for either, that no input names by its id, can’t be told from
 * other text, so the check says it couldn’t check it.
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
    // Two turns that have ended: one still running may yet read it.
    const next = turnsOf(f, a.to).filter((t) => t.started > a.due);
    if (next.length < 2 || next[0].running || next[1].running) continue;
    if (got.some((x) => x.at >= a.from - 1000 && x.at <= next[1].ended && holds(x, a))) continue;
    if (!tellable(a)) {
      out.push(notCheckableText(f, 'delivery-dropped', a));
      continue;
    }
    const blind = next.slice(0, 2).find((t) => !recorded(got, t));
    if (blind) {
      unreadable(unread, a.to, blind);
      continue;
    }
    out.push({
      key: `delivery-dropped:${a.to}:${a.itemId ?? headOf(a.text) ?? plain(a.text)}`,
      title: `A message addressed to @${a.to} never reached it`,
      evidence: `The ${said(a)} (“${clip(a.text, 100)}”) was due to @${a.to} from ${new Date(a.due).toISOString()}, and none of its prompts or tool results held it by the end of its next two turns.`,
    });
  }
  return [...notCheckableAll(f, 'delivery-dropped', unread), ...out];
}

/**
 * Whom a prompt that holds a delivery’s whole text gives it to, when other deliveries to that agent hold the same
 * text: the item it names, if it names one; otherwise every delivery that could have reached the agent by then, from
 * when it could reach it. Naming none, it is this delivery’s only when no other could have been due by then; one
 * that could be another’s as well is `unsure`, for the older delivery and the newer alike, and `other` is the first
 * such other delivery.
 * @param {ReturnType<typeof addressed>[number]} a  @param {ReturnType<typeof addressed>} all  @param {{ at: number, kind: string, text: string, key: string }[]} got
 */
function ownPrompts(a, all, got) {
  const text = plain(a.text);
  const same = all.filter((b) => b !== a && b.to === a.to && b.itemId !== a.itemId && plain(b.text).includes(text));
  const ids = same.map((b) => b.itemId).filter((id) => typeof id === 'string');
  const mine = [];
  const unsure = [];
  let other;
  for (const x of got) {
    if (x.kind !== 'prompt' || x.at < a.from - 1000 || !x.key.includes(text)) continue;
    if (a.itemId && x.text.includes(a.itemId)) mine.push(x);
    else if (ids.some((id) => x.text.includes(id))) continue;
    else {
      const rivals = same.filter((b) => x.at >= b.from - 1000 && x.key.includes(plain(b.text)));
      if (!rivals.length) mine.push(x);
      else {
        unsure.push(x);
        other ??= rivals[0];
      }
    }
  }
  return { mine, unsure, other };
}

/**
 * unlabeled-repeat: the same delivery, whole, in two of an agent’s prompts, the later one without a resend label.
 * Tool results don’t count: an agent may read a message again with read_message, and that’s its own doing. A prompt
 * counts for a delivery only from when it could reach the agent, and, when another delivery holds the same text, only
 * when it names its item or no other could have reached the agent by then (ownPrompts); one that could be more than one
 * delivery’s makes each of them unverified, not a finding. A turn since it was due with no line in the transcript may have held a copy: when that could make two,
 * the check says it couldn’t check it there.
 */
function unlabeledRepeats(f) {
  const out = [];
  const inputs = new Map();
  const unread = new Map();
  const all = addressed(f);
  for (const a of all) {
    if (!inputs.has(a.to)) inputs.set(a.to, inputsOf(f, a.to));
    const head = headOf(a.text);
    if (!head) continue;
    const got = inputs.get(a.to);
    if (!got) {
      unreadable(unread, a.to);
      continue;
    }
    // In full: every letter and digit of it, in order. A pointer to it, or a message that quotes its start, isn’t.
    const { mine, unsure, other } = ownPrompts(a, all, got);
    const bare = mine.slice(1).find((x) => !labeled(x.text, a.text));
    if (!bare) {
      if (unsure.length && mine.length + unsure.length >= 2) {
        out.push(sameText(f, a, head, other, unsure[0]));
        continue;
      }
      const blind = turnsOf(f, a.to).filter((t) => t.started >= a.from - 1000 && !recorded(got, t));
      if (mine.length + blind.length >= 2 && blind.length) unreadable(unread, a.to, blind[0]);
      continue;
    }
    out.push({
      key: `unlabeled-repeat:${a.to}:${a.itemId ?? head}`,
      title: `@${a.to} was given the same message twice, and the second time didn’t say it was a repeat`,
      evidence: `The ${said(a)} (“${clip(a.text, 100)}”) was in ${mine.length} of @${a.to}’s prompts, first at ${new Date(mine[0].at).toISOString()}, again at ${new Date(bare.at).toISOString()} with no resend label.`,
    });
  }
  return [...notCheckableAll(f, 'unlabeled-repeat', unread), ...out];
}

/** What unlabeled-repeat says of a delivery it can’t tell from another with the same text: unverified, not a defect. */
function sameText(f, a, head, rival, x) {
  const name = a.itemId ?? head;
  const other = rival.itemId ? `${rival.itemId}` : 'another delivery';
  return {
    key: `unlabeled-repeat:unverified:${a.to}:${name}`,
    issue: null,
    title: `unlabeled-repeat isn’t checkable for ${a.itemId ?? 'a delivery'} to @${a.to}: another item has the same text`,
    evidence: `The ${said(a)} (“${clip(a.text, 100)}”) came whole again in @${a.to}’s prompt at ${new Date(x.at).toISOString()}, which names no item, when ${other}, with the same text, could reach it too: it may be that one’s delivery or this one’s, so the check can’t tell.`,
    verdict: 'measurement',
    note: `Not a defect: unlabeled-repeat couldn’t tell ${name} from ${other} for @${a.to}, so this run doesn’t verify it there.`,
    unverified: { check: 'unlabeled-repeat', handle: a.to, backend: backendOf(f, a.to), item: a.itemId ?? null },
  };
}

/**
 * Whether the person stopped this turn (Stop, or Send now) before its first token: stop() (server/runtime.mjs) adds
 * the session’s empty agent item, status stopped, when the turn had said nothing, and sets the session to stopping;
 * either, within the turn’s span (and MARKER_TO_SPAWN_MS after, for a turn whose stream ended late), marks it.
 * @param {any} f  @param {string} sessionId  @param {{ started: number, ended: number }} turn
 */
function stoppedTurn(f, sessionId, turn) {
  const within = (at) => Number.isFinite(at) && at >= turn.started - 1000 && at <= turn.ended + MARKER_TO_SPAWN_MS;
  return (f.events ?? []).some(
    (e) =>
      (e.type === 'session' && e.data?.id === sessionId && e.data.state === 'stopping' && within(e.data.updatedAt ?? e.data.finishedAt)) ||
      (e.type === 'item.add' &&
        e.data?.item?.kind === 'agent' &&
        e.data.item.sessionId === sessionId &&
        e.data.item.status === 'stopped' &&
        within(e.data.item.stoppedAt)),
  );
}

/**
 * marker-before-output: a session’s catch-up marker (seenItem) moved for a turn whose stream then produced no
 * output, so what the catch-up gave counts as read though the agent never saw it (DL-3, #508’s design: a turn that
 * fails before output leaves its deliveries waiting and the marker unmoved). The move is the session event that
 * changed it; its turn is that agent’s next stream, started within MARKER_TO_SPAWN_MS of it. A turn the person stopped
 * before its first token (stoppedTurn) wrote nothing by their choice, not by a failure; and one whose prompt Claude
 * Code wrote to its transcript (recorded) delivered what the catch-up gave, which DL-3 counts as delivered: neither is
 * a finding. The transcript is read when the room has one; without it, the events and streams alone decide, so a turn
 * cut before any transcript line is checked all the same.
 */
function markersBeforeOutput(f) {
  const last = new Map();
  const inputs = new Map();
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
    // A turn still running may write yet: only one that ended with nothing counts.
    if (!turn || turn.running || turn.output) continue;
    if (!inputs.has(handle)) inputs.set(handle, inputsOf(f, handle));
    const got = inputs.get(handle);
    if ((got && recorded(got, turn)) || stoppedTurn(f, id, turn)) continue;
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

// The triggers of tests/uat/e2e/scenarios/hostwakes.md: a hand-off between agents while a wake card waits for the person.
// Two agents waking each other in turn stop after a hand-off and its answer (PAIR_LIMIT, shared/limits.mjs), and while
// that card is open a wake that needs a second card is refused (server/side-threads.mjs, askToWake). An agent here gets
// the refusal as wake_agent’s own result. An agent on a host gets the shim’s answer at once, and the refusal reaches it
// only at its next turn (server/remote/turns-tools.mjs, tellAgent), so nothing tells it its hand-off was lost.
//
// Postbox keeps no record of a refused wake (the told notice is in a session’s context, which the history drops), but it
// records every message it sends an agent from another (recordAgentMessage, server/side-threads.mjs), which the runner
// reads from its store as facts.received (tools/uat/run-files.mjs). So a wake_agent call its target never received
// was refused, whatever else woke the target meanwhile. Whether its sender was told reads which turns follow.

import { clip } from '../../server/helpers.mjs';
import { PAIR_LIMIT } from '../../shared/limits.mjs';
import { agentTurns, onHost, placeOf } from './remote-facts.mjs';
import { resultText } from './trigger-facts.mjs';

const MINUTE = 60_000;
/** How soon after a wake_agent call Postbox posts it, when it applies it: a host’s shim sends it on at once. */
const APPLIED_MS = MINUTE;
/** How far a host’s clock, which stamps its turn’s stream, may run ahead of this computer’s, which stamps items. */
const SKEW_MS = 30_000;
/** How long the scenario stays silent after phase 2’s hand-offs: a sender with no turn by then was never told. */
const SILENT_MS = 3 * MINUTE;
const hostRun = (f) => Boolean(f.hosts?.hosts?.length);
const itemsOf = (f) => (f.threads ?? []).flatMap((t) => f.state?.items?.[t] ?? []);
const handleOf = (s) => String(s ?? '').replace(/^@/, '');

/**
 * Every hop card, a wake past a limit’s or one asking to add an agent, since either refuses other wakes while it waits:
 * who asked about whom, when it opened, whether the pair limit raised it, and when the person answered it, from the
 * line resolveHop posts (server/side-threads.mjs). The facts are one conversation and its threads (threadsUnderTest),
 * and a card refuses wakes only in its own conversation, so these are the ones that can.
 */
export function hopCards(f) {
  const items = itemsOf(f);
  const said = (it, text) => items.find((v) => v.kind === 'voice' && v.text === text && (v.at ?? 0) >= (it.at ?? 0))?.at ?? null;
  return items
    .filter((it) => it.kind === 'hop')
    .map((it) => {
      const yes = it.join ? `Added @${it.to} to this conversation for @${it.from}` : `Allowed: @${it.from} wakes @${it.to}`;
      const no = it.join ? `Didn’t add @${it.to} to this conversation` : `Didn’t allow @${it.from} to wake @${it.to}`;
      const allowedAt = said(it, yes);
      const answeredAt = allowedAt ?? said(it, no);
      return {
        from: it.from,
        to: it.to,
        join: it.join === true,
        text: it.text ?? it.reason ?? '',
        at: it.at ?? null,
        pair: it.pair ?? null,
        status: it.status,
        allowedAt,
        answeredAt,
      };
    });
}

/**
 * Whether a hop card was waiting at this time: opened before it, and not yet answered. An answered card with no line
 * saying when isn’t taken as waiting: read as open for good, it would make every later refusal look like #439’s.
 */
const cardOpenAt = (cards, at, call) =>
  cards.some((c) => !raisedBy(c, call) && (c.at ?? Infinity) <= at && (c.status === 'open' || (c.answeredAt ?? -Infinity) > at));
/**
 * Whether this call raised the card: its own wake, which the card holds, not one the card refused. Matched by who, to
 * whom, what and roughly when, since a host stamps its call by its own clock (SKEW_MS), so it can read as after its card.
 */
const raisedBy = (c, call) =>
  c.from === call.from && c.to.toLowerCase() === call.to.toLowerCase() && c.text === call.message && Math.abs((c.at ?? Infinity) - call.at) <= SKEW_MS;

/**
 * Every wake_agent call in the recorded streams, with its result’s text, where its sender runs, and whether Postbox
 * applied it: its target received the call’s message within APPLIED_MS. Each record answers one call, in order, so an
 * agent that sends the same text twice has the second refusal seen. A target woken by another agent meanwhile doesn’t
 * make a refused call look applied (tests/uat-hostwakes.test.mjs replays a run where it did).
 */
export function wakeCalls(f) {
  // The sender’s next turn counts as the refusal’s only if the person did nothing in between: a question from the person
  // 11 s after a refused wake read as the sender told of the refusal (replayed in tests/uat-hostwakes.test.mjs).
  const acts = personActs(f);
  const personBetween = (from, to) => acts.some((t) => t > from && t <= to);
  const startsOf = turnStarts(f);
  const cards = hopCards(f);
  const received = [...(f.received ?? [])];
  return (
    (f.streams ?? [])
      .flatMap((s) => {
        const results = new Map();
        for (const e of s.events ?? [])
          if (e?.type === 'user')
            for (const b of Array.isArray(e.message?.content) ? e.message.content : []) if (b?.type === 'tool_result') results.set(b.tool_use_id, b);
        return (s.events ?? [])
          .filter((e) => e?.type === 'assistant')
          .flatMap((e) =>
            (Array.isArray(e.message?.content) ? e.message.content : [])
              .filter((b) => b?.type === 'tool_use' && /^mcp__[\w-]+__wake_agent$/.test(String(b.name)))
              .map((b) => {
                const at = Date.parse(e.timestamp);
                const to = handleOf(b.input?.handle);
                return {
                  from: s.handle,
                  to,
                  at: Number.isFinite(at) ? at : null,
                  text: resultText(results.get(b.id)),
                  message: String(b.input?.message ?? ''),
                  onHost: onHost(f, s.handle),
                  cardOpen: Number.isFinite(at) && cardOpenAt(cards, at, { from: s.handle, to, message: String(b.input?.message ?? ''), at }),
                };
              }),
          );
      })
      .sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
      .map((c) => ({ ...c, applied: receivedFor(c, received, c.at - SKEW_MS, c.at + APPLIED_MS) !== null }))
      // Once every call has claimed what it sent, a refused one whose message Postbox sent its target later was delivered
      // then. The record is written when Postbox accepts a wake, a busy target’s queued one included (sendWake,
      // server/side-threads.mjs), so this assumes what #439’s acceptance asks: a held wake is recorded, and posted, only
      // when it’s delivered, not while it waits. Recorded while it waits, it would read as applied, never refused.
      .map((c) => ({ ...c, deliveredAt: c.applied ? null : receivedFor(c, received, c.at, Infinity) }))
      .map((c) => ({
        ...c,
        senderNext: Number.isFinite(c.at) ? (startsOf(c.from).find((t) => t > /** @type {number} */ (c.at) && !personBetween(c.at, t)) ?? null) : null,
        targetNext: Number.isFinite(c.at) ? (startsOf(c.to).find((t) => t > /** @type {number} */ (c.at)) ?? null) : null,
        targetTurns: Number.isFinite(c.at) ? startsOf(c.to).filter((t) => t > /** @type {number} */ (c.at)) : [],
      }))
  );
}

/**
 * When each agent’s turns started, earliest first: its stream’s file says when its process started. A turn’s first item
 * can come after a call made in that same turn (a refused call 3 s before its turn’s first item, replayed in
 * tests/uat-hostwakes.test.mjs), so items are only the fallback, for an agent with no recorded streams.
 * @returns {(handle: string) => number[]}
 */
function turnStarts(f) {
  const turns = agentTurns(f);
  return (handle) => {
    const streams = (f.streams ?? []).filter((s) => s.handle === handle && Number.isFinite(s.started)).map((s) => /** @type {number} */ (s.started));
    const all = streams.length ? streams : turns.filter((t) => t.handle === handle && Number.isFinite(t.at)).map((t) => /** @type {number} */ (t.at));
    return all.sort((a, b) => a - b);
  };
}

/** When the person acted: a message, or an answer or Allow (a voice line). A turn that follows one may be theirs. */
const personActs = (f) =>
  itemsOf(f)
    .filter((it) => (it.kind === 'user' || it.kind === 'voice') && Number.isFinite(it.at))
    .map((it) => /** @type {number} */ (it.at));

/** When the facts were read: checks run during the run, so now, unless the facts say (a replay, a test). */
const factsAt = (f) => (Number.isFinite(f.now) ? f.now : Date.now());

/**
 * When Postbox sent this call’s message to its target, between from and to, taking that record so no other call can
 * claim it, or null. The record keeps the message as recordAgentMessage clips it (server/side-threads.mjs).
 */
function receivedFor(c, received, from, to) {
  if (!Number.isFinite(c.at)) return null;
  const text = clip(c.message, 120);
  // Postbox matches a handle without case (personaByHandle), and records the session’s own.
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const i = received.findIndex((r) => same(r.handle, c.to) && same(r.from, c.from) && r.text === text && r.at >= from && r.at <= to);
  if (i < 0) return null;
  const [r] = received.splice(i, 1);
  return /** @type {number} */ (r.at);
}

/** The calls Postbox refused: a hop card was waiting, and it didn’t send the call’s message to its target. */
const refused = (f) => wakeCalls(f).filter((c) => c.cardOpen && !c.applied);
const where = (f, h) => (placeOf(f, h) === 'local' ? 'this computer' : placeOf(f, h));

/**
 * The defects, as checks (tools/uat/checks-remote.mjs): a refused wake that its host sender was told was sent, and a
 * refused hand-off that nobody resent. Both are #439’s: its fix holds the wake, and makes wake_agent wait for Postbox’s
 * answer on a host, so the agent there hears what became of it.
 */
export const HOSTWAKE_CHECKS = [
  {
    id: 'host-wake-said-sent',
    issue: 439,
    run: (f) =>
      hostRun(f)
        ? refused(f)
            .filter((c) => c.onHost && /Sent your message|applies it as soon/i.test(c.text))
            .map((c) => ({
              key: `${c.from}:${c.to}:${c.at}`,
              title: `@${c.from} on ${where(f, c.from)} was told its wake of @${c.to} was sent, and Postbox refused it`,
              evidence: `wake_agent answered “${c.text.slice(0, 80)}”, but Postbox didn’t send it to @${c.to} within a minute: a wake card was waiting.`,
            }))
        : [],
  },
  {
    id: 'refused-wake-lost',
    issue: 439,
    // Host mode only, like host-wake-said-sent: withRemote (tools/uat/checks.mjs) puts these checks in every run, and
    // other scenarios aren’t built to tell a refused hand-off from one an agent never meant to make.
    run: (f) =>
      hostRun(f)
        ? refused(f)
            // Judged only once SILENT_MS have passed since the call: run during the run, a window not over yet proves nothing.
            .filter(
              (c) => c.at !== null && c.at + SILENT_MS <= factsAt(f) && (c.senderNext === null || c.senderNext > c.at + SILENT_MS) && c.deliveredAt === null,
            )
            .map((c) => ({
              key: `${c.from}:${c.to}:${c.at}`,
              title: `@${c.from}’s hand-off to @${c.to} was refused and lost`,
              evidence: `A wake card was waiting, so the wake was refused; for 3 minutes after, @${c.from} started no turn but ones you started, and Postbox never delivered it to @${c.to}.`,
            }))
        : [],
  },
];

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const HOSTWAKE_TRIGGERS = {
  'pair-card-opened': {
    issue: 439,
    says: 'a third wake in a row between the same two agents raised a card, which waited for you',
    recorded: (f) => !!f.state,
    run: (f) =>
      hopCards(f)
        .filter((c) => c.pair === PAIR_LIMIT)
        .map((c) => ({
          at: c.at,
          evidence: `@${c.from}’s third wake of @${c.to} in a row raised a card, ${c.allowedAt ? 'allowed later' : 'still waiting'}.`,
        })),
  },
  'refused-wake-told-in-turn': {
    issue: 439,
    says: 'an agent on a host whose wake was refused was told so, and acted, within a minute',
    recorded: hostRun,
    run: (f) =>
      refused(f)
        .filter((c) => c.onHost && c.at !== null && c.senderNext !== null && c.senderNext <= c.at + APPLIED_MS)
        .map((c) => ({
          at: c.senderNext,
          evidence: `@${c.from} (${where(f, c.from)}) started a turn ${Math.round(/** @type {number} */ (c.senderNext - /** @type {number} */ (c.at)) / 1000)} s after its refused wake of @${c.to}.`,
        })),
  },
  'local-wake-told-in-turn': {
    issue: 439,
    says: 'an agent on this computer whose wake was refused got the refusal as the call’s own result',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) =>
      wakeCalls(f)
        .filter((c) => !c.onHost && /wasn’t sent/.test(c.text))
        .map((c) => ({ at: c.at, evidence: `@${c.from}’s wake of @${c.to} answered: “${c.text.slice(0, 100)}”.` })),
  },
  'held-wake-delivered-after-allow': {
    issue: 439,
    says: 'a hand-off refused while a card waited reached its target once you allowed the card, without being sent again',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) => {
      const calls = wakeCalls(f);
      const allowedAt = hopCards(f)
        .map((c) => c.allowedAt)
        .filter((t) => t !== null);
      return calls
        .filter((c) => c.cardOpen && !c.applied && c.at !== null)
        .flatMap((c) => {
          const allow = allowedAt.filter((t) => t > /** @type {number} */ (c.at)).sort((a, b) => a - b)[0];
          // Only the refused hand-off’s own message counts, sent to its target after the Allow; a turn of its target
          // started by anything else, such as the wake the card held, isn’t it (tests/uat-hostwakes.test.mjs). A resend by the
          // agent claims its own record, so it never reads as Postbox’s delivery.
          const delivered = c.deliveredAt;
          if (!allow || delivered === null || delivered < allow) return [];
          const turn = c.targetTurns.find((t) => t >= delivered - SKEW_MS);
          if (turn === undefined) return [];
          return [
            { at: turn, evidence: `Postbox sent @${c.from}’s refused hand-off to @${c.to} after you allowed the card, and @${c.to} started a turn with it.` },
          ];
        });
    },
  },
};

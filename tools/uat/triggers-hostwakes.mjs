// The triggers of tests/uat/e2e/scenarios/hostwakes.md: a hand-off between agents while a wake card waits for the person.
// Two agents waking each other in turn stop after a hand-off and its answer (PAIR_LIMIT, shared/limits.mjs), and while
// that card is open a wake that needs a second card is refused (server/side-threads.mjs, askToWake). An agent here gets
// the refusal as wake_agent’s own result. An agent on a host gets the shim’s answer at once, and the refusal reaches it
// only at its next turn (server/remote/turns-tools.mjs, tellAgent), so nothing tells it its hand-off was lost.
//
// Postbox keeps no record of a refused wake (the told notice is in a session’s context, which the history drops), so
// these read what follows a wake_agent call: whether its target started a turn, and whether its sender did. The
// scenario keeps the person silent in those windows, so a turn that starts there was started by the wake or the notice.

import { PAIR_LIMIT } from '../../shared/limits.mjs';
import { agentTurns, onHost, placeOf } from './remote-facts.mjs';
import { resultText } from './trigger-facts.mjs';

const MINUTE = 60_000;
/** How soon after a wake_agent call its target’s turn starts when Postbox applies it. */
const APPLIED_MS = MINUTE;
/** How long the scenario stays silent after phase 2’s hand-offs: a sender with no turn by then was never told. */
const SILENT_MS = 3 * MINUTE;
const hostRun = (f) => Boolean(f.hosts?.hosts?.length);
const itemsOf = (f) => (f.threads ?? []).flatMap((t) => f.state?.items?.[t] ?? []);
const handleOf = (s) => String(s ?? '').replace(/^@/, '');

/** Every hop card: who asked to wake whom, when it opened, whether the pair limit raised it, and when it was allowed. */
export function hopCards(f) {
  const items = itemsOf(f);
  return items
    .filter((it) => it.kind === 'hop' && !it.join)
    .map((it) => {
      const allowed = items.find((v) => v.kind === 'voice' && v.text === `Allowed: @${it.from} wakes @${it.to}` && (v.at ?? 0) >= (it.at ?? 0));
      return { from: it.from, to: it.to, at: it.at ?? null, pair: it.pair ?? null, status: it.status, allowedAt: allowed?.at ?? null };
    });
}

/** Whether a hop card was waiting at this time: opened before it, and not yet answered. */
const cardOpenAt = (cards, at) => cards.some((c) => (c.at ?? Infinity) <= at && (c.status === 'open' || (c.allowedAt ?? Infinity) > at));

/**
 * Every wake_agent call in the recorded streams, with its result’s text, where its sender runs, and whether Postbox
 * applied it: its target started a turn within APPLIED_MS.
 */
export function wakeCalls(f) {
  const turns = agentTurns(f);
  const startsOf = (handle) => turns.filter((t) => t.handle === handle && Number.isFinite(t.at)).map((t) => /** @type {number} */ (t.at));
  const cards = hopCards(f);
  return (f.streams ?? [])
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
              const applied = Number.isFinite(at) && startsOf(to).some((t) => t > at && t <= at + APPLIED_MS);
              return {
                from: s.handle,
                to,
                at: Number.isFinite(at) ? at : null,
                text: resultText(results.get(b.id)),
                onHost: onHost(f, s.handle),
                applied,
                cardOpen: Number.isFinite(at) && cardOpenAt(cards, at),
              };
            }),
        );
    })
    .map((c) => ({
      ...c,
      senderNext: Number.isFinite(c.at) ? (startsOf(c.from).find((t) => t > /** @type {number} */ (c.at)) ?? null) : null,
      targetNext: Number.isFinite(c.at) ? (startsOf(c.to).find((t) => t > /** @type {number} */ (c.at)) ?? null) : null,
    }));
}

/** The calls Postbox refused: a hop card was waiting, and the target didn’t start a turn. */
const refused = (f) => wakeCalls(f).filter((c) => c.cardOpen && !c.applied);
const where = (f, h) => (placeOf(f, h) === 'local' ? 'this computer' : placeOf(f, h));

/**
 * The defects, as checks (tools/uat/checks-remote.mjs): a refused wake that its host sender was told was sent, and a
 * refused hand-off that nobody resent. issue: null until the host part is filed; #326 is the dropped wake itself.
 */
export const HOSTWAKE_CHECKS = [
  {
    id: 'host-wake-said-sent',
    issue: null,
    run: (f) =>
      hostRun(f)
        ? refused(f)
            .filter((c) => c.onHost && /Sent your message|applies it as soon/i.test(c.text))
            .map((c) => ({
              key: `${c.from}:${c.to}:${c.at}`,
              title: `@${c.from} on ${where(f, c.from)} was told its wake of @${c.to} was sent, and Postbox refused it`,
              evidence: `wake_agent answered “${c.text.slice(0, 80)}”, and @${c.to} never started a turn: a wake card was waiting.`,
            }))
        : [],
  },
  {
    id: 'refused-wake-lost',
    issue: 326,
    run: (f) =>
      refused(f)
        .filter((c) => c.at !== null && (c.senderNext === null || c.senderNext > c.at + SILENT_MS) && c.targetNext === null)
        .map((c) => ({
          key: `${c.from}:${c.to}:${c.at}`,
          title: `@${c.from}’s hand-off to @${c.to} was refused and lost`,
          evidence: `A wake card was waiting, so the wake was refused; @${c.from} had no turn for 3 minutes after, and @${c.to} never had one.`,
        })),
  },
];

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const HOSTWAKE_TRIGGERS = {
  'pair-card-opened': {
    issue: 326,
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
    issue: 326,
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
    issue: 326,
    says: 'an agent on this computer whose wake was refused got the refusal as the call’s own result',
    recorded: (f) => !!f.state && Array.isArray(f.streams),
    run: (f) =>
      wakeCalls(f)
        .filter((c) => !c.onHost && /wasn’t sent/.test(c.text))
        .map((c) => ({ at: c.at, evidence: `@${c.from}’s wake of @${c.to} answered: “${c.text.slice(0, 100)}”.` })),
  },
  'held-wake-delivered-after-allow': {
    issue: 326,
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
          if (!allow || c.targetNext === null || c.targetNext < allow) return [];
          // Sent again by its agent after the Allow: that’s the agent’s resend, not Postbox’s delivery.
          if (calls.some((x) => x.from === c.from && x.to === c.to && x.at !== null && x.at > allow && x.at < /** @type {number} */ (c.targetNext))) return [];
          return [{ at: c.targetNext, evidence: `@${c.to} started a turn after you allowed the card, with @${c.from}’s refused hand-off and no resend.` }];
        });
    },
  },
};

// Mentions held on a wake card while it waited (#439), for the hostwakes checks (tools/uat/triggers-hostwakes.mjs).
// Since wake_agent is gone (#481), a held hand-off is a mention, which the card item keeps in its `held` list.

import { placeName } from './remote-facts.mjs';

/**
 * Mentions held on a card while it waited (#439), as the card item keeps them (`held`, server/wake-cards.mjs): a
 * mention’s has the id of the message it came from. Since wake_agent is gone (#481), this is how a held hand-off shows.
 * @param {any} f
 */
export function heldMentions(f) {
  return Object.values(f.state?.items ?? {})
    .flat()
    .filter((/** @type {any} */ it) => it?.kind === 'hop')
    .flatMap((/** @type {any} */ card) => (card.held ?? []).filter((/** @type {any} */ h) => h?.itemId))
    .map((/** @type {any} */ h) => ({
      at: h.at ?? null,
      evidence: `@${h.from}’s mention of @${h.to} is held (${placeName(f, h.from)}): “${String(h.text ?? '').slice(0, 100)}”.`,
    }));
}

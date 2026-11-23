// A turn left running under an older Postbox on its host (#759, designs/759-adopt-old-turns.md). The host’s daemon
// relays it to that version’s daemon, and says `relay` when it can’t (off) or when the relay ended while the turn ran
// (lost). The turn gets a step that says so, and a lost relay ends the turn’s open prompt cards: an answer can’t reach
// the older daemon now, and that daemon sends an expiry only once. A card ended this way stays ended, as any ended
// card does (turns-prompts.mjs, onPrompt), even if a relay comes back and the older daemon sends its prompt again:
// that daemon then denies it at its own permissionWaitMax.

import { openCards } from './turns-prompt-cards.mjs';
import { endCard } from './turns-prompts.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/** The step of a turn that was never relayed. @param {string} version @param {string} host */
export const relayOffText = (version, host) =>
  `This turn started under Postbox ${version} on ${host}. Its blocks, messages and questions after the update can’t reach this conversation.`;
/** The step of a turn whose relay ended while it ran. @param {string} version @param {string} host */
export const relayLostText = (version, host) =>
  `Postbox lost its link to Postbox ${version} on ${host}, which this turn runs under. A question or block it sent meanwhile may not have arrived.`;
/** What a card says when its turn’s relay ended. */
export const RELAY_LOST_CARD = 'Postbox lost its link to the Postbox version this turn runs under, so this can’t be answered any more.';

/**
 * @param {RemoteTurns} rts @param {string} hostId
 * @param {{ turn: string, version: string, state: 'off' | 'lost' }} m
 */
export function onRelay(rts, hostId, m) {
  const host = rts.rt.s.hosts?.[hostId]?.name ?? 'its host';
  const label = m.state === 'off' ? relayOffText(m.version, host) : relayLostText(m.version, host);
  // One step for each state: a relay lost twice says so once.
  rts.byTurn.get(m.turn)?.step?.({ id: `relay-${m.state}-${m.turn}`, label, state: 'failed' });
  if (m.state !== 'lost') return;
  for (const card of openCards(rts, m.turn)) endCard(rts, card, 'expired', RELAY_LOST_CARD, rts.now());
}

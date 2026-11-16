// Turns’ one port into waiting code (designs/architecture/services.md, “Delivery and Turns, built as the inbox”,
// Turns: “Calls into waiting code”): until the permission layer goes and Asks is built, a turn asks the person, records
// a refusal, expires its permission cards and reads or releases what the person needs only through these calls.
// The composition root builds it with the Runtime and hands it to Turns as `asks`.

import { keptTurns, nextNeed, noticeNeed, releaseNeed, stateFor, TURN_TIED } from './card-needs.mjs';

/** @param {any} rt */
export function asksPort(rt) {
  return {
    /** A turn’s tool call asks the person: a permission card, or the harness’s own question. @param {string} sessionId @param {any} req */
    requestPermission: (sessionId, req) => rt.requestPermission(sessionId, req),
    /** A refusal the harness made on its own, as a card that offers Always allow. @param {any} turn @param {any} d */
    recordDenial: (turn, d) => rt.recordDenial(turn, d),
    /**
     * Every permission card the agent’s turn waits on expires: at the turn’s end, or at Stop, with what the card is told
     * and who stopped it. @param {string} sessionId @param {string} [message] @param {object} [patch]
     */
    expirePermissions(sessionId, message, patch = {}) {
      for (const [id, w] of rt.permissionWaits) if (w.sessionId === sessionId) rt.settlePermission(id, 'expired', message, {}, patch);
    },
    /** The turns still asking the person something, which a turn that doesn’t move on keeps. @param {any} se */
    keptTurns: (se) => keptTurns(rt, se),
    /** Whether a need is tied to a turn, so the person moving on clears it. @param {string} kind */
    turnTied: (kind) => TURN_TIED.has(kind),
    /** @param {any} se @param {string} itemId @param {string} [busy] @param {{ turnIds?: string[] }} [opts] */
    releaseNeed: (se, itemId, busy, opts) => releaseNeed(rt, se, itemId, busy, opts),
    /** @param {any} se @param {{ turnIds?: string[], keep?: string|null }} [opts] */
    nextNeed: (se, opts) => nextNeed(rt, se, opts),
    /** @param {any} se @param {any} needs */
    noticeNeed: (se, needs) => noticeNeed(rt, se, needs),
    stateFor,
  };
}

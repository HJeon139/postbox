// What an update_block does, and what a host refuses of one before Postbox sees it (#854). Postbox (server/blocks.mjs)
// and a host’s daemon (broker-tools.mjs) and shim (shim-calls.mjs) all read it here, so none of them can judge an
// update differently.

import { validateBlock } from './catalog.mjs';

/**
 * What an update_block does, in the order Postbox applies it (#854): withdraws the block, records an outcome on it,
 * or replaces it with a whole block, which validateBlock checks. Postbox and a host’s daemon and shim read it alike.
 * @param {unknown} block  the update as the agent sent it
 * @returns {'withdraw' | 'outcome' | 'block'}
 */
export function updateKind(block) {
  if (block === null || typeof block !== 'object') return 'block';
  if (Object.hasOwn(block, 'withdraw')) return 'withdraw';
  return typeof (/** @type {{ outcome?: unknown }} */ (block).outcome) === 'string' ? 'outcome' : 'block';
}

/**
 * Why a host refuses an update_block before Postbox sees it, or null to send it on (#854). A host’s shim, in the call,
 * and its daemon both ask this, so they can’t disagree: only a whole block is checked, with the image origin left to
 * Postbox, which has the person’s list.
 * @param {unknown} block  the update as the agent sent it @returns {string | null}
 */
export function hostUpdateRefusal(block) {
  if (updateKind(block) !== 'block') return null;
  const v = validateBlock(block, { origins: 'later' });
  return v.ok ? null : `The update was invalid and wasn’t applied: ${v.errors.join(' ')}`;
}

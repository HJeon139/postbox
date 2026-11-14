// What an update_block does, and what a host refuses of one, or of a show_block (#1319), before Postbox sees it
// (#854). Postbox (server/blocks.mjs) and a host’s daemon (broker-tools.mjs) and shim (shim-calls.mjs) all read it
// here, so none of them can judge a block differently.

import { notShown, withShape } from './block-examples.mjs';
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
  return v.ok ? null : `The update was invalid and wasn’t applied: ${withShape(v.errors, block)}`;
}

/**
 * Why a host refuses a show_block before Postbox sees it, or null to send it on (#1319): the block the laptop would
 * refuse, in its words (server/block-show.mjs), checked against the host’s own catalog, which is the one its agent
 * was offered. An app’s intent is left out, since Postbox trims one rather than refusing it (#995), and an image’s
 * origin is Postbox’s to check. @param {unknown} block  the block as the agent sent it @returns {string | null}
 */
export function hostShowRefusal(block) {
  const app = block !== null && typeof block === 'object' && /** @type {any} */ (block).type === 'app';
  const v = validateBlock(app ? { ...block, intent: undefined } : block, { origins: 'later' });
  return v.ok ? null : notShown(v.errors, block);
}

/**
 * The refusal a host makes of a block call before Postbox sees it, or null: its shim in the call and its daemon both
 * ask this. @param {string} name  the tool @param {unknown} block  the call’s block
 */
export function hostBlockRefusal(name, block) {
  if (name === 'update_block') return hostUpdateRefusal(block);
  if (name === 'show_block') return hostShowRefusal(block);
  return null;
}

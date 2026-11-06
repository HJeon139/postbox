// What an update_block does (#854). Postbox (server/blocks.mjs) and a host’s daemon (broker-tools.mjs) and shim
// (shim-calls.mjs) all read it here, so none of them can judge an update differently.

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

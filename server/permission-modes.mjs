// The two permission modes a persona runs in: auto, where its harness judges each call in its own Auto mode, and
// bypass, where it runs everything. Postbox’s own Ask me and Accept edits are gone, so a persona stored with one runs
// Auto from its next turn, as one picked now would.

import { httpError } from './helpers.mjs';

export const PERMISSION_MODES = ['auto', 'bypass'];
/** The modes Postbox had before, which a persona stored or sent with one runs as Auto. */
const RETIRED = ['ask', 'acceptEdits'];

/** A stored mode as a turn runs it: Run everything stays, and anything else is Auto. @param {unknown} mode */
export const runsAs = (mode) => (mode === 'bypass' ? 'bypass' : 'auto');

/**
 * A mode a person or an agent sends, as it’s stored: a retired one is Auto, and anything else is refused.
 * @param {unknown} mode @returns {'auto' | 'bypass'}
 */
export function checkedMode(mode) {
  if (mode === 'auto' || mode === 'bypass') return mode;
  if (RETIRED.includes(/** @type {string} */ (mode))) return 'auto';
  throw httpError(422, `Permissions are one of ${PERMISSION_MODES.join(', ')}.`);
}

/** Every stored persona with a retired mode, or none, runs Auto: written once, as the store loads. @param {any} rt */
export function retireModes(rt) {
  for (const p of Object.values(rt.s.personas))
    if (p.permissionMode !== runsAs(p.permissionMode)) rt.store.emit('persona', { ...p, permissionMode: runsAs(p.permissionMode) });
}

// The rings beside an agent’s replies in a transcript (#622). Only the one beside its latest reply follows its session,
// as the words beside its name do (paintStateWords): it moves, and it’s the button to what the agent needs. The rings
// beside its earlier replies rest idle at the context they last showed, so a session change draws one ring, not one
// for each reply the agent ever wrote.

import { ringFor } from './ring.mjs';

/**
 * Paints the transcript’s rings of one session: the last follows it, and those before it rest.
 * @param {HTMLElement} root  the transcript @param {any} se  the session
 */
export function paintReplyRings(root, se) {
  if (!se) return;
  const rings = root.querySelectorAll(`pb-ring[data-session="${CSS.escape(se.id)}"]`);
  rings.forEach((r, i) => {
    const size = r.getAttribute('size') ?? 'xs';
    if (i === rings.length - 1) ringFor(se, size, r);
    else if (r.getAttribute('state') !== 'idle' || r.getAttribute('subs')) {
      const ctx = r.getAttribute('ctx');
      ringFor({ ...se, state: 'idle', subagents: [], ctx: ctx === 'unknown' ? null : ctx }, size, r);
    }
  });
}

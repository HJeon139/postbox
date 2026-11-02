// The rings beside an agent’s replies in a transcript (#622). Only the one beside its latest reply follows its session,
// as the words beside its name do: it moves, and it’s the button to what the agent needs. The rings beside its earlier
// replies rest: they say only whose they are, with no state or context, so a session change draws one ring, not one for
// each reply the agent ever wrote.

import { restRing, ringFor } from './ring.mjs';

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
    else if (r.getAttribute('state') !== 'rest') restRing(r);
  });
}

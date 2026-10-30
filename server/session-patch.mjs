// A session’s change as the store carries it: session.patch, with only the fields that changed (designs/508, “Store
// events”). A whole session went with every change before, about a kilobyte or more each time a working agent’s step,
// context or subagents moved; the shared reducer (shared/state.mjs) merges the patch into the session it names.

/** Whether two field values are the same, by value for the arrays and objects a session holds. */
const same = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/**
 * The session.patch event for a change to a session: the fields it sets to something new, and by name those it sets
 * to undefined that the session holds, since JSON drops an undefined.
 *
 * A field is compared with what the session holds, so a change that mutated a field’s object or array in place (say,
 * pushing onto se.jobs) and passed it back is invisible here, and nothing is emitted for it. No caller does that today:
 * every change passes a new array or object (updateSession’s callers build them with spreads and map). Keep it so.
 * @param {Record<string, any>} se  the session as it is
 * @param {Record<string, any>} change  the fields to set
 * @returns {{ id: string, patch: Record<string, any>, unset?: string[] }}
 */
export function sessionPatch(se, change) {
  /** @type {Record<string, any>} */
  const patch = {};
  const unset = [];
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) {
      if (Object.hasOwn(se, k)) unset.push(k);
    } else if (!Object.hasOwn(se, k) || !same(se[k], v)) patch[k] = v;
  }
  return unset.length ? { id: se.id, patch, unset } : { id: se.id, patch };
}

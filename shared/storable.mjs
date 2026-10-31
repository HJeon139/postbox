// What the store’s Redis would refuse, found before anything is applied or broadcast (#508’s design, “Storage: a Redis
// 8 server that Postbox bundles and runs”; the integrator’s review of #553, blocker 2). RedisJSON 8.10.3 parses a
// document with serde_json, which refuses nesting 128 levels deep (“recursion limit exceeded”: 127 levels are taken)
// and a string holding a lone surrogate, half of a character cut in two (“unexpected end of hex escape”). An optimistic
// emit that reached either wedged the store, so the store checks each event’s JSON here first, and the entry points
// where an agent or app hands Postbox JSON of its own shape (an app’s saved state, an app’s event) refuse it with the
// same words. LIMITS.jsonDepth is the depth an event’s data may have: the document adds one level around it.

import { LIMITS } from './limits.mjs';

/**
 * The depth an event’s data may have, where the store checks every event (server/store-check.mjs): an app’s value sits
 * a few levels into its event (an app’s state one level in, an event’s values about four, in the agent’s session), and
 * the document Redis holds adds one more, which keeps the whole under RedisJSON’s 127.
 */
export const EVENT_DEPTH = LIMITS.jsonDepth + 20;

/**
 * The deepest document RedisJSON 8.10.3 holds: it parses with serde_json, whose recursion limit refuses the 128th level.
 * The import of an old store checks each document against this (server/store-import.mjs), since old Postbox capped an
 * app’s state by size alone; a running store checks events at EVENT_DEPTH, well inside it.
 */
export const REDIS_DEPTH = 127;

/**
 * How deep a JSON text nests: 0 for a scalar, 1 for a flat object or array. Brackets inside strings don’t count.
 * @param {string} text
 */
export function depthOf(text) {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // a backslash: skip what it escapes
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 123 || c === 91) {
      if (++depth > max) max = depth;
    } else if (c === 125 || c === 93) depth--;
  }
  return max;
}

// JSON.stringify writes a paired surrogate as the character itself and a lone one as its \udXXX escape, so an escape
// in the range in a stringified text is a lone surrogate, unless the backslash is itself escaped (the six characters).
const LONE_SURROGATE = /(?<!\\)(?:\\\\)*\\ud[89a-f][0-9a-f]{2}/i;

/**
 * Why Redis would refuse this JSON text, as JSON.stringify made it, or null when it would take it.
 * @param {string} text @param {{ jsonDepth: number }} [limits]
 * @returns {(Error & { code: 'EUNSTORABLE', cut?: boolean }) | null}
 */
export function storable(text, limits = LIMITS) {
  // A text nested n levels deep is at least 2n characters long, so a short one needn’t be scanned.
  if (text.length > 2 * limits.jsonDepth) {
    const depth = depthOf(text);
    if (depth > limits.jsonDepth)
      return Object.assign(
        new Error(
          `This JSON is nested ${depth} levels deep; Postbox stores up to ${limits.jsonDepth}. Flatten it, or send ids and keep the detail in your own files.`,
        ),
        {
          code: /** @type {const} */ ('EUNSTORABLE'),
        },
      );
  }
  if (LONE_SURROGATE.test(text))
    return Object.assign(
      new Error('This JSON holds half of a character (a lone surrogate), which Postbox can’t store. Cut text between characters, not inside one.'),
      {
        code: /** @type {const} */ ('EUNSTORABLE'),
        cut: true,
      },
    );
  return null;
}

/**
 * The value with every lone surrogate in its strings replaced by U+FFFD, changed in place where it’s an object or an
 * array: what the store does for its own callers, since Postbox cuts agents’ text to a length everywhere.
 * @template T @param {T} value @returns {T}
 */
export function wellFormed(value) {
  // String.prototype.isWellFormed and toWellFormed are ES2024, which Node 22 has and the type library here doesn’t name.
  if (typeof value === 'string') {
    const str = /** @type {any} */ (value);
    return str.isWellFormed() ? value : str.toWellFormed();
  }
  if (value && typeof value === 'object')
    for (const k of Object.keys(value)) {
      const v = /** @type {any} */ (value)[k];
      const w = wellFormed(v);
      if (w !== v) /** @type {any} */ (value)[k] = w;
    }
  return value;
}

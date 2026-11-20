// What each turn sent its agent, in the store’s events (their entries in EVENTS, shared/state.mjs): the system prompt
// Postbox appends (its guide, once per distinct text, by its SHA-256), and each prompt a turn sent, whole, naming the
// guide it went with. They change no state: they are a record in the log and on /api/stream, which an ATIF
// trajectory reads (tools/atif.mjs), so a reviewer sees what the agent was given (hydrant-critic’s review of #1522).
// The backend’s own system prompt (Claude Code’s, Codex’s) isn’t Postbox’s to see, and isn’t here.

/** Refuses an event without its fields, before anything changes (#609). @param {any} d @param {string[]} strings */
function check(d, strings) {
  for (const k of strings) if (typeof d[k] !== 'string') throw new TypeError(`A turn prompt event’s ${k} is a string.`);
}

export const PROMPT_EVENTS = Object.freeze({
  'turn.guide': { apply: (/** @type {any} */ _s, /** @type {any} */ d) => check(d, ['sha', 'text']), public: true },
  'turn.prompt': { apply: (/** @type {any} */ _s, /** @type {any} */ d) => check(d, ['sessionId', 'turnId', 'text']), public: true },
});

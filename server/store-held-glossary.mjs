// A thread’s glossary as memory will hold it once the emits held behind a commit are released (#1819): a term an
// agent defines with define_term while a commit is held is pending, not published, and the reply that uses it in the
// same turn is checked at the turn’s end (server/turn-checks.mjs), so the check reads the glossary as written. The
// reducer keeps one map per thread, by term key (shared/state.mjs, putGlossary). A `glossary` event puts one entry,
// and only a thread’s removal deletes them: there is no event that removes one term.
//
// A read walks what is held, as the run clock’s does (server/store-held.mjs, pendingClock): its readers run once per
// turn end or define_term, so no index of held events names glossaries.

import { apply } from '../shared/state.mjs';

/**
 * One thread’s glossary, by term key, as written: the published map itself when nothing held puts a term in it or
 * removes its thread, else a frozen copy with those held events applied in order, from the JSON the release applies.
 * @param {import('./store.mjs').Store} store @param {string} threadId @returns {Readonly<Record<string, any>>}
 */
export function pendingGlossary(store, threadId) {
  const published = store.state.glossary?.[threadId] ?? {};
  if (!store.held) return published;
  /** @type {any} */
  let s = null;
  for (let i = 0; i < store.heldLog.length; i++) {
    const { held, json } = store.heldLog.at(i);
    const removes = held.type === 'remove' && held.data?.kind === 'thread' && held.data.id === threadId;
    if (!removes && (held.type !== 'glossary' || held.data?.threadId !== threadId)) continue;
    s ??= { glossary: Object.assign(Object.create(null), { [threadId]: Object.assign(Object.create(null), published) }) };
    if (removes) delete s.glossary[threadId];
    else {
      const { type, data } = JSON.parse(json);
      try {
        apply(s, type, data);
      } catch {
        // the reducer rejects it the same way (an entry with no key), and the release holds it as rejected (#609): skipped
      }
    }
  }
  return s ? Object.freeze(s.glossary[threadId] ?? {}) : published;
}

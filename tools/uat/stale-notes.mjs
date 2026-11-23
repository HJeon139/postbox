// The page’s notices on blocks whose answers Postbox refused because they changed meanwhile (#123), as the run records
// them, and the answer while the agent works that causes them. Moved from tools/uat-run.mjs.

import { sleep } from '../browser.mjs';

/**
 * Reads Postbox’s notice on a block whose answer it refused because it changed meanwhile (#123): the page’s own record.
 * Each notice goes on the run’s probes once.
 * @param {{ d: any, facts: any, timeline: any[], log: (line: string) => void }} o @returns {() => Promise<void>}
 */
export function staleNoter({ d, facts, timeline, log }) {
  /** @type {Set<string>} */
  const staleSeen = new Set();
  return async () => {
    const notes = await d.staleNotes().catch((e) => {
      log(`Couldn’t read the page’s stale-answer notices, so the stale-answer trigger may be missed: ${e.message}`);
      return [];
    });
    for (const n of notes ?? []) {
      if (!n?.key || staleSeen.has(`${n.key}\n${n.text}`)) continue;
      staleSeen.add(`${n.key}\n${n.text}`);
      facts.probes.stale.push({ key: n.key, text: n.text, at: Date.now(), step: timeline.length });
      log(`the page refused a stale answer to ${n.key}: ${n.text}`);
    }
  };
}

/** @param {any} st @param {string} id */
const blockById = (st, id) =>
  Object.values(st?.items ?? {})
    .flatMap((list) => list ?? [])
    .find((x) => x?.id === id);

/**
 * An answer while the agent works (an interrupt that answers), to cause #123’s refusals: the page answers the
 * revision it showed, whatever the agent has done since.
 * @param {{ d: any, api: any, keys: Map<string, string>, facts: any, noteStale: () => Promise<void> }} o
 * @returns {(it: any) => Promise<string>}
 */
export function midTurnAnswerer({ d, api, keys, facts, noteStale }) {
  return async (it) => {
    const key = keys.get(it.item);
    if (!key) throw new Error(`There’s no item ${it.item}.`);
    const now = blockById((await api('/api/state')).state, key);
    if (now?.kind === 'block') facts.probes.answers.push({ key, revision: now.revision ?? 1, at: Date.now() });
    if (it.verdict) await d.review(key, { verdict: it.verdict, comments: it.comments ?? [] });
    else await d.act(key, { fills: it.fills ?? [], choose: it.choose ?? [], button: it.button ?? null });
    await sleep(1000);
    await noteStale();
    return `Answered ${it.item}${now?.revision ? ` (at revision ${now.revision} when you answered)` : ''} while the agent worked.`;
  };
}

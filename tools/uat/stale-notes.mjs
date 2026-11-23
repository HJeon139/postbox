// The page’s notices on blocks whose answers Postbox refused because they changed meanwhile (#123), as the run records
// them. Moved from tools/uat-run.mjs.

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

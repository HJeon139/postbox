// A finished UAT run’s inbox entries, read from its event log’s entry events (server/delivery.mjs): what each turn
// took, and what was left waiting. tools/uat/inbox-measures.mjs counts from them.

/**
 * What an entry event writes: the whole entry (entry.add, and entry.put, which a Retry reopens and takes an entry
 * with), or some of its fields (entry.patch). Null for any other event.
 * @param {any} e
 * @returns {{ id: string, whole: boolean, fields: any } | null}
 */
function entryWrite(e) {
  const d = e.data ?? {};
  if ((e.type === 'entry.add' || e.type === 'entry.put') && d.entry) return { id: d.entry.id, whole: true, fields: { ...d.entry, sessionId: d.sessionId } };
  return e.type === 'entry.patch' && d.id ? { id: d.id, whole: false, fields: d.patch ?? {} } : null;
}

/**
 * Entries waiting in another thread when a turn starts, from the event log’s entry events (server/delivery.mjs): once
 * a turn has taken its entries, how many of that agent’s entries still wait in a thread other than the one taken. A
 * notice rides a take whatever its thread, so it is neither the turn’s thread nor waiting elsewhere. A run on `main`
 * before the inbox has no entry events, and gives no counts.
 * @param {any[]} events
 * @returns {number[]}  one count per turn that took an entry other than a notice
 */
export function waitingElsewhere(events) {
  /** @type {Map<string, any>} */
  const entries = new Map();
  const counts = [];
  /** @type {string | null} */
  let taking = null;
  const seen = new Set();
  const close = () => {
    const all = [...entries.values()];
    const lead = all.find((x) => x.takenBy === taking && x.source !== 'notice');
    const elsewhere = (/** @type {any} */ x) =>
      x.sessionId === lead.sessionId && x.state === 'waiting' && x.source !== 'notice' && x.threadId !== lead.threadId;
    if (lead) counts.push(all.filter(elsewhere).length);
    taking = null;
  };
  for (const e of events) {
    const write = entryWrite(e);
    const turn = write?.fields.state === 'taken' ? (write.fields.takenBy ?? null) : null;
    // A turn’s take is a run of writes naming it; anything else ends the run, and the count is made then.
    if (taking && turn !== taking) close();
    if (write?.whole) entries.set(write.id, write.fields);
    else if (write && entries.has(write.id)) Object.assign(entries.get(write.id), write.fields);
    if (turn && !seen.has(turn)) {
      seen.add(turn);
      taking = turn;
    }
  }
  if (taking) close();
  return counts;
}

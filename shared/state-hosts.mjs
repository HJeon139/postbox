// The remote hosts’ events in the store’s reducer (#120; their entries in EVENTS, shared/state.mjs): the hosts agents
// can run on, each with its settings, each one’s connection as the host manager last reported it, the memory
// removals each still owes (#491), and the stops there of sessions since removed, which hold those removals (#1796).
// Each is a record by id with only its own keys, as map() in shared/state.mjs makes them (#352).

/**
 * A 'host' event: a host with its settings, or its removal with its last reported status.
 * @param {any} s @param {any} d
 */
export function putHost(s, d) {
  if (d.removed) {
    delete s.hosts?.[d.id];
    delete s.hostStatus?.[d.id];
    delete s.hostForgets?.[d.id];
    delete s.hostStops?.[d.id];
  } else (s.hosts ??= Object.create(null))[d.id] = d;
}

/**
 * A 'host.status' event: a host’s connection as the host manager last reported it, or none.
 * @param {any} s @param {any} d
 */
export function putHostStatus(s, d) {
  if (d.status === null) delete s.hostStatus?.[d.id];
  else (s.hostStatus ??= Object.create(null))[d.id] = d.status;
}

/**
 * A 'host.forget' event (#491): deleted personas a host now owes a memory removal for (add), or no longer does (drop),
 * one entry at a time, so a write of one never undoes another’s. And a stop there that a removed session left
 * unconfirmed (stop), or the host’s confirmation of one (stopEnded), which hold a removal across a restart (#1796).
 * @param {any} s
 * @param {{ id: string, add?: string[], drop?: string[], stop?: { turn: string, personaId?: string, unconfirmed: boolean, at: number }, stopEnded?: string }} d
 */
export function putHostForget(s, d) {
  // A host removed meanwhile, as behind a held commit, owes nothing.
  if (!s.hosts?.[d.id]) return;
  if (d.stop || d.stopEnded) putHostStop(s, d);
  const owed = new Set(s.hostForgets?.[d.id] ?? []);
  for (const p of d.add ?? []) owed.add(p);
  for (const p of d.drop ?? []) owed.delete(p);
  if (owed.size) (s.hostForgets ??= Object.create(null))[d.id] = [...owed];
  else delete s.hostForgets?.[d.id];
}

/**
 * A host’s kept stops (#1796): each turn once, by the turn. An older Postbox replays the event as one with nothing to
 * add or drop, so it reads the same format (server/store-format.mjs).
 * @param {any} s @param {{ id: string, stop?: { turn: string }, stopEnded?: string }} d
 */
function putHostStop(s, d) {
  // A stop names its turn, which its confirmation drops it by: one that doesn’t, from a damaged log, is never kept.
  if (d.stop && typeof d.stop.turn !== 'string') return;
  const gone = d.stop?.turn ?? d.stopEnded;
  const kept = (s.hostStops?.[d.id] ?? []).filter((/** @type {any} */ x) => x.turn !== gone);
  if (d.stop) kept.push(d.stop);
  if (kept.length) (s.hostStops ??= Object.create(null))[d.id] = kept;
  else delete s.hostStops?.[d.id];
}

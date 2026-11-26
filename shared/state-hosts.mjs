// The remote hosts’ events in the store’s reducer (#120; their entries in EVENTS, shared/state.mjs): the hosts agents
// can run on, each with its settings, each one’s connection as the host manager last reported it, and the memory
// removals each still owes (#491). Each is a record by id with only its own keys, as map() in shared/state.mjs makes
// them (#352).

/**
 * A 'host' event: a host with its settings, or its removal with its last reported status.
 * @param {any} s @param {any} d
 */
export function putHost(s, d) {
  if (d.removed) {
    delete s.hosts?.[d.id];
    delete s.hostStatus?.[d.id];
    delete s.hostForgets?.[d.id];
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
 * one entry at a time, so a write of one never undoes another’s.
 * @param {any} s @param {{ id: string, add?: string[], drop?: string[] }} d
 */
export function putHostForget(s, d) {
  // A host removed meanwhile, as behind a held commit, owes nothing.
  if (!s.hosts?.[d.id]) return;
  const owed = new Set(s.hostForgets?.[d.id] ?? []);
  for (const p of d.add ?? []) owed.add(p);
  for (const p of d.drop ?? []) owed.delete(p);
  if (owed.size) (s.hostForgets ??= Object.create(null))[d.id] = [...owed];
  else delete s.hostForgets?.[d.id];
}

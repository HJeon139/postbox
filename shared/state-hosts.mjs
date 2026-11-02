// The remote hosts’ events in the store’s reducer (#120; their entries in EVENTS, shared/state.mjs): the hosts agents
// can run on, each with its settings, and each one’s connection as the host manager last reported it. Both are
// records by id with only their own keys, as map() in shared/state.mjs makes them (#352).

/**
 * A 'host' event: a host with its settings, or its removal with its last reported status.
 * @param {any} s @param {any} d
 */
export function putHost(s, d) {
  if (d.removed) {
    delete s.hosts?.[d.id];
    delete s.hostStatus?.[d.id];
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

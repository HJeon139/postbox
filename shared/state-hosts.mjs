// The remote hosts’ events in the store’s reducer (#120; apply in shared/state.mjs, whose default case calls this):
// the hosts agents can run on, each with its settings, and each one’s connection as the host manager last reported it.

/**
 * Applies a 'host' or 'host.status' event; false for any other type.
 * @param {any} s @param {string} type @param {any} d
 */
export function applyHost(s, type, d) {
  if (type === 'host') {
    if (d.removed) {
      delete s.hosts?.[d.id];
      delete s.hostStatus?.[d.id];
    } else (s.hosts ??= {})[d.id] = d;
    return true;
  }
  if (type === 'host.status') {
    if (d.status === null) delete s.hostStatus?.[d.id];
    else (s.hostStatus ??= {})[d.id] = d.status;
    return true;
  }
  return false;
}

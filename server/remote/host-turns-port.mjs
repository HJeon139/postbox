// The `hostTurns` port (designs/architecture/services.md, “Hosts”): what Hosts reaches of the turns on a host, through
// the runtime. A rename refuses while turns run on the host, and a removal stops them first; each part looks the
// runtime’s own up as it’s called, so it is the one in place then.

/** @param {any} rt  the runtime @returns {import('./host-service.mjs').HostTurns} */
export function hostTurnsPort(rt) {
  return {
    busyOn: (hostId) => rt.remote.busyOn(hostId),
    sessionsOn: (hostId) => rt.remote.sessionsOn(hostId),
    stopOn: (sessionId) => rt.stop(sessionId, { silent: true }),
    cancel: (sessionId) => rt.remote.cancel(sessionId),
    confirmStops: (hostId, waitMs) => rt.remote.confirmStops(hostId, waitMs),
    stoppingSession: (turnId) => rt.remote.stopping.get(turnId)?.sessionId,
    stoppingPersonas: (hostId) => [...rt.remote.stopping.values()].filter((s) => s.hostId === hostId).map((s) => s.personaId),
    onStopEnded: (heard) => rt.remote.stopsEnded.add(heard),
  };
}

// Whose quota a persona’s turns use (#442): its backend, and the host it runs on, if any (`backend@host`), since a host’s
// harness signs in to its own account (designs/architecture/adapters.md, “Quota: each backend’s usage, in the
// composer”). The server marks agents out of quota by it (server/turn-quota.mjs), and keeps each backend’s usage under
// it, so the page’s bars and an agent’s row agree. Moved from server/turn-quota.mjs.

/** @param {any} persona @returns {string} */
export function quotaKeyOf(persona) {
  const backend = persona?.backend ?? 'mock';
  const host = persona?.remote?.hostId;
  return typeof host === 'string' && host ? `${backend}@${host}` : backend;
}

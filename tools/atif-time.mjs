// When an ATIF trajectory says something happened (tools/atif.mjs and the modules beside it): an ISO 8601 time, or
// nothing for a time the recording lacks. A step with none keeps no timestamp, since ATIF’s is optional, rather than a
// RangeError losing every trajectory of the run.

/** @param {unknown} ms @returns {string | undefined} */
export const iso = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

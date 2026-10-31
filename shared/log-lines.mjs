// One line of Postbox’s event log (#508’s storage design, “The line format”) holds either one event,
// `{"seq":4,"type":"thread","data":{…}}`, the form every line had before commits, or a commit of several events as a
// JSON array of them with consecutive seqs. A commit of one event is a plain event line. Either may carry the commit’s
// operation id as `op` on its first event. Every reader of the log, the store’s replay (server/store-replay.mjs) and
// the UAT tools (tools/uat/history.mjs, tools/uat/run-files.mjs), parses a line through eventsOf, so none of them drops
// a commit’s events for lacking a `.type` at the top.

/**
 * The events on one log line: the one event of a plain line, or every event of an array line, in order.
 * Throws what JSON.parse throws on a line that isn’t JSON; makes nothing of the events’ shape, which the store’s
 * replay checks.
 * @param {string} line
 * @returns {any[]}
 */
export function eventsOf(line) {
  const parsed = JSON.parse(line);
  return Array.isArray(parsed) ? parsed : [parsed];
}

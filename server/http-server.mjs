// Postbox’s HTTP server, with how long it keeps an idle connection (#1726). Node’s default closes one idle 5 s (plus a
// 1 s buffer), and a client that reuses it at that moment gets ECONNRESET: Playwright’s request context did, on CI.
// Go’s and Rust’s hyper clients, which an agent’s MCP client may be, keep one 90 s without reading the Keep-Alive hint,
// and a tool call is a POST nothing retries. So an idle connection stays open longer than they keep it. To close,
// closeServer drops that time first: close() ends only the connections idle at that moment, and one whose response was
// still going would otherwise wait out the whole time before the quit could finish.

import { createServer } from 'node:http';

/** How long an idle connection stays open, in ms: past the 90 s Go’s and hyper’s clients pool one for. */
export const KEEP_ALIVE_MS = 120_000;

/** Postbox’s HTTP server for this request handler. @param {import('node:http').RequestListener} handle */
export function httpServer(handle) {
  const server = createServer(handle);
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  return server;
}

/**
 * Stops the server once its connections end: an idle one at once, and one whose response is still going about a second
 * after that response ends (Node’s keep-alive buffer), not KEEP_ALIVE_MS later.
 * @param {import('node:http').Server} server @returns {Promise<void>}
 */
export function closeServer(server) {
  server.keepAliveTimeout = 1;
  return new Promise((ok) => server.close(() => ok()));
}

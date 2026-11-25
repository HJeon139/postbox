// Who Postbox answers, before any route (designs/architecture/security-boundaries.md, “This computer alone”): only
// requests addressed to it on this computer, no write from another site, and for what runs as the person, only while
// it listens on this computer alone and the request came from it. Moved out of server/index.mjs, which calls these
// before the page’s token is checked.

import { httpError } from './helpers.mjs';
import { isLoopback } from './shell.mjs';

/**
 * @param {{ port: number, host: () => string, front?: { hosts: string[], origins: string[] }, local?: () => boolean }} listening
 *   the port, and the address Postbox listens on; front: the addresses it answers as when it’s served beyond this
 *   computer (#558, server/identity/front.mjs); local: whether this is a run on this computer for the person who runs it
 */
export function requestGate({ port, host, front, local = () => true }) {
  const hosts = front?.hosts ?? [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = front?.origins ?? hosts.map((h) => `http://${h}`);
  return {
    /**
     * Postbox listens on localhost only; refuse other hosts (DNS rebinding) and cross-site writes.
     * @param {import('node:http').IncomingMessage} req @param {string} path
     * @returns {'health' | 'route'}  health: answer that it’s up, and nothing else
     */
    admit(req, path) {
      // The load balancer’s health check, addressed to the pod itself: it says only that Postbox is up.
      if (path === '/healthz' && req.method === 'GET') return 'health';
      if (!hosts.includes((req.headers.host ?? '').toLowerCase())) throw httpError(421, 'Postbox only answers requests addressed to 127.0.0.1 or localhost.');
      // An agent’s way in stays on the machine its harness runs on, never through the front door.
      if (path === '/mcp' && !isLoopback(req.socket?.remoteAddress)) throw httpError(403, 'Agents reach Postbox’s tools only from the machine it runs on.');
      if (req.method !== 'GET' && req.headers.origin && !origins.includes(req.headers.origin))
        throw httpError(403, 'Requests from other sites aren’t allowed.');
      return 'route';
    },
    /**
     * `!` runs commands as the person (#67), and an app’s link starts their browser (#1480), so both are off unless
     * Postbox listens on this computer alone and the request came from it, on top of the page’s token. Postbox listens
     * on 127.0.0.1 today; a later change to that can’t open these silently. `does` says what is refused: “! commands run”.
     * @param {import('node:http').IncomingMessage} req @param {string} does
     */
    hereAlone(req, does) {
      if (!isLoopback(host())) throw httpError(403, `${does} only while Postbox listens on this computer alone (127.0.0.1), and it’s listening on ${host()}.`);
      if (!isLoopback(req.socket?.remoteAddress)) throw httpError(403, `${does} only from this computer.`);
      // Served to a team, they would run as the unix user Postbox runs as, for whoever signed in (#558).
      if (!local()) throw httpError(403, `${does} only on a run on this computer, for the person who runs it.`);
    },
  };
}

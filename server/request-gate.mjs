// Who Postbox answers, before any route (designs/architecture/security-boundaries.md, “This computer alone”): only
// requests addressed to it on this computer, no write from another site, and for what runs as the person, only while
// it listens on this computer alone and the request came from it. Moved out of server/index.mjs, which calls these
// before the page’s token is checked.

import { httpError } from './helpers.mjs';
import { isLoopback } from './shell.mjs';

/**
 * @param {{ port: number, host: () => string }} listening  the port, and the address Postbox listens on
 */
export function requestGate({ port, host }) {
  return {
    /**
     * Postbox listens on localhost only; refuse other hosts (DNS rebinding) and cross-site writes.
     * @param {import('node:http').IncomingMessage} req
     */
    admit(req) {
      const to = (req.headers.host ?? '').toLowerCase();
      if (to !== `127.0.0.1:${port}` && to !== `localhost:${port}`) throw httpError(421, 'Postbox only answers requests addressed to 127.0.0.1 or localhost.');
      if (req.method !== 'GET' && req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))
        throw httpError(403, 'Requests from other sites aren’t allowed.');
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
    },
  };
}

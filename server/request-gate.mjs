// Who Postbox answers, before any route (designs/architecture/security-boundaries.md, “This computer alone”): only
// requests addressed to it, no write from another site, and for what runs as the person, only while it listens on this
// computer alone and the request came from it. On your own computer “addressed to it” is 127.0.0.1 or localhost on its
// port; a hosted Postbox answers its one public origin instead (designs/architecture/hosted.md, “The address it
// answers”). Moved out of server/index.mjs, which calls these before the page’s token is checked.

import { httpError } from './helpers.mjs';
import { isLoopback } from './shell.mjs';

/** The one path a hosted Postbox answers with no sign-in and for any `Host`: the load balancer’s health check. */
export const HEALTH_PATH = '/health';

/**
 * @param {{ port: number, host: () => string, publicOrigin?: string }} listening  the port, the address Postbox listens
 *   on, and a hosted Postbox’s public origin
 */
export function requestGate({ port, host, publicOrigin }) {
  const origins = publicOrigin ? [publicOrigin] : [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const hosts = origins.map((o) => new URL(o).host);
  const addressed = publicOrigin
    ? 'This Postbox only answers requests addressed to its own public address.' // which it doesn’t say, to a request that didn’t know it
    : 'Postbox only answers requests addressed to 127.0.0.1 or localhost.';
  return {
    /**
     * Refuse other hosts (DNS rebinding) and cross-site writes.
     * @param {import('node:http').IncomingMessage} req
     */
    admit(req) {
      if (!hosts.includes((req.headers.host ?? '').toLowerCase())) throw httpError(421, addressed);
      if (req.method !== 'GET' && req.headers.origin && !origins.includes(req.headers.origin))
        throw httpError(403, 'Requests from other sites aren’t allowed.');
    },
    /**
     * The load balancer’s health check, answered before `admit` and before sign-in, since it comes from the balancer’s
     * own nodes with no `Host` of the public origin and no one signed in. Hosted only, so a local gate is unchanged.
     * It says one thing, the same whatever the store’s state: something answers here (designs/architecture/hosted.md,
     * “Who is asking”). True when it answered.
     * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string} path
     */
    health(req, res, path) {
      if (!publicOrigin || path !== HEALTH_PATH || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok\n');
      return true;
    },
    /**
     * Hosted, every answer tells the browser to come back over TLS only, for a year: the public origin is HTTPS, and a
     * first plain request is the one moment someone on the network could answer in its place. Locally the handler is
     * returned as it is. @param {import('node:http').RequestListener} handle @returns {import('node:http').RequestListener}
     */
    overTls(handle) {
      if (!publicOrigin) return handle;
      return (req, res) => {
        res.setHeader('strict-transport-security', 'max-age=31536000');
        return handle(req, res);
      };
    },
    /**
     * The one page that may frame an app’s sandbox (#992): the origin the request came to. Locally that is its checked
     * `Host`, either loopback name; hosted it is the public origin, since behind TLS `http://` and the `Host` would
     * name a page no browser has open. @param {import('node:http').IncomingMessage} req
     */
    framedBy: (req) => publicOrigin ?? `http://${(req.headers.host ?? '').toLowerCase()}`,
    /**
     * `!` runs commands as the person (#67), and an app’s link starts their browser (#1480), so both are off unless
     * Postbox listens on this computer alone and the request came from it, on top of the page’s token. A hosted
     * Postbox listens on every address of its container, so both are refused there. `does` says what is refused:
     * “! commands run”.
     * @param {import('node:http').IncomingMessage} req @param {string} does
     */
    hereAlone(req, does) {
      if (!isLoopback(host())) throw httpError(403, `${does} only while Postbox listens on this computer alone (127.0.0.1), and it’s listening on ${host()}.`);
      if (!isLoopback(req.socket?.remoteAddress)) throw httpError(403, `${does} only from this computer.`);
    },
  };
}

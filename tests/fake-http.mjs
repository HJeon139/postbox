// A request through Postbox’s router without a network: start({ listen: false }) returns the handler.

import { Readable } from 'node:stream';

/**
 * One request through the router, as Node’s server would make it.
 * @param {(req: any, res: any) => any} handle
 * @param {{ method?: string, path: string, body?: any, cookie?: string, origin?: string, host: string, remoteAddress?: string,
 *           headers?: Record<string, string> }} r
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string, json: any }>}
 */
export function fakeRequest(handle, { method = 'GET', path, body, cookie, origin, host, remoteAddress = '127.0.0.1', headers = {} }) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url: path,
    headers: { host, ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...headers },
    socket: { remoteAddress },
  });
  return new Promise((resolve) => {
    const chunks = [];
    const res = {
      headersSent: false,
      status: 0,
      headers: {},
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
        this.headersSent = true;
      },
      write(c) {
        chunks.push(Buffer.from(c));
      },
      end(c) {
        if (c) chunks.push(Buffer.from(c));
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: this.status, headers: this.headers, text, json });
      },
      destroy() {},
    };
    handle(req, res);
  });
}

/** The Fetch Metadata headers a browser sends when you open a page: the server gives the page’s token only to these. */
export const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' };

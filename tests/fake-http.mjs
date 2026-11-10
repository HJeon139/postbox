// A request through Postbox’s router without a network: start({ listen: false }) returns the handler.

import { Readable } from 'node:stream';

/**
 * One request through the router, as Node’s server would make it.
 * @param {(req: any, res: any) => any} handle
 * @param {{ method?: string, path: string, body?: any, raw?: string, cookie?: string, origin?: string, host: string, remoteAddress?: string,
 *           headers?: Record<string, string> }} r  raw: the body’s text as sent, for JSON that JSON.stringify can’t write (1e400)
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string, json: any, bytes: Buffer }>}
 */
export function fakeRequest(handle, { method = 'GET', path, body, raw, cookie, origin, host, remoteAddress = '127.0.0.1', headers = {} }) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(payload)]);
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
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: this.status, headers: this.headers, text, json, bytes });
      },
      destroy() {},
    };
    handle(req, res);
  });
}

/** The Fetch Metadata headers a browser sends when you open a page: the server gives the page’s token only to these. */
export const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' };

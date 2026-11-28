// A fake Responses API endpoint on 127.0.0.1 for the Codex conformance probe (#585). It records the body of each
// request Codex sends and answers with the smallest stream that completes a turn: one assistant message, “ok”.
// It checks that the only credential it was sent is the placeholder, and never logs the header itself.

import { createServer } from 'node:http';
import { developerTexts, occurrences } from './markers.mjs';
import { PLACEHOLDER } from './sandbox-env.mjs';

/** The Authorization header Codex sends with the placeholder as its key. */
export const EXPECTED_AUTHORIZATION = `Bearer ${PLACEHOLDER}`;

/**
 * Whether a request’s Authorization header is the placeholder’s, exactly. A missing header or any other value
 * fails: Codex sent something the probe didn’t give it. Node keeps the first of repeated Authorization headers, and
 * the probe’s environment holds no other credential for Codex to send in another header.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
export const authorizationOk = (headers) => headers.authorization === EXPECTED_AUTHORIZATION;

/** One server-sent event. @param {any} data */
const event = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

/** The stream of a turn that answers “ok”, as codex-cli 0.167.0 reads one. @param {number} n  the request’s number */
export function okStream(n) {
  const id = `resp_${n}`;
  const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 };
  const message = { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'ok' }] };
  return [
    event({ type: 'response.created', response: { id } }),
    event({ type: 'response.output_item.done', item: message }),
    event({ type: 'response.completed', response: { id, usage } }),
  ].join('');
}

/**
 * Handles one request: records it in `seen` (its path, its parsed body, whether its Authorization was the
 * placeholder’s), and answers a POST to …/responses with okStream, anything else with 404.
 * @param {{ url?: string, method?: string, headers: import('node:http').IncomingHttpHeaders }} req
 * @param {string} body @param {{ path: string, authOk: boolean, body: any }[]} seen
 * @returns {{ status: number, type?: string, text: string }}
 */
export function answer(req, body, seen) {
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null; // not JSON: recorded as null, and the check that reads it fails
  }
  seen.push({ path: String(req.url), authOk: authorizationOk(req.headers), body: parsed });
  if (req.method !== 'POST' || !String(req.url).endsWith('/responses')) return { status: 404, text: '' };
  return { status: 200, type: 'text/event-stream', text: okStream(seen.length) };
}

/**
 * Starts the fake on 127.0.0.1 at a free port. `seen` fills as requests arrive; close() stops it.
 * @returns {Promise<{ baseUrl: string, seen: { path: string, authOk: boolean, body: any }[], close: () => Promise<void> }>}
 */
export async function startFake() {
  /** @type {{ path: string, authOk: boolean, body: any }[]} */
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const out = answer(req, body, seen);
      res.writeHead(out.status, out.type ? { 'content-type': out.type } : {});
      res.end(out.text);
    });
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => ok(undefined));
  });
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  const close = async () => {
    server.closeAllConnections(); // Codex may keep its connection open
    await new Promise((ok) => server.close(() => ok(undefined)));
  };
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen, close };
}

/**
 * How many times `marker` is in the developer messages of a Responses request’s input, how many times anywhere in
 * the request, and in how many developer texts the whole guide is, so a guide cut short can’t pass on its marker.
 * @param {any} body @param {string} marker @param {string} [guide]
 */
export function requestMarkers(body, marker, guide) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const texts = developerTexts(input);
  return {
    developer: texts.reduce((n, text) => n + occurrences(text, marker), 0),
    anywhere: occurrences(JSON.stringify(body ?? null), marker),
    whole: guide ? texts.filter((text) => text.includes(guide)).length : 0,
  };
}

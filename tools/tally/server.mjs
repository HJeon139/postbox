// A ticket tracker that exists only for tests (#296): what the `tally` command (tools/tally/bin/tally) talks to, so a
// real agent can create, comment on, edit, close and delete tickets with nothing leaving this computer. It keeps the
// tickets in memory and writes each request it gets to a log, one JSON line each, which a UAT reads to see what ran.
//
//   node tools/tally/server.mjs --port 4591 --log /tmp/tally.jsonl

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { port: { type: 'string', default: '4591' }, log: { type: 'string' } } });
const port = Number(args.port);
const origin = `http://127.0.0.1:${port}`;
/** @type {Map<number, { id: number, title: string, body: string, state: 'open'|'closed', comments: string[] }>} */
const tickets = new Map();
let next = 1;

const MAX_BODY = 256 * 1024;
const read = (req) =>
  new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c) => {
      text += c;
      if (text.length > MAX_BODY) req.destroy(new Error('The request is too large.'));
    });
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const urlOf = (t) => `${origin}/tickets/${t.id}`;

const server = createServer(async (req, res) => {
  // Only this computer, by its own name.
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return send(res, 403, { error: 'Wrong host.' });
  // Not from a web page: a browser sends an Origin, and a form can’t send JSON.
  if (req.headers.origin) return send(res, 403, { error: 'tally takes no requests from web pages.' });
  if (req.method !== 'GET' && req.method !== 'DELETE' && !/^application\/json\b/.test(req.headers['content-type'] ?? ''))
    return send(res, 415, { error: 'Send JSON.' });
  let body = {};
  try {
    body = await read(req);
  } catch {
    return send(res, 400, { error: 'The body isn’t JSON.' });
  }
  const { pathname } = new URL(req.url ?? '/', origin);
  if (args.log) appendFileSync(args.log, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path: pathname, body })}\n`);
  const m = /^\/tickets\/(\d+)(\/comments|\/close)?$/.exec(pathname);
  const t = m ? tickets.get(Number(m[1])) : null;
  if (pathname === '/tickets' && req.method === 'GET')
    return send(
      res,
      200,
      [...tickets.values()].map((x) => ({ ...x, url: urlOf(x) })),
    );
  if (pathname === '/tickets' && req.method === 'POST') {
    if (typeof body.title !== 'string' || !body.title.trim()) return send(res, 422, { error: 'A ticket needs a title.' });
    const created = { id: next++, title: body.title, body: String(body.body ?? ''), state: /** @type {const} */ ('open'), comments: [] };
    tickets.set(created.id, created);
    return send(res, 201, { ...created, url: urlOf(created) });
  }
  if (!t) return send(res, 404, { error: 'No such ticket.' });
  if (!m?.[2] && req.method === 'GET') return send(res, 200, { ...t, url: urlOf(t) });
  if (m?.[2] === '/comments' && req.method === 'POST') {
    t.comments.push(String(body.body ?? ''));
    return send(res, 201, { url: `${urlOf(t)}#comment-${t.comments.length}` });
  }
  if (!m?.[2] && req.method === 'PATCH') {
    if (typeof body.title === 'string') t.title = body.title;
    if (typeof body.body === 'string') t.body = body.body;
    return send(res, 200, { ...t, url: urlOf(t) });
  }
  if (m?.[2] === '/close' && req.method === 'POST') {
    t.state = 'closed';
    return send(res, 200, { ...t, url: urlOf(t) });
  }
  if (!m?.[2] && req.method === 'DELETE') {
    tickets.delete(t.id);
    return send(res, 200, { deleted: t.id });
  }
  return send(res, 405, { error: 'Not a tally request.' });
});
server.listen(port, '127.0.0.1', () => console.log(`tally server on ${origin}${args.log ? `, logging to ${args.log}` : ''}`));

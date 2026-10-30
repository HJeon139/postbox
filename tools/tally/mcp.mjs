// tally as an MCP server, for tests only (#296): the same tickets as tools/tally/bin/tally, as tools named the way
// Postbox’s rules for writes outside expect (create_ticket, add_ticket_comment, edit_ticket, delete_ticket), so a real
// agent’s writes reach Postbox’s check with nothing leaving this computer. It talks to tools/tally/server.mjs at
// $TALLY_URL (http://127.0.0.1:4591 by default), over stdio, one JSON-RPC message a line.
//
//   { "mcpServers": { "tally": { "command": "node", "args": ["tools/tally/mcp.mjs"] } } }

import { createInterface } from 'node:readline';

const base = (process.env.TALLY_URL ?? 'http://127.0.0.1:4591').replace(/\/$/, '');
const num = { type: 'integer', description: 'The ticket’s number.' };
const text = (description) => ({ type: 'string', description });
const TOOLS = [
  { name: 'create_ticket', description: 'Create a tally ticket.', props: { title: text('The title.'), body: text('The body.') }, required: ['title'] },
  { name: 'add_ticket_comment', description: 'Comment on a tally ticket.', props: { number: num, body: text('The comment.') }, required: ['number', 'body'] },
  {
    name: 'edit_ticket',
    description: 'Change a tally ticket’s title or body.',
    props: { number: num, title: text('The new title.'), body: text('The new body.') },
    required: ['number'],
  },
  { name: 'delete_ticket', description: 'Delete a tally ticket.', props: { number: num }, required: ['number'] },
];

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error ?? `tally answered ${r.status}`);
  return out;
}
const RUN = {
  create_ticket: (a) => call('POST', '/tickets', { title: a.title, body: a.body ?? '' }).then((t) => t.url),
  add_ticket_comment: (a) => call('POST', `/tickets/${Number(a.number)}/comments`, { body: a.body }).then((t) => t.url),
  edit_ticket: (a) => call('PATCH', `/tickets/${Number(a.number)}`, { title: a.title, body: a.body }).then((t) => t.url),
  delete_ticket: (a) => call('DELETE', `/tickets/${Number(a.number)}`).then((t) => `Deleted #${t.deleted}`),
};

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
async function handle(m) {
  if (m.method === 'initialize')
    return reply(m.id, {
      protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tally', version: '1.0.0' },
    });
  if (m.method === 'tools/list')
    return reply(m.id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.required } })),
    });
  if (m.method === 'tools/call') {
    const run = Object.hasOwn(RUN, m.params?.name) ? RUN[m.params.name] : null;
    try {
      if (!run) throw new Error(`No tool ${m.params?.name}.`);
      return reply(m.id, { content: [{ type: 'text', text: await run(m.params.arguments ?? {}) }] });
    } catch (e) {
      return reply(m.id, { content: [{ type: 'text', text: `tally: ${e.message}` }], isError: true });
    }
  }
  if (m.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not a tally method.' } })}\n`);
}
createInterface({ input: process.stdin }).on('line', (line) => {
  let m = null;
  try {
    m = JSON.parse(line);
  } catch {
    // A line that isn’t JSON-RPC isn’t for tally: skip it.
    return;
  }
  handle(m).catch(() => {});
});

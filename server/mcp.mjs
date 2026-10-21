// The MCP server: Postbox’s UI tools over JSON-RPC 2.0 (MCP’s Streamable HTTP transport, JSON responses).
// One endpoint serves every backend. A Claude Code session or an Agent SDK agent connects to
//   POST <origin>/mcp?session=<postbox session id>
// and gets show_block, update_block, show_app, update_app, define_term, propose_agent, schedule_wake,
// wake_agent and corpus_search. Every tool returns at once; when you answer a block, your answer reaches
// the agent later as a new message carrying { blockId, action, values }.

const PROTOCOL = '2025-06-18';

const blockSchema = { type: 'object', description: 'A block from the catalog: { id, type, version, title?, fallback, …fields }. See README, “The block catalog”.' };

export const TOOL_DEFS = [
  { name: 'show_block', description: 'Show a catalog block (choice, form, table, progress, card, confirm, image, code, review) in the thread. Returns at once; the person’s answer arrives later as a message.', inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] } },
  { name: 'update_block', description: 'Replace a block you showed earlier, by its id, for example to move a progress list on. An update can ask again.', inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] } },
  { name: 'show_app', description: 'Show an app you wrote (HTML with inline script and style) in a sandbox with no network. It can call postbox.query(tool, args) for tools in permissions that you also hold.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, code: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } }, fallback: { type: 'string' } }, required: ['title', 'code'] } },
  { name: 'update_app', description: 'Replace an app you showed with a new version, in place. Older versions stay in its version menu.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }, required: ['id', 'code'] } },
  { name: 'define_term', description: 'Add a term to this thread’s glossary. Every later mention links to its definition.', inputSchema: { type: 'object', properties: { term: { type: 'string' }, definition: { type: 'string' }, key: { type: 'string' }, source: { type: 'string' } }, required: ['term', 'definition'] } },
  { name: 'propose_agent', description: 'Propose a new teammate. The person sees a card and decides; tools beyond yours are highlighted.', inputSchema: { type: 'object', properties: { handle: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } } }, required: ['handle', 'description'] } },
  { name: 'schedule_wake', description: 'Ask to be woken later, with a note to yourself.', inputSchema: { type: 'object', properties: { in_minutes: { type: 'number' }, note: { type: 'string' } }, required: ['in_minutes'] } },
  { name: 'wake_agent', description: 'Wake another agent with a message. The exchange happens in a side thread. After 3 agent wakes in a row, the person must allow the next one.', inputSchema: { type: 'object', properties: { handle: { type: 'string' }, message: { type: 'string' } }, required: ['handle', 'message'] } },
  { name: 'corpus_search', description: 'Search the project’s corpus by exact words (BM25) and by meaning (a stub until a real index is connected).', inputSchema: { type: 'object', properties: { query: { type: 'string' }, mode: { type: 'string', enum: ['both', 'lexical', 'semantic'] }, k: { type: 'number' } }, required: ['query'] } },
];

/**
 * Handles one JSON-RPC message (or a batch). Returns the response body, or null for notifications.
 * @param {import('./runtime.mjs').Runtime} rt
 */
export function handleMcp(rt, sessionId, body) {
  if (Array.isArray(body)) {
    const out = body.map((m) => one(rt, sessionId, m)).filter(Boolean);
    return out.length ? out : null;
  }
  return one(rt, sessionId, body);
}

function one(rt, sessionId, msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request.' } };
  }
  const isNotification = msg.id === undefined;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'postbox', version: '0.2.0' },
        instructions: 'Postbox renders your UI. Reply in Markdown; use show_block for questions and show_app for interactive software. Tools never block: answers arrive as new messages.' });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOL_DEFS });
    case 'tools/call': {
      if (!rt.s.sessions[sessionId]) return fail(-32602, 'Unknown Postbox session. Connect with /mcp?session=<id>.');
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const tools = rt.toolsFor(sessionId, rt.turns.get(sessionId) ?? null);
      if (!(name in tools) || !TOOL_DEFS.some((t) => t.name === name)) return fail(-32602, `There’s no tool called “${name}”.`);
      try {
        const r = tools[name](args);
        return reply({ content: [{ type: 'text', text: r.results ? JSON.stringify(r.results) : r.message }], isError: r.ok === false && !r.waiting });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e.userMessage ?? e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method “${msg.method}” isn’t supported.`);
  }
}

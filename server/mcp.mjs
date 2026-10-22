// The MCP server: Postbox’s UI tools over JSON-RPC 2.0 (MCP’s Streamable HTTP transport, JSON responses).
// One endpoint serves every backend. A Claude Code session or an Agent SDK agent connects to
//   POST <origin>/mcp?session=<postbox session id>
// and gets show_block, update_block, show_app, update_app, define_term, propose_agent, schedule_wake,
// wake_agent and corpus_search. Every tool returns at once; when you answer a block, your answer reaches
// the agent later as a new message carrying { blockId, action, values }.
//
// One tool is the exception: permission_prompt is what Claude Code calls (--permission-prompt-tool) before
// a risky tool call in “ask” mode, and it waits for your answer on a card in the thread.

import { limitText as n, PALETTES } from '../shared/limits.mjs';
import { describePermission } from './adapters/claude-stream.mjs';

const PROTOCOL = '2025-06-18';

const blockSchema = {
  type: 'object',
  description: 'A block from the catalog: { id, type, version, title?, fallback, …fields }. See README, “The block catalog”.',
};

// The tools, as agents read them. Their limits come from shared/limits.mjs, as the guide’s do (#50).
export const TOOL_DEFS = [
  {
    name: 'show_block',
    description: `Show a catalog block (choice, form, table, progress, card, confirm, image, code, review) in the thread. Returns at once; the person’s answer arrives later as a message. Limits: a fallback up to ${n('fallback')} characters, a prompt or statement up to ${n('prompt')}, choice options 1–${n('choiceOptions')}, form fields up to ${n('formFields')}, select options up to ${n('selectOptions')}, table columns up to ${n('tableColumns')} and rows up to ${n('tableRows')}, progress steps up to ${n('progressSteps')}, a card body up to ${n('cardBody')} characters with up to ${n('cardFacts')} facts and ${n('cardActions')} actions, code and review content up to ${n('longText')} characters.`,
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  {
    name: 'update_block',
    description:
      'Replace a block you showed earlier, by its id. An update can ask again. For a progress block, send every step each time: set progress { done, total, unit } on a step as items finish, update at least every minute, and close each step as done or failed before your turn ends, or Postbox marks it stalled and tells you. Postbox stamps when the block and each step changed, and fills in duration.',
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  {
    name: 'show_app',
    description: `Show an app you wrote (HTML with inline script and style, up to ${n('appCode')} characters) in a sandbox with no network. It can call postbox.query(tool, args) for tools in permissions that you also hold, and postbox.send(action, values, summary) right after the person clicks or presses a key in it (up to 5 a minute; more wait for the person to allow them). One send carries up to ${n('eventBytes')} of JSON; a larger one rejects inside the app, so send ids for many items. Chart colors: ${PALETTES.map((p) => `${p.name} for ${p.for}`).join('; ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        code: { type: 'string' },
        permissions: { type: 'array', items: { type: 'string' } },
        fallback: { type: 'string' },
      },
      required: ['title', 'code'],
    },
  },
  {
    name: 'update_app',
    description: `Replace an app you showed with a new version, in place, up to ${n('appCode')} characters. Older versions stay in its version menu.`,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, code: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } },
      required: ['id', 'code'],
    },
  },
  {
    name: 'define_term',
    description: 'Add a term to this thread’s glossary. Every later mention links to its definition.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' }, definition: { type: 'string' }, key: { type: 'string' }, source: { type: 'string' } },
      required: ['term', 'definition'],
    },
  },
  {
    name: 'propose_agent',
    description: 'Propose a new teammate. The person sees a card and decides; tools beyond yours are highlighted.',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
      },
      required: ['handle', 'description'],
    },
  },
  {
    name: 'schedule_wake',
    description: 'Ask to be woken later, with a note to yourself.',
    inputSchema: { type: 'object', properties: { in_minutes: { type: 'number' }, note: { type: 'string' } }, required: ['in_minutes'] },
  },
  {
    name: 'wake_agent',
    description: 'Wake another agent with a message. The exchange happens in a side thread. After 3 agent wakes in a row, the person must allow the next one.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, message: { type: 'string' } }, required: ['handle', 'message'] },
  },
  {
    name: 'read_conversation',
    description:
      'Read this conversation’s history: what the person and every agent in it said, newest last. Each turn already starts with what happened since your last one; use this for anything older.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many items, up to 200. Default 50.' },
        skip: { type: 'number', description: 'Skip this many of the newest items, to read further back.' },
      },
    },
  },
  {
    name: 'permission_prompt',
    description: 'Postbox calls this for you before a tool needs the person’s permission. Don’t call it yourself.',
    inputSchema: {
      type: 'object',
      properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
      required: ['tool_name', 'input'],
    },
  },
  {
    name: 'corpus_search',
    description: 'Search the project’s corpus by exact words (BM25) and by meaning (a stub until a real index is connected).',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' }, mode: { type: 'string', enum: ['both', 'lexical', 'semantic'] }, k: { type: 'number' } },
      required: ['query'],
    },
  },
];

/**
 * Handles one JSON-RPC message (or a batch). Returns the response body, or null for notifications.
 * @param {import('./runtime.mjs').Runtime} rt
 */
export async function handleMcp(rt, sessionId, body) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(rt, sessionId, m)))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(rt, sessionId, body);
}

async function one(rt, sessionId, msg) {
  if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Not a JSON-RPC 2.0 request.' } };
  }
  const isNotification = msg.id === undefined;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'postbox', version: '0.2.0' },
        instructions:
          'Postbox renders your UI. Reply in Markdown; use show_block for questions and show_app for interactive software. Tools never block: answers arrive as new messages.',
      });
    case 'notifications/initialized':
    case 'notifications/cancelled': // lint-allow spelling: the MCP protocol’s method name.
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
      if (name === 'permission_prompt') return reply(await permission(rt, sessionId, args));
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

/**
 * Asks the person whether a tool may run, and answers in the shape Claude Code expects from a
 * permission prompt tool: { behavior: "allow", updatedInput } or { behavior: "deny", message }.
 */
async function permission(rt, sessionId, { tool_name, input = {}, tool_use_id }) {
  const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
  const answer = await rt.requestPermission(sessionId, { tool: String(tool_name ?? ''), summary, detail, toolUseId: tool_use_id });
  const decision = answer.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
  return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
}

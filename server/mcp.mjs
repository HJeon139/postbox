// The MCP server: Postbox’s UI tools over JSON-RPC 2.0 (MCP’s Streamable HTTP transport, JSON responses).
// One endpoint serves every backend. A Claude Code session or an Agent SDK agent connects to
//   POST <origin>/mcp?session=<postbox session id>&turn=<the turn’s token>
// and gets show_block, update_block, review_block, show_app, update_app, retire_app, define_term, react, propose_agent, schedule_wake,
// wake_agent, bring_to_conversation (in side and topic threads), ask_for_tool, corpus_search and add_dataset.
// Every tool returns at once; when you answer a block, your answer reaches the agent later as a new message
// carrying { blockId, action, values }. The tools’ definitions are in shared/mcp-tools.mjs, which the shim on a
// remote host serves too (#120); their handlers are here.
//
// One tool is the exception: permission_prompt is what Claude Code calls (--permission-prompt-tool) before
// a risky tool call in “ask” mode, and it waits for your answer on a card in the conversation.
//
// Each turn Postbox starts gets its own token in the URL. A tool call needs the token of the session’s running turn:
// one from a turn you stopped whose process hadn’t exited yet is refused, and nothing of it reaches the conversation
// (#126). So is a call with no token (#54): the session id alone let any process on this computer act as that agent,
// and agents posted large apps to /mcp from scripts, outside the tool calls you see. A large app goes by codePath.

import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

import { offersBring } from './bring.mjs';
import { noteAnswer } from './empty-reply.mjs';
import { sameToken } from './helpers.mjs';
import { asksByPrompt, NOT_YOUR_PROMPT, permission } from './permission-prompt.mjs';
import { reactTool } from './reactions.mjs';
import { AgentFileError } from './runtime.mjs';
import { recordedTools } from './scheduled-wakes.mjs';
import { withUrgent } from './subagent-end.mjs';

/** The tools that read and never write: they answer while the store is closed. */
const READ_TOOLS = new Set(['read_conversation', 'read_message', 'corpus_search']);

/**
 * While the store can’t be written (#508’s storage design, “When a write fails (ST-3)”), a tool that would write is
 * refused with the cause at the MCP entry, the one gate for tools, as the router is for the page; reads still answer.
 * @param {any} rt @param {string} name
 */
const storeClosedTo = (rt, name) => !rt.store.writable && !READ_TOOLS.has(name);

// The tools live in shared/mcp-tools.mjs, which the host’s shim serves too (#120); this keeps their old import working.
export { TOOL_DEFS };

const PROTOCOL = '2025-06-18';

/**
 * Handles one JSON-RPC message (or a batch). Returns the response body, or null for notifications.
 * @param {import('./runtime.mjs').Runtime} rt @param {string|null} sessionId @param {any} body
 * @param {string|null} [turnToken]  the turn’s token from the URL, if it carried one
 * @param {AbortSignal|import('node:http').ServerResponse|null} [closeOrSignal]  aborted/closed when the HTTP client disconnects
 */
export async function handleMcp(rt, sessionId, body, turnToken = null, closeOrSignal = null) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(rt, sessionId, m, turnToken, closeOrSignal)))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(rt, sessionId, body, turnToken, closeOrSignal);
}

async function one(rt, sessionId, msg, turnToken, closeOrSignal) {
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
      return reply({ tools: TOOL_DEFS.filter((t) => offered(rt, sessionId, turnToken, t.name)) });
    case 'tools/call': {
      if (!rt.s.sessions[sessionId]) return fail(-32602, 'Unknown Postbox session. Connect with /mcp?session=<id>.');
      if (turnToken === null)
        return fail(
          -32001,
          'Postbox runs tool calls only from an agent turn it started, which carries its own token, so it didn’t run this one. Call the tool from your turn; for a large app, use codePath.',
        );
      if (!sameToken(rt.turns.get(sessionId)?.token, turnToken))
        return fail(-32001, 'This call came from an agent turn that was stopped or has ended, so Postbox didn’t run it.');
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (storeClosedTo(rt, name)) return reply({ content: [{ type: 'text', text: rt.store.cause.message }], isError: true });
      // react is the reactions’ own (server/reactions.mjs), beside the runtime’s tools, and recorded as they are (#466).
      const turn = rt.turns.get(sessionId) ?? null;
      const tools = { ...rt.toolsFor(sessionId, turn), ...recordedTools(rt, turn, { react: (a) => reactTool(rt, rt.session(sessionId), a) }) };
      if (name === 'permission_prompt') return reply(asksByPrompt(rt, sessionId) ? await permission(rt, sessionId, args, closeOrSignal) : NOT_YOUR_PROMPT);
      if (!(name in tools) || !TOOL_DEFS.some((t) => t.name === name)) return fail(-32602, `There’s no tool called “${name}”.`);
      try {
        // An app’s code and data files may come from files in the agent’s folder, which Postbox reads itself (#54).
        const app = name === 'show_app' || name === 'update_app' ? await rt.appFiles(sessionId, args) : { args };
        const r = await tools[name](app.args, app.files ? { files: app.files } : {});
        noteAnswer(rt.turns.get(sessionId) ?? null, name, r);
        // An urgent note for the agent comes first (#229): this is how it hears one mid-turn.
        const text = withUrgent(rt, sessionId, r.results ? JSON.stringify(r.results) : r.message);
        return reply({ content: [{ type: 'text', text }], isError: r.ok === false && !r.waiting });
      } catch (e) {
        if (e instanceof AgentFileError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        return reply({ content: [{ type: 'text', text: e.userMessage ?? e.message }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method “${msg.method}” isn’t supported.`);
  }
}

/**
 * Whether tools/list offers a tool: bring_to_conversation only to the person’s turn in a side or topic thread (#128),
 * permission_prompt only to a backend that asks through it (server/permission-prompt.mjs), and every other tool always.
 */
function offered(rt, sessionId, turnToken, name) {
  const turn = rt.turns.get(sessionId);
  if (name === 'bring_to_conversation') return sameToken(turn?.token, turnToken) && offersBring(rt, turn);
  return name !== 'permission_prompt' || asksByPrompt(rt, sessionId);
}

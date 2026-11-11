// The MCP server: Postbox’s UI tools over JSON-RPC 2.0 (MCP’s Streamable HTTP transport, JSON responses).
// One endpoint serves every backend. A Claude Code session or an Agent SDK agent connects to
//   POST <origin>/mcp?session=<postbox session id>&turn=<the turn’s token>
// and gets show_block, update_block, review_block, show_app, update_app, retire_app, define_term, react, propose_agent, schedule_wake,
// cancel_wake, wake_agent, open_topic, bring_to_conversation (in side and topic threads), read_conversation,
// read_message, ask_for_tool, and the asset tools (server/asset-tools.mjs).
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
import { assetTools } from './asset-tools.mjs';
import { offersBring } from './bring.mjs';
import { noteAnswer } from './empty-reply.mjs';
import { sameToken } from './helpers.mjs';
import { asksByPrompt, NOT_YOUR_PROMPT, permission } from './permission-prompt.mjs';
import { reactTool } from './reactions.mjs';
import { blockFiles, keptIfShown } from './review-files.mjs';
import { AgentFileError } from './runtime.mjs';
import { recordedTools } from './scheduled-wakes.mjs';
import { withUrgent } from './subagent-end.mjs';
import { closedTo, READ_TOOLS } from './tool-gate.mjs';
import { viewApp } from './view-app/view-app.mjs';

// The tools live in shared/mcp-tools.mjs, which the host’s shim serves too (#120); this keeps their old import working.
export { READ_TOOLS, TOOL_DEFS };

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
      if (closedTo(rt, name)) return reply({ content: [{ type: 'text', text: closedTo(rt, name) }], isError: true }); // tool-gate.mjs
      const turn = rt.turns.get(sessionId) ?? null;
      const tools = { ...rt.toolsFor(sessionId, turn), ...recordedTools(rt, turn, ownTools(rt, sessionId, turn)) };
      if (name === 'permission_prompt') return reply(asksByPrompt(rt, sessionId) ? await permission(rt, sessionId, args, closeOrSignal) : NOT_YOUR_PROMPT);
      if (!(name in tools) || !TOOL_DEFS.some((t) => t.name === name)) return fail(-32602, `There’s no tool called “${name}”.`);
      try {
        // An app’s files (#54) and a review’s images (#780) may come from the agent’s folder, which Postbox reads itself.
        const app = name === 'show_app' || name === 'update_app' ? await rt.appFiles(sessionId, args) : await blockFiles(rt, sessionId, name, args);
        const r = await keptIfShown(app, (given) => tools[name](app.args, given));
        noteAnswer(rt.turns.get(sessionId) ?? null, name, r);
        // An urgent note for the agent comes first (#229): this is how it hears one mid-turn.
        const text = withUrgent(rt, sessionId, r.results ? JSON.stringify(r.results) : r.message, turn);
        return reply({ content: contentOf(text, r), isError: r.ok === false && !r.waiting });
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

/** What view_app needs of the turn: where it speaks, how to end its reply so far, and whether its agent sees images. */
function viewContext(rt, sessionId, turn) {
  const se = rt.session(sessionId);
  const images = rt.adapters.get(rt.personaFor(se)?.backend)?.capabilities?.images === true;
  return {
    threadId: () => turn?.threadId ?? se.threadId,
    endSegment: () => {
      if (turn) turn.segment = null;
    },
    images,
  };
}

/** react, view_app and the asset tools: their own modules’, beside the runtime’s tools, and recorded as they are (#466). */
function ownTools(rt, sessionId, turn) {
  return {
    react: (a) => reactTool(rt, rt.session(sessionId), a),
    view_app: (a) => viewApp(rt, sessionId, a, viewContext(rt, sessionId, turn)),
    ...assetTools(rt, sessionId, turn),
  };
}

/** A tool’s reply as MCP content: its text, and the picture view_app took, for a backend that sees images (#95). */
const contentOf = (text, r) => [{ type: 'text', text }, ...(r.image ? [{ type: 'image', data: r.image.data, mimeType: r.image.mimeType }] : [])];

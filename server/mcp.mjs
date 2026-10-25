// The MCP server: Postbox’s UI tools over JSON-RPC 2.0 (MCP’s Streamable HTTP transport, JSON responses).
// One endpoint serves every backend. A Claude Code session or an Agent SDK agent connects to
//   POST <origin>/mcp?session=<postbox session id>&turn=<the turn’s token>
// and gets show_block, update_block, review_block, show_app, update_app, retire_app, define_term, react, propose_agent, schedule_wake,
// wake_agent, bring_to_conversation (in side and topic threads), ask_for_tool, corpus_search and add_dataset.
// Every tool returns at once; when you answer a block, your answer reaches the agent later as a new message
// carrying { blockId, action, values }.
//
// One tool is the exception: permission_prompt is what Claude Code calls (--permission-prompt-tool) before
// a risky tool call in “ask” mode, and it waits for your answer on a card in the conversation.
//
// Each turn Postbox starts gets its own token in the URL. A tool call needs the token of the session’s running turn:
// one from a turn you stopped whose process hadn’t exited yet is refused, and nothing of it reaches the conversation
// (#126). So is a call with no token (#54): the session id alone let any process on this computer act as that agent,
// and agents posted large apps to /mcp from scripts, outside the tool calls you see. A large app goes by codePath.

import { limitText as n, PALETTES, READING } from '../shared/limits.mjs';
import { REACTIONS } from '../shared/reactions.mjs';
import { offersBring } from './bring.mjs';
import { sameToken } from './helpers.mjs';
import { asksByPrompt, NOT_YOUR_PROMPT, permission } from './permission-prompt.mjs';
import { reactTool } from './reactions.mjs';
import { REVIEW_BLOCK_DEF } from './review-comments.mjs';
import { AgentFileError } from './runtime.mjs';
import { withUrgent } from './subagent-end.mjs';

const PROTOCOL = '2025-06-18';
const count = (k) => k.toLocaleString('en-US');

const blockSchema = {
  type: 'object',
  description: 'A block from the catalog: { id, type, version, title?, fallback, …fields }. See README, “The block catalog”.',
};

/** A data file an app carries (#54): a path in the agent’s folder, and the name the app reads it by. */
const FILE_SCHEMA = { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['path'] };

// The tools, as agents read them. Their limits come from shared/limits.mjs, as the guide’s do (#50).
export const TOOL_DEFS = [
  {
    name: 'show_block',
    description: `Show a catalog block (choice, form, table, progress, card, confirm, image, code, review) in the conversation. Its id names that one block in this conversation: showing an id you already showed is refused, so change a block with update_block, or pick a new id. Returns at once; the person’s answer arrives later as a message. The person can also dismiss a choice, form, confirm or review without answering it: you get the action “dismiss”, and it no longer waits on them. Limits: a fallback up to ${n('fallback')} characters, a prompt or statement up to ${n('prompt')}, choice options 1–${n('choiceOptions')}, form fields up to ${n('formFields')}, select options up to ${n('selectOptions')}, table columns up to ${n('tableColumns')} and rows up to ${n('tableRows')}, progress steps up to ${n('progressSteps')}, a card body up to ${n('cardBody')} characters with up to ${n('cardFacts')} facts and ${n('cardActions')} actions, code and review content up to ${n('longText')} characters.`,
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  {
    name: 'update_block',
    description: `Replace a block you showed earlier, by its id. An update asks again, except one that sets outcome on an answered choice, form, confirm or review (Markdown, up to ${n('outcome')} characters): that reports the result under the person’s answer, such as “Filed as #105”, keeps the block answered, and changes nothing else. To close a choice, form, confirm or review that’s wrong, handled or stale, answered or not, call update_block with block: { id, withdraw: why } (up to ${n('outcome')} characters): the person sees it closed with your reason, and it stops waiting on them. Don’t ask again just to say a block is done. A choice, form, confirm or review that asks again moves to the newest point in the conversation, with a line where it was; other blocks update in place. Each update makes the block’s next revision, and the person’s answer names the revision it’s for. An update over an answer you haven’t read yet (it waits until your turn ends), whether it asks again or sets outcome, is refused, and the reply says what they answered: read it, then update. For a progress block, send every step each time: set progress { done, total, unit } on a step as items finish, update at least every minute, and close each step as done or failed before your turn ends, or Postbox marks it stalled and tells you. Postbox stamps when the block and each step changed, and fills in duration.`,
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  REVIEW_BLOCK_DEF,
  {
    name: 'show_app',
    description: `Show an app you wrote (HTML with inline script and style, up to ${n('appCode')} characters) in a sandbox with no network. Send its code inline, or as codePath, a file in your folder, which Postbox reads under the same limit; never post to Postbox from a script. files: up to ${n('appFiles')} data files from your folder, [{ name?, path }], up to ${n('appFileBytes')} each; the app reads one as text with await postbox.file(name). Images load from data: URLs, or from <origin>/media/<name> for a file you copy into the folder $POSTBOX_MEDIA names (never into Postbox’s own folder). It can call postbox.query(tool, args) for tools in permissions that you also hold, and postbox.send(action, values, summary) right after the person clicks or presses a key in it (up to 5 a minute; more wait for the person to allow them). One send carries up to ${n('eventBytes')} of JSON; a larger one rejects inside the app, so send ids for many items. Chart colors: ${PALETTES.map((p) => `${p.name} for ${p.for}`).join('; ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        code: { type: 'string' },
        codePath: { type: 'string', description: 'A file in your folder with the app’s code, in place of code.' },
        files: { type: 'array', items: FILE_SCHEMA, description: 'Data files from your folder that the app reads with postbox.file(name).' },
        permissions: { type: 'array', items: { type: 'string' } },
        fallback: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_app',
    description: `Replace an app you showed with a new version, up to ${n('appCode')} characters inline or from codePath, rather than showing a second app. files replaces its data files; without it, the new version keeps the last one’s. The app moves to the newest point in the conversation, with its saved state, and its old place becomes a one-line link to it. Older versions stay in its version menu; summary (up to 300 characters) names what changed.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        code: { type: 'string' },
        codePath: { type: 'string', description: 'A file in your folder with the new code, in place of code.' },
        files: { type: 'array', items: FILE_SCHEMA },
        permissions: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'retire_app',
    description:
      'Retire an app you showed that’s wrong, replaced or no longer needed, rather than updating it to a version that only points elsewhere. It shows as one line where it is, with reason (up to 300 characters) and, when replacedBy names an app or block shown in this conversation, a link to it; it doesn’t move, runs nothing until the person opens a version, and keeps its versions. update_app brings it back.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        reason: { type: 'string' },
        replacedBy: { type: 'string', description: 'The id of the app or block that replaces it.' },
      },
      required: ['id', 'reason'],
    },
  },
  {
    name: 'define_term',
    description: 'Add a term to the glossary of this conversation, or of the topic thread you’re in. Every later mention links to its definition.',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string' }, definition: { type: 'string' }, key: { type: 'string' }, source: { type: 'string' } },
      required: ['term', 'definition'],
    },
  },
  {
    name: 'react',
    description: `React to a message, block or app in this conversation or its topic and side threads, your own included, with one of ${REACTIONS.map(([e, w]) => `${e} (${w.toLowerCase()})`).join(', ')}, as the person can. 🚩 flags something that went wrong. The agent whose message it is hears it at its next turn, as feedback; it wakes no one. Calling it again with the same emoji takes yours back. id: the item’s id, from read_conversation, or a block’s id.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The item’s id, such as it_4kQ2xY9a, or a block’s id.' },
        emoji: { type: 'string', enum: REACTIONS.map(([e]) => e) },
      },
      required: ['id', 'emoji'],
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
    description:
      'Wake another agent with a message. The exchange happens in a side thread, and the agent answers from its one session in this conversation, so it remembers it; if it’s busy, it answers when its current turn ends. Waking an agent that isn’t in this conversation asks the person to add it. After 3 agent wakes in a row, the person must allow the next one.',
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, message: { type: 'string' } }, required: ['handle', 'message'] },
  },
  {
    name: 'bring_to_conversation',
    description:
      'Post text in the main conversation from the side thread or topic thread you’re in. Use it only when the person asks for something to go to the main chat, in a message to you there: nothing goes there on its own. It shows as shared by you from the side or topic thread, and wakes no one; the conversation’s agents read it at their next turn.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to post, in Markdown.' } }, required: ['text'] },
  },
  {
    name: 'read_conversation',
    description: `Read this conversation’s history: what the person and every agent in it said and showed (a block’s content, and the person’s answer), newest last. Each turn already starts with what happened since your last one; use this for anything older. Each item starts with its id, such as [it_4kQ2xY9a], which read_message and react take, and is cut at ${count(READING.item)} characters. Pass the id of one of its side threads or topic threads to read that one instead: a catch-up line, or a link the person sent, gives it.`,
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many items, up to 200. Default 50.' },
        skip: { type: 'number', description: 'Skip this many of the newest items, to read further back.' },
        thread: { type: 'string', description: 'The id (th_…) of a side thread or topic thread of this conversation. Default: where you are.' },
      },
    },
  },
  {
    name: 'read_message',
    description: `Read one message or block of this conversation, or of one of its side or topic threads, in full: a message’s whole text, or a block’s whole content with its comments and the person’s answer. Your history and read_conversation cut each item at ${count(READING.item)} characters, say how much they kept, and give its id. Returns up to ${count(READING.part)} characters, and says how to read on from there.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id a cut gives, such as it_4kQ2xY9a, or a block’s id.' },
        from: { type: 'number', description: 'The character to start from, for a message longer than one read.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'permission_prompt',
    description: 'Postbox calls this for you before a tool needs the person’s permission. Don’t call it yourself.',
    inputSchema: {
      type: 'object',
      // What Claude Code sends (tests/fixtures/claude-code/permission-prompts.json), and the suggestions and agent id
      // its prompt types document (PermissionRequestHookInput’s permission_suggestions), should a version send them.
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
        permission_suggestions: { type: 'array', items: { type: 'object' } },
        agent_id: { type: 'string' },
      },
      required: ['tool_name', 'input'],
    },
  },
  {
    name: 'ask_for_tool',
    description:
      'Ask the person to turn on a tool that’s turned off for you in Postbox (an id from “Turned off for you” in your instructions, such as shell), when a request needs it. Say in why what you’d use it for. The person sees a card that turns it on for you, in every conversation, from your next turn. Returns at once; their answer arrives as a message, so end your turn.',
    inputSchema: {
      type: 'object',
      properties: { tool: { type: 'string', description: 'The tool’s id, such as shell or web.fetch.' }, why: { type: 'string' } },
      required: ['tool', 'why'],
    },
  },
  {
    name: 'corpus_search',
    description:
      'Search the project’s corpus by exact words (BM25) and by meaning (a stub until a real index is connected). books limits it to those book or dataset ids; a dataset is searched only when books names it.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['both', 'lexical', 'semantic'] },
        k: { type: 'number' },
        books: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_dataset',
    description: `Load a dataset into the corpus now, with no restart: a JSON Lines file of records { id?, text, title? }, one per line, up to ${n('datasetBytes')}, in the project’s .postbox/datasets/ folder (write it there first). Each record becomes a passage, read with corpus.read { id: "<dataset id>:<record id>" }. It’s searched only when a search names it in books, so it doesn’t mix into other agents’ results. Loading the same id again replaces it, and it’s loaded again after a restart.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The dataset’s id: letters, digits, - and _, such as scifact-abstracts.' },
        path: { type: 'string', description: 'The file, relative to the project’s .postbox/datasets/.' },
        title: { type: 'string' },
      },
      required: ['id', 'path'],
    },
  },
];

/**
 * Handles one JSON-RPC message (or a batch). Returns the response body, or null for notifications.
 * @param {import('./runtime.mjs').Runtime} rt @param {string|null} sessionId @param {any} body
 * @param {string|null} [turnToken]  the turn’s token from the URL, if it carried one
 */
export async function handleMcp(rt, sessionId, body, turnToken = null) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => one(rt, sessionId, m, turnToken)))).filter(Boolean);
    return out.length ? out : null;
  }
  return one(rt, sessionId, body, turnToken);
}

async function one(rt, sessionId, msg, turnToken) {
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
      // react is the reactions’ own (server/reactions.mjs), beside the runtime’s tools.
      const tools = { ...rt.toolsFor(sessionId, rt.turns.get(sessionId) ?? null), react: (a) => reactTool(rt, rt.session(sessionId), a) };
      if (name === 'permission_prompt') return reply(asksByPrompt(rt, sessionId) ? await permission(rt, sessionId, args) : NOT_YOUR_PROMPT);
      if (!(name in tools) || !TOOL_DEFS.some((t) => t.name === name)) return fail(-32602, `There’s no tool called “${name}”.`);
      try {
        // An app’s code and data files may come from files in the agent’s folder, which Postbox reads itself (#54).
        const app = name === 'show_app' || name === 'update_app' ? await rt.appFiles(sessionId, args) : { args };
        const r = await tools[name](app.args, app.files ? { files: app.files } : {});
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

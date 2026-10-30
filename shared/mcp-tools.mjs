// Postbox’s MCP tools as agents read them: each one’s name, description and input schema, which a tools/list
// answer carries. server/mcp.mjs serves them on the laptop and runs their calls; the host’s stdio shim
// (server/remote/host/) serves the same list, so an agent on another host sees exactly these tools and limits.
// So this file imports only node: modules and shared/, as host code must (#120); tests/host-imports.test.mjs checks it.

import { HOP_LIMIT, limitText as n, PALETTES, READING, SENDING } from './limits.mjs';
import { REACTIONS } from './reactions.mjs';
import { COMMENT_MAX, MAX_COMMENTS, QUOTE_MAX, VERDICTS } from './review-comments.mjs';

const count = (k) => k.toLocaleString('en-US');

const blockSchema = {
  type: 'object',
  description: 'A block from the catalog: { id, type, version, title?, fallback, …fields }. See README, “The block catalog”.',
};

/** A data file an app carries (#54): a path in the agent’s folder, and the name the app reads it by. */
const FILE_SCHEMA = { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' } }, required: ['path'] };

/** review_block (#133), as agents read it; server/review-comments.mjs runs it. */
const REVIEW_BLOCK_DEF = {
  name: 'review_block',
  // lint-allow thread: a review block’s comment threads, not a topic or side thread.
  description: `Comment on another agent’s review block in this conversation, as its reviewer. Each comment becomes an open comment thread on the draft, with your handle, where the person sees it, and the block’s agent hears about it, so it can revise and resolve it. It doesn’t answer the block: that stays the person’s to approve. blockId: the review’s id, or its item id if two agents use the same one. comments (1–${MAX_COMMENTS}, each up to ${COMMENT_MAX.toLocaleString('en-US')} characters): { line, text } on a line; { line, col, endLine, endCol, quote, text } on a selection, with columns from 1, endCol the column of its last character, and quote the exact text there (up to ${QUOTE_MAX.toLocaleString('en-US')} characters); { anchor, text } on an app’s part; or { threadId, text } to reply in its comment thread. verdict?: “comment”, “approve” or “request_changes”, shown on the block.`,
  inputSchema: {
    type: 'object',
    properties: {
      blockId: { type: 'string' },
      comments: { type: 'array', items: { type: 'object' } },
      verdict: { type: 'string', enum: VERDICTS },
    },
    required: ['blockId', 'comments'],
  },
};

// The tools, as agents read them. Their limits come from shared/limits.mjs, as the guide’s do (#50).
export const TOOL_DEFS = [
  {
    name: 'show_block',
    description: `Show a catalog block (choice, form, table, progress, card, confirm, image, code, review) in the conversation. Its id names that one block in this conversation: showing an id you already showed is refused, so change a block with update_block, or pick a new id. Returns at once; the person’s answer arrives later as a message. The person can also dismiss a choice, form, confirm or review without answering it: you get the action “dismiss”, and it no longer waits on them. Limits: a fallback up to ${n('fallback')} characters, a prompt or statement up to ${n('prompt')}, choice options 1–${n('choiceOptions')}, form fields up to ${n('formFields')}, select options up to ${n('selectOptions')}, table columns up to ${n('tableColumns')} and rows up to ${n('tableRows')}, progress steps up to ${n('progressSteps')}, a card body up to ${n('cardBody')} characters with up to ${n('cardFacts')} facts and ${n('cardActions')} actions, code and review content up to ${n('longText')} characters.`,
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  {
    name: 'update_block',
    description: `Replace a block you showed earlier, by its id. An update asks again, except one that sets outcome on an answered choice, form, confirm or review, with block: { id, outcome } (Markdown, up to ${n('outcome')} characters): that reports the result under the person’s answer, such as “Filed as #105”, keeps the block answered, and changes nothing else. One that changes only an answered block’s fallback doesn’t ask again either. To close a choice, form, confirm or review that’s wrong, handled or stale, answered or not, call update_block with block: { id, withdraw: why } (up to ${n('outcome')} characters): the person sees it closed with your reason, and it stops waiting on them. Don’t ask again just to say a block is done. A choice, form, confirm or review that asks again moves to the newest point in the conversation, with a line where it was; other blocks update in place. Each update makes the block’s next revision, and the person’s answer names the revision it’s for. An update over an answer you haven’t read yet (it waits until your turn ends), whether it asks again or sets outcome, is refused, and the reply says what they answered: read it, then update. For a progress block, send every step each time: set progress { done, total, unit } on a step as items finish, update at least every minute, and close each step as done or failed before your turn ends, or Postbox marks it stalled and tells you. Postbox stamps when the block and each step changed, and fills in duration.`,
    inputSchema: { type: 'object', properties: { block: blockSchema }, required: ['block'] },
  },
  REVIEW_BLOCK_DEF,
  {
    name: 'show_app',
    description: `Show an app you wrote (HTML with inline script and style, up to ${n('appCode')} characters) in a sandbox with no network. Send its code inline, or as codePath, a file in your folder, which Postbox reads under the same limit; never post to Postbox from a script. files: up to ${n('appFiles')} data files from your folder, [{ name?, path }], up to ${n('appFileBytes')} each; the app reads one as text with await postbox.file(name). Images load from data: URLs, or from <origin>/media/<name> for a file you copy into the folder $POSTBOX_MEDIA names (never into Postbox’s own folder). It can call postbox.query(tool, args) for tools in permissions that you also hold, and postbox.send(action, values, summary) right after the person clicks or presses a key in it (up to 5 a minute; more wait for the person to allow them). One send carries up to ${n('eventBytes')} of JSON, nested up to ${n('jsonDepth')} levels (as is the state an app saves); a larger one rejects inside the app, so send ids for many items. Chart colors: ${PALETTES.map((p) => `${p.name} for ${p.for}`).join('; ')}. Returns the saved appId, version and pending browser check; read_message { id: appId } reads the recorded check later.`,
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
    description: `Replace an app you showed with a new version, up to ${n('appCode')} characters inline or from codePath, rather than showing a second app. files replaces its data files; without it, the new version keeps the last one’s. The app moves to the newest point in the conversation, with its saved state, and its old place becomes a one-line link to it. Older versions stay in its version menu; summary (up to 300 characters) names what changed. Returns the saved version and pending browser check, not a passed check; read_message { id } reads the current result.`,
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
    description: 'Ask to be woken later, with a note to yourself. It says the wake’s id: if you finish its work before then, cancel it with cancel_wake.',
    inputSchema: { type: 'object', properties: { in_minutes: { type: 'number' }, note: { type: 'string' } }, required: ['in_minutes'] },
  },
  {
    name: 'cancel_wake',
    description: 'Cancel a wake you scheduled, by the id schedule_wake gave you, once its work is done, so it doesn’t wake you for nothing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'wake_agent',
    description: `Wake another agent with a message, up to ${count(SENDING.message)} characters. Your message posts where you are, the conversation or a topic thread, and the agent answers there from its one session in this conversation; its reply wakes you only if it @-mentions you. If it’s busy, it answers when its current turn ends. Waking an agent that isn’t in this conversation asks the person to add it. After ${HOP_LIMIT} agent wakes in one chain, the person must allow the next one; while that waits, a further one is held and goes with their answer.`,
    inputSchema: { type: 'object', properties: { handle: { type: 'string' }, message: { type: 'string' } }, required: ['handle', 'message'] },
  },
  {
    name: 'bring_to_conversation',
    description: `Post text in the main conversation from the topic thread you’re in, up to ${count(SENDING.message)} characters. Use it only when the person asks for something to go to the main chat, in a message to you there: nothing goes there on its own. It shows as shared by you from the topic thread, and wakes no one; the conversation’s agents read it at their next turn.`,
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
    description: `Read one message or block of this conversation, or of one of its side or topic threads, in full: a message’s whole text, or a block’s whole content with its comments and the person’s answer. Your history and read_conversation cut each item at ${count(READING.item)} characters, say how much they kept, and give its id. Your history cuts a message that @-mentions you at ${count(READING.mention)} instead. For an app, also returns its current version and recorded browser check, which may stay pending indefinitely without an open browser. Reading does not trigger a check. Say passed only for that version’s recorded pass; report pending as unverified rather than waiting. An author’s summary or a separate render is not this recorded check. Returns up to ${count(READING.part)} characters, and says how to read on from there.`,
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
 * What a permission_prompt call gets, at once, from an agent whose backend doesn’t ask through it (server/mcp.mjs on
 * the laptop, by server/permission-prompt.mjs’s asksByPrompt; the host’s shim, started without it, #120).
 */
export const NOT_YOUR_PROMPT = Object.freeze({
  content: [
    {
      type: 'text',
      text: 'Postbox didn’t run permission_prompt: it’s how the Claude Code CLI asks the person before a risky call, and your backend asks another way, or not at all. Don’t call it yourself. Make the call you need: if it needs the person’s permission, Postbox asks them.',
    },
  ],
  isError: true,
});

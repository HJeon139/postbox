// What a real agent is told about Postbox, and how Postbox’s messages are written to it.
// Shared by the Claude Code and Agent SDK adapters, so both backends behave the same way.
// lint-allow-file quotes: this is read by models, and straight quotes mark literal values in it.

import { factsText, runsWith } from '../../shared/agent-facts.mjs';
import { LIMITS, limitText, PALETTES } from '../../shared/limits.mjs';
import { commentAt } from '../../shared/review-comments.mjs';
import { formatLint } from '../checks.mjs';
import { formatQueuedMessages } from './queued-messages.mjs';
import { DEFAULT_EFFORT, DEFAULT_MODEL, TOOL_RULES, TOOL_WORDS, toolsOff } from './setup.mjs';

/**
 * The system prompt Postbox appends for an agent: who it is, who else is here, and how to use the room.
 * toolRules: the backend’s map of Tools ids to the tools it turns off (TOOL_RULES for Claude Code and the Agent SDK,
 * the Kiro CLI’s own), or null for a backend that can’t turn a tool off for one agent.
 * room: the other agents in this conversation, with their roles (Runtime.roomOf); handles: every agent in Postbox.
 * @param {{ persona: any, handles: string[], room?: { handle: string, role: string }[], project?: any, brief?: string|null,
 *           session?: { backend?: string, personaSnapshot?: { model?: string, effort?: string }, lastModel?: string, lastEffort?: string }|null,
 *           toolRules?: Record<string, string[]>|null, setup?: boolean }} who  setup: false leaves out what Postbox knows
 *           of the session and how to check a setup (#131), for a backend whose rules file has no room for them (agy)
 */
export function agentGuide({ persona, handles, room = [], project, brief, session, toolRules = TOOL_RULES, setup = true }) {
  const here = new Set(room.map((r) => r.handle));
  const others = handles.filter((h) => h !== persona.handle && !here.has(h));
  return [
    `You are @${persona.handle}, an agent in Postbox: a chat room where one person directs several AI agents, and where agents reply with Markdown, interactive blocks and small apps they write.`,
    persona.description ? `Your role: ${persona.description}` : '',
    persona.instructions ? `The person’s instructions for you:\n${persona.instructions}` : '',
    roomText(room),
    others.length
      ? `${room.length ? 'Other agents in Postbox' : 'Agents in Postbox'}: ${others.map((h) => `@${h}`).join(', ')}. Mention one with @handle, or use wake_agent, to bring it in.`
      : '',
    project?.name ? `This conversation belongs to the project “${project.name}”.` : '',
    brief ? `How you joined: ${brief}` : '',
    setup ? sessionText(session, persona) : '',
    setup ? SETUP_CHECK : '',
    setup && (persona?.backend ?? session?.backend) === 'codex' ? TURN_ENDS : '',
    setup && (persona?.backend ?? session?.backend) === 'codex' ? CODEX_WRITING : '',
    offText(toolsOff(persona, toolRules)),
    guideText(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Who else is in this conversation and what each does, with how to share the work. It comes from the room, not from
 * a persona’s prompt, so any team works this way: two agents on one task did it twice from different decisions (#121),
 * and role-based agent teams do better with explicit handoffs than with role names alone (MetaGPT, arXiv 2308.00352).
 * @param {{ handle: string, role: string }[]} room
 */
export function roomText(room) {
  if (!room.length) return '';
  const who = room.map((r) => `- @${r.handle}${r.role ? `: ${r.role}` : ''}`).join('\n');
  return `## In this conversation

${who}

Each agent here has a part. Take the part of a request that’s yours, and leave another agent’s part to it, so no task is done twice. To hand work on, @mention the agent with what it needs to start: the files and lines, the checks you ran and what they showed, and what’s still open. @mention one only when it must act next (a hand-off, a question, a review); else write its name without @. Before redoing something, read what the others already did here.`;
}

/**
 * What the persona turned off (#104). The backend removes those tools, so the agent can’t tell a tool that’s off from
 * a computer without one, and told a person who could run gh that it had no shell. This says which, and how to ask.
 * @param {string[]} off  tool ids, from toolsOff
 */
export function offText(off) {
  if (!off.length) return '';
  const list = off.map((id) => `${TOOL_WORDS[id] ?? id} (${id})`).join('; ');
  return `## Turned off for you

The person turned these off for you in Postbox, so their tools aren’t in your list: ${list}. This computer has them; Postbox doesn’t give them to you. If a request needs one, don’t say the computer or the person lacks it: call ask_for_tool { tool: "${off[0]}", why: what you’d use it for }, then end your turn. The person sees a card that turns it on for you, and their answer reaches you as a message.`;
}

/** What Postbox knows about this session’s backend, model and effort (#131): this session’s, not another command’s. */
function sessionText(session, persona) {
  const facts = runsWith(session, persona, { defaultModel: DEFAULT_MODEL, defaultEffort: DEFAULT_EFFORT });
  const text = facts.mock
    ? `Postbox runs you with ${factsText(facts)}.`
    : facts.answered
      ? `Your last turn ran on ${factsText(facts)}.`
      : `Postbox has you set to ${factsText(facts)}, and hasn’t recorded an answered turn yet.`;
  return `## Your session\n\n${text} That’s this session; a command you run may use other settings.`;
}

/** How to check a setup before blaming it (#131): the agent’s own calls work, and a cause is a guess until it’s tested. */
const SETUP_CHECK = `## Before blaming the setup

Your own model calls work, so don’t ask the person to change their setup or credentials on a hunch. Compare the failing command with a working one that changes one thing; rerun it yourself only if it just reads or checks something, and otherwise ask first. If you can’t confirm the cause, say it’s a guess and what you compared.`;

/**
 * Work left for later is work nobody does: an agent ended turns with “results will follow”, and nothing woke it when
 * they did. Postbox wakes an agent only for a message, a mention or a wake it scheduled (intent.md, “Attention and
 * wakes”), so the agent is told to finish, or to schedule its own wake. Only Codex agents are told: the habit was
 * Codex’s, and on Codex the turn’s process group stops when the turn completes (adapters/codex.mjs).
 */
const TURN_ENDS = `## When your turn ends

Your turn ends when you reply. Postbox wakes you again only for a message, a mention or a wake you scheduled, never because a command you started finished, and what you left running may stop with your turn. So wait for a check to finish before you report it, and don’t end with “results will follow”. If something must outlive your turn, call schedule_wake with a note to yourself and say when you’ll check.`;

/**
 * Codex agents wrote less and less Markdown over a long room, and their wake_agent messages ran words together
 * (“reviewstillP1”): in one room, 56% of a Codex agent’s long messages had any structure against 97–100% for the
 * other agents, and 11 of its hand-offs were garbled. Codex’s own prompt says it “may” format and to use lists
 * sparingly, so this says what Postbox shows and wants. Codex only, like TURN_ENDS above.
 */
const CODEX_WRITING = `## How you write here

Everything you send is read in the conversation as Markdown, including the message you give wake_agent. Write it as you would for a person: short paragraphs, a bullet list for parallel items such as results or findings, \`code\` for names, paths and commands, a blank line before every list, and a space between all words. Don’t compress or abbreviate a hand-off to save room: the agent reading it sees it as written.`;

/**
 * How to use Postbox, the same for every agent. Every limit in it comes from shared/limits.mjs (#50).
 * @param {Record<string, number>} [limits]  the limits to write in, for tests
 */
export function guideText(limits = LIMITS) {
  const n = (/** @type {import('../../shared/limits.mjs').LimitName} */ name) => limitText(name, limits);
  return `## What your reply contains decides its form

Postbox shows blocks the person answers with a click. Every time you reply, whether or not the person asked for a block, look at what the reply contains:
- Options to pick from → a choice, not a numbered list; prose that weighs options still ends with a choice of what to do next. For “Load the corpus or the claims first?”: options [{ id: "corpus", label: "The corpus" }, { id: "claims", label: "The claims" }].
- Questions for the person → a form, one field per question, not questions in prose. For “Who will read it, and how long?”: fields [{ id: "reader", label: "Who will read it?", kind: "text" }, { id: "words", label: "How many words?", kind: "number" }].
- A draft to approve (a document, a spec, a message to send) → a review block { format: "markdown", content: the draft }, and a one-line reply. After comments, update_block with previous set to the old text, so the person sees a diff.
- Data the person would sort or filter (a scan of datasets, candidates and their traits) → a table block with sortable columns, not a Markdown table.
- A job of several steps that takes minutes → a progress block, with steps such as { id: "read", label: "Read the papers", state: "running", progress: { done: 3, total: 40, unit: "papers" } }. Move it on with update_block as items finish, at least every minute, and close every step as done or failed before your turn ends; one left running shows as stalled. Give each parallel subagent its own step.
- A write outside this conversation (a document, an issue, a message, through any tool) → first its draft in a review block, even when asked to create it; make the call once the person approves, unless they said to publish directly.
- Something destructive or costly → first, a confirm that says exactly what will happen.
- Anything else → Markdown.

The Postbox tools (the “postbox” MCP server) return at once: the answer arrives later as a new message. So ask, end your turn, and continue when it comes. The answer names the block and its revision. A choice, form, confirm or review turns read-only once answered. Report what you did in your reply, or with update_block on the answered block with outcome set (Markdown, up to ${n('outcome')} characters): it shows under the answer, and the block stays answered. Update an answered block without outcome only to ask again.

## Blocks

Every block has id (letters, digits, - _ . :; one block per id in a conversation), type, version: 1, title?, and fallback: plain text (up to ${n('fallback')} characters) the person can answer in chat if the block can’t be shown. Long text is Markdown, with a prompt or statement up to ${n('prompt')} characters; labels are plain text.
- choice: options [{ id, label }] (1–${n('choiceOptions')}), prompt?, multiple?, max?, other?: { label, placeholder? }, display?: "chips" | "buttons", submitLabel?, outcome?. Answer: "choose", { selected: [ids], other? }.
- form: fields (up to ${n('formFields')}) [{ id, label, kind: "text" | "longtext" | "number" | "select" | "toggle" | "date", required?, placeholder?, help?, min?, max?, step?, maxLength?, options? (select only, up to ${n('selectOptions')}), default? }], prompt?, submitLabel?, outcome?. Answer: "submit", { [fieldId]: value }.
- confirm: statement, confirmLabel (the action, such as “Delete 23 frames”), cancelLabel?, outcome?. Answer: "confirm" or "cancel".
- review: format "markdown" | "code" | "app", content (up to ${n('longText')} characters) or appId, previous?, threads?, language?, filename?, outcome?. Answer: "submit", { verdict: "comment" | "approve" | "request_changes", comments: [{ line? | anchor?, text }] }.
- progress: steps (up to ${n('progressSteps')}) [{ id, label, state: "pending" | "running" | "done" | "failed", detail?, progress?: { done, total, unit? }, percent?: 0–100, eta? }]. Postbox shows when it last changed and times each step.
- table: columns (up to ${n('tableColumns')}) [{ id, label, kind?: "text" | "number", sortable? }], rows (up to ${n('tableRows')}) [{ id, cells: { [columnId]: value } }], rowAction?: { id, label }. Answer: the rowAction id, { rowId }.
- card: body? (up to ${n('cardBody')} characters), facts? (up to ${n('cardFacts')}) [{ label, value }], actions? (up to ${n('cardActions')}) [{ id, label }]. Answer: the action id.
- image: src (https, from an allowed origin), alt, caption?.
- code: code (up to ${n('longText')} characters), language?, filename?.

## Markdown and diagrams

Postbox renders headings, lists, tables, links (https only), \`code\`, fenced code, \`\`\`mermaid diagrams, and math with $…$ or $$…$$. Raw HTML shows as text, except \`<details><summary>Answer</summary> … </details>\`, which hides an exercise’s answer until the person opens it.

Diagrams are scaled to a 728 px column, so a wide one becomes unreadable. Keep about five boxes side by side: draw longer chains top to bottom (flowchart TD), keep labels to a few words, put lists in the text, and split anything over about 15 boxes.

## Apps

When a tool explains better than prose (an explorer, simulator, exercise), write one with show_app { id, title, code, permissions?, fallback? }. Change it with update_app, not a new app; retire a wrong or replaced one with retire_app { id, reason, replacedBy? }, not a pointer version. code: one HTML document, inline <script> and <style>, up to ${n('appCode')} characters; for a large one, codePath. Data: files [{ name?, path }] (up to ${n('appFiles')}, ${n('appFileBytes')} each), read with postbox.file(name). add_dataset loads searchable JSONL from .postbox/datasets/ (up to ${n('datasetBytes')}); searches name it in books. No network: no fetch, external scripts or fonts. Use var(--token) colors (--text, --dim, --bg, --panel, --line, --accent…), never raw colors, for light and dark, and Postbox’s classes btn (sm, ghost), chip, pill, field, label, input, select, dim, small, mono. Prefix your own classes (lab-row): Postbox styles names like bar. In charts:
${PALETTES.map((p) => `- ${p.name} for ${p.for}: ${p.when}.`).join('\n')}

The global postbox gives you:
- await postbox.ready → { state, theme, appId }
- postbox.query(tool, args), for permitted tools you hold:
  - "corpus.search" with { query, k?, mode?: "both" | "lexical" | "semantic", books?: [ids] } returns [{ id, book, title, author, year, chapter, text, lexical: { score, terms } | null, semantic: number | null }]
  - "corpus.read" with { id } returns one, without scores
  - "corpus.stats" returns { books: [{ id, title, author, year, passages, chapters }], passages }
- postbox.send(action, values, summary) sends you one event, only from the person’s click or key press; summary is the app’s words, not theirs. Up to 5 a minute; more wait for the person. An event carries up to ${n('eventBytes')} of JSON (more rejects), so hand over many items by id.
- postbox.saveState(obj) and postbox.restoreState() keep state over reloads and versions
- postbox.load("d3" | "katex" | "mermaid") loads a bundled library
- postbox.charts.line / scatter / stacked / heatmap / table(el, spec) draw charts with a Table view
- postbox.on("theme", fn) to redraw canvas or SVG on a theme change

Don’t autofocus: Postbox stops an app that keeps taking the keyboard. Before showing an app, Postbox checks it in a narrow and a wide window (375 and 1280 px) for layout, accessibility and script errors; fix what it reports with update_app. Read the version’s check via read_message.

## Working with others

- You see all of the conversation; read “[Postbox]” notes first. read_conversation reads it or a topic thread; read_message { id }, cut items.
- One session each, topic threads too: busy ones reply later; only the person adds agents.
- Writing @handle wakes that agent; to name one, omit @.
- define_term a term the first time you use it, so later mentions link to it.
- Use bring_to_conversation only when the person asks to put something in the main chat.

## Recipes

Use one when the person asks for what it covers.
- Explorer: an app that searches with postbox.query("corpus.search"), keeps its state with saveState, and sends picks back with postbox.send.
- Explainer with practice: Markdown with a \`\`\`mermaid diagram and math, define_term for new terms, then a small practice app.
- Narrated walkthrough: passages first (one per slide, two or three short sentences, up to 1,200 characters each), then an app with slides, Previous and Next buttons, and postbox.narration(el, passages, { onPassage: (i) => showSlide(i) }), with permission "narrate.speak".
- Slidev export: write slides.md (slides split by ---, notes in <!-- --> comments), show it as a code block with filename "slides.md", and say \`npx @slidev/cli export slides.md\` makes a PDF.

## Writing

Plain English, sentence case, American spelling, curly quotes and apostrophes (“ ” ’). Say what happened and what the person can do next. Keep replies short; put detail in blocks and apps.`;
}

/**
 * Whether an event is a review’s: the person’s (a verdict) or another agent’s (from). An app’s isn’t, whatever its
 * values hold: Postbox counted what it sent, and its values aren’t the person’s words (#51).
 * @param {any} event
 */
const isReview = (event) =>
  !event.sent && (typeof event.from === 'string' || typeof event.values?.verdict === 'string') && Array.isArray(event.values?.comments);

/**
 * Writes one Postbox message as the text of a turn for the agent.
 * @param {any} message  see server/adapters/adapter.mjs
 * @param {(a: any) => string|null} [pathOf]  where an attachment can be read on disk
 */
export function formatMessage(message, pathOf = () => null) {
  const body = message.messages?.length ? formatQueuedMessages(message.messages, pathOf, formatMessage) : formatBody(message, pathOf);
  if (message.taskContext)
    return [
      message.taskContext,
      '[Postbox] Your task in this topic or side thread is the request below. Answer it here.',
      body,
      ...(message.context ?? []),
    ].join('\n\n');
  // Context that waited for a room turn (a topic thread’s brief, something shared back) comes first.
  return message.context?.length ? `${message.context.join('\n\n')}\n\n${body}` : body;
}

function formatBody(message, pathOf) {
  switch (message.kind) {
    case 'user': {
      const files = (message.attachments ?? []).map((a) => {
        const where = pathOf(a);
        const what = a.kind === 'project-file' ? a.path : `${a.name}${a.type ? ` (${a.type})` : ''}`;
        return `- ${what}${where ? `: ${where}` : ''}`;
      });
      return [message.text, files.length ? `Attached:\n${files.join('\n')}` : ''].filter(Boolean).join('\n\n') || '(The person sent an empty message.)';
    }
    case 'event':
      return [
        `[Postbox] ${message.event.from ? `@${message.event.from} reviewed your` : 'The person acted in'} block “${message.event.blockId}”${message.event.revision ? ` (revision ${message.event.revision})` : ''}: ${message.event.action}\n${JSON.stringify(message.event.values ?? {})}`,
        // A review’s comments, as the history gives them (#179): “line 12, col 5–23 “the quoted text”: the comment”.
        isReview(message.event)
          ? message.event.values.comments
              .filter((c) => c && typeof c === 'object')
              .map((c) => `- ${commentAt(c)}: ${c.text}`)
              .join('\n')
          : '',
        // Another agent’s review (#133): its comments are on the block now, and the person still decides.
        message.event.from
          ? 'Each comment is on the block now, by its threadId. Revise with update_block, and keep each one in the block’s threads? with status “resolved” once you’ve handled it. The block still waits on the person.'
          : '',
        // From an app (#51): what Postbox counted, and the app’s own summary, which the person didn’t write.
        message.event.sent ? `What Postbox counted in it: ${message.event.sent}` : '',
        message.event.appSummary ? `The app’s own summary, not the person’s words: “${message.event.appSummary}”` : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'agent':
      // A reply doesn’t go back by itself (#372): say so where the agent reads the message it answers.
      return `[Postbox] ${message.from} wrote to you. Your reply posts here; it reaches ${message.from} only if you @-mention them, so do that only when they must act next.\n\n${message.text}`;
    case 'wake':
      return `[Postbox] A wake-up you scheduled is due. Your note: ${message.note || '(none)'}`;
    case 'app-check':
      return `[Postbox] Your app “${message.appId}” failed the pre-display check. Fix it with update_app:\n${(message.problems ?? []).map((p) => `- ${p.code}: ${p.message}`).join('\n')}`;
    case 'lint':
      return formatLint(message);
    case 'notice':
      return `[Postbox] ${message.text}`;
    default:
      return `[Postbox] ${JSON.stringify(message)}`;
  }
}

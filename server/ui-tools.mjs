// The UI tools an agent calls during a turn, the same set MCP exposes (server/mcp.mjs): each tool’s handler, bound to
// the session it acts for and the turn it acts in, recorded as a step of that turn (recordedTools). Most handlers
// delegate to the module that owns their block, app, wake or read. Moved out of server/runtime.mjs; Runtime keeps
// toolsFor, which delegates here.

import { retireApp } from './app-retire.mjs';
import { showApp, updateApp } from './apps.mjs';
import { showBlock } from './block-show.mjs';
import { updateBlock } from './blocks.mjs';
import { bringToConversation } from './bring.mjs';
import { reviewBlock } from './review-comments.mjs';
import { cancelWake, scheduleWakeTool } from './schedule-tools.mjs';
import { recordedTools } from './scheduled-wakes.mjs';
import { wakeAgent } from './side-threads.mjs';
import { askForTool } from './tool-ask.mjs';
import { openTopic } from './topic-open.mjs';
import { wokeOf } from './turn-marks.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/** @param {string} sessionId @param {any} [turn]  the turn the tools act for; null outside a turn */
export function toolsFor(rt, sessionId, turn = null) {
  const se = () => rt.session(sessionId);
  const endSegment = () => {
    if (turn) turn.segment = null;
  };
  // Where the turn speaks: its session’s thread, or the side thread it answers in (#110).
  const threadId = () => turn?.threadId ?? se().threadId;
  return recordedTools(rt, turn, {
    /** @param {{ block: any }} args @param {{ files?: AppFile[] }} [given]  data files Postbox read for show_app (#54) */
    show_block(args, given = {}) {
      return showBlock(rt, sessionId, { turn, se, threadId, endSegment, tools: this }, args, given);
    },
    update_block(args, given = {}) {
      return updateBlock(rt, sessionId, args, { turn, se, threadId, endSegment }, given);
    },
    review_block: (args) => reviewBlock(rt, sessionId, args),
    show_app(args, given = {}) {
      return showApp(rt, sessionId, this, args, given);
    },
    update_app(args, given) {
      return updateApp(rt, sessionId, turn, threadId, endSegment, args, given);
    },
    retire_app(args) {
      return retireApp(rt, sessionId, args);
    },
    define_term({ term, definition, key, source }) {
      if (!term || !definition) return { ok: false, message: 'define_term needs a term and a definition.' };
      const k =
        String(key ?? term)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 64) || 'term';
      if (turn) (turn.defined ??= []).push(String(term).slice(0, 80));
      rt.store.emit('glossary', {
        threadId: threadId(),
        entry: {
          key: k,
          term: String(term).slice(0, 80),
          definition: String(definition).slice(0, 2000),
          source: source ? String(source).slice(0, 200) : '',
          by: se().handle,
          at: Date.now(),
        },
      });
      const inherited = rt
        .lineage(threadId())
        .slice(1)
        .some((id) => rt.s.glossary[id]?.[k]);
      return { ok: true, message: inherited ? `Defined “${term}” here, over the conversation’s definition.` : `Defined “${term}”.` };
    },
    propose_agent({ handle, description, instructions, tools = [], model = 'mock', backend = 'mock' }) {
      const mine = new Set(rt.persona(se().personaId)?.tools ?? []);
      // Agents send JSON: anything that isn’t a string here is coerced, so it can only ever show as text.
      const str = (v, max) => String(v ?? '').slice(0, max);
      handle = str(handle, 40);
      description = str(description, 500);
      instructions = str(instructions, 20000);
      tools = (Array.isArray(tools) ? tools : []).filter((t) => typeof t === 'string').slice(0, 40);
      model = str(model, 80);
      backend = str(backend, 40);
      endSegment();
      rt.addItem(threadId(), {
        kind: 'proposal',
        sessionId,
        handle: se().handle,
        // Its turn’s, so it shares that turn’s sender line and no other (#135).
        turnId: turn?.id ?? null,
        ...wokeOf(turn),
        status: 'open',
        proposal: { handle: String(handle).replace(/^@/, ''), description, instructions, tools, model, backend },
        extraTools: tools.filter((t) => !mine.has(t)),
      });
      return { ok: true, message: 'Proposed. The person decides whether to create it.' };
    },
    schedule_wake: (args) => scheduleWakeTool(rt, sessionId, args),
    cancel_wake: (args) => cancelWake(rt, sessionId, args),
    wake_agent: (args) => wakeAgent(rt, sessionId, args),
    open_topic: (args) => openTopic(rt, sessionId, args),
    bring_to_conversation: (args = {}) => bringToConversation(rt, sessionId, turn, args),
    read_conversation(args = {}) {
      try {
        return { ok: true, message: rt.readConversation(se(), args) };
      } catch (e) {
        return { ok: false, message: e.message };
      }
    },
    read_message(args = {}) {
      return rt.readMessage(se(), args);
    },
    ask_for_tool(args = {}) {
      return askForTool(rt, sessionId, args, endSegment, threadId());
    },
  });
}

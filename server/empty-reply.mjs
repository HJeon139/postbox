// A turn that ends with no reply (#485). A Claude Code turn of about 45 minutes ended with its report as the text after
// its last command, and Postbox posted the reply as an item with no text: the report reached no one, and the room
// worked on as if it hadn’t been sent. Whatever the backend did, such a turn is never posted as an empty message. It
// ends as a failed reply that says so, with Retry, keeping the turn’s last raw lines for diagnosis, and the agent hears
// of it at its next turn.

import { endedExchange } from './reply-back.mjs';
import { isOwnWork, NO_ANSWER, READ_TOOLS } from './tool-gate.mjs';

/**
 * The turns that owe a reply: a message from the person or from another agent. Others may end quietly: an event (a
 * block answered or dismissed, a review, an app’s send), a scheduled wake, a lint pass or an app check.
 */
const ASKED = new Set(['user', 'agent']);

/**
 * Marks a turn that answered through one of Postbox’s tools that act, such as a reaction or a term, which leave no
 * item of the turn’s own. server/mcp.mjs and a host’s calls (remote/turns-tools.mjs) both call it, and so does a call
 * in Postbox’s own process (notedTools). `acted` marks one that did work (tool-gate.mjs, isOwnWork): a turn that showed
 * or changed something has it to report, so its reply goes back (reply-back.mjs, endedExchange). `wrote` names each
 * call that wasn’t only a read, for a retry to check (turn-transient.mjs).
 * @param {any} turn  the turn the call came from, or null @param {string} name @param {any} r  the tool’s result
 */
export function noteAnswer(turn, name, r) {
  if (!turn || (r?.ok === false && !r?.waiting)) return;
  // Each of its calls that may have written, by name, which a retry of the turn is told to check (#1713): open_topic
  // and react are quiet and make no step, and a call outside Postbox’s process makes none either.
  if (!READ_TOOLS.has(name) && !(turn.wrote ??= []).includes(name)) turn.wrote.push(name);
  if (NO_ANSWER.has(name)) return;
  turn.answered = true;
  if (isOwnWork(name)) turn.acted = true;
}

/**
 * A turn’s Postbox tools, each noting its answer as it returns, for a call made in Postbox’s own process, as the mock
 * backend makes them: MCP and a host note theirs once Postbox has read the call’s files, and noting twice changes
 * nothing. A tool that calls another (show_app, update_app) is noted once, as the call the agent made.
 * @param {any} turn @param {Record<string, Function>} tools
 */
export function notedTools(turn, tools) {
  if (!turn) return tools;
  const raw = { ...tools };
  for (const [name, fn] of Object.entries(raw))
    tools[name] = (/** @type {any[]} */ ...args) => {
      const r = fn.apply(raw, args);
      // A promise is noted when it settles; one that rejects answered nothing, and its caller hears why.
      if (typeof r?.then === 'function') void r.then((/** @type {any} */ done) => noteAnswer(turn, name, done)).catch(() => {});
      else noteAnswer(turn, name, r);
      return r;
    };
  return tools;
}

/**
 * Whether a turn that owes a reply ended with none: no text, no call that acted (noteAnswer), and nothing else of its
 * own in the thread (a block, an app, a card, a message it sent another agent, which carries fromTurnId).
 * @param {any} turn @param {readonly any[]} items  the thread’s
 */
export function endedWithoutReply(turn, items) {
  if (!ASKED.has(turn.kind) || turn.slash || turn.said.trim() || turn.answered) return false;
  if (endedExchange(turn)) return false;
  return !items.some((it) => (it.turnId === turn.id || it.fromTurnId === turn.id) && (it.kind !== 'agent' || it.text?.trim()));
}

/**
 * The failure an empty turn ends with: what the person reads, and the turn’s raw ending, which the failed reply keeps.
 * The agent is told too, at its next turn.
 * @param {any} rt @param {any} se @param {any} turn
 */
export function emptyReply(rt, se, turn) {
  rt.sessions.tell(
    se.id,
    'Your last turn in this conversation ended without a reply: nothing you wrote reached it, so no one read your answer. If you meant to report something, say it again now.',
  );
  return Object.assign(new Error(`@${se.handle}’s turn ended without a reply.`), {
    rawEnding: { backend: rt.personas.forSession(se)?.backend ?? null, lines: [...(turn.rawTail ?? [])] },
  });
}

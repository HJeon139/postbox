// Claude Code’s AskUserQuestion (#521). The CLI sends it to its permission prompt tool and the Agent SDK to canUseTool,
// in Auto and Ask me alike (Bypass passes no prompt tool, and the CLI then doesn’t offer it), and both reach
// requestPermission, as a host’s prompt does. So the question is asked there as Postbox’s own choice blocks, one per
// question and one at a time, and the person’s answers are the tool’s result:
// { behavior: 'allow', updatedInput: { questions, answers } }, keyed by each question’s text, several labels joined
// with “, ” (tests/fixtures/claude-code/ask-user-question-prompts.json). A question the catalog can’t show keeps the
// permission card it had before.
//
// Each block waits as a permission card does, in rt.permissionWaits under its item’s id, marked `question`. The
// person’s answer (blocks.mjs, act) settles the wait and isn’t sent as an event, since the tool’s result carries it. A
// wait that ends first (the turn ends or stops, CARD_WAIT_MS, the host’s limit) leaves the block asking: its answer
// then reaches the agent as an event, as any block’s does, and the call is refused with STILL_OPEN, so the agent
// doesn’t ask it again. A restart drops the wait the same way, since the call died with the process.

import { validateBlock } from '../shared/catalog.mjs';
import { offerNeed } from './card-needs.mjs';
import { newId } from './ids.mjs';
import { CARD_WAIT_MS, expireWait } from './permission-cards.mjs';
import { gated } from './store-outage.mjs';

export const QUESTION_TOOL = 'AskUserQuestion';
export const DISMISSED = 'The person dismissed the question.';
export const STILL_OPEN = 'The question stays open in the conversation; their answer reaches you as a message, so don’t ask it again.';

/**
 * The choice blocks for an AskUserQuestion input, one per question, or null if any can’t be shown as one: the call
 * then keeps its permission card. @param {any} input @returns {any[] | null}
 */
export function questionBlocks(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const blocks = [];
  for (const q of questions) {
    const block = choiceOf(q);
    const v = block ? validateBlock(block) : null;
    if (!v?.ok) return null;
    blocks.push(v.block);
  }
  return blocks;
}

/** One question as a choice block, or null when its shape isn’t AskUserQuestion’s. @param {any} q */
function choiceOf(q) {
  if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return null;
  const options = q.options.map((o, i) => ({
    id: `o${i + 1}`,
    label: o?.label,
    ...(typeof o?.description === 'string' && o.description.trim() ? { description: o.description } : {}),
  }));
  const labels = options.map((o) => `- ${o.label}`).join('\n');
  return {
    id: newId('ask'),
    type: 'choice',
    version: 1,
    ...(typeof q.header === 'string' && q.header.trim() ? { title: q.header } : {}),
    prompt: q.question,
    options,
    multiple: q.multiSelect === true,
    other: { label: 'Other' },
    fallback: `${q.question}\n${labels}`.slice(0, 4000),
  };
}

/**
 * Asks each question in turn and answers the call. @param {any} rt @param {string} sessionId
 * @param {{ input: any, hostPrompt?: any }} req @param {any[]} blocks  questionBlocks(req.input)
 * @returns {Promise<{ allow: boolean, message?: string, updatedInput?: Record<string, any> }>}
 */
export async function askQuestions(rt, sessionId, req, blocks) {
  /** @type {Record<string, string>} */
  const answers = {};
  for (const block of blocks) {
    const got = await askOne(rt, sessionId, block, req.hostPrompt ?? null);
    if (got.dismissed) return { allow: false, message: DISMISSED };
    if (!got.values) return { allow: false, message: stillOpen(got.message, answers) };
    answers[block.prompt] = answerText(block, got.values);
  }
  return { allow: true, updatedInput: { ...req.input, answers } };
}

/** The chosen labels in the options’ order, then the Other text, joined with “, ” as Claude Code joins several. */
function answerText(block, { selected = [], other }) {
  const chosen = block.options.filter((o) => selected.includes(o.id)).map((o) => o.label);
  return [...chosen, ...(other ? [other] : [])].join(', ');
}

/** Why the call ends unanswered, what was answered before it, and that the question stays open. */
function stillOpen(why, answers) {
  const before = Object.entries(answers).map(([q, a]) => `“${q}”: ${a}`);
  const said = before.length ? ` They had answered ${before.join('; ')}.` : '';
  return `${why ?? 'The turn ended before the person answered.'}${said} ${STILL_OPEN}`;
}

/**
 * Shows one question block and waits for its answer: { values } chosen, { dismissed }, or { message } when the wait
 * ended first. @param {any} rt @param {string} sessionId @param {any} block @param {any} hostPrompt
 */
function askOne(rt, sessionId, block, hostPrompt) {
  const se = rt.s.sessions[sessionId];
  const turn = rt.turns.get(sessionId);
  if (!se || !turn) return Promise.resolve({ message: 'The turn has ended.' });
  const it = rt.addItem(turn.threadId, {
    kind: 'block',
    sessionId,
    handle: se.handle,
    turnId: turn.id,
    valid: true,
    block,
    answered: false,
    question: true,
  });
  rt.closeSegment(turn);
  offerNeed(rt, se, { kind: 'block', itemId: it.id, text: block.title ?? block.prompt, ...rt.awayFrom(se, turn.threadId) }, 'needs');
  rt.notify('blocking', se, `@${se.handle} asks you`, block.prompt, turn.threadId);
  return new Promise((resolve) => {
    // A host prompt ends when its host says so, as its card would (permission-cards.mjs, askPerson).
    const timer = hostPrompt ? null : setTimeout(() => gated(rt, () => expireWait(rt, it.id)), CARD_WAIT_MS);
    timer?.unref?.();
    rt.permissionWaits.set(it.id, { resolve, threadId: turn.threadId, sessionId, timer, question: true });
  });
}

/** Whether a block’s item is an AskUserQuestion whose call still waits for it. @param {any} rt @param {string} itemId */
export const waitingQuestion = (rt, itemId) => rt.permissionWaits.get(itemId)?.question === true;

/**
 * The person answered a waiting question’s block: its call gets the values, or null when they dismissed it.
 * @param {any} rt @param {string} itemId @param {any} values
 */
export function answerQuestion(rt, itemId, values) {
  const w = rt.permissionWaits.get(itemId);
  clearTimeout(w.timer);
  rt.permissionWaits.delete(itemId);
  w.resolve(values ? { values } : { dismissed: true });
}
